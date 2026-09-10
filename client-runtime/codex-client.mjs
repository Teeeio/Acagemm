import { execFile as nodeExecFile, spawn as nodeSpawn } from 'node:child_process';
import { mkdir, appendFile, readFile, stat, writeFile, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { runtimeDir } from './storage-paths.mjs';
import { createScopedGitEnvironment } from './git-environment.mjs';
import { resolveCliInvocation } from './cli-command.mjs';
import { DEFAULT_JOB_HELPER_TIMEOUT_MS, createJobName, jobObjectSupported, spawnJobObjectProcess } from './windows-job-object.mjs';

const defaultTimeoutMs = 12_000;

const execFileAsync = (execFileImpl, command, args, options = {}) => new Promise((resolve, reject) => {
  execFileImpl(command, args, { ...options, encoding: 'utf8', timeout: options.timeout ?? defaultTimeoutMs }, (error, stdout = '', stderr = '') => {
    if (error) {
      error.stdout = stdout;
      error.stderr = stderr;
      reject(error);
      return;
    }
    resolve({ stdout, stderr });
  });
});

const parseLines = (content) => content.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).flatMap((line) => {
  try { return [JSON.parse(line)]; } catch { return [{ type: 'text', text: line }]; }
});

const hasCompletedTurn = (events = []) => events.some((event) => event?.type === 'turn.completed');

// Keep transport/protocol evidence separate from the business result.  A
// missing `turn.completed` is only useful for diagnosis when we can tell
// whether bytes stopped at the provider, the child-process pipe, or the JSONL
// parser.  These counters are deliberately additive and bounded; they never
// influence candidate admission or Gate decisions.
const emptyStreamObservability = (transport = 'child-process-stdio') => ({
  transport,
  stdoutBytes: 0,
  stderrBytes: 0,
  stdoutChunks: 0,
  stderrChunks: 0,
  parsedEventCount: 0,
  parseErrorCount: 0,
  firstStdoutAt: null,
  lastStdoutAt: null,
  firstStderrAt: null,
  lastStderrAt: null,
  firstEventAt: null,
  lastEventAt: null,
  terminalEventType: null,
});

const markStreamActivity = (observability, stream, byteLength, now = new Date().toISOString()) => {
  if (!observability || !byteLength) return;
  const bytesKey = stream === 'stderr' ? 'stderrBytes' : 'stdoutBytes';
  const chunksKey = stream === 'stderr' ? 'stderrChunks' : 'stdoutChunks';
  const firstKey = stream === 'stderr' ? 'firstStderrAt' : 'firstStdoutAt';
  const lastKey = stream === 'stderr' ? 'lastStderrAt' : 'lastStdoutAt';
  observability[bytesKey] += byteLength;
  observability[chunksKey] += 1;
  observability[firstKey] ||= now;
  observability[lastKey] = now;
};

const enabledSetting = (value, fallback = true) => {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'boolean') return value;
  return /^(1|true|yes|on)$/i.test(String(value));
};

// Schedule-delay-tolerant override for the Job supervisor's helper timeout.
// A value below the floor would turn an ordinary loaded-machine cold start
// into a false CODEX_JOB_START_TIMEOUT, so an unusable setting falls back
// rather than shrinking the bound.
const helperTimeoutSetting = (value, fallback) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 1_000 ? parsed : fallback;
};

// Serialize an argv array for CreateProcessW using the CommandLineToArgvW
// escaping rules.  The Job helper receives lpApplicationName separately; this
// string contains only target arguments.
const quoteWindowsArgument = (value) => {
  const argument = String(value ?? '');
  if (argument && !/[\s"]/u.test(argument)) return argument;
  let result = '"';
  let slashes = 0;
  for (const character of argument) {
    if (character === '\\') { slashes += 1; continue; }
    if (character === '"') {
      result += '\\'.repeat(slashes * 2 + 1) + '"';
      slashes = 0;
      continue;
    }
    result += '\\'.repeat(slashes) + character;
    slashes = 0;
  }
  return result + '\\'.repeat(slashes * 2) + '"';
};

const windowsCommandLine = (args = []) => args.map(quoteWindowsArgument).join(' ');

const eventText = (event) => event?.text || event?.message || event?.item?.text || event?.item?.aggregated_output || event?.item?.output || event?.item?.command || event?.item?.content || event?.error?.message || '';

const sanitizeCodexDiagnostic = (value = '') => String(value)
  .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, '$1 [REDACTED]')
  .replace(/\b(?:sk|sess|key)-[A-Za-z0-9_-]{8,}\b/gi, '[REDACTED]')
  .replace(/((?:api[_-]?key|token|authorization)\s*[:=]\s*)[^\s,;]+/gi, '$1[REDACTED]')
  .trim()
  .slice(0, 4_000);

export const classifyCodexFailure = (run = {}, events = []) => {
  const rawDiagnostic = [
    run?.error?.message,
    ...events.map((event) => eventText(event)),
  ].filter(Boolean).join('\n');
  const diagnostic = sanitizeCodexDiagnostic(rawDiagnostic);

  if (/CodexSandboxOffline/i.test(rawDiagnostic)) {
    return {
      code: 'CODEX_USER_CONTEXT_UNAVAILABLE',
      phase: 'Codex 用户上下文不匹配',
      title: 'Operator Studio 未运行在你的 Windows 用户下',
      detail: '当前服务由受限自动化账户启动，无法读取你本机 Codex 的登录与 Provider 配置。请从正常 Windows 用户终端启动 Operator Studio；无需向本项目注入密钥。',
    };
  }
  if (/windows sandbox: helper_unknown_error: setup refresh had errors|SetNamedSecurityInfoW failed:\s*5/i.test(rawDiagnostic)) {
    return {
      code: 'CODEX_WINDOWS_SANDBOX_SETUP_FAILED',
      phase: 'Codex Windows 隔离环境异常',
      title: 'Codex Windows Sandbox 无法初始化',
      detail: 'Windows 拒绝了当前工作区的 Sandbox ACL 设置。Operator Studio 将使用 Codex 官方的 unelevated fallback；重启本地服务后重新运行。',
    };
  }

  if (/\b401\b|invalid[_ -]?api[_ -]?key|missing (?:bearer|basic).*authentication|unauthori[sz]ed|authentication (?:failed|required)|incorrect api key/i.test(rawDiagnostic)) {
    return {
      code: 'CODEX_AUTH_FAILED',
      phase: 'Codex 认证失败',
      title: '本机 Codex Provider 认证失败',
      detail: 'Codex CLI 已启动，但当前本机 Provider 拒绝认证。请在 Codex 或 Provider 管理工具中修复本机配置后重试。',
    };
  }
  if (/\b403\b|forbidden|permission denied|insufficient permissions?/i.test(rawDiagnostic)) {
    return {
      code: 'CODEX_ACCESS_DENIED',
      phase: 'Codex 访问被拒绝',
      title: '本机 Codex Provider 拒绝访问',
      detail: '当前 Provider 已收到请求，但账号或模型权限不足。请检查本机 Codex 的 Provider 与模型权限后重试。',
    };
  }
  if (/selected model is at capacity|\bat capacity\b|(?:provider|model|service).{0,32}(?:overloaded|capacity)|(?:overloaded|capacity).{0,32}(?:provider|model|service)/i.test(rawDiagnostic)) {
    return {
      code: 'CODEX_PROVIDER_CAPACITY',
      category: 'provider_capacity',
      retryable: true,
      phase: 'Codex Provider 容量暂不可用',
      title: '当前 Codex Provider 暂时满载',
      detail: 'Provider 明确返回容量暂不可用。先确认本次 Agent 资源已释放，再在剩余 Round 预算内进行有限恢复；不要把该次 attempt 当作候选生成失败。',
    };
  }
  if (/invalid peer certificate|unknownissuer|certificate (?:verify|validation|trust)|unable to verify (?:the )?first certificate|self[- ]signed certificate|CERT_(?:UNTRUSTED|AUTHORITY_INVALID|VERIFY_FAILED)/i.test(rawDiagnostic)) {
    return {
      code: 'CODEX_TLS_TRUST_FAILED',
      category: 'tls_trust',
      retryable: false,
      phase: 'Codex TLS 信任链失败',
      title: 'Codex Provider 证书不受信任',
      detail: 'Codex 连接路径返回证书信任错误。请修复代理/CA/中间证书并重新执行同运行栈预检；不要关闭证书校验或在相同配置下无限重试。',
    };
  }
  if (/\b429\b|rate.?limit|too many requests|quota/i.test(rawDiagnostic)) {
    return {
      code: 'CODEX_RATE_LIMITED',
      category: 'provider_rate_limit',
      retryable: true,
      phase: 'Codex 请求受限',
      title: '本机 Codex Provider 请求受限',
      detail: '当前 Provider 返回限流或配额错误。稍后重试，或在本机 Provider 管理工具中切换可用配置。',
    };
  }
  if (/ENOTFOUND|ECONN(?:RESET|REFUSED)|ETIMEDOUT|network|dns|websocket.*(?:failed|closed)|failed to connect|connection (?:failed|closed|refused)/i.test(rawDiagnostic)) {
    return {
      code: 'CODEX_NETWORK_FAILED',
      category: 'network',
      retryable: false,
      phase: 'Codex 网络失败',
      title: '本机 Codex 无法连接 Provider',
      detail: 'Codex CLI 无法连接当前 Provider。请检查本机网络、代理和 Provider 地址后重试。',
    };
  }
  if (/readonly database|read-only database|attempt to write|access is denied|拒绝访问|permission denied|failed to initialize in-process app-server/i.test(rawDiagnostic)) {
    return {
      code: 'CODEX_RUNTIME_PERMISSION_DENIED',
      phase: 'Codex 运行环境受限',
      title: '本机 Codex 状态目录不可写',
      detail: '当前启动 Operator Studio 的进程没有写入本机 Codex 状态目录的权限。请从您的 Windows 用户终端启动 Operator Studio，不要从隔离的 Agent/沙箱会话启动。',
    };
  }
  if (run?.error?.code === 'CODEX_SPAWN_FAILED') {
    return {
      code: 'CODEX_SPAWN_FAILED',
      phase: 'Codex 启动失败',
      title: '无法启动本机 Codex CLI',
      detail: '请确认 Codex CLI 已安装并可从当前用户环境的 PATH 直接运行。',
    };
  }

  const lastLine = diagnostic.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).at(-1);
  return {
    code: run?.error?.code || 'CODEX_EXEC_FAILED',
    phase: 'Codex 执行失败',
    title: 'Codex CLI 执行失败',
    detail: lastLine ? lastLine.slice(0, 320) : 'Codex CLI 未返回可识别的失败原因，请检查本机 Codex 运行日志。',
  };
};

export const createCodexClient = (options = {}) => {
  const platform = options.platform || process.platform;
  const configuredCommand = options.command || process.env.CODEX_COMMAND || 'codex';
  const invocation = resolveCliInvocation({ provider: 'codex', configuredCommand });
  const command = invocation.command;
  const commandArgs = (args) => [...invocation.prefixArgs, ...args];
  const injectedSpawn = typeof options.spawnImpl === 'function';
  const spawnImpl = options.spawnImpl || nodeSpawn;
  const spawnJobObjectImpl = options.spawnJobObjectProcessImpl || spawnJobObjectProcess;
  const execFileImpl = options.execFileImpl || nodeExecFile;
  const bridgeDir = options.bridgeDir || path.resolve(process.env.OPERATOR_BRIDGE_DIR || path.join(runtimeDir, 'agent-bridge'));
  const sandboxMode = options.sandboxMode || process.env.OPERATOR_CODEX_SANDBOX || 'workspace-write';
  const model = options.model || process.env.OPERATOR_CODEX_MODEL || process.env.CODEX_MODEL || null;
  // User/project Codex config can inject a very large instruction context into
  // every non-interactive run. Operator Studio already supplies its own
  // semantic/workspace contract and enforces the write boundary, so keep the
  // CLI context bounded by default. Set OPERATOR_CODEX_IGNORE_USER_CONFIG=0
  // when a local provider explicitly depends on Codex config.toml.
  const ignoreUserConfigValue = options.ignoreUserConfig ?? process.env.OPERATOR_CODEX_IGNORE_USER_CONFIG ?? '1';
  const ignoreUserConfig = ignoreUserConfigValue === true || /^(1|true|yes)$/i.test(String(ignoreUserConfigValue));
  // The MVP deliberately uses Codex's Windows unelevated fallback unless an
  // operator explicitly selects another sandbox mode. The repository still
  // confines writes to the Mission Workspace and owns process cleanup through
  // the runtime/Job Object boundary; requiring the optional Windows sandbox
  // setup helper would make ordinary local Agent runs fail closed when that
  // helper is absent from a portable Codex installation.
  const windowsSandbox = options.windowsSandbox ?? process.env.OPERATOR_CODEX_WINDOWS_SANDBOX
    ?? (platform === 'win32' ? 'unelevated' : null);
  // Real Windows Codex runs are contained by default. Tests and injected
  // transports keep their own deterministic child-process implementation.
  // A .cmd shim cannot be passed to CreateProcessW as an executable; the CLI
  // resolver normally replaces it with codex.exe or node.exe.
  const jobObjectRequested = enabledSetting(options.useJobObject ?? process.env.OPERATOR_CODEX_JOB_OBJECT, true);
  const jobObjectEligible = jobObjectSupported(platform) && !injectedSpawn && !/\.cmd$/i.test(command);
  const useWindowsJobObject = jobObjectRequested && jobObjectEligible;
  // Bounded liveness check for the Job helper, not a release deadline. It is
  // generous enough that machine load alone cannot expire it; expiry still
  // fails closed through the same quarantine path.
  const jobStartTimeoutMs = helperTimeoutSetting(
    options.jobStartTimeoutMs ?? process.env.OPERATOR_CODEX_JOB_START_TIMEOUT_MS,
    DEFAULT_JOB_HELPER_TIMEOUT_MS,
  );
  const runsDir = path.join(bridgeDir, 'codex-runs');
  const children = new Map();
  const userName = options.userName ?? process.env.USERNAME ?? process.env.USER ?? '';
  const userProfile = options.userProfile ?? process.env.USERPROFILE ?? '';
  const restrictedUserContext = /CodexSandboxOffline/i.test(`${userName} ${userProfile}`);
  const descriptorTtlMs = Number(options.descriptorTtlMs ?? 60_000);
  let descriptorCache = null;
  let descriptorCachedAt = 0;

  const runPath = (runId) => path.join(runsDir, `${runId}.json`);
  const eventsPath = (runId) => path.join(runsDir, `${runId}.jsonl`);

  const describe = async ({ refresh = false } = {}) => {
    if (!refresh && descriptorCache && Date.now() - descriptorCachedAt < descriptorTtlMs) return descriptorCache;
    let version;
    try {
      const result = await execFileAsync(execFileImpl, command, commandArgs(['--version']));
      version = (result.stdout || result.stderr).trim().split(/\r?\n/)[0] || null;
    } catch (error) {
      descriptorCache = { installed: false, loggedIn: false, version: null, error: error.message, userContext: { userName, restricted: restrictedUserContext } };
      descriptorCachedAt = Date.now();
      return descriptorCache;
    }
    let loggedIn = false;
    let loginOutput = '';
    try {
      const result = await execFileAsync(execFileImpl, command, commandArgs(['login', 'status']));
      loginOutput = `${result.stdout}\n${result.stderr}`.trim();
      loggedIn = !/not logged in|logged out|no credentials/i.test(loginOutput);
    } catch (error) {
      loginOutput = `${error.stdout || ''}\n${error.stderr || error.message}`.trim();
    }
    descriptorCache = { installed: true, loggedIn, version, loginOutput, userContext: { userName, restricted: restrictedUserContext } };
    descriptorCachedAt = Date.now();
    return descriptorCache;
  };

  const preflight = async ({ workspace }) => {
    const descriptor = await describe();
    if (!descriptor.installed) {
      return { ready: false, code: 'CODEX_NOT_INSTALLED', detail: '未检测到本机 Codex CLI。', workspace };
    }
    if (descriptor.userContext?.restricted) {
      return { ready: false, code: 'CODEX_USER_CONTEXT_UNAVAILABLE', detail: 'Operator Studio 未运行在当前 Windows 用户上下文中。', workspace };
    }
    try {
      const workspaceStat = await stat(workspace);
      if (!workspaceStat.isDirectory()) throw new Error('workspace is not a directory');
    } catch (cause) {
      return { ready: false, code: 'CODEX_WORKSPACE_UNAVAILABLE', detail: cause.message, workspace };
    }
    return {
      ready: true,
      code: 'CODEX_READY',
      workspace,
      command,
      version: descriptor.version,
      configurationAuthority: 'local-codex',
      sandbox: sandboxMode,
      windowsSandbox: platform === 'win32' ? (windowsSandbox || 'codex-config') : null,
      processSupervisor: useWindowsJobObject ? 'windows-job-object' : 'child-process',
      processSupervisorReason: platform === 'win32' && jobObjectRequested && !jobObjectEligible
        ? 'native-executable-unavailable'
        : null,
    };
  };

  const writes = new Map();
  const instanceId = randomUUID();
  // Codex may leave a short-lived PowerShell/tool descendant behind after a
  // completed turn. A one-second force window classified valid candidates as
  // unconfirmed before that descendant exited, so keep cleanup bounded but
  // long enough to observe the normal Windows process-tree drain.
  const graceMs = Math.max(10, Number(options.cancelGraceMs) || 2_000);
  const forceMs = Math.max(10, Number(options.cancelForceMs) || 5_000);
  // Give a completed turn a short drain window before cancellation. Native
  // Windows Codex may close its process before inherited stdout handles drain;
  // callers can tune this bounded window without changing cancellation safety.
  const logicalCleanupMs = Math.max(10, Number(options.logicalCleanupMs ?? process.env.OPERATOR_CODEX_LOGICAL_CLEANUP_MS) || 15_000);
  const saveRun = (record) => {
    const snapshot = structuredClone(record);
    const previous = writes.get(record.runId) || Promise.resolve();
    const pending = previous.catch(() => {}).then(async () => {
      const temporary = runPath(record.runId) + '.' + randomUUID() + '.tmp';
      try {
        await writeFile(temporary, JSON.stringify(snapshot, null, 2) + '\n', 'utf8');
        await rename(temporary, runPath(record.runId));
      } finally { await rm(temporary, { force: true }).catch(() => {}); }
    });
    writes.set(record.runId, pending);
    pending.finally(() => { if (writes.get(record.runId) === pending) writes.delete(record.runId); }).catch(() => {});
    return pending;
  };
  const waitForClose = (execution, timeoutMs) => execution.closed ? Promise.resolve(true) : new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), timeoutMs);
    execution.closedPromise.then(() => { clearTimeout(timer); resolve(true); });
  });
  const terminateTree = options.terminateProcessTree || (async ({ child, force, execution }) => {
    // The ChildProcess close receipt ends our authority to signal its PID.
    // A later force pass must never act on a possibly reused numeric PID.
    if (execution?.jobSupervisor) {
      if (execution.closed) return execution.jobReceipt?.release === 'confirmed';
      try {
        await execution.jobSupervisor.terminate({ timeoutMs: force ? forceMs : graceMs });
        // TerminateJobObject is only a request.  `treeSignalled` remains false
        // until the supervisor receipt proves that all Job members exited.
        return true;
      } catch (error) {
        // A target may have naturally exited while the helper is still
        // draining its files. Treat an already-closed Job as a wait condition;
        // any other failure remains fail-closed.
        if (/OpenJobObject|not found|不存在|invalid handle/i.test(String(error?.message || '')) && !execution.closed) return true;
        throw Object.assign(new Error('Codex Job Object termination was requested, but release could not be verified.'), {
          code: error?.code || 'CODEX_PROCESS_TREE_UNVERIFIED', cause: error,
        });
      }
    }
    if (!child?.pid || execution?.closed) return false;
    if (platform === 'win32') {
      const pid = Number(child.pid);
      try {
        await execFileAsync(execFileImpl, 'taskkill.exe', ['/pid', String(pid), '/t', ...(force ? ['/f'] : [])],
          { windowsHide: true, timeout: forceMs });
        return true;
      } catch (error) {
        // A live ChildProcess handle permits a best-effort stop of this parent
        // only. It proves nothing about descendants: never upgrade this to a
        // successful tree signal or invoke a new command using its bare PID.
        // If the process closed during taskkill, even this handle is no longer
        // used. Unknown descendants keep the workspace quarantined.
        if (!execution?.closed && typeof child.kill === 'function') {
          try { child.kill('SIGKILL'); } catch {}
        }
        throw Object.assign(new Error('Codex parent termination was requested, but Windows process-tree release could not be verified.'), {
          code: 'CODEX_PROCESS_TREE_UNVERIFIED', cause: error,
        });
      }
    }
    try { process.kill(-child.pid, force ? 'SIGKILL' : 'SIGTERM'); }
    catch (error) { if (error.code !== 'ESRCH') throw error; }
    return true;
  });
  const groupReleased = (execution) => {
    if (execution?.jobSupervisor) return execution.jobReceipt?.release === 'confirmed'
      && execution.jobReceipt?.releaseProof?.confirmed !== false;
    if (platform === 'win32' || options.terminateProcessTree) return execution.treeSignalled;
    try { process.kill(-execution.child.pid, 0); return false; }
    catch (error) { return error.code === 'ESRCH'; }
  };
  const settleClosed = async (execution, events = []) => {
    const { record } = execution;
    if (!execution.closed) return false;
    if (record.cancelRequested && !groupReleased(execution)) return false;
    if (execution.jobSupervisor && !groupReleased(execution)) {
      record.resourceRelease = {
        ...(record.resourceRelease || {}), confirmed: false, status: 'unconfirmed',
        code: execution.jobError?.code || 'CODEX_JOB_RELEASE_UNCONFIRMED',
        reason: sanitizeCodexDiagnostic(execution.jobError?.message) || 'Windows Job Object did not provide a complete release proof.',
        nextAction: 'Inspect the Job receipt and quarantine the workspace before any recovery attempt.',
      };
      await saveRun(record);
      return false;
    }
    record.resourceRelease = {
      ...(record.resourceRelease || {}), confirmed: true, status: 'confirmed',
      reason: execution.jobSupervisor ? 'Agent Job Object exited and active-process query confirmed release.' : 'Agent process exited and cancellation cleanup is confirmed.',
      confirmedAt: new Date().toISOString(),
      ...(execution.jobReceipt?.releaseProof ? { releaseProof: execution.jobReceipt.releaseProof } : {}),
    };
    record.process = { ...record.process, exitedAt: new Date().toISOString(), exitCode: execution.exitCode, signal: execution.exitSignal };
    record.status = record.logicalCompleted ? 'completed' : record.cancelRequested ? 'cancelled' : execution.exitCode === 0 ? 'completed' : 'failed';
    record.completedAt ||= new Date().toISOString();
    record.error = record.status === 'failed'
      ? record.error || { code: 'CODEX_EXIT_' + (execution.exitCode ?? execution.exitSignal), message: sanitizeCodexDiagnostic(execution.stderr) || 'Codex exited without a successful result.' }
      : null;
    const turnCompleted = events.some((event) => event?.type === 'turn.completed');
    const failureEvent = events.some((event) => {
      const type = String(event?.type || '').toLowerCase();
      const text = eventText(event);
      return type === 'turn.failed' || type === 'response.failed'
        || (type === 'error' && /provider|transport|connection|certificate|unknownissuer|capacity|rate.?limit|quota|network|dns|timeout/i.test(text));
    });
    if (record.status === 'failed' || (!turnCompleted && failureEvent) || record.resourceRelease?.code === 'CODEX_CANCEL_UNCONFIRMED') {
      const classified = classifyCodexFailure(record, events);
      record.primaryFailure = {
        code: classified.code,
        category: classified.category || null,
        retryable: classified.retryable ?? null,
        title: classified.title,
        detail: classified.detail,
        phase: classified.phase,
      };
    }
    await saveRun(record);
    children.delete(record.runId);
    return true;
  };
  const readRun = async (runId) => {
    await writes.get(runId);
    const record = JSON.parse(await readFile(runPath(runId), 'utf8'));
    // A new adapter cannot safely signal a stale/reused PID. Preserve uncertainty;
    // an owner-aware recovery operation must establish release before resuming.
    if (!children.has(runId) && !['completed', 'failed', 'cancelled'].includes(record.status)) {
      return { ...record, status: 'cancel_requested', resourceRelease: {
        confirmed: false, status: 'unconfirmed', reason: 'The Agent execution owner is unavailable; process-tree release cannot be verified.',
        code: 'CODEX_EXECUTION_OWNER_UNAVAILABLE', deadline: record.resourceRelease?.deadline || new Date().toISOString(),
        nextAction: 'Inspect the recorded owner and process; confirm termination before resuming this workspace.',
      } };
    }
    return record;
  };
  const cancel = async (runId, { reason = 'user' } = {}) => {
    const execution = children.get(runId);
    if (!execution) {
      const record = await readRun(runId);
      if (!['completed', 'failed', 'cancelled'].includes(record.status)) {
        record.cancelRequested = true;
        await saveRun(record);
      }
      return record;
    }
    if (execution.cancelling) return execution.cancelling;
    execution.cancelling = (async () => {
      const { record } = execution;
      record.cancelRequested = true;
      record.cancelReason = reason;
      record.status = 'cancel_requested';
      record.resourceRelease = { confirmed: false, status: 'pending', reason: 'Cancelling the Agent process tree.',
        requestedAt: new Date().toISOString(), deadline: new Date(Date.now() + graceMs + forceMs * 3).toISOString(),
        nextAction: 'Await process exit; force termination follows the grace period.' };
      await saveRun(record);
      let failure = null;
      try { execution.treeSignalled = (await terminateTree({ child: execution.child, force: false, execution })) !== false; }
      catch (error) { failure = error; }
      if (await waitForClose(execution, graceMs) && await settleClosed(execution)) return readRun(runId);
      try { execution.treeSignalled = (await terminateTree({ child: execution.child, force: true, execution })) !== false; }
      catch (error) { failure = error; }
      if (await waitForClose(execution, forceMs) && await settleClosed(execution)) return readRun(runId);
      record.resourceRelease = { ...record.resourceRelease, status: 'unconfirmed',
        code: failure?.code || 'CODEX_CANCEL_UNCONFIRMED',
        reason: sanitizeCodexDiagnostic(failure?.message) || 'The Agent process tree did not confirm exit before its cancellation deadline.',
        nextAction: 'Inspect or retry cancellation. The workspace remains blocked; no new Agent or candidate action is permitted.' };
      await saveRun(record);
      return readRun(runId);
    })().finally(() => { execution.cancelling = null; });
    return execution.cancelling;
  };

  const start = async ({ runId = `codex_${randomUUID().replaceAll('-', '').slice(0, 16).toUpperCase()}`, missionId, goal, workspace, additionalDirectories = [], resumeThreadId = null, sandboxMode: runSandboxMode = null, skipGitRepoCheck = false, environment = {} }) => {
    await mkdir(runsDir, { recursive: true });
    const writableDirectories = [...new Set((additionalDirectories || []).filter(Boolean).map((directory) => path.resolve(directory)))];
    const effectiveSandbox = runSandboxMode || sandboxMode;
    const boundaryEnabled = Boolean(environment.OPERATOR_AGENT_ROOTS);
    // The MVP relies on Codex's workspace sandbox plus the post-run Mission
    // Workspace diff audit. Do not remove the structured edit/apply tools just
    // because the workflow boundary is enabled: doing so leaves only the
    // limited node_repl surface and can strand a real run after its first read.
    // Operators may still opt into the stricter tool surface explicitly.
    const disableShellTool = String(environment.OPERATOR_CODEX_DISABLE_SHELL_TOOL ?? process.env.OPERATOR_CODEX_DISABLE_SHELL_TOOL ?? '').toLowerCase() === '1'
      || String(environment.OPERATOR_CODEX_DISABLE_SHELL_TOOL ?? process.env.OPERATOR_CODEX_DISABLE_SHELL_TOOL ?? '').toLowerCase() === 'true';
    const record = { schemaVersion: 2, runId, missionId, workspace: workspace || process.cwd(), additionalDirectories: writableDirectories, threadId: resumeThreadId, status: 'running', startedAt: new Date().toISOString(), completedAt: null, eventPath: eventsPath(runId), sandbox: effectiveSandbox, boundary: boundaryEnabled ? { role: environment.OPERATOR_AGENT_ROLE || 'stage', roots: JSON.parse(environment.OPERATOR_AGENT_ROOTS), enforcement: 'workspace-sandbox-and-workflow-diff' } : null, skipGitRepoCheck: Boolean(skipGitRepoCheck), error: null,
      process: { pid: null, ownerPid: process.pid, instanceId },
      // This is a diagnostic projection only.  It records each boundary that
      // the adapter can observe and is intentionally not used to infer a
      // provider terminal state or to weaken fail-closed cleanup.
      observability: emptyStreamObservability(),
      resourceRelease: { confirmed: false, status: 'active', reason: 'Agent execution is active.' } };
    await saveRun(record);
    const sandboxArgs = platform === 'win32' && windowsSandbox ? ['-c', `windows.sandbox="${windowsSandbox}"`] : [];
    const gitRepoArgs = skipGitRepoCheck ? ['--skip-git-repo-check'] : [];
    // unified_exec is needed for apply_patch; the workspace sandbox confines it.
    const toolRestrictionArgs = boundaryEnabled && disableShellTool ? ['--disable', 'shell_tool'] : [];
    const modelArgs = model ? ['--model', model] : [];
    const configArgs = ignoreUserConfig ? ['--ignore-user-config'] : [];
    const args = resumeThreadId
      ? ['exec', ...configArgs, ...modelArgs, 'resume', ...gitRepoArgs, ...toolRestrictionArgs, '--json', '--sandbox', effectiveSandbox, ...sandboxArgs, resumeThreadId, '-']
      : ['exec', ...configArgs, ...modelArgs, ...gitRepoArgs, ...toolRestrictionArgs, '--json', '--sandbox', effectiveSandbox, ...sandboxArgs, '--cd', record.workspace, ...writableDirectories.flatMap((directory) => ['--add-dir', directory]), '-'];
    const scopedEnvironment = await createScopedGitEnvironment(record.workspace, process.env, { configDir: path.join(bridgeDir, 'git-trust') });
    const runEnvironment = { ...scopedEnvironment, ...environment };
    const runJobObject = useWindowsJobObject
      && enabledSetting(environment.OPERATOR_CODEX_JOB_OBJECT, true);
    let child = null;
    let jobSupervisor = null;
    let resolveClosed;
    const execution = { child: null, record, closed: false, closedPromise: new Promise(resolve => { resolveClosed = resolve; }),
      treeSignalled: false, stderr: '', cancelling: null, exitCode: null, exitSignal: null,
      jobSupervisor: null, jobReceipt: null, jobError: null };
    children.set(runId, execution);
    let eventBuffer = '';
    let terminalCleanupTimer = null;
    let appendChain = Promise.resolve();

    const consumeEventText = (text) => {
      if (!text) return;
      eventBuffer += text;
      const lines = eventBuffer.split(/\r?\n/);
      eventBuffer = lines.pop() || '';
      for (const line of lines) {
        let event;
        try { event = JSON.parse(line); }
        catch { record.observability.parseErrorCount += 1; continue; }
        const eventAt = new Date().toISOString();
        record.observability.parsedEventCount += 1;
        record.observability.firstEventAt ||= eventAt;
        record.observability.lastEventAt = eventAt;
        if (event?.type === 'turn.completed' || event?.type === 'turn.failed' || event?.type === 'response.failed') {
          record.observability.terminalEventType = event.type;
        }
        if (event.thread_id || event.threadId || event.thread?.id) record.threadId ||= event.thread_id || event.threadId || event.thread.id;
        if (event.type !== 'turn.completed' || record.logicalCompleted) continue;
        record.logicalCompleted = true;
        appendChain = appendChain.then(() => saveRun(record)).catch(() => {});
        // Logical completion is not release. Only close/cleanup publishes terminal status.
        terminalCleanupTimer = setTimeout(() => { void cancel(runId, { reason: 'turn_completed' }).catch(() => {}); }, logicalCleanupMs);
        terminalCleanupTimer.unref?.();
      }
    };
    const consumeStdout = (chunk) => {
      const text = chunk?.toString?.() ?? String(chunk || '');
      markStreamActivity(record.observability, 'stdout', Buffer.byteLength(text, 'utf8'));
      appendChain = appendChain.then(() => appendFile(eventsPath(runId), text, 'utf8')).catch(() => {});
      consumeEventText(text);
    };
    const consumeStderr = (chunk) => {
      const text = chunk?.toString?.() ?? String(chunk || '');
      markStreamActivity(record.observability, 'stderr', Buffer.byteLength(text, 'utf8'));
      execution.stderr = (execution.stderr + text).slice(-4_000);
    };
    const finishClosed = async () => {
      const rawEvents = await readFile(eventsPath(runId), 'utf8').catch(() => '');
      const events = parseLines(rawEvents);
      // A final JSON line may arrive without a trailing newline. Re-read the
      // durable log at close so the projection does not claim fewer events
      // than the persisted evidence contains.
      record.observability.parsedEventCount = Math.max(record.observability.parsedEventCount || 0, events.length);
      record.observability.lastEventAt ||= events.length ? new Date().toISOString() : null;
      record.logicalCompleted ||= hasCompletedTurn(events);
      await settleClosed(execution, events);
    };
    const attachChild = (target) => {
      target.stderr?.on('data', consumeStderr);
      target.stdout?.on('data', consumeStdout);
      target.once('error', error => {
        record.error ||= { code: error.code || 'CODEX_SPAWN_FAILED', message: sanitizeCodexDiagnostic(error.message) };
        if (!target.pid) execution.treeSignalled = true;
        void saveRun(record).catch(() => {});
      });
      target.once('close', (code, signal) => {
        execution.closed = true; execution.exitCode = code; execution.exitSignal = signal;
        if (terminalCleanupTimer) clearTimeout(terminalCleanupTimer);
        resolveClosed();
        void appendChain.then(finishClosed).catch(() => {});
      });
    };

    try {
      if (runJobObject) {
        const safeRunId = String(runId).replace(/[^a-zA-Z0-9_.-]/g, '_');
        const jobDir = path.join(runsDir, `${safeRunId}.job`);
        await mkdir(jobDir, { recursive: true });
        const stdinPath = path.join(jobDir, 'stdin.txt');
        const stdoutPath = path.join(jobDir, 'stdout.log');
        const stderrPath = path.join(jobDir, 'stderr.log');
        const readyPath = path.join(jobDir, 'ready.json');
        const receiptPath = path.join(jobDir, 'receipt.json');
        await writeFile(stdinPath, `${goal || ''}\n`, 'utf8');
        jobSupervisor = await spawnJobObjectImpl({
          filePath: command,
          arguments: windowsCommandLine(commandArgs(args)),
          cwd: record.workspace,
          stdinPath, stdoutPath, stderrPath, readyPath, receiptPath,
          jobName: createJobName(runId),
          tempRoot: bridgeDir,
          env: runEnvironment,
          startTimeoutMs: jobStartTimeoutMs,
          onStdout: consumeStdout,
          onStderr: consumeStderr,
        });
        child = jobSupervisor.helper;
        execution.child = child;
        execution.jobSupervisor = jobSupervisor;
        record.observability.transport = 'windows-job-object-file-tail';
        record.process = { ...record.process, supervisorPid: jobSupervisor.helperPid, jobName: jobSupervisor.jobName, jobObject: true,
          stdoutPath, stderrPath, readyPath, receiptPath };
        // The helper owns the target. Its result, rather than the helper's
        // close event, is the release authority and includes active-process
        // query evidence.
        jobSupervisor.result.then(async receipt => {
          execution.jobReceipt = receipt;
          execution.treeSignalled = receipt.release === 'confirmed' && receipt.releaseProof?.confirmed !== false;
          execution.closed = true;
          execution.exitCode = receipt.exitCode;
          execution.exitSignal = null;
          record.process.pid = receipt.pid || record.process.pid;
          resolveClosed();
          await appendChain.then(finishClosed);
        }).catch(async error => {
          execution.jobError = error;
          execution.closed = true;
          execution.exitCode = null;
          record.error ||= { code: error.code || 'CODEX_JOB_RELEASE_UNCONFIRMED', message: sanitizeCodexDiagnostic(error.message || execution.stderr) };
          record.resourceRelease = { ...(record.resourceRelease || {}), confirmed: false, status: 'unconfirmed',
            code: error.code || 'CODEX_JOB_RELEASE_UNCONFIRMED', reason: sanitizeCodexDiagnostic(error.message),
            nextAction: 'Inspect the Job receipt and quarantine the workspace before recovery.' };
          record.cancelRequested = true;
          record.status = 'cancel_requested';
          resolveClosed();
          children.delete(runId);
          const events = parseLines(await readFile(eventsPath(runId), 'utf8').catch(() => ''));
          const classified = classifyCodexFailure(record, events);
          record.primaryFailure = {
            code: classified.code,
            category: classified.category || null,
            retryable: classified.retryable ?? null,
            title: classified.title,
            detail: classified.detail,
            phase: classified.phase,
          };
          await saveRun(record);
        }).finally(() => { void rm(stdinPath, { force: true }).catch(() => {}); });
        const started = await jobSupervisor.started;
        record.process.pid = started.pid;
        record.process.startedAt = started.startedAt || new Date().toISOString();
        await saveRun(record);
      } else {
        child = spawnImpl(command, commandArgs(args), { cwd: record.workspace, stdio: ['pipe', 'pipe', 'pipe'],
          detached: platform !== 'win32', windowsHide: true, env: runEnvironment });
        execution.child = child;
        record.process.pid = child.pid || null;
        attachChild(child);
        await saveRun(record);
        child.stdin?.on('error', error => { record.error ||= { code: error.code || 'CODEX_STDIN_FAILED', message: sanitizeCodexDiagnostic(error.message) }; });
        child.stdin?.end(`${goal || ''}\n`);
      }
    } catch (error) {
      // A native spawn failure proves no managed target only when the legacy
      // child was never created. Job startup failures remain unconfirmed and
      // therefore keep the workspace fail-closed.
      if (!child && !jobSupervisor) {
        children.delete(runId);
        record.status = 'failed';
        record.error = { code: error.code || 'CODEX_SPAWN_FAILED', message: sanitizeCodexDiagnostic(error.message) };
        record.resourceRelease = { confirmed: true, status: 'confirmed', reason: 'No Agent process was created.' };
        record.completedAt = new Date().toISOString();
      } else {
        record.error ||= { code: error.code || 'CODEX_JOB_START_FAILED', message: sanitizeCodexDiagnostic(error.message) };
        record.resourceRelease = { ...(record.resourceRelease || {}), confirmed: false, status: 'unconfirmed',
          code: error.code || 'CODEX_JOB_START_FAILED', reason: sanitizeCodexDiagnostic(error.message),
          nextAction: 'Inspect supervisor state; no recovery attempt is permitted until release is confirmed.' };
      }
      await saveRun(record);
      throw error;
    }
    return { ...record, pid: record.process.pid || child?.pid || null };
  };
  const readEvents = async (runId) => parseLines(await readFile(eventsPath(runId), 'utf8').catch(() => ''));
  return { command, sandboxMode, windowsSandbox, describe, preflight, start, readRun, readEvents, cancel, eventText };
};

export const codexClient = createCodexClient();
