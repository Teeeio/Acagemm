import { execFile as nodeExecFile, spawn as nodeSpawn } from 'node:child_process';
import { appendFile, mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { runtimeDir } from './storage-paths.mjs';
import { createScopedGitEnvironment } from './git-environment.mjs';
import { resolveCliInvocation } from './cli-command.mjs';
import { observeClaudeModel } from './model-observation.mjs';

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

// Minimal, I/O-free metadata projection of one raw Claude stream event. It runs
// before telemetry filtering so thinking-only assistant responses still contribute
// their provider-reported model; text/thinking/tool payloads are never copied.
const claudeModelMetadataFromEvent = (event) => {
  if (!event || typeof event !== 'object' || Array.isArray(event)) return null;
  if (event.type === 'assistant') {
    return { type: 'assistant', session_id: event.session_id, message: { model: event.message?.model } };
  }
  if (event.type === 'system' && event.subtype === 'init') {
    return { type: 'system', subtype: 'init', session_id: event.session_id, model: event.model };
  }
  if (event.type === 'result') {
    const usage = event.modelUsage && typeof event.modelUsage === 'object' && !Array.isArray(event.modelUsage)
      ? Object.keys(event.modelUsage)
      : [];
    return { type: 'result', session_id: event.session_id, modelUsage: Object.fromEntries(usage.map((key) => [key, null])) };
  }
  return null;
};

const contentText = (content) => {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((entry) => contentText(entry)).filter(Boolean).join('\n');
  if (!content || typeof content !== 'object') return '';
  return content.text || content.content || content.message || '';
};

const compactValue = (value, limit = 120) => String(value || '').replace(/\s+/g, ' ').trim().slice(0, limit);

export const describeClaudeTool = (name = 'Claude tool', input = {}) => {
  const tool = String(name || 'Claude tool');
  const file = compactValue(input.file_path || input.path);
  if (tool === 'Read') return file ? `读取 ${file}` : '读取工作区文件';
  if (tool === 'Write') return file ? `写入 ${file}` : '写入候选文件';
  if (tool === 'Edit') return file ? `修改 ${file}` : '修改候选文件';
  if (tool === 'Glob') return `查找文件 ${compactValue(input.pattern) || ''}`.trim();
  if (tool === 'Grep') {
    const pattern = compactValue(input.pattern);
    const root = compactValue(input.path);
    return `搜索 ${pattern ? `“${pattern}”` : '代码'}${root ? `，范围 ${root}` : ''}`;
  }
  if (tool === 'WebSearch') return `检索 ${compactValue(input.query) || '外部资料'}`;
  if (tool === 'WebFetch') return `读取网页 ${compactValue(input.url) || ''}`.trim();
  return `${tool}${file ? ` · ${file}` : ''}`;
};

export const claudeActivityFromEvent = (event, previous = null) => {
  const now = new Date().toISOString();
  if (event?.type === 'system' && event?.subtype === 'init') {
    return { kind: 'session', status: 'running', name: 'Claude Code', summary: '会话已建立，正在读取任务上下文', updatedAt: now };
  }
  if (event?.type === 'system' && event?.subtype === 'thinking_tokens') {
    return { kind: 'thinking', status: 'running', name: '分析', summary: '正在分析任务，尚未调用新工具', updatedAt: now };
  }
  if (event?.type === 'assistant') {
    const content = Array.isArray(event.message?.content) ? event.message.content : [];
    const tool = [...content].reverse().find((item) => item?.type === 'tool_use');
    if (tool) return { kind: 'tool', status: 'running', toolId: tool.id || null, name: tool.name || 'Claude tool', summary: describeClaudeTool(tool.name, tool.input), updatedAt: now };
    if (content.some((item) => item?.type === 'text' && item.text)) {
      return { kind: 'message', status: 'running', name: '候选整理', summary: '正在整理分析结果与候选说明', updatedAt: now };
    }
  }
  if (event?.type === 'user') {
    const results = Array.isArray(event.message?.content) ? event.message.content.filter((item) => item?.type === 'tool_result') : [];
    const result = results.at(-1);
    if (result) {
      const sameTool = previous?.toolId && previous.toolId === result.tool_use_id;
      return {
        kind: 'tool',
        status: result.is_error ? 'failed' : 'completed',
        toolId: result.tool_use_id || previous?.toolId || null,
        name: sameTool ? previous.name : '工具',
        summary: sameTool ? previous.summary : result.is_error ? '工具执行失败' : '工具执行完成，正在检查结果',
        updatedAt: now,
      };
    }
  }
  if (event?.type === 'result') {
    return { kind: 'result', status: event.is_error ? 'failed' : 'completed', name: 'Claude Code', summary: event.is_error ? '本次分析失败' : '本次分析完成', updatedAt: now };
  }
  return previous;
};

export const normalizeClaudeEvents = (events = []) => {
  const normalized = [];
  let lastAssistantText = '';
  const tools = new Map();
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
          const tool = { id: item.id || `claude-tool-${eventIndex}-${contentIndex}`, name: item.name || 'Claude tool', input: item.input || {} };
          tools.set(tool.id, tool);
          normalized.push({
            type: 'item.started',
            item: { ...tool, type: 'command_execution', command: tool.name, summary: describeClaudeTool(tool.name, tool.input) },
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
        const tool = tools.get(item.tool_use_id) || {};
        normalized.push({
          type: 'item.completed',
          item: {
            id: item.tool_use_id || `claude-tool-result-${eventIndex}-${contentIndex}`,
            type: 'command_execution',
            name: tool.name || 'Claude tool',
            command: tool.name || 'Claude tool',
            input: tool.input || {},
            summary: tool.name ? describeClaudeTool(tool.name, tool.input) : item.is_error ? '工具执行失败' : '工具执行完成',
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
  || event?.item?.summary
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

const DIAGNOSTICS_SCHEMA_VERSION = 'operator-studio.agent-run-diagnostics/v1';
const CANCELLATION_CONTEXT_SCHEMA_VERSION = 'operator-studio.cancellation-context/v1';
const CANCELLATION_ROLES = new Set(['main', 'research', 'materializer']);
const CANCELLATION_TRIGGERS = new Set([
  'explicit_cancel', 'budget_exceeded', 'stall_timeout', 'budget_and_stall',
  'logical_completion', 'prior_cancel_requested', 'terminal_unreleased', 'release_pending',
]);
// Fixed conventional Node signal names; anything else is reported as null.
const NODE_SIGNAL_NAMES = new Set([
  'SIGABRT', 'SIGALRM', 'SIGBREAK', 'SIGBUS', 'SIGCHLD', 'SIGCONT', 'SIGEMT', 'SIGFPE',
  'SIGHUP', 'SIGILL', 'SIGINFO', 'SIGINT', 'SIGIO', 'SIGIOT', 'SIGKILL', 'SIGLOST',
  'SIGPIPE', 'SIGPOLL', 'SIGPROF', 'SIGPWR', 'SIGQUIT', 'SIGSEGV', 'SIGSTKFLT',
  'SIGSTOP', 'SIGSYS', 'SIGTERM', 'SIGTRAP', 'SIGTSTP', 'SIGTTIN', 'SIGTTOU',
  'SIGURG', 'SIGUSR1', 'SIGUSR2', 'SIGVTALRM', 'SIGWINCH', 'SIGXCPU', 'SIGXFSZ',
]);
const ISO_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;

const isPlainDiagnosticObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const saturatingAdd = (value, delta) => Math.min(value + delta, Number.MAX_SAFE_INTEGER);
const diagnosticChunkBytes = (chunk, text) => (typeof chunk === 'string'
  ? Buffer.byteLength(chunk)
  : chunk && typeof chunk.length === 'number' ? chunk.length : Buffer.byteLength(text));

// Bounded run diagnostics: counts, byte sizes, real client-boundary timestamps and
// one child lifecycle receipt. No stream body, prompt, thinking, path or credential
// is ever copied, and no separate persisted record is introduced.
const createRunDiagnostics = (runId, missionId) => ({
  schemaVersion: DIAGNOSTICS_SCHEMA_VERSION,
  provider: 'claude-code',
  runId,
  missionId: missionId ?? null,
  stdout: { chunks: 0, bytes: 0, firstAt: null, lastAt: null },
  stderr: { chunks: 0, bytes: 0, firstAt: null, lastAt: null },
  events: { systemInit: 0, thinkingTokens: 0, assistant: 0, result: 0, other: 0, invalidJson: 0 },
  firstModelObservedAt: null,
  cancellation: null,
  close: null,
});

const countDiagnosticChunk = (stream, chunk, text) => {
  if (!text) return;
  const at = new Date().toISOString();
  stream.chunks = saturatingAdd(stream.chunks, 1);
  stream.bytes = saturatingAdd(stream.bytes, diagnosticChunkBytes(chunk, text));
  if (stream.firstAt === null) stream.firstAt = at;
  stream.lastAt = at;
};

// Event keys are a fixed set derived from the existing type/subtype, never from
// arbitrary provider strings; primitives, arrays and unknown types are `other`.
const classifyDiagnosticEvent = (event) => {
  if (!isPlainDiagnosticObject(event)) return 'other';
  if (event.type === 'system') {
    if (event.subtype === 'init') return 'systemInit';
    if (event.subtype === 'thinking_tokens') return 'thinkingTokens';
    return 'other';
  }
  if (event.type === 'assistant') return 'assistant';
  if (event.type === 'result') return 'result';
  return 'other';
};

// Count one raw JSONL line exactly once, before telemetry filtering. Blank lines
// are no-ops; `parsed === undefined` means the caller's JSON.parse already failed.
const countDiagnosticLine = (events, line, parsed) => {
  if (typeof line !== 'string' || !line.trim()) return;
  const key = parsed === undefined ? 'invalidJson' : classifyDiagnosticEvent(parsed);
  events[key] = saturatingAdd(events[key], 1);
};

const isIsoTimestamp = (value) => typeof value === 'string'
  && ISO_TIMESTAMP_PATTERN.test(value) && Number.isFinite(Date.parse(value));
const optionalNumber = (source, key) => (Object.hasOwn(source, key) && source[key] !== undefined ? source[key] : null);
const isNonNegativeNumberOrNull = (value) => value === null || (typeof value === 'number' && Number.isFinite(value) && value >= 0);
const isPositiveNumberOrNull = (value) => value === null || (typeof value === 'number' && Number.isFinite(value) && value > 0);

// Copy only the listed keys, as detached scalars. Any invalid schema, identity,
// enum, time or numeric value yields null without preventing cancellation; a
// missing optional timing/budget value is reported as null, never as a guessed zero.
const detachCancellationContext = (context, record) => {
  if (!isPlainDiagnosticObject(context)) return null;
  if (context.schemaVersion !== CANCELLATION_CONTEXT_SCHEMA_VERSION) return null;
  if (typeof context.runId !== 'string' || !context.runId.trim() || context.runId !== record.runId) return null;
  if (typeof context.missionId !== 'string' || !context.missionId.trim() || context.missionId !== record.missionId) return null;
  if (!CANCELLATION_ROLES.has(context.role)) return null;
  if (!CANCELLATION_TRIGGERS.has(context.trigger)) return null;
  if (!isIsoTimestamp(context.triggeredAt)) return null;
  const budgetMs = optionalNumber(context, 'budgetMs');
  const elapsedMs = optionalNumber(context, 'elapsedMs');
  const stallTimeoutMs = optionalNumber(context, 'stallTimeoutMs');
  const idleMs = optionalNumber(context, 'idleMs');
  if (!isNonNegativeNumberOrNull(budgetMs) || !isNonNegativeNumberOrNull(elapsedMs)) return null;
  if (!isPositiveNumberOrNull(stallTimeoutMs) || !isNonNegativeNumberOrNull(idleMs)) return null;
  return {
    schemaVersion: CANCELLATION_CONTEXT_SCHEMA_VERSION,
    runId: context.runId,
    missionId: context.missionId,
    role: context.role,
    trigger: context.trigger,
    triggeredAt: context.triggeredAt,
    budgetMs,
    elapsedMs,
    stallTimeoutMs,
    idleMs,
  };
};

export const createClaudeClient = (options = {}) => {
  const configuredCommand = options.command || process.env.CLAUDE_COMMAND || 'claude';
  const invocation = resolveCliInvocation({ provider: 'claude', configuredCommand });
  const command = invocation.command;
  const commandArgs = (args) => [...invocation.prefixArgs, ...args];
  const spawnImpl = options.spawnImpl || nodeSpawn;
  const execFileImpl = options.execFileImpl || nodeExecFile;
  const bridgeDir = options.bridgeDir || path.resolve(process.env.OPERATOR_BRIDGE_DIR || path.join(runtimeDir, 'agent-bridge'));
  const permissionMode = options.permissionMode || process.env.OPERATOR_CLAUDE_PERMISSION_MODE || 'acceptEdits';
  const runsDir = path.join(bridgeDir, 'claude-runs');
  const emptyMcpConfigPath = path.join(bridgeDir, 'claude-empty-mcp.json');
  const children = new Map();
  const liveRuns = new Map();
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
      const result = await execFileAsync(execFileImpl, command, commandArgs(['--version']));
      const version = (result.stdout || result.stderr).trim().split(/\r?\n/)[0] || null;
      let loggedIn = false;
      let authOutput = '';
      try {
        const auth = await execFileAsync(execFileImpl, command, commandArgs(['auth', 'status']));
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
    // Every run starts unknown: a resume hint is a request parameter, never an
    // observed response identity. The real session is learned from this stream and
    // then fixed; until it is learned, no session identity is claimed at all.
    const observationEvents = [];
    let streamSessionId = null;
    const record = {
      schemaVersion: 1,
      provider: 'claude-code',
      runId,
      missionId,
      workspace: workspace || process.cwd(),
      additionalDirectories: directories,
      threadId: null,
      sessionId: null,
      status: 'running',
      startedAt: new Date().toISOString(),
      lastActivityAt: new Date().toISOString(),
      completedAt: null,
      eventPath: eventsPath(runId),
      permissionMode,
      boundary: { role, roots, enforcement: 'claude-permissions-and-workflow-diff' },
      activity: { kind: 'startup', status: 'running', name: 'Claude Code', summary: '正在启动候选生成智能体', updatedAt: new Date().toISOString() },
      modelObservation: observeClaudeModel({ runId, missionId, sessionId: '', events: [] }),
      diagnostics: createRunDiagnostics(runId, missionId),
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
    const child = spawnImpl(command, commandArgs(args), {
      cwd: record.workspace,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      env: { ...scopedEnvironment, ...environment },
    });
    let stderr = '';
    let eventBuffer = '';
    let logicalTerminal = false;
    let appendChain = Promise.resolve();
    let lastActivityPersistedAt = Date.now();
    // The live record is exposed so the first real cancel can durably record itself
    // through the existing serialized atomic writer without delaying termination.
    liveRuns.set(runId, {
      record,
      enqueueDiagnosticPersist: () => persistRun(runId, record).catch(() => {}),
    });
    children.set(runId, child);
    // Recompute the pure DTO from accumulated safe metadata; persist on change so a
    // metadata-only update is durable without waiting for the next activity write.
    const refreshModelObservation = () => {
      const next = observeClaudeModel({ runId, missionId, sessionId: streamSessionId || '', events: observationEvents });
      if (JSON.stringify(next) === JSON.stringify(record.modelObservation)) return;
      record.modelObservation = next;
      // The first time the existing authority really observes a response model, the
      // historical time is fixed for this run; init/usage/configured labels and a
      // later conflict never set or erase it.
      if (next.status === 'observed' && record.diagnostics.firstModelObservedAt === null) {
        record.diagnostics.firstModelObservedAt = new Date().toISOString();
      }
      appendChain = appendChain.then(() => persistRun(runId, record)).catch(() => {});
    };
    // The first real session in the current stream becomes the run identity and is
    // fixed for the rest of the run: a later (foreign) event can never replace it,
    // and session bytes are compared exactly, never trimmed or normalized.
    const learnStreamSession = (value) => {
      if (typeof value !== 'string' || !value.trim() || streamSessionId) return false;
      streamSessionId = value;
      record.sessionId = value;
      record.threadId = value;
      return true;
    };
    // Bounded, merged stderr diagnostics persistence. At most one write is queued on
    // the existing serialized run writer at a time and every chunk arriving while it
    // is pending merges into it, so a burst costs one write while a single chunk still
    // becomes durable on its own rather than waiting for a later chunk or for close.
    // No timer is added and lastActivityAt/stall semantics stay untouched.
    let stderrDiagnosticsQueued = false;
    const queueStderrDiagnosticsPersist = () => {
      if (stderrDiagnosticsQueued) return;
      stderrDiagnosticsQueued = true;
      appendChain = appendChain.then(async () => {
        stderrDiagnosticsQueued = false;
        await persistRun(runId, record);
      }).catch(() => { stderrDiagnosticsQueued = false; });
    };
    child.stderr?.on('data', (chunk) => {
      const text = chunk.toString();
      stderr += text;
      if (!text) return;
      // stderr-only activity stays observable through the same serialized run writer;
      // lastActivityAt/stall semantics are not touched.
      countDiagnosticChunk(record.diagnostics.stderr, chunk, text);
      queueStderrDiagnosticsPersist();
    });
    child.stdout?.on('data', (chunk) => {
      const text = chunk.toString();
      const activityAt = Date.now();
      record.lastActivityAt = new Date(activityAt).toISOString();
      if (activityAt - lastActivityPersistedAt >= 2_000) {
        lastActivityPersistedAt = activityAt;
        appendChain = appendChain.then(() => persistRun(runId, record)).catch(() => {});
      }
      countDiagnosticChunk(record.diagnostics.stdout, chunk, text);
      eventBuffer += text;
      const lines = eventBuffer.split(/\r?\n/);
      eventBuffer = lines.pop() || '';
      for (const line of lines) {
        let event;
        try { event = JSON.parse(line); } catch {
          // Counted before telemetry filtering, exactly once per nonblank line.
          countDiagnosticLine(record.diagnostics.events, line, undefined);
          appendChain = appendChain.then(() => appendFile(eventsPath(runId), `${line}\n`, 'utf8')).catch(() => {});
          continue;
        }
        countDiagnosticLine(record.diagnostics.events, line, event);
        // Safe model metadata is captured before telemetry filtering, so
        // thinking-only responses are still observed without persisting thinking.
        const modelMetadata = claudeModelMetadataFromEvent(event);
        if (modelMetadata) observationEvents.push(modelMetadata);
        // Valid JSON primitives/arrays/null are already counted as `other`; they carry
        // no stream fields, so every later read of this line is optional and harmless.
        const learnedSession = learnStreamSession(event?.session_id);
        if (modelMetadata || learnedSession) refreshModelObservation();
        const previousActivity = record.activity;
        record.activity = claudeActivityFromEvent(event, previousActivity);
        const significantActivityChange = record.activity !== previousActivity
          && (record.activity?.kind !== previousActivity?.kind || record.activity?.toolId !== previousActivity?.toolId || record.activity?.status !== previousActivity?.status);
        if (significantActivityChange) appendChain = appendChain.then(() => persistRun(runId, record)).catch(() => {});
        if (!isClaudeTelemetryEvent(event)) appendChain = appendChain.then(() => appendFile(eventsPath(runId), `${line}\n`, 'utf8')).catch(() => {});
        if (event?.type !== 'result' || logicalTerminal) continue;
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
      liveRuns.delete(runId);
      const cancelled = cancellationRequested.delete(runId);
      // A real child lifecycle receipt, captured before any queued write is awaited.
      record.diagnostics.close = {
        at: new Date().toISOString(),
        exitCode: Number.isInteger(code) ? code : null,
        signal: NODE_SIGNAL_NAMES.has(signal) ? signal : null,
      };
      // Capture the unterminated final line locally and clear the buffer first:
      // the deferred append/persist must never read an already-cleared buffer.
      const tailLine = eventBuffer;
      eventBuffer = '';
      if (tailLine.trim()) {
        let tailEvent;
        try { tailEvent = JSON.parse(tailLine); } catch { /* preserve non-JSON diagnostics */ }
        countDiagnosticLine(record.diagnostics.events, tailLine, tailEvent);
        const tailMetadata = claudeModelMetadataFromEvent(tailEvent);
        if (tailMetadata) observationEvents.push(tailMetadata);
        const learnedSession = learnStreamSession(tailEvent?.session_id);
        if (tailMetadata || learnedSession) refreshModelObservation();
        if (!isClaudeTelemetryEvent(tailEvent)) appendChain = appendChain.then(() => appendFile(eventsPath(runId), `${tailLine}\n`, 'utf8')).catch(() => {});
      }
      refreshModelObservation();
      await appendChain;
      const rawEvents = parseLines(await readFile(eventsPath(runId), 'utf8').catch(() => ''));
      // Raw lines can legitimately parse to primitives/arrays/null (counted as
      // `other`), so every lookup over the reloaded raw events is optional.
      const session = rawEvents.find((event) => event?.session_id)?.session_id || null;
      record.threadId = record.threadId || session;
      record.sessionId = record.sessionId || session;
      const result = [...rawEvents].reverse().find((event) => event?.type === 'result');
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
  const cancel = async (runId, context) => {
    const child = children.get(runId);
    if (child) {
      cancellationRequested.add(runId);
      const live = liveRuns.get(runId);
      let cancellationWrite = null;
      // Only a live owned child can record a request. The first actual call fixes
      // {requestedAt, context}; repeats never replace it, and a child that is
      // already gone fabricates nothing. The write is queued on the existing
      // serialized atomic writer but never awaited before termination starts.
      if (live && live.record.diagnostics.cancellation === null) {
        live.record.diagnostics.cancellation = {
          requestedAt: new Date().toISOString(),
          context: detachCancellationContext(context, live.record),
        };
        cancellationWrite = live.enqueueDiagnosticPersist();
      }
      await terminateProcessTree(child);
      await cancellationWrite;
    }
    const record = await readRun(runId);
    return { ...record, status: child ? 'cancel_requested' : record.status };
  };

  return { command, permissionMode, describe, preflight, start, readRun, readEvents, cancel, eventText: claudeEventText };
};

export const claudeClient = createClaudeClient();
