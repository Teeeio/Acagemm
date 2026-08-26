import { execFile as nodeExecFile, spawn as nodeSpawn } from 'node:child_process';
import { mkdir, appendFile, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { runtimeDir } from './storage-paths.mjs';
import { createScopedGitEnvironment } from './git-environment.mjs';

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
  const command = process.platform === 'win32' && configuredCommand === 'codex' ? 'codex.cmd' : configuredCommand;
  const spawnImpl = options.spawnImpl || nodeSpawn;
  const execFileImpl = options.execFileImpl || nodeExecFile;
  const bridgeDir = options.bridgeDir || path.resolve(process.env.OPERATOR_BRIDGE_DIR || path.join(runtimeDir, 'agent-bridge'));
  const sandboxMode = options.sandboxMode || process.env.OPERATOR_CODEX_SANDBOX || 'workspace-write';
  const windowsSandbox = options.windowsSandbox || process.env.OPERATOR_CODEX_WINDOWS_SANDBOX || 'unelevated';
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
      const result = await execFileAsync(execFileImpl, command, ['--version']);
      version = (result.stdout || result.stderr).trim().split(/\r?\n/)[0] || null;
    } catch (error) {
      descriptorCache = { installed: false, loggedIn: false, version: null, error: error.message, userContext: { userName, restricted: restrictedUserContext } };
      descriptorCachedAt = Date.now();
      return descriptorCache;
    }
    let loggedIn = false;
    let loginOutput = '';
    try {
      const result = await execFileAsync(execFileImpl, command, ['login', 'status']);
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
      windowsSandbox: process.platform === 'win32' ? windowsSandbox : null,
    };
  };

  const start = async ({ runId = `codex_${randomUUID().replaceAll('-', '').slice(0, 16).toUpperCase()}`, missionId, goal, workspace, additionalDirectories = [], resumeThreadId = null, sandboxMode: runSandboxMode = null, skipGitRepoCheck = false, environment = {} }) => {
    await mkdir(runsDir, { recursive: true });
    const writableDirectories = [...new Set((additionalDirectories || []).filter(Boolean).map((directory) => path.resolve(directory)))];
    const effectiveSandbox = runSandboxMode || sandboxMode;
    const boundaryEnabled = Boolean(environment.OPERATOR_AGENT_ROOTS);
    const record = { schemaVersion: 1, runId, missionId, workspace: workspace || process.cwd(), additionalDirectories: writableDirectories, threadId: resumeThreadId, status: 'running', startedAt: new Date().toISOString(), completedAt: null, eventPath: eventsPath(runId), sandbox: effectiveSandbox, boundary: boundaryEnabled ? { role: environment.OPERATOR_AGENT_ROLE || 'stage', roots: JSON.parse(environment.OPERATOR_AGENT_ROOTS), enforcement: 'local-shell-disabled' } : null, skipGitRepoCheck: Boolean(skipGitRepoCheck), error: null };
    await writeFile(runPath(runId), `${JSON.stringify(record, null, 2)}\n`, 'utf8');
    const sandboxArgs = process.platform === 'win32' && windowsSandbox
      ? ['-c', `windows.sandbox="${windowsSandbox}"`]
      : [];
    const gitRepoArgs = skipGitRepoCheck ? ['--skip-git-repo-check'] : [];
    const toolRestrictionArgs = boundaryEnabled ? ['--disable', 'shell_tool', '--disable', 'unified_exec'] : [];
    const args = resumeThreadId
      ? ['exec', 'resume', ...gitRepoArgs, ...toolRestrictionArgs, '--json', '--sandbox', effectiveSandbox, ...sandboxArgs, resumeThreadId, '-']
      : ['exec', ...gitRepoArgs, ...toolRestrictionArgs, '--json', '--sandbox', effectiveSandbox, ...sandboxArgs, '--cd', record.workspace, ...writableDirectories.flatMap((directory) => ['--add-dir', directory]), '-'];
    const scopedEnvironment = await createScopedGitEnvironment(record.workspace, process.env, {
      configDir: path.join(bridgeDir, 'git-trust'),
    });
    const child = spawnImpl(command, args, {
      cwd: record.workspace,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      env: { ...scopedEnvironment, ...environment },
    });
    children.set(runId, child);
    let stderr = '';
    let eventBuffer = '';
    let logicalCompleted = false;
    let terminalCleanupTimer = null;
    let appendChain = Promise.resolve();
    child.stderr?.on('data', (chunk) => { stderr += chunk.toString(); });
    child.stdout?.on('data', (chunk) => {
      const text = chunk.toString();
      appendChain = appendChain.then(() => appendFile(eventsPath(runId), text, 'utf8')).catch(() => {});
      eventBuffer += text;
      const lines = eventBuffer.split(/\r?\n/);
      eventBuffer = lines.pop() || '';
      for (const line of lines) {
        let event;
        try { event = JSON.parse(line); } catch { continue; }
        if (event?.type === 'thread.started' || event?.type === 'thread_start' || event?.thread_id || event?.threadId) {
          record.threadId = record.threadId || event.thread_id || event.threadId || event.thread?.id || null;
        }
        if (event?.type !== 'turn.completed' || logicalCompleted) continue;
        logicalCompleted = true;
        record.status = 'completed';
        record.error = null;
        record.completedAt = new Date().toISOString();
        appendChain = appendChain.then(() => writeFile(runPath(runId), `${JSON.stringify(record, null, 2)}\n`, 'utf8')).catch(() => {});
        terminalCleanupTimer = setTimeout(() => {
          if (!child.killed) child.kill('SIGTERM');
        }, 1_500);
        terminalCleanupTimer.unref?.();
      }
    });
    child.on('error', async (error) => {
      record.status = 'failed';
      record.error = { code: error.code || 'CODEX_SPAWN_FAILED', message: sanitizeCodexDiagnostic(error.message) };
      record.completedAt = new Date().toISOString();
      await writeFile(runPath(runId), `${JSON.stringify(record, null, 2)}\n`, 'utf8').catch(() => {});
    });
    child.on('close', async (code, signal) => {
      children.delete(runId);
      if (terminalCleanupTimer) clearTimeout(terminalCleanupTimer);
      await appendChain;
      const output = await readFile(eventsPath(runId), 'utf8').catch(() => '');
      const events = parseLines(output);
      const thread = events.find((event) => event.type === 'thread.started' || event.type === 'thread_start' || event.thread_id || event.threadId);
      record.threadId = record.threadId || thread?.thread_id || thread?.threadId || thread?.thread?.id || null;
      const completed = logicalCompleted || hasCompletedTurn(events);
      record.status = completed ? 'completed' : signal ? 'cancelled' : code === 0 ? 'completed' : 'failed';
      record.error = completed || code === 0 ? null : { code: `CODEX_EXIT_${code ?? signal}`, message: sanitizeCodexDiagnostic(stderr) || `Codex exited with ${code ?? signal}` };
      record.completedAt ||= new Date().toISOString();
      await writeFile(runPath(runId), `${JSON.stringify(record, null, 2)}\n`, 'utf8').catch(() => {});
    });
    child.stdin?.end(`${goal || ''}\n`);
    return { ...record, pid: child.pid || null };
  };

  const readRun = async (runId) => {
    const record = JSON.parse(await readFile(runPath(runId), 'utf8'));
    if (record.status !== 'completed') {
      const events = parseLines(await readFile(eventsPath(runId), 'utf8').catch(() => ''));
      if (hasCompletedTurn(events)) {
        record.status = 'completed';
        record.error = null;
        record.completedAt ||= new Date().toISOString();
        await writeFile(runPath(runId), `${JSON.stringify(record, null, 2)}\n`, 'utf8').catch(() => {});
      }
    }
    return record;
  };
  const readEvents = async (runId) => parseLines(await readFile(eventsPath(runId), 'utf8').catch(() => ''));
  const cancel = async (runId) => {
    const child = children.get(runId);
    if (child && !child.killed) child.kill('SIGTERM');
    const record = await readRun(runId);
    return { ...record, status: child ? 'cancel_requested' : record.status };
  };
  return { command, sandboxMode, windowsSandbox, describe, preflight, start, readRun, readEvents, cancel, eventText };
};

export const codexClient = createCodexClient();
