import { execFile as nodeExecFile, spawn as nodeSpawn } from 'node:child_process';
import { appendFile, mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
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

export const isClaudeTelemetryEvent = (event) => {
  if (event?.type === 'system' && event?.subtype === 'thinking_tokens') return true;
  const content = event?.type === 'assistant' && Array.isArray(event?.message?.content)
    ? event.message.content
    : [];
  return content.length > 0 && content.every((item) => item?.type === 'thinking');
};

const contentText = (content) => {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((entry) => contentText(entry)).filter(Boolean).join('\n');
  if (!content || typeof content !== 'object') return '';
  return content.text || content.content || content.message || '';
};

export const normalizeClaudeEvents = (events = []) => {
  const normalized = [];
  let lastAssistantText = '';
  for (const [eventIndex, event] of events.entries()) {
    if (event?.type === 'system' && event?.subtype === 'init') {
      normalized.push({ type: 'thread.started', thread_id: event.session_id || null, provider: 'claude-code' });
      continue;
    }
    if (event?.type === 'assistant') {
      const content = Array.isArray(event.message?.content) ? event.message.content : [];
      for (const [contentIndex, item] of content.entries()) {
        if (item?.type === 'text' && item.text) {
          lastAssistantText = item.text;
          normalized.push({
            type: 'item.completed',
            item: { id: `claude-message-${eventIndex}-${contentIndex}`, type: 'agent_message', text: item.text },
            provider: 'claude-code',
          });
        } else if (item?.type === 'tool_use') {
          normalized.push({
            type: 'item.started',
            item: { id: item.id || `claude-tool-${eventIndex}-${contentIndex}`, type: 'command_execution', command: item.name || 'Claude tool', input: item.input || {} },
            provider: 'claude-code',
          });
        }
      }
      continue;
    }
    if (event?.type === 'user') {
      const content = Array.isArray(event.message?.content) ? event.message.content : [];
      for (const [contentIndex, item] of content.entries()) {
        if (item?.type !== 'tool_result') continue;
        normalized.push({
          type: 'item.completed',
          item: {
            id: item.tool_use_id || `claude-tool-result-${eventIndex}-${contentIndex}`,
            type: 'command_execution',
            status: item.is_error ? 'failed' : 'completed',
            aggregated_output: contentText(item.content),
          },
          provider: 'claude-code',
        });
      }
      continue;
    }
    if (event?.type === 'result') {
      const resultText = typeof event.result === 'string' ? event.result : '';
      if (resultText && resultText !== lastAssistantText) {
        normalized.push({ type: 'item.completed', item: { id: `claude-result-${eventIndex}`, type: 'agent_message', text: resultText }, provider: 'claude-code' });
      }
      if (event.is_error === true || (event.subtype && event.subtype !== 'success')) {
        normalized.push({ type: 'error', error: { message: resultText || event.subtype || 'Claude Code returned an error result.' }, provider: 'claude-code' });
        if (event.usage) normalized.push({ type: 'turn.failed', usage: event.usage, usageId: event.uuid || event.id || `claude-usage-${eventIndex}`, provider: 'claude-code' });
      } else {
        normalized.push({ type: 'turn.completed', usage: event.usage || null, usageId: event.uuid || event.id || `claude-usage-${eventIndex}`, provider: 'claude-code' });
      }
      continue;
    }
    if (event?.type === 'text') normalized.push(event);
  }
  return normalized;
};

export const claudeEventText = (event) => event?.text
  || event?.message
  || event?.item?.text
  || event?.item?.aggregated_output
  || event?.item?.output
  || event?.item?.command
  || event?.error?.message
  || '';

const sanitizeClaudeDiagnostic = (value = '') => String(value)
  .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, '$1 [REDACTED]')
  .replace(/\b(?:sk-ant|sk|sess|key)-[A-Za-z0-9_-]{8,}\b/gi, '[REDACTED]')
  .replace(/((?:api[_-]?key|token|authorization)\s*[:=]\s*)[^\s,;]+/gi, '$1[REDACTED]')
  .trim()
  .slice(0, 4_000);

export const classifyClaudeFailure = (run = {}, events = []) => {
  const raw = [run?.error?.message, ...events.map((event) => claudeEventText(event))].filter(Boolean).join('\n');
  const diagnostic = sanitizeClaudeDiagnostic(raw);
  if (/\b401\b|invalid[_ -]?api[_ -]?key|not logged in|authentication (?:failed|required)|unauthori[sz]ed/i.test(raw)) {
    return { code: 'CLAUDE_AUTH_FAILED', phase: 'Claude Code 认证失败', title: 'Claude Code 认证失败', detail: '请在测试用户环境中完成 Claude Code 登录或企业网关认证后重试。' };
  }
  if (/\b403\b|forbidden|insufficient permissions?|access denied/i.test(raw)) {
    return { code: 'CLAUDE_ACCESS_DENIED', phase: 'Claude Code 访问被拒绝', title: 'Claude Code 账号或模型无权访问', detail: '请检查 Claude Code 当前账号、模型和企业策略权限。' };
  }
  if (/\b429\b|rate.?limit|too many requests|quota/i.test(raw)) {
    return { code: 'CLAUDE_RATE_LIMITED', phase: 'Claude Code 请求受限', title: 'Claude Code 请求受限', detail: '当前 Claude Code 服务触发限流或配额限制，请稍后重试。' };
  }
  if (/\b402\b|insufficient balance|insufficient credits?|payment required|billing/i.test(raw)) {
    return { code: 'CLAUDE_BILLING_UNAVAILABLE', phase: 'Claude Code 余额不足', title: 'Claude Code 模型服务不可用', detail: 'Claude Code 已认证，但当前账号或企业网关余额不足。请补充额度或切换可用的模型服务配置。' };
  }
  if (/ENOTFOUND|ECONN(?:RESET|REFUSED)|ETIMEDOUT|network|dns|failed to connect|connection (?:failed|closed|refused)/i.test(raw)) {
    return { code: 'CLAUDE_NETWORK_FAILED', phase: 'Claude Code 网络失败', title: 'Claude Code 无法连接模型服务', detail: '请检查测试机网络、代理和 Claude Code 企业网关配置。' };
  }
  if (run?.error?.code === 'CLAUDE_SPAWN_FAILED') {
    return { code: 'CLAUDE_SPAWN_FAILED', phase: 'Claude Code 启动失败', title: '无法启动 Claude Code CLI', detail: '请确认 claude 命令已安装并位于当前用户 PATH。' };
  }
  const lastLine = diagnostic.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).at(-1);
  return {
    code: run?.error?.code || 'CLAUDE_EXEC_FAILED',
    phase: 'Claude Code 执行失败',
    title: 'Claude Code CLI 执行失败',
    detail: lastLine ? lastLine.slice(0, 320) : 'Claude Code 未返回可识别的失败原因，请检查 Agent run 日志。',
  };
};

export const createClaudeClient = (options = {}) => {
  const configuredCommand = options.command || process.env.CLAUDE_COMMAND || 'claude';
  const command = process.platform === 'win32' && configuredCommand === 'claude' ? 'claude.cmd' : configuredCommand;
  const spawnImpl = options.spawnImpl || nodeSpawn;
  const execFileImpl = options.execFileImpl || nodeExecFile;
  const bridgeDir = options.bridgeDir || path.resolve(process.env.OPERATOR_BRIDGE_DIR || path.join(runtimeDir, 'agent-bridge'));
  const permissionMode = options.permissionMode || process.env.OPERATOR_CLAUDE_PERMISSION_MODE || 'acceptEdits';
  const runsDir = path.join(bridgeDir, 'claude-runs');
  const emptyMcpConfigPath = path.join(bridgeDir, 'claude-empty-mcp.json');
  const children = new Map();
  const cancellationRequested = new Set();
  const runWriteChains = new Map();
  const terminateProcessTree = options.terminateProcessTreeImpl || (async (child) => {
    if (!child) return;
    if (process.platform === 'win32' && child.pid) {
      try {
        await execFileAsync(execFileImpl, 'taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { timeout: 15_000 });
        return;
      } catch { /* Fall back to signalling the wrapper process below. */ }
    }
    if (!child.killed) child.kill('SIGTERM');
  });
  const descriptorTtlMs = Number(options.descriptorTtlMs ?? 60_000);
  let descriptorCache = null;
  let descriptorCachedAt = 0;

  const runPath = (runId) => path.join(runsDir, `${runId}.json`);
  const eventsPath = (runId) => path.join(runsDir, `${runId}.jsonl`);
  const persistRun = (runId, record) => {
    const snapshot = `${JSON.stringify(record, null, 2)}\n`;
    const previous = runWriteChains.get(runId) || Promise.resolve();
    const next = previous.catch(() => {}).then(async () => {
      const target = runPath(runId);
      const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
      await writeFile(temporary, snapshot, 'utf8');
      await rename(temporary, target);
    });
    runWriteChains.set(runId, next);
    next.finally(() => {
      if (runWriteChains.get(runId) === next) runWriteChains.delete(runId);
    }).catch(() => {});
    return next;
  };

  const describe = async ({ refresh = false } = {}) => {
    if (!refresh && descriptorCache && Date.now() - descriptorCachedAt < descriptorTtlMs) return descriptorCache;
    try {
      const result = await execFileAsync(execFileImpl, command, ['--version']);
      const version = (result.stdout || result.stderr).trim().split(/\r?\n/)[0] || null;
      let loggedIn = false;
      let authOutput = '';
      try {
        const auth = await execFileAsync(execFileImpl, command, ['auth', 'status']);
        authOutput = `${auth.stdout}\n${auth.stderr}`.trim();
        loggedIn = !/not logged in|logged out|no credentials|authentication required/i.test(authOutput);
      } catch (error) {
        authOutput = `${error.stdout || ''}\n${error.stderr || error.message}`.trim();
      }
      descriptorCache = { installed: true, loggedIn, version, authOutput: sanitizeClaudeDiagnostic(authOutput) };
    } catch (error) {
      descriptorCache = { installed: false, loggedIn: false, version: null, error: sanitizeClaudeDiagnostic(error.message) };
    }
    descriptorCachedAt = Date.now();
    return descriptorCache;
  };

  const preflight = async ({ workspace }) => {
    const descriptor = await describe();
    if (!descriptor.installed) return { ready: false, code: 'CLAUDE_NOT_INSTALLED', detail: '未检测到 Claude Code CLI。', workspace };
    if (permissionMode !== 'acceptEdits') {
      return {
        ready: false,
        code: 'CLAUDE_PERMISSION_MODE_UNSAFE',
        detail: `仅允许 acceptEdits，当前配置为 ${permissionMode}。`,
        workspace,
      };
    }
    try {
      const workspaceStat = await stat(workspace);
      if (!workspaceStat.isDirectory()) throw new Error('workspace is not a directory');
    } catch (cause) {
      return { ready: false, code: 'CLAUDE_WORKSPACE_UNAVAILABLE', detail: cause.message, workspace };
    }
    return { ready: true, code: 'CLAUDE_READY', workspace, command, version: descriptor.version, configurationAuthority: 'local-claude-code', permissionMode };
  };

  const start = async ({ runId = `claude_${randomUUID().replaceAll('-', '').slice(0, 16).toUpperCase()}`, missionId, goal, workspace, additionalDirectories = [], resumeThreadId = null, environment = {} }) => {
    if (permissionMode !== 'acceptEdits') {
      const error = new Error(`Claude Code 仅允许 acceptEdits，当前配置为 ${permissionMode}。`);
      error.code = 'CLAUDE_PERMISSION_MODE_UNSAFE';
      throw error;
    }
    await mkdir(runsDir, { recursive: true });
    await writeFile(emptyMcpConfigPath, '{"mcpServers":{}}\n', 'utf8');
    const directories = [...new Set((additionalDirectories || []).filter(Boolean).map((directory) => path.resolve(directory)))];
    const role = environment.OPERATOR_AGENT_ROLE || 'stage';
    const roots = environment.OPERATOR_AGENT_ROOTS ? JSON.parse(environment.OPERATOR_AGENT_ROOTS) : { workspace: path.resolve(workspace) };
    const record = {
      schemaVersion: 1,
      provider: 'claude-code',
      runId,
      missionId,
      workspace: workspace || process.cwd(),
      additionalDirectories: directories,
      threadId: resumeThreadId,
      sessionId: resumeThreadId,
      status: 'running',
      startedAt: new Date().toISOString(),
      lastActivityAt: new Date().toISOString(),
      completedAt: null,
      eventPath: eventsPath(runId),
      permissionMode,
      boundary: { role, roots, enforcement: 'claude-permissions-and-workflow-diff' },
      error: null,
    };
    await persistRun(runId, record);
    const allowedTools = ['research-acquire', 'research-experience'].includes(role)
      ? 'Read,Glob,Grep,Write,Edit,WebSearch,WebFetch'
      : 'Read,Write,Edit';
    const configuredMaxTurns = Number(environment.OPERATOR_CLAUDE_MAX_TURNS || process.env.OPERATOR_CLAUDE_MATERIALIZER_MAX_TURNS || 6);
    const maxTurns = role === 'materializer'
      ? Math.max(1, Math.min(20, Math.trunc(Number.isFinite(configuredMaxTurns) ? configuredMaxTurns : 6)))
      : null;
    const args = [
      '-p',
      '--output-format', 'stream-json',
      '--verbose',
      '--permission-mode', permissionMode,
      '--tools', allowedTools,
      '--allowedTools', allowedTools,
      '--disallowedTools', 'Bash,NotebookEdit',
      '--disable-slash-commands',
      '--strict-mcp-config',
      '--mcp-config', emptyMcpConfigPath,
      '--no-chrome',
      ...(maxTurns ? ['--max-turns', String(maxTurns)] : []),
      ...directories.flatMap((directory) => ['--add-dir', directory]),
      ...(resumeThreadId ? ['--resume', resumeThreadId] : []),
    ];
    const scopedEnvironment = await createScopedGitEnvironment(record.workspace, process.env, { configDir: path.join(bridgeDir, 'git-trust') });
    const child = spawnImpl(command, args, {
      cwd: record.workspace,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      env: { ...scopedEnvironment, ...environment },
    });
    children.set(runId, child);
    let stderr = '';
    let eventBuffer = '';
    let logicalTerminal = false;
    let appendChain = Promise.resolve();
    let lastActivityPersistedAt = Date.now();
    child.stderr?.on('data', (chunk) => { stderr += chunk.toString(); });
    child.stdout?.on('data', (chunk) => {
      const text = chunk.toString();
      const activityAt = Date.now();
      record.lastActivityAt = new Date(activityAt).toISOString();
      if (activityAt - lastActivityPersistedAt >= 2_000) {
        lastActivityPersistedAt = activityAt;
        appendChain = appendChain.then(() => persistRun(runId, record)).catch(() => {});
      }
      eventBuffer += text;
      const lines = eventBuffer.split(/\r?\n/);
      eventBuffer = lines.pop() || '';
      for (const line of lines) {
        let event;
        try { event = JSON.parse(line); } catch {
          appendChain = appendChain.then(() => appendFile(eventsPath(runId), `${line}\n`, 'utf8')).catch(() => {});
          continue;
        }
        if (!isClaudeTelemetryEvent(event)) appendChain = appendChain.then(() => appendFile(eventsPath(runId), `${line}\n`, 'utf8')).catch(() => {});
        if (event.session_id) record.threadId = record.threadId || event.session_id, record.sessionId = record.sessionId || event.session_id;
        if (event.type !== 'result' || logicalTerminal) continue;
        logicalTerminal = true;
        const failed = event.is_error === true || (event.subtype && event.subtype !== 'success');
        record.status = failed ? 'failed' : 'completed';
        record.error = failed ? { code: 'CLAUDE_RESULT_ERROR', message: sanitizeClaudeDiagnostic(event.result || event.subtype) } : null;
        record.completedAt = new Date().toISOString();
        appendChain = appendChain.then(() => persistRun(runId, record)).catch(() => {});
      }
    });
    child.on('error', async (error) => {
      record.status = 'failed';
      record.error = { code: error.code || 'CLAUDE_SPAWN_FAILED', message: sanitizeClaudeDiagnostic(error.message) };
      record.completedAt = new Date().toISOString();
      await persistRun(runId, record).catch(() => {});
    });
    child.on('close', async (code, signal) => {
      children.delete(runId);
      const cancelled = cancellationRequested.delete(runId);
      if (eventBuffer.trim()) {
        let tailEvent = null;
        try { tailEvent = JSON.parse(eventBuffer); } catch { /* preserve non-JSON diagnostics */ }
        if (!isClaudeTelemetryEvent(tailEvent)) appendChain = appendChain.then(() => appendFile(eventsPath(runId), `${eventBuffer}\n`, 'utf8')).catch(() => {});
        eventBuffer = '';
      }
      await appendChain;
      const rawEvents = parseLines(await readFile(eventsPath(runId), 'utf8').catch(() => ''));
      const session = rawEvents.find((event) => event.session_id)?.session_id || null;
      record.threadId = record.threadId || session;
      record.sessionId = record.sessionId || session;
      const result = [...rawEvents].reverse().find((event) => event.type === 'result');
      const completed = result && result.is_error !== true && (!result.subtype || result.subtype === 'success');
      const failedResult = result && !completed;
      record.status = completed ? 'completed' : cancelled || signal ? 'cancelled' : 'failed';
      record.error = completed || cancelled || signal
        ? null
        : failedResult
          ? { code: 'CLAUDE_RESULT_ERROR', message: sanitizeClaudeDiagnostic(result.result || result.subtype) }
          : { code: code === 0 ? 'CLAUDE_RESULT_MISSING' : `CLAUDE_EXIT_${code}`, message: sanitizeClaudeDiagnostic(stderr) || 'Claude Code exited without a terminal result event.' };
      record.completedAt ||= new Date().toISOString();
      await persistRun(runId, record).catch(() => {});
    });
    child.stdin?.end(`${goal || ''}\n`);
    return { ...record, pid: child.pid || null };
  };

  const readRun = async (runId) => {
    await runWriteChains.get(runId)?.catch(() => {});
    return JSON.parse(await readFile(runPath(runId), 'utf8'));
  };
  const readEvents = async (runId) => normalizeClaudeEvents(parseLines(await readFile(eventsPath(runId), 'utf8').catch(() => '')));
  const cancel = async (runId) => {
    const child = children.get(runId);
    if (child) {
      cancellationRequested.add(runId);
      await terminateProcessTree(child);
    }
    const record = await readRun(runId);
    return { ...record, status: child ? 'cancel_requested' : record.status };
  };

  return { command, permissionMode, describe, preflight, start, readRun, readEvents, cancel, eventText: claudeEventText };
};

export const claudeClient = createClaudeClient();
