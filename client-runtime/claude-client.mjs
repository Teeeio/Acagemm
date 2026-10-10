import { execFile as nodeExecFile, spawn as nodeSpawn } from 'node:child_process';
import { appendFile, mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { runtimeDir } from './storage-paths.mjs';
import { createScopedGitEnvironment } from './git-environment.mjs';
import { resolveCliInvocation } from './cli-command.mjs';
import { observeClaudeModel } from './model-observation.mjs';
import { buildClaudeSettings, claudeRulePath, resolveClaudeToolSurface, writeDenyRulesFor } from './claude-permission-surface.mjs';
import { inspectExperimentAgentAccess } from './experiment-storage.mjs';
import { jobObjectSupported, terminateJobObject } from './windows-job-object.mjs';
import { createClaudeExecutionRetirement } from './claude-execution-retirement.mjs';
import { createClaudeJobLossRetirement } from './claude-job-loss-retirement.mjs';
import { createClaudeHostRecovery } from './claude-host-recovery.mjs';
import { CLAUDE_PROCESS_SCHEMA, createClaudeProcessIdentity, startClaudeSupervisedProcess, inspectClaudeProcess, recoverClaudeProcessRecord, terminateClaudeProcessWithReceipt } from './claude-process-supervisor.mjs';
import { POSIX_AGENT_PROCESS_SCHEMA, createPosixProcessIdentity, startPosixSupervisedProcess, inspectPosixProcess, recoverPosixProcessRecord, requestPosixCancellation } from './posix-process-supervisor.mjs';
import { requireBoundarySupervisor, resolveAppContainerPlan, preflightAppContainerExecution } from './appcontainer-execution.mjs';

const defaultTimeoutMs = 12_000;

// Claude Code 从**配置根**（默认 ~/.claude）读 settings.json，那里面的 permissions.deny/allow/ask、
// hooks、mcpServers 都是对本次运行生效的强制通道——实测证据：配置根里放
// permissions.deny=["Read(<外部路径>/**)"] 后，即便同时传了 --permission-mode acceptEdits，
// 那次 Read 仍被以 "denied by your permission settings" 拒绝。不 pin 配置根，宿主的这套规则就会
// 跟着进到运行时的 agent 里，适配器声明的参数就不再是唯一的约束来源。故把配置根指向运行时自己的目录。
//
// 这里**不**声称「宿主的 defaultMode 会盖掉 --permission-mode」：那条我没测过。mode 之间谁优先与本处
// 无关——实测 --permission-mode 本身并不构成写边界（四种 mode 下越界写都成功），真正有牙齿的是
// deny 类规则与工具面；pin 配置根是为了让这些有牙齿的通道归适配器所有。
//
// 宿主 settings.env 也可能承载认证与模型路由。只把固定白名单投影到子进程内存，
// 不复制宿主设置/凭据文件；认证探针与模型进程必须使用相同投影及受管配置根。
//
// 与 git-environment 同样的回退：打包目录可能只读，退到系统临时目录，而不是让每次运行都失败。
const ensureClaudeConfigDir = async (configuredDir) => {
  // 回退目录按运行隔离（沿用运行 id 这一层）：共用一个回退目录会让并发的两次运行互相覆盖
  // settings.json，把其中一次的 deny 规则悄悄抹掉。
  const configDirs = [...new Set([configuredDir, path.join(os.tmpdir(), 'operator-studio-claude-config', path.basename(configuredDir))])];
  let configDir;
  let lastError;
  for (const candidate of configDirs) {
    try {
      await mkdir(candidate, { recursive: true });
      configDir = candidate;
      break;
    } catch (error) {
      lastError = error;
    }
  }
  if (!configDir) throw lastError;
  return configDir;
};

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

const AUTH_SECRET_KEYS = ['ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN'];
const AUTH_ENV_KEYS = [...AUTH_SECRET_KEYS, 'ANTHROPIC_BASE_URL', 'ANTHROPIC_MODEL',
  'ANTHROPIC_DEFAULT_OPUS_MODEL', 'ANTHROPIC_DEFAULT_SONNET_MODEL', 'ANTHROPIC_DEFAULT_HAIKU_MODEL'];
const UNSUPPORTED_PROVIDER_KEYS = ['CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY'];
const AUTH_MESSAGES = {
  CLAUDE_HOST_CONFIG_INVALID: 'Claude host settings are not valid authentication configuration.',
  CLAUDE_HOST_CONFIG_UNREADABLE: 'Claude host settings could not be read.',
  CLAUDE_AUTH_ENV_INVALID: 'Claude authentication environment requires string values without null bytes.',
  CLAUDE_AUTH_CONFIG_UNSUPPORTED: 'This Claude authentication mechanism is not supported by the managed adapter.',
  CLAUDE_CONFIG_OVERRIDE_FORBIDDEN: 'The Claude run configuration directory is owned by the adapter.',
  CLAUDE_MANAGED_CONFIG_UNAVAILABLE: 'The managed Claude configuration directory is unavailable.',
  CLAUDE_AUTH_STATUS_INVALID: 'Claude authentication status did not contain a JSON loggedIn boolean.',
  CLAUDE_AUTH_PROBE_FAILED: 'The managed Claude authentication probe failed.',
  CLAUDE_AUTH_UNAVAILABLE: 'Authentication is unavailable in the managed Claude execution context.',
  CLAUDE_NOT_INSTALLED: 'Claude Code CLI version probe failed.',
  CLAUDE_RUN_ID_INVALID: 'Claude run identity is not a safe directory name.',
};
const authFailure = (code) => Object.assign(new Error(AUTH_MESSAGES[code]), { code });
const objectRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

// No values from this function belong in a descriptor, run record or settings file.
const projectHostAuthentication = async (hostConfigDir, ambient, explicit) => {
  let settings = {};
  try { settings = JSON.parse(await readFile(path.join(hostConfigDir, 'settings.json'), 'utf8')); }
  catch (error) {
    if (error.code !== 'ENOENT') throw authFailure(error instanceof SyntaxError
      ? 'CLAUDE_HOST_CONFIG_INVALID' : 'CLAUDE_HOST_CONFIG_UNREADABLE');
  }
  if (!objectRecord(settings) || (Object.hasOwn(settings, 'env') && !objectRecord(settings.env))) {
    throw authFailure('CLAUDE_HOST_CONFIG_INVALID');
  }
  const defaults = {};
  for (const key of AUTH_ENV_KEYS) {
    if (!Object.hasOwn(settings.env || {}, key)) continue;
    const value = settings.env[key];
    if (typeof value !== 'string' || value.includes('\0')) throw authFailure('CLAUDE_HOST_CONFIG_INVALID');
    defaults[key] = value;
  }
  if (!Object.hasOwn(defaults, 'ANTHROPIC_MODEL') && Object.hasOwn(settings, 'model')) {
    if (typeof settings.model !== 'string' || settings.model.includes('\0')) throw authFailure('CLAUDE_HOST_CONFIG_INVALID');
    defaults.ANTHROPIC_MODEL = settings.model;
  }
  // Spread precedence deliberately respects an explicitly empty string.
  const environment = { ...defaults, ...ambient, ...explicit };
  for (const key of AUTH_ENV_KEYS) {
    if (Object.hasOwn(environment, key) && (typeof environment[key] !== 'string' || environment[key].includes('\0'))) {
      throw authFailure('CLAUDE_AUTH_ENV_INVALID');
    }
  }
  for (const key of UNSUPPORTED_PROVIDER_KEYS) {
    const value = Object.hasOwn(environment, key) ? environment[key] : settings.env?.[key];
    if (value && !['0', 'false'].includes(String(value).toLowerCase())) throw authFailure('CLAUDE_AUTH_CONFIG_UNSUPPORTED');
  }
  if (settings.apiKeyHelper && !AUTH_SECRET_KEYS.some((key) => environment[key])) {
    throw authFailure('CLAUDE_AUTH_CONFIG_UNSUPPORTED');
  }
  const secrets = [...new Set([defaults, ambient, explicit].flatMap((source) =>
    AUTH_SECRET_KEYS.map((key) => source[key]).filter((value) => typeof value === 'string' && value.length > 0)))];
  // Non-JSON diagnostics can contain literal or escaped echoes. Structured data
  // must instead redact string VALUES only: replacing serialized digits/booleans
  // or object keys would corrupt persisted state for a valid short credential.
  const patterns = [...new Set(secrets.flatMap((value) => [value, JSON.stringify(value).slice(1, -1)]))]
    .sort((a, b) => b.length - a.length);
  const redactText = (text) => patterns.reduce((safe, value) => safe.split(value).join('[REDACTED]'), text);
  const redactValue = (value) => {
    if (typeof value === 'string') return redactText(value);
    if (Array.isArray(value)) return value.map(redactValue);
    if (objectRecord(value)) return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redactValue(item)]));
    return value;
  };
  const redactLine = (line) => {
    try { return JSON.stringify(redactValue(JSON.parse(line))); }
    catch { return redactText(line); }
  };
  return { environment, redactText, redactValue, redactLine };
};

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

const TOOL_PERMISSION_DENIED = 'CLAUDE_TOOL_PERMISSION_DENIED';
const MANAGED_TOOLS = new Set(['Read', 'Write', 'Edit', 'Glob', 'Grep', 'WebSearch', 'WebFetch']);
const isToolPermissionDenial = (content) => {
  // Only inspect the tool's leading diagnostic, never a quoted old_string/file
  // excerpt following an ordinary missing/ambiguous replacement error.
  const diagnostic = String(contentText(content)).trim().replace(/^<tool_use_error>\s*/i, '').replace(/^Error:\s*/i, '').split(/\r?\n/)[0];
  if (/^(?:(?:The )?(?:string|text|substring) (?:to replace )?(?:was )?not found\b|Found \d+ matches of (?:the )?string\b|File (?:does not exist|not found)\b|No such file or directory\b|old_string (?:was )?not found\b)/i.test(diagnostic)) return false;
  return /\bsuspicious Windows path pattern that requires manual approval\b|\bdenied by your permission settings\b|\bpermission to use (?:Read|Write|Edit|Glob|Grep|WebSearch|WebFetch) (?:has been |was |is )?denied\b/i.test(diagnostic)
    || /^(?:File )?.+ is outside .+; the permissions\.blockReadsOutsideWorkingDirectories setting blocks reads outside the working directories\./i.test(diagnostic)
    || /^Claude requested permissions to write to .+, but you haven't granted it yet\./i.test(diagnostic);
};
const createToolPermissionObserver = () => {
  const tools = new Map();
  return (event) => {
    const content = Array.isArray(event?.message?.content) ? event.message.content : [];
    if (event?.type === 'assistant') {
      for (const item of content) {
        if (item?.type === 'tool_use' && typeof item.id === 'string' && item.id.trim() && MANAGED_TOOLS.has(item.name)) tools.set(item.id, item.name);
      }
    }
    if (event?.type !== 'user') return null;
    for (const item of content) {
      if (item?.type !== 'tool_result' || item.is_error !== true || !tools.has(item.tool_use_id) || !isToolPermissionDenial(item.content)) continue;
      return {
        code: TOOL_PERMISSION_DENIED, retryable: false,
        message: 'Claude Code managed tool permission was denied; this run cannot admit a candidate or apply a result patch.',
        toolUseId: item.tool_use_id, toolName: tools.get(item.tool_use_id),
      };
    }
    return null;
  };
};

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
  const observePermission = createToolPermissionObserver();
  let permissionFailure = null;
  for (const [eventIndex, event] of events.entries()) {
    const denied = observePermission(event);
    if (denied && !permissionFailure) {
      permissionFailure = denied;
      normalized.push({ type: 'error', error: denied, provider: 'claude-code' });
    }
    if (event?.type === 'system' && event?.subtype === 'init') {
      normalized.push({ type: 'thread.started', thread_id: event.session_id || null, provider: 'claude-code' });
      continue;
    }
    if (event?.type === 'system' && event?.subtype === 'api_retry') {
      // A retry is diagnostic evidence, not a terminal model failure. Keep only
      // bounded protocol metadata; never retain arbitrary provider error bodies.
      normalized.push({ type: 'provider.retry', provider: 'claude-code',
        attempt: Number.isSafeInteger(event.attempt) && event.attempt > 0 ? event.attempt : null,
        statusCode: Number.isSafeInteger(event.error_status) && event.error_status >= 100 && event.error_status <= 599 ? event.error_status : null });
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
      if (content.some(item => item?.type === 'text' && /^Output token limit hit\./i.test(String(item.text || '')))) {
        normalized.push({ type: 'provider.output_limit', provider: 'claude-code', code: 'OUTPUT_TOKEN_LIMIT_REACHED', timestamp: event.timestamp || null });
      }
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
      if (permissionFailure || event.is_error === true || (event.subtype && event.subtype !== 'success')) {
        if (!permissionFailure) normalized.push({ type: 'error', error: { message: resultText || event.subtype || 'Claude Code returned an error result.' }, provider: 'claude-code' });
        if (event.usage || permissionFailure) normalized.push({ type: 'turn.failed', usage: event.usage || null, usageId: event.uuid || event.id || `claude-usage-${eventIndex}`, provider: 'claude-code' });
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
  // Typed adapter evidence outranks result text, exit status and generic API errors.
  const denied = run?.error?.code === TOOL_PERMISSION_DENIED ? run.error
    : events.find(event => event?.type === 'error' && event.provider === 'claude-code' && event.error?.code === TOOL_PERMISSION_DENIED)?.error;
  if (denied) return {
    code: TOOL_PERMISSION_DENIED, retryable: false,
    phase: 'Claude Code 工具权限被拒绝', title: 'Claude Code 工具权限被拒绝',
    detail: '受管工具被明确拒绝或要求人工批准；本次运行不得应用结果 Patch 或准入已有工作区改动。',
  };
  const raw = [run?.error?.message, ...events.map((event) => claudeEventText(event))].filter(Boolean).join('\n');
  const diagnostic = sanitizeClaudeDiagnostic(raw);
  if (/\b401\b|invalid[_ -]?api[_ -]?key|not logged in|authentication (?:failed|required)|unauthori[sz]ed/i.test(raw)) {
    return { code: 'CLAUDE_AUTH_FAILED', phase: 'Claude Code 认证失败', title: 'Claude Code 认证失败', detail: '受管执行上下文认证失败；请检查认证投影与端点配置。' };
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
  const useJobObject = options.jobObject ?? (jobObjectSupported(options.platform || process.platform) && !options.spawnImpl);
  const usePosixSupervisor = process.platform === 'linux' && !options.spawnImpl && !useJobObject;
  const useSupervisor = useJobObject || usePosixSupervisor;
  requireBoundarySupervisor({ environment: options.environment, platform: options.platform || process.platform, supervised: useJobObject });
  const bridgeDir = options.bridgeDir || path.resolve(process.env.OPERATOR_BRIDGE_DIR || path.join(runtimeDir, 'agent-bridge'));
  const hostConfigDir = path.resolve(options.hostConfigDir ?? (process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude')));
  const experimentIsolation = process.env.OPERATOR_CLAUDE_EXPERIMENT_ISOLATION === '1' || options.experimentIsolation === true;
  const experimentRoot = process.env.OPERATOR_EXPERIMENT_ROOT || options.experimentRoot;
  // 传给 CLI 的 permission mode。它决定 CLI 的交互行为，**不是**安全边界——实测四种 mode 下
  // workspace 之外的写入都成功（见文件头注释）。真正的能力边界是工具面与配置根里的 deny 规则，
  // 由 claude-permission-surface 推导。这个旋钮保留只是为了让 CLI 有一个确定的行为档位。
  const permissionMode = experimentIsolation ? 'dontAsk' : options.permissionMode || process.env.OPERATOR_CLAUDE_PERMISSION_MODE || 'acceptEdits';
  const runsDir = path.join(bridgeDir, 'claude-runs');
  const executionRetirement = createClaudeExecutionRetirement({ runsDir, command, ...(options.readTransportCensus ? { readCensus: options.readTransportCensus } : {}), ...(options.readCommandStat ? { readCommandStat: options.readCommandStat } : {}) });
  const jobLossRetirement = createClaudeJobLossRetirement({ runsDir, command,
    ...(options.fenceRegistryDir ? { fenceRegistryDir: options.fenceRegistryDir } : {}),
    ...(options.readTransportCensus ? { readCensus: options.readTransportCensus } : {}),
    ...(options.readCommandStat ? { readCommandStat: options.readCommandStat } : {}) });
  const hostRecovery = createClaudeHostRecovery({ runsDir, ...(options.readHostIdentity ? { readHostIdentity: options.readHostIdentity } : {}) });
  const emptyMcpConfigPath = path.join(bridgeDir, 'claude-empty-mcp.json');
  const children = new Map();
  const liveRuns = new Map();
  const cancellationRequested = new Set();
  const runWriteChains = new Map();
  const runRedactors = new Map();
  const terminateProcessTree = options.terminateProcessTreeImpl || (async (child) => {
    if (!child) return;
    if (child.ready) return child.terminate();
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
  let probeConfigPromise = null;

  const runPath = (runId) => path.join(runsDir, `${runId}.json`);
  const eventsPath = (runId) => path.join(runsDir, `${runId}.jsonl`);
  const persistRun = (runId, record) => {
    const snapshot = `${JSON.stringify((runRedactors.get(runId) || ((value) => value))(record), null, 2)}\n`;
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

  const managedConfig = async (name, denyRules = []) => {
    const requested = path.resolve(bridgeDir, 'claude-config', name);
    const withinHost = (directory) => {
      const relative = path.relative(hostConfigDir, directory);
      return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
    };
    if (withinHost(requested)) throw authFailure('CLAUDE_CONFIG_OVERRIDE_FORBIDDEN');
    try {
      const directory = await ensureClaudeConfigDir(requested);
      if (withinHost(directory)) throw authFailure('CLAUDE_CONFIG_OVERRIDE_FORBIDDEN');
      if (experimentIsolation) await inspectExperimentAgentAccess({ rootDir: experimentRoot, workspace: directory, bridgeDir });
      await writeFile(path.join(directory, 'settings.json'), `${JSON.stringify(buildClaudeSettings({ denyRules, experimentIsolation }), null, 2)}\n`, 'utf8');
      return directory;
    } catch {
      throw authFailure('CLAUDE_MANAGED_CONFIG_UNAVAILABLE');
    }
  };

  const probeAuthentication = async (environment, directory) => {
    let result;
    let failed = false;
    try {
      result = await execFileAsync(execFileImpl, command, commandArgs([...(experimentIsolation ? ['--safe-mode'] : []), 'auth', 'status']),
        { env: environment, cwd: directory, windowsHide: true });
    } catch (error) {
      result = { stdout: error.stdout || '' };
      failed = true;
    }
    let status;
    try { status = JSON.parse(result.stdout); }
    catch { throw authFailure(failed ? 'CLAUDE_AUTH_PROBE_FAILED' : 'CLAUDE_AUTH_STATUS_INVALID'); }
    if (!objectRecord(status) || typeof status.loggedIn !== 'boolean') throw authFailure('CLAUDE_AUTH_STATUS_INVALID');
    if (!status.loggedIn) throw authFailure('CLAUDE_AUTH_UNAVAILABLE');
    if (failed) throw authFailure('CLAUDE_AUTH_PROBE_FAILED');
  };

  const describe = async ({ refresh = false } = {}) => {
    if (!refresh && descriptorCache && Date.now() - descriptorCachedAt < descriptorTtlMs) return descriptorCache;
    let version;
    try {
      const result = await execFileAsync(execFileImpl, command, commandArgs(['--version']), { windowsHide: true });
      const line = (result.stdout || result.stderr).trim().split(/\r?\n/)[0];
      version = /^\d+\.\d+\.\d+[\w.+-]*(?: \(Claude Code\))?$/.test(line) ? line : null;
    } catch {
      descriptorCache = { installed: false, loggedIn: false, version: null, code: 'CLAUDE_NOT_INSTALLED', error: AUTH_MESSAGES.CLAUDE_NOT_INSTALLED };
      descriptorCachedAt = Date.now();
      return descriptorCache;
    }
    try {
      const { environment } = await projectHostAuthentication(hostConfigDir, process.env, {});
      // The dot-prefixed probe name cannot collide with an admitted run id.
      // Initialize once per client, then leave its identical settings read-only.
      probeConfigPromise ??= managedConfig('.auth-probe').catch((error) => {
        probeConfigPromise = null;
        throw error;
      });
      const directory = await probeConfigPromise;
      await probeAuthentication({ ...environment, CLAUDE_CONFIG_DIR: directory,
        ...(experimentIsolation ? { CLAUDE_CODE_SIMPLE: '0', CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1' } : {}) }, directory);
      descriptorCache = { installed: true, loggedIn: true, version, code: 'CLAUDE_READY', authOutput: 'Managed execution authentication is available.' };
    } catch (error) {
      const code = Object.hasOwn(AUTH_MESSAGES, error.code) ? error.code : 'CLAUDE_AUTH_PROBE_FAILED';
      descriptorCache = { installed: true, loggedIn: false, version, code, error: AUTH_MESSAGES[code], authOutput: AUTH_MESSAGES[code] };
    }
    descriptorCachedAt = Date.now();
    return descriptorCache;
  };

  const preflight = async ({ workspace, environment = {} }) => {
    const boundary = await preflightAppContainerExecution({ environment, platform: options.platform || process.platform,
      supervised: useJobObject, cwd: workspace || process.cwd(), filePath: command,
      argv: [command, ...invocation.prefixArgs], inspectResources: options.resourceInspectorImpl });
    if (!boundary.ready) return { ...boundary, workspace };
    const descriptor = await describe({ refresh: true });
    if (!descriptor.installed) return { ready: false, code: 'CLAUDE_NOT_INSTALLED', detail: '未检测到 Claude Code CLI。', workspace };
    if (!descriptor.loggedIn) return { ready: false, code: descriptor.code, detail: descriptor.error, workspace };
    try {
      const workspaceStat = await stat(workspace);
      if (!workspaceStat.isDirectory()) throw new Error('workspace is not a directory');
    } catch (cause) {
      return { ready: false, code: 'CLAUDE_WORKSPACE_UNAVAILABLE', detail: cause.message, workspace };
    }
    return {
      ...boundary,
      ready: true, code: 'CLAUDE_READY', workspace, command, version: descriptor.version,
      configurationAuthority: 'local-claude-code', permissionMode,
      // 明确登记 permissionMode 不是能力边界，免得下游把它当成安全属性读。
      permissionModeIsBoundary: false,
    };
  };

  const start = async ({ runId = `claude_${randomUUID().replaceAll('-', '').slice(0, 16).toUpperCase()}`, missionId, goal, workspace, additionalDirectories = [], readOnlyDirectories = [], protectedDirectories = [], resumeThreadId = null, environment = {} }) => {
    await jobLossRetirement.assertStartAllowed({ runId, missionId, resumeThreadId, workspace });
    requireBoundarySupervisor({ environment, platform: options.platform || process.platform, supervised: useJobObject });
    await resolveAppContainerPlan({ environment, cwd: workspace || process.cwd(), filePath: command, argv: [command, ...invocation.prefixArgs], inspectResources: options.resourceInspectorImpl });
    if (!/^[A-Za-z0-9_-]+$/.test(runId)) throw authFailure('CLAUDE_RUN_ID_INVALID');
    await executionRetirement.assertStartAllowed({ runId, missionId, resumeThreadId });
    if (Object.hasOwn(environment, 'CLAUDE_CONFIG_DIR')) throw authFailure('CLAUDE_CONFIG_OVERRIDE_FORBIDDEN');
    if (experimentIsolation) await inspectExperimentAgentAccess({ rootDir: experimentRoot, workspace,
      directories: [...additionalDirectories, ...readOnlyDirectories], bridgeDir });
    const resumeHintDiscarded = experimentIsolation && Boolean(resumeThreadId);
    if (experimentIsolation) resumeThreadId = null; // Required round facts arrive in the explicit prompt.
    await mkdir(runsDir, { recursive: true });
    await writeFile(emptyMcpConfigPath, '{"mcpServers":{}}\n', 'utf8');
    // 对 claude 而言 --add-dir 是「可读」授权通道——注意它只是把该目录显式列为工作目录，**不是**写权限的
    // 开关：实测不传任何 --add-dir 时，越界写照样成功，permission mode 也拦不住（acceptEdits / dontAsk
    // 四种 mode 全试过）。所以只读引用根必须进 --add-dir 才读得到；它的只读性由下面的工具面摘除保证，
    // 不能指望 mode 或 --add-dir 本身。
    //
    // 更正（2026-09-19）：此前这里写着「路径级 deny 在 Windows 绝对路径上不匹配」，那是我测错了。
    // 当时的四种写法都构造无效——写规则写成 Write(...)（文件权限检查从不匹配这个名字，写规则要用
    // Edit(...)，这正是 2.1.275 修掉的坑），路径又用了 `//C:/abs/**` 这种带盘符冒号的大写形式，
    // 而 Windows 路径先归一化成 POSIX 小写（C:\x → /c/x），绝对锚点是 `//c/...`。用正确写法实测是
    // 拦得住的：Read(//f/…/**) 返回 "File is in a directory that is denied by your permission
    // settings"，permissions.blockReadsOutsideWorkingDirectories 返回 "is outside ..."。见
    // .operator-studio-local/probe/boundary-read-probe/。
    //
    // 主边界用工具面摘除而不是路径规则：摘除让写能力根本不存在，比逐次调用被拒更强，也与 codex
    // 侧「沙箱里没有可写根」对齐。路径 deny 规则作为纵深防御同时写入配置根（见下方 denyRules）。
    // 两者都由 grant 派生，判定见 claude-permission-surface.mjs。
    const writableDirectories = [...new Set((additionalDirectories || []).filter(Boolean).map((directory) => path.resolve(directory)))];
    const readOnlyResolved = [...new Set((readOnlyDirectories || []).filter(Boolean).map((directory) => path.resolve(directory)))];
    const overlap = writableDirectories.filter((directory) => readOnlyResolved.includes(directory));
    if (overlap.length) {
      const error = new Error(`同一次运行不能把目录同时授予可写与只读：${overlap.join(', ')}`);
      error.code = 'CLAUDE_DIRECTORY_GRANT_CONFLICT';
      throw error;
    }
    const directories = [...new Set([...writableDirectories, ...readOnlyResolved])];
    const role = environment.OPERATOR_AGENT_ROLE || 'stage';
    const roots = environment.OPERATOR_AGENT_ROOTS ? JSON.parse(environment.OPERATOR_AGENT_ROOTS) : { workspace: path.resolve(workspace) };
    // 能力边界由 grant 派生，不由 role 名字派生：持有只读根且没有任何可写根 → 摘除写工具。
    const toolSurface = resolveClaudeToolSurface({ role, writableDirectories, readOnlyDirectories: readOnlyResolved });
    // A global Edit auto-approval grants outside writes even with read confinement.
    // Controlled runs auto-approve only declared writable paths; dontAsk refuses
    // all remaining edit requests without a prompt or an expanded grant.
    const autoApprovedTools = experimentIsolation
      ? [
        ...toolSurface.allowedTools.split(',').filter((tool) => !['Write', 'Edit'].includes(tool)),
        ...(toolSurface.writeToolsWithheld ? [] : [...new Set([path.resolve(workspace), ...writableDirectories])]
          .map((directory) => `Edit(${claudeRulePath(directory)}/**)`)),
      ].join(',') : toolSurface.allowedTools;
    // 采集阶段宣称对 Source Registry 只读，就必须真的没有可写根可用。缺根时**显式失败**，
    // 绝不让它静默落到「联网 + 有写工具」那一档——那会比改动前更宽，而不是更严。
    if (role === 'research-acquire' && readOnlyResolved.length === 0) {
      const error = new Error('research-acquire 必须携带只读引用根，否则无法保证 Source Registry 只读。');
      error.code = 'CLAUDE_ACQUIRE_GRANT_MISSING';
      throw error;
    }
    // 受保护路径（旁路的同级目录：候选工作区、基线、来源）。工具面摘除在这里不适用——研究员
    // 需要写自己的调研目录，所以它有写工具；能拦住它的只有路径级 deny 规则。这不是「纵深防御」
    // 的残余面，而是这条边界**唯一**的强制点，因此自相矛盾的授权必须显式失败而不是静默放宽。
    const protectedResolved = [...new Set((protectedDirectories || []).filter(Boolean).map((directory) => path.resolve(directory)))];
    const protectedConflict = protectedResolved.filter((directory) => writableDirectories.includes(directory));
    if (protectedConflict.length) {
      const error = new Error(`同一次运行不能把目录同时授予可写与受保护：${protectedConflict.join(', ')}`);
      error.code = 'CLAUDE_DIRECTORY_GRANT_CONFLICT';
      throw error;
    }
    // 规则是前缀匹配，无法表达「保护这个目录、但放行它里面的 cwd」。同级关系下二者不会互相包含；
    // 真出现了就跳过并登记，绝不写成一条会把 agent 自己锁在外面的规则。
    const protectedApplies = protectedResolved.filter((directory) => !path.resolve(workspace || '').startsWith(`${directory}${path.sep}`));
    const protectedSkipped = protectedResolved
      .filter((directory) => !protectedApplies.includes(directory))
      .map((directory) => ({ directory, reason: 'contains_workspace' }));
    // 配置根每次运行独立：deny 规则写在这里，共用目录会让并发的两次运行互相覆盖，
    // 「最后写者赢」会把一次运行的 deny 悄悄抹掉，而运行记录里登记的却是它写过。
    // 纵深防御：主边界是上面的工具面摘除，deny 规则覆盖「某个工具仍能走到写路径」的残余面。
    // 受保护目录走的就是这套规则——对旁路而言它是主边界。
    const denyRules = [...writeDenyRulesFor(readOnlyResolved), ...writeDenyRulesFor(protectedApplies)];
    const projection = await projectHostAuthentication(hostConfigDir, process.env, environment);
    const claudeConfigDir = await managedConfig(runId, denyRules);
    const scopedEnvironment = await createScopedGitEnvironment(workspace || process.cwd(), projection.environment, { configDir: path.join(bridgeDir, 'git-trust') });
    const runEnvironment = { ...scopedEnvironment, CLAUDE_CONFIG_DIR: claudeConfigDir };
    requireBoundarySupervisor({ environment: runEnvironment, platform: options.platform || process.platform, supervised: useJobObject });
    if (experimentIsolation) {
      runEnvironment.CLAUDE_CODE_DISABLE_AUTO_MEMORY = '1';
      // Bare/simple mode ignores bearer-token authentication. Safe mode disables
      // hidden customization discovery while retaining ordinary authentication.
      runEnvironment.CLAUDE_CODE_SIMPLE = '0';
    }
    await probeAuthentication(runEnvironment, claudeConfigDir);
    const { redactText, redactLine } = projection;
    runRedactors.set(runId, projection.redactValue);
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
      additionalDirectories: writableDirectories,
      readOnlyDirectories: readOnlyResolved,
      // 受保护目录（拒绝写入）与实际生效的拒绝规则都在这里登记，避免「提示里说了保护、实际上没下发」。
      protectedDirectories: protectedApplies,
      protectedDirectoriesSkipped: protectedSkipped,
      // 两种根都进 --add-dir，读授权是合并后的结果；记录合并值以便审计实际授权面。
      grantedDirectories: directories,
      // 登记实际使用的配置根，好让「有没有沿用宿主全局配置」可被审计而不是靠约定。
      claudeConfigDir,
      threadId: null,
      sessionId: null,
      status: 'running',
      startedAt: new Date().toISOString(),
      lastActivityAt: new Date().toISOString(),
      completedAt: null,
      eventPath: eventsPath(runId),
      permissionMode,
      // 如实登记：这次运行实际生效的能力强制面是什么。permissionMode 只记录、不作为边界。
      enforcedSurface: {
        authority: 'tool-surface',
        toolSurface: { allowedTools: toolSurface.allowedTools, disallowedTools: toolSurface.disallowedTools, writeToolsWithheld: toolSurface.writeToolsWithheld },
        denyRules,
        permissionModeIsBoundary: false,
        ...(experimentIsolation ? { experimentIsolation: {
          root: experimentRoot, autoDiscovery: 'disabled-safe-mode', autoMemory: false,
          blockReadsOutsideWorkingDirectories: true, session: 'fresh', resumeHintDiscarded,
          settingsSources: ['user'], autoApprovedTools, osSandbox: false,
        } } : {}),
      },
      boundary: { role, roots, enforcement: 'claude-tool-surface-and-config-deny' },
      activity: { kind: 'startup', status: 'running', name: 'Claude Code', summary: '正在启动候选生成智能体', updatedAt: new Date().toISOString() },
      modelObservation: observeClaudeModel({ runId, missionId, sessionId: '', events: [] }),
      diagnostics: createRunDiagnostics(runId, missionId),
      error: null,
    };
    await persistRun(runId, record);
    // 只读轮次对 Source Registry 只读：写工具从工具面整个摘掉，写入因此不是「被规则拒绝」而是
    // 「不存在该工具」。研究员的交付物是 JSON 回答，没有任何下游会读取它在采集阶段写的文件，
    // 所以摘掉写工具不影响采集结果。判定键是 grant（上面的 toolSurface），不是 role 字符串。
    const { allowedTools, disallowedTools } = toolSurface;
    const configuredMaxTurns = Number(environment.OPERATOR_CLAUDE_MAX_TURNS || process.env.OPERATOR_CLAUDE_MATERIALIZER_MAX_TURNS || 6);
    const maxTurns = role === 'materializer'
      ? Math.max(1, Math.min(20, Math.trunc(Number.isFinite(configuredMaxTurns) ? configuredMaxTurns : 6)))
      : null;
    const args = [
      '-p',
      ...(experimentIsolation ? ['--safe-mode', '--setting-sources', 'user', '--settings', path.join(claudeConfigDir, 'settings.json')] : []),
      '--output-format', 'stream-json',
      '--verbose',
      '--permission-mode', permissionMode,
      '--tools', allowedTools,
      '--allowedTools', autoApprovedTools,
      '--disallowedTools', disallowedTools,
      '--disable-slash-commands',
      '--strict-mcp-config',
      '--mcp-config', emptyMcpConfigPath,
      '--no-chrome',
      ...(maxTurns ? ['--max-turns', String(maxTurns)] : []),
      ...directories.flatMap((directory) => ['--add-dir', directory]),
      ...(resumeThreadId ? ['--resume', resumeThreadId] : []),
    ];
    if (useSupervisor) {
      record.process = usePosixSupervisor ? await createPosixProcessIdentity({ runsDir, runId, missionId }) : createClaudeProcessIdentity({ runsDir, runId, missionId });
      record.resourceRelease = { confirmed: false, status: 'active' };
      // Persist the named Job and artifact identity before any target can start.
      await persistRun(runId, record);
    }
    const child = usePosixSupervisor ? startPosixSupervisedProcess({
      identity: record.process, command, args: commandArgs(args), cwd: record.workspace,
      environment: runEnvironment, stdinText: (goal || '') + '\n',
      onIdentity: identity => { record.process = identity; return persistRun(runId, record); },
    }) : useJobObject ? startClaudeSupervisedProcess({
      identity: record.process, command, args: commandArgs(args), cwd: record.workspace,
      environment: runEnvironment, stdinText: (goal || '') + '\n',
      onIdentity: identity => { record.process = identity; return persistRun(runId, record); },
      ...(options.spawnJobObjectImpl ? { spawnJobObjectImpl: options.spawnJobObjectImpl } : {}),
    }) : spawnImpl(command, commandArgs(args), {
      cwd: record.workspace, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, env: runEnvironment,
    });
    let resolveRecordSettlement;
    const recordSettlement = new Promise(resolve => { resolveRecordSettlement = resolve; });
    let stderr = '';
    let eventBuffer = '';
    let logicalTerminal = false;
    const observePermission = createToolPermissionObserver();
    let permissionFailure = null;
    const rememberPermissionFailure = (event) => {
      const denied = observePermission(event);
      if (!denied || permissionFailure) return;
      permissionFailure = denied;
      record.status = 'failed';
      record.error = denied;
      // A logical denial is not a process-exit receipt. Runtime must settle the
      // existing cancellation barrier before it can project a terminal failure.
      record.resourceRelease = { confirmed: false, status: 'active' };
      appendChain = appendChain.then(() => persistRun(runId, record)).catch(() => {});
    };
    let appendChain = Promise.resolve();
    let lastActivityPersistedAt = Date.now();
    // The live record is exposed so the first real cancel can durably record itself
    // through the existing serialized atomic writer without delaying termination.
    liveRuns.set(runId, {
      record,
      enqueueDiagnosticPersist: () => persistRun(runId, record).catch(() => {}),
      recordSettlement,
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
          appendChain = appendChain.then(() => appendFile(eventsPath(runId), `${redactLine(line)}\n`, 'utf8')).catch(() => {});
          continue;
        }
        countDiagnosticLine(record.diagnostics.events, line, event);
        rememberPermissionFailure(event);
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
        if (!isClaudeTelemetryEvent(event)) appendChain = appendChain.then(() => appendFile(eventsPath(runId), `${redactLine(line)}\n`, 'utf8')).catch(() => {});
        if (event?.type !== 'result' || logicalTerminal) continue;
        logicalTerminal = true;
        const failed = permissionFailure || event.is_error === true || (event.subtype && event.subtype !== 'success');
        record.status = failed ? 'failed' : 'completed';
        record.error = permissionFailure || (failed ? { code: 'CLAUDE_RESULT_ERROR', message: sanitizeClaudeDiagnostic(redactText(String(event.result || event.subtype))) } : null);
        record.completedAt = new Date().toISOString();
        appendChain = appendChain.then(() => persistRun(runId, record)).catch(() => {});
      }
    });
    child.on('error', async (error) => {
      record.status = 'failed';
      record.error = permissionFailure || { code: error.code || 'CLAUDE_SPAWN_FAILED', message: sanitizeClaudeDiagnostic(redactText(String(error.message))) };
      record.completedAt = new Date().toISOString();
      await persistRun(runId, record).catch(() => {});
    });
    child.on('close', async (code, signal) => {
      if (useSupervisor && !child.jobReceipt) {
        children.delete(runId); liveRuns.delete(runId);
        record.status = 'cancel_requested'; record.completedAt = null;
        record.resourceRelease = { confirmed: false, status: 'unconfirmed',
          code: child.jobError?.code || 'CLAUDE_PROCESS_RELEASE_UNCONFIRMED',
          reason: 'Supervisor did not produce a verified whole-tree exit receipt.' };
        await persistRun(runId, record).catch(() => {}); resolveRecordSettlement(); return;
      }
      children.delete(runId);
      liveRuns.delete(runId);
      const cancelled = cancellationRequested.delete(runId);
      // A real child lifecycle receipt, captured before any queued write is awaited.
      record.diagnostics.close = {
        at: child.jobReceipt?.completedAt || new Date().toISOString(),
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
        rememberPermissionFailure(tailEvent);
        const tailMetadata = claudeModelMetadataFromEvent(tailEvent);
        if (tailMetadata) observationEvents.push(tailMetadata);
        const learnedSession = learnStreamSession(tailEvent?.session_id);
        if (tailMetadata || learnedSession) refreshModelObservation();
        if (!isClaudeTelemetryEvent(tailEvent)) appendChain = appendChain.then(() => appendFile(eventsPath(runId), `${redactLine(tailLine)}\n`, 'utf8')).catch(() => {});
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
      record.status = permissionFailure ? 'failed' : completed ? 'completed' : cancelled || signal ? 'cancelled' : 'failed';
      record.error = permissionFailure || (completed || cancelled || signal
        ? null
        : failedResult
          ? { code: 'CLAUDE_RESULT_ERROR', message: sanitizeClaudeDiagnostic(result.result || result.subtype) }
          : { code: code === 0 ? 'CLAUDE_RESULT_MISSING' : `CLAUDE_EXIT_${code}`, message: sanitizeClaudeDiagnostic(redactText(stderr)) || 'Claude Code exited without a terminal result event.' });
      if (useSupervisor) {
        const inspection = await (usePosixSupervisor ? inspectPosixProcess : inspectClaudeProcess)({ record, runsDir });
        record.resourceRelease = inspection.confirmed
          ? { confirmed: true, status: 'confirmed', source: usePosixSupervisor ? 'linux-process-group' : 'windows-job-object', reason: 'Original supervisor proved its execution group released.',
            proof: { ...inspection.receipt.releaseProof, jobName: inspection.identity.jobName, pid: inspection.identity.pid,
              processCreatedAt: inspection.identity.processCreatedAt, receiptDigest: inspection.receiptDigest } }
          : { confirmed: false, status: 'unconfirmed', code: inspection.code, reason: inspection.detail };
      } else if (permissionFailure) record.resourceRelease = { confirmed: true, status: 'confirmed' };
      record.completedAt ||= new Date().toISOString();
      await persistRun(runId, record).catch(() => {}); resolveRecordSettlement();
      runRedactors.delete(runId);
    });
    if (useSupervisor) await child.ready;
    child.stdin?.end(`${goal || ''}\n`);
    return { ...record, pid: child.pid || null };
  };

  const readRun = async (runId) => {
    await runWriteChains.get(runId)?.catch(() => {});
    const fenced = await jobLossRetirement.readFencedRun(runId);
    if (fenced) return fenced;
    const record = JSON.parse(await readFile(runPath(runId), 'utf8'));
    if (children.has(runId)) return record;
    const posix = record.process?.schemaVersion === POSIX_AGENT_PROCESS_SCHEMA;
    if (!posix && record.process?.schemaVersion !== CLAUDE_PROCESS_SCHEMA) return hostRecovery.project(record);
    const inspection = await (posix ? inspectPosixProcess : inspectClaudeProcess)({ record, runsDir });
    const recovered = (posix ? recoverPosixProcessRecord : recoverClaudeProcessRecord)(record, inspection, parseLines(await readFile(eventsPath(runId), 'utf8').catch(() => '')));
    if (recovered !== record) {
      await appendFile(eventsPath(runId), JSON.stringify({ type: 'system', subtype: 'process_recovered',
        runId, missionId: record.missionId, recovery: recovered.processRecovery }) + '\n', 'utf8');
      await persistRun(runId, recovered);
      return recovered;
    }
    if (!inspection.confirmed) return { ...record, processInspection: { state: inspection.state, code: inspection.code || null,
      observation: inspection.observation || null }, resourceRelease: { confirmed: false,
      status: inspection.state === 'active' ? 'active' : 'unconfirmed', code: inspection.code || null,
      reason: inspection.detail || 'Owned Job remains active.' } };
    return record;
  };
  const readEvents = async (runId) => await jobLossRetirement.readFence(runId) ? []
    : normalizeClaudeEvents(parseLines(await readFile(eventsPath(runId), 'utf8').catch(() => '')));
  const cancel = async (runId, context) => {
    if (await jobLossRetirement.readFence(runId)) throw Object.assign(new Error('This execution is permanently fenced; cancellation cannot resume or rewrite it.'), { code: 'AGENT_EXECUTION_RETIRED', status: 409 });
    const child = children.get(runId);
    let terminationRecovery = null;
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
      if (useJobObject) {
        terminationRecovery = await terminateClaudeProcessWithReceipt({ record: live?.record, runsDir,
          terminate: () => terminateProcessTree(child) });
      } else await terminateProcessTree(child);
      await cancellationWrite;
      // Native supervision settles the verified terminal receipt before return.
      // Legacy injected children may emit close after their termination port
      // resolves; preserve a truthful pending request without inventing close.
      if (useSupervisor) await live?.recordSettlement;
    }
    let record = await readRun(runId);
    if (!child && record.process?.schemaVersion === POSIX_AGENT_PROCESS_SCHEMA && record.processInspection?.state === 'active') {
      await requestPosixCancellation({ record, runsDir });
      record = await readRun(runId);
    }
    if (!child && record.process?.schemaVersion === CLAUDE_PROCESS_SCHEMA && record.processInspection?.state === 'active') {
      // Restart recovery cancels the verified named Job, never a bare/reused PID.
      terminationRecovery = await terminateClaudeProcessWithReceipt({ record, runsDir,
        terminate: () => terminateJobObject(record.process.jobName) });
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        try { await stat(record.process.receiptPath); break; } catch (error) { if (error.code !== 'ENOENT') throw error; }
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      record = await readRun(runId);
    }
    if (terminationRecovery) {
      record = { ...record, processTerminationRecovery: terminationRecovery };
      await persistRun(runId, record);
    }
    return { ...record, status: child && record.resourceRelease?.confirmed !== true ? 'cancel_requested' : record.status };
  };

  const localHostRecovery = async (runId, action) => {
    if (!['capture', 'recover'].includes(action) || children.has(runId)) throw Object.assign(new Error('Only an inactive legacy local run can use capture/recover.'), { code: 'LOCAL_HOST_RECOVERY_INELIGIBLE', status: 409 });
    const outcome = await hostRecovery[action](runId);
    return { ...outcome, run: await readRun(runId) };
  };
  return { command, permissionMode, describe, preflight, start, readRun, readEvents, cancel, localHostRecovery,
    retireExecution: (runId, context) => context ? jobLossRetirement.retire({ ...context, runId }) : executionRetirement.retire(runId), eventText: claudeEventText };
};

export const claudeClient = createClaudeClient();
