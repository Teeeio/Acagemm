import { execFile as nodeExecFile, spawn as nodeSpawn } from 'node:child_process';
import { mkdir, appendFile, readFile, stat, writeFile, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { runtimeDir } from './storage-paths.mjs';
import { createScopedGitEnvironment } from './git-environment.mjs';
import { resolveCliInvocation } from './cli-command.mjs';

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
  if (/\b429\b|rate.?limit|too many requests|quota/i.test(rawDiagnostic)) {
    return {
      code: 'CODEX_RATE_LIMITED',
      phase: 'Codex 请求受限',
      title: '本机 Codex Provider 请求受限',
      detail: '当前 Provider 返回限流或配额错误。稍后重试，或在本机 Provider 管理工具中切换可用配置。',
    };
  }
  if (/ENOTFOUND|ECONN(?:RESET|REFUSED)|ETIMEDOUT|network|dns|websocket.*(?:failed|closed)|failed to connect|connection (?:failed|closed|refused)/i.test(rawDiagnostic)) {
    return {
      code: 'CODEX_NETWORK_FAILED',
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
  const configuredCommand = options.command || process.env.CODEX_COMMAND || 'codex';
  const invocation = resolveCliInvocation({ provider: 'codex', configuredCommand });
  const command = invocation.command;
  const commandArgs = (args) => [...invocation.prefixArgs, ...args];
  const spawnImpl = options.spawnImpl || nodeSpawn;
  const execFileImpl = options.execFileImpl || nodeExecFile;
  const bridgeDir = options.bridgeDir || path.resolve(process.env.OPERATOR_BRIDGE_DIR || path.join(runtimeDir, 'agent-bridge'));
  const sandboxMode = options.sandboxMode || process.env.OPERATOR_CODEX_SANDBOX || 'workspace-write';
  const model = options.model || process.env.OPERATOR_CODEX_MODEL || process.env.CODEX_MODEL || null;
  // The MVP deliberately uses Codex's Windows unelevated fallback unless an
  // operator explicitly selects another sandbox mode. The repository still
  // confines writes to the Mission Workspace and owns process cleanup through
  // the runtime/Job Object boundary; requiring the optional Windows sandbox
  // setup helper would make ordinary local Agent runs fail closed when that
  // helper is absent from a portable Codex installation.
  const windowsSandbox = options.windowsSandbox ?? process.env.OPERATOR_CODEX_WINDOWS_SANDBOX
    ?? (process.platform === 'win32' ? 'unelevated' : null);
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
      windowsSandbox: process.platform === 'win32' ? (windowsSandbox || 'codex-config') : null,
    };
  };

  const writes = new Map();
  const instanceId = randomUUID();
  const graceMs = Math.max(10, Number(options.cancelGraceMs) || 1_000);
  const forceMs = Math.max(10, Number(options.cancelForceMs) || 1_000);
  // Give a completed turn a short drain window before cancellation. Native
  // Windows Codex may close its process before inherited stdout handles drain;
  // callers can tune this bounded window without changing cancellation safety.
  const logicalCleanupMs = Math.max(10, Number(options.logicalCleanupMs ?? process.env.OPERATOR_CODEX_LOGICAL_CLEANUP_MS) || 1_500);
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
    if (!child?.pid || execution?.closed) return false;
    if (process.platform === 'win32') {
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
    if (process.platform === 'win32' || options.terminateProcessTree) return execution.treeSignalled;
    try { process.kill(-execution.child.pid, 0); return false; }
    catch (error) { return error.code === 'ESRCH'; }
  };
  const settleClosed = async (execution) => {
    const { record } = execution;
    if (!execution.closed) return false;
    if (record.cancelRequested && !groupReleased(execution)) return false;
    record.resourceRelease = { confirmed: true, status: 'confirmed', reason: 'Agent process exited and cancellation cleanup is confirmed.', confirmedAt: new Date().toISOString() };
    record.process = { ...record.process, exitedAt: new Date().toISOString(), exitCode: execution.exitCode, signal: execution.exitSignal };
    record.status = record.logicalCompleted ? 'completed' : record.cancelRequested ? 'cancelled' : execution.exitCode === 0 ? 'completed' : 'failed';
    record.completedAt ||= new Date().toISOString();
    record.error = record.status === 'failed'
      ? record.error || { code: 'CODEX_EXIT_' + (execution.exitCode ?? execution.exitSignal), message: sanitizeCodexDiagnostic(execution.stderr) || 'Codex exited without a successful result.' }
      : null;
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
    const record = { schemaVersion: 2, runId, missionId, workspace: workspace || process.cwd(), additionalDirectories: writableDirectories, threadId: resumeThreadId, status: 'running', startedAt: new Date().toISOString(), completedAt: null, eventPath: eventsPath(runId), sandbox: effectiveSandbox, boundary: boundaryEnabled ? { role: environment.OPERATOR_AGENT_ROLE || 'stage', roots: JSON.parse(environment.OPERATOR_AGENT_ROOTS), enforcement: 'workspace-sandbox-and-workflow-diff' } : null, skipGitRepoCheck: Boolean(skipGitRepoCheck), error: null,
      process: { pid: null, ownerPid: process.pid, instanceId }, resourceRelease: { confirmed: false, status: 'active', reason: 'Agent execution is active.' } };
    await saveRun(record);
    const sandboxArgs = process.platform === 'win32' && windowsSandbox ? ['-c', `windows.sandbox="${windowsSandbox}"`] : [];
    const gitRepoArgs = skipGitRepoCheck ? ['--skip-git-repo-check'] : [];
    // unified_exec is needed for apply_patch; the workspace sandbox confines it.
    const toolRestrictionArgs = boundaryEnabled ? ['--disable', 'shell_tool'] : [];
    const modelArgs = model ? ['--model', model] : [];
    const args = resumeThreadId
      ? ['exec', ...modelArgs, 'resume', ...gitRepoArgs, ...toolRestrictionArgs, '--json', '--sandbox', effectiveSandbox, ...sandboxArgs, resumeThreadId, '-']
      : ['exec', ...modelArgs, ...gitRepoArgs, ...toolRestrictionArgs, '--json', '--sandbox', effectiveSandbox, ...sandboxArgs, '--cd', record.workspace, ...writableDirectories.flatMap((directory) => ['--add-dir', directory]), '-'];
    const scopedEnvironment = await createScopedGitEnvironment(record.workspace, process.env, { configDir: path.join(bridgeDir, 'git-trust') });
    let child;
    try {
      child = spawnImpl(command, commandArgs(args), { cwd: record.workspace, stdio: ['pipe', 'pipe', 'pipe'],
        detached: process.platform !== 'win32', windowsHide: true, env: { ...scopedEnvironment, ...environment } });
    } catch (error) {
      record.status = 'failed'; record.error = { code: error.code || 'CODEX_SPAWN_FAILED', message: sanitizeCodexDiagnostic(error.message) };
      record.resourceRelease = { confirmed: true, status: 'confirmed', reason: 'No Agent process was created.' };
      record.completedAt = new Date().toISOString();
      await saveRun(record);
      throw error;
    }
    let resolveClosed;
    const execution = { child, record, closed: false, closedPromise: new Promise(resolve => { resolveClosed = resolve; }),
      treeSignalled: false, stderr: '', cancelling: null, exitCode: null, exitSignal: null };
    children.set(runId, execution);
    record.process.pid = child.pid || null;
    let eventBuffer = '';
    let terminalCleanupTimer = null;
    let appendChain = Promise.resolve();
    child.stderr?.on('data', chunk => { execution.stderr = (execution.stderr + chunk.toString()).slice(-4_000); });
    child.stdout?.on('data', chunk => {
      const text = chunk.toString();
      appendChain = appendChain.then(() => appendFile(eventsPath(runId), text, 'utf8')).catch(() => {});
      eventBuffer += text;
      const lines = eventBuffer.split(/\r?\n/);
      eventBuffer = lines.pop() || '';
      for (const line of lines) {
        let event; try { event = JSON.parse(line); } catch { continue; }
        if (event.thread_id || event.threadId || event.thread?.id) record.threadId ||= event.thread_id || event.threadId || event.thread.id;
        if (event.type !== 'turn.completed' || record.logicalCompleted) continue;
        record.logicalCompleted = true;
        appendChain = appendChain.then(() => saveRun(record)).catch(() => {});
        // Logical completion is not release. Only close/cleanup publishes terminal status.
        terminalCleanupTimer = setTimeout(() => { void cancel(runId, { reason: 'turn_completed' }).catch(() => {}); }, logicalCleanupMs);
        terminalCleanupTimer.unref?.();
      }
    });
    child.once('error', error => {
      record.error = { code: error.code || 'CODEX_SPAWN_FAILED', message: sanitizeCodexDiagnostic(error.message) };
      if (!child.pid) execution.treeSignalled = true;
      void saveRun(record).catch(() => {});
    });
    child.once('close', (code, signal) => {
      execution.closed = true; execution.exitCode = code; execution.exitSignal = signal;
      if (terminalCleanupTimer) clearTimeout(terminalCleanupTimer);
      resolveClosed();
      void appendChain.then(async () => {
        const events = parseLines(await readFile(eventsPath(runId), 'utf8').catch(() => ''));
        record.logicalCompleted ||= hasCompletedTurn(events);
        await settleClosed(execution);
      }).catch(() => {});
    });
    await saveRun(record);
    child.stdin?.on('error', error => { record.error ||= { code: error.code || 'CODEX_STDIN_FAILED', message: sanitizeCodexDiagnostic(error.message) }; });
    child.stdin?.end(`${goal || ''}\n`);
    return { ...record, pid: child.pid || null };
  };
  const readEvents = async (runId) => parseLines(await readFile(eventsPath(runId), 'utf8').catch(() => ''));
  return { command, sandboxMode, windowsSandbox, describe, preflight, start, readRun, readEvents, cancel, eventText };
};

export const codexClient = createCodexClient();
