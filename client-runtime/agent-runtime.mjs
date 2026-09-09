import { lstat, mkdir, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { isExecutionReleased, assertResourcesReleased, reconcileResourceRelease } from './cancellation-contract.mjs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { opencodeClient as defaultOpenCodeClient, parseOpenCodeModel } from './opencode-client.mjs';
import { classifyCodexFailure, codexClient as defaultCodexClient } from './codex-client.mjs';
import { classifyClaudeFailure, claudeClient as defaultClaudeClient } from './claude-client.mjs';
import { parseAgentResult, parseBaselineMaterializerResult, parseResearchResult } from './agent-result.mjs';
import { runtimeDir } from './storage-paths.mjs';
import { workspaceManager } from './workspace-manager.mjs';
import { materializeBaselineSource } from './baseline-materializer.mjs';
import { prepareAgentBoundary } from './agent-boundary.mjs';
import { loadSourceMirrorPolicy, normalizeRepositoryIdentity, resolveSourceTransport, verifySourceTransportSnapshot } from './source-mirror-policy.mjs';
import { buildCandidateGenerationPrompt } from './candidate-generation/prompt.mjs';
import { candidateWorkspaceRequirements, finalizeCandidateAdmission, inspectCandidateDiff } from './candidate-generation/admission.mjs';
import { testSpecAgentInstruction } from './test-spec.mjs';
import { formatExperienceContext } from './experience-contract.mjs';
import { fixedOperatorPrompt } from './fixed-operator-profiles.mjs';
import { recordRunTokenUsage } from './token-usage.mjs';
import { runtimeRegistry } from './agent-runtime/registry.mjs';
import { createAgentRuntimeEngine } from './agent-runtime/engine.mjs';
import { isManagedWorkspaceRuntimeMode, normalizeAgentRuntimeMode } from './agent-runtime/capabilities.mjs';
import { appendRuntimeEvent } from './runtime-events.mjs';

export { isManagedWorkspaceRuntimeMode } from './agent-runtime/capabilities.mjs';
export { appendRuntimeEvent } from './runtime-events.mjs';

const serverDir = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(serverDir, '..');
const defaultBridgeDir = path.join(runtimeDir, 'agent-bridge');

const fileExists = async (target) => {
  try { return (await stat(target)).isFile(); } catch { return false; }
};

const directoryExists = async (target) => {
  try { return (await stat(target)).isDirectory(); } catch { return false; }
};

const readJson = async (target) => JSON.parse(await readFile(target, 'utf8'));

const summarizeAcquiredSources = (sources = []) => sources.map((source) => ({
  name: source.name,
  selectionMode: source.selectionMode,
  repository: source.repository,
  canonicalRepository: source.canonicalRepository,
  transportRepository: source.transportRepository,
  transportMode: source.transportMode,
  mirrorVerified: source.mirrorVerified,
  pin: source.pin,
  commit: source.commit,
  tree: source.tree,
  evidencePaths: (source.evidence || []).map((entry) => entry.path),
  evidenceCount: (source.evidence || []).length,
}));

const finalAgentJson = (events = []) => {
  const texts = events.map((event) => event?.item?.text || event?.text || '').filter(Boolean).reverse();
  for (const text of texts) {
    try { return JSON.parse(text); } catch { /* try the next assistant message */ }
  }
  return null;
};

const collectSourceEvidence = async (sourceDirectory, requestedPaths = []) => {
  const evidence = [];
  const collect = async (paths, discovery) => {
    for (const relativePath of paths) {
      if (evidence.length >= 8 || evidence.reduce((total, item) => total + item.content.length, 0) >= 120_000) break;
      if (path.isAbsolute(relativePath) || relativePath.split('/').includes('..')) continue;
      const target = path.resolve(sourceDirectory, relativePath);
      if (!target.startsWith(`${sourceDirectory}${path.sep}`)) continue;
      const [info, resolvedTarget, resolvedRoot] = await Promise.all([
        lstat(target).catch(() => null),
        realpath(target).catch(() => null),
        realpath(sourceDirectory),
      ]);
      if (!info?.isFile() || info.isSymbolicLink() || info.size > 2_000_000) continue;
      if (!resolvedTarget || !(resolvedTarget === resolvedRoot || resolvedTarget.startsWith(`${resolvedRoot}${path.sep}`))) continue;
      const content = await readFile(target, 'utf8').catch(() => '');
      if (content) evidence.push({ path: relativePath, content: content.slice(0, 40_000), truncated: content.length > 40_000, discovery });
    }
  };
  await collect(requestedPaths, 'agent-selected');
  if (!evidence.length) {
    const trackedFiles = (await workspaceManager.git(['ls-files'], sourceDirectory)).stdout.split(/\r?\n/).filter(Boolean);
    const candidates = trackedFiles
      .filter((file) => /\.(?:py|cu|cuh|cc|cpp|h|hpp|md|rst)$/i.test(file))
      .map((file) => {
        const lower = file.toLowerCase();
        const score = (lower.includes('mla') ? 20 : 0)
          + (lower.includes('paged') ? 8 : 0)
          + (lower.includes('attention') ? 4 : 0)
          + (lower.includes('decode') ? 3 : 0)
          + (lower.includes('test') ? 1 : 0);
        return { file: file.replaceAll('\\', '/'), score };
      })
      .filter((entry) => entry.score >= 20)
      .sort((left, right) => right.score - left.score || left.file.localeCompare(right.file))
      .slice(0, 24);
    const semanticallyRelevant = [];
    for (const candidate of candidates) {
      const content = await readFile(path.join(sourceDirectory, candidate.file), 'utf8').catch(() => '');
      if (/mla/i.test(content) && /pag(?:e|ed|ing)|kv.?cache/i.test(content)) semanticallyRelevant.push(candidate.file);
      if (semanticallyRelevant.length >= 8) break;
    }
    await collect(semanticallyRelevant, 'fixed-workflow-discovery');
  }
  return evidence;
};

export const acquireSelectedSources = async ({ events, sourceRoot, researchDir, mirrorPolicy, allowDiscoveredSources = false, allowSemanticFallback = false }) => {
  const result = finalAgentJson(events);
  const repositories = result?.sourceAcquisition?.repositories;
  if (!Array.isArray(repositories) || repositories.length > 3 || (!repositories.length && !allowSemanticFallback)) {
    const error = new Error(allowSemanticFallback
      ? 'Research Agent 必须返回 repositories 数组（允许为空并进入语义 fallback）。'
      : 'Research Agent 必须选择 1-3 个可验证的上游 Git 仓库。');
    error.code = 'RESEARCH_SOURCE_SELECTION_INVALID';
    throw error;
  }
  await mkdir(sourceRoot, { recursive: true });
  const acquired = [];
  const failures = [];
  for (const repository of repositories) {
    const url = String(repository.url || '').trim();
    const name = String(repository.name || '').trim();
    const localSelection = repository.location === 'local' || repository.reuseLocal === true;
    let temporaryDirectory = null;
    try {
      if (!/^[A-Za-z0-9_.-]+$/.test(name)) {
        const error = new Error(`Research Agent 返回了不受支持的来源：${url || name}`);
        error.code = 'RESEARCH_SOURCE_SELECTION_UNSAFE';
        throw error;
      }
      const destination = path.resolve(sourceRoot, name);
      if (!destination.startsWith(`${path.resolve(sourceRoot)}${path.sep}`)) throw new Error('Research source destination escaped Source Registry.');
      let sourceDirectory = destination;
      let transport;
      if (localSelection) {
        if (!await directoryExists(path.join(destination, '.git'))) {
          const error = new Error(`本地 Source Registry 中不存在 Git 来源：${name}`);
          error.code = 'RESEARCH_LOCAL_SOURCE_MISSING';
          throw error;
        }
        const [localOrigin, configuredCanonical] = await Promise.all([
          workspaceManager.git(['config', '--get', 'remote.origin.url'], destination).then((entry) => entry.stdout.trim()).catch(() => ''),
          workspaceManager.git(['config', '--get', 'operatorStudio.canonicalRepository'], destination).then((entry) => entry.stdout.trim()).catch(() => ''),
        ]);
        if (!localOrigin) {
          const error = new Error(`本地来源 ${name} 缺少可审计的 HTTPS origin；调查员可改选远程来源或进入语义 fallback。`);
          error.code = 'RESEARCH_LOCAL_SOURCE_IDENTITY_MISSING';
          throw error;
        }
        resolveSourceTransport(localOrigin, { configured: false, requireMirror: false, mirrors: [] }, { allowDiscoveredSources: true });
        transport = resolveSourceTransport(configuredCanonical || localOrigin, mirrorPolicy, { allowDiscoveredSources: true });
        if (normalizeRepositoryIdentity(transport.transport) !== normalizeRepositoryIdentity(localOrigin)) {
          const error = new Error(`本地来源 ${name} 的 origin 与配置的来源 transport 不一致。`);
          error.code = 'RESEARCH_LOCAL_SOURCE_TRANSPORT_MISMATCH';
          throw error;
        }
      } else {
        transport = resolveSourceTransport(url, mirrorPolicy, { allowDiscoveredSources });
        if (await stat(destination).catch(() => null)) {
          const error = new Error(`Source Registry 已存在同名来源：${name}`);
          error.code = 'RESEARCH_SOURCE_DESTINATION_EXISTS';
          throw error;
        }
        temporaryDirectory = `${destination}.acquiring-${randomUUID()}`;
        let cloneError = null;
        for (let attempt = 1; attempt <= 3; attempt += 1) {
          try {
            await workspaceManager.git(['-c', 'core.longpaths=true', 'clone', '--depth=1', '--filter=blob:none', transport.transport, temporaryDirectory], sourceRoot, { timeout: 180_000 });
            cloneError = null;
            break;
          } catch (error) {
            cloneError = error;
            await rm(temporaryDirectory, { recursive: true, force: true }).catch(() => {});
            if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, attempt * 750));
          }
        }
        if (cloneError) {
          cloneError.code = cloneError.code || 'RESEARCH_SOURCE_CLONE_FAILED';
          throw cloneError;
        }
        sourceDirectory = temporaryDirectory;
        const clonedHead = await workspaceManager.git(['rev-parse', 'HEAD'], sourceDirectory).then((entry) => entry.stdout.trim());
        if (transport.requiredCommit && clonedHead.toLowerCase() !== transport.requiredCommit) {
          try {
            await workspaceManager.git(['fetch', '--depth=1', 'origin', transport.requiredCommit], sourceDirectory, { timeout: 180_000 });
            await workspaceManager.git(['checkout', '--detach', transport.requiredCommit], sourceDirectory, { timeout: 60_000 });
          } catch (error) {
            error.code = 'SOURCE_MIRROR_COMMIT_UNAVAILABLE';
            throw error;
          }
        }
      }
      const [head, tree, origin] = await Promise.all([
        workspaceManager.git(['rev-parse', 'HEAD'], sourceDirectory).then((entry) => entry.stdout.trim()),
        workspaceManager.git(['rev-parse', 'HEAD^{tree}'], sourceDirectory).then((entry) => entry.stdout.trim()),
        workspaceManager.git(['config', '--get', 'remote.origin.url'], sourceDirectory).then((entry) => entry.stdout.trim()).catch(() => transport.transport),
      ]);
      const snapshot = verifySourceTransportSnapshot({ resolution: transport, commit: head, tree });
      await workspaceManager.git(['config', 'operatorStudio.canonicalRepository', snapshot.canonicalRepository], sourceDirectory);
      await workspaceManager.git(['config', 'operatorStudio.transportRepository', origin || transport.transport], sourceDirectory);
      await workspaceManager.git(['config', 'operatorStudio.sourceTree', snapshot.tree], sourceDirectory);
      const requestedPaths = [...new Set((repository.evidencePaths || []).map((value) => String(value || '').replaceAll('\\', '/').replace(/^\.\//, '')).filter(Boolean))].slice(0, 8);
      const evidence = await collectSourceEvidence(sourceDirectory, requestedPaths);
      if (!evidence.length) {
        const error = new Error(`Research Agent 没有为 ${name} 提供可读取的源码证据路径。`);
        error.code = 'RESEARCH_SOURCE_EVIDENCE_MISSING';
        throw error;
      }
      if (!localSelection) await rename(sourceDirectory, destination);
      temporaryDirectory = null;
      acquired.push({
        name,
        selectionMode: localSelection ? 'local' : 'remote',
        repository: snapshot.canonicalRepository,
        canonicalRepository: snapshot.canonicalRepository,
        transportRepository: snapshot.transportRepository,
        transportMode: snapshot.mode,
        mirrorVerified: snapshot.mirrorVerified,
        pin: snapshot.pin,
        commit: snapshot.commit,
        tree: snapshot.tree,
        reason: String(repository.reason || ''),
        requestedEvidencePaths: requestedPaths,
        evidence,
      });
    } catch (error) {
      if (temporaryDirectory) await rm(temporaryDirectory, { recursive: true, force: true }).catch(() => {});
      if (!allowSemanticFallback) throw error;
      failures.push({ name: name || null, repository: url || null, code: error.code || 'RESEARCH_SOURCE_ACQUISITION_FAILED', detail: String(error.message || error).slice(0, 800) });
    }
  }
  const semanticFallback = acquired.length ? null : {
    allowed: allowSemanticFallback,
    requested: result?.sourceAcquisition?.semanticFallback === true || repositories.length === 0 || failures.length > 0,
    reason: String(result?.sourceAcquisition?.fallbackReason || failures[0]?.detail || 'No usable local or remote source was acquired.').slice(0, 1_000),
  };
  const manifestPath = path.join(researchDir, 'acquisition-result.json');
  await writeFile(manifestPath, `${JSON.stringify({ schemaVersion: 2, strategy: 'local-first-agent-discovery', acquired, failures, semanticFallback }, null, 2)}\n`, 'utf8');
  return acquired;
};

const loadMaterializerSourceEvidence = async ({ sourceRoot, source }) => {
  const inspection = await workspaceManager.inspectSources(sourceRoot, [source]);
  const reference = inspection.references?.[0];
  if (!inspection.ready || !reference?.verified) {
    const error = new Error(reference?.detail || inspection.errors?.[0]?.detail || 'Baseline source reference is not verified.');
    error.code = reference?.code || inspection.errors?.[0]?.code || 'BASELINE_SOURCE_NOT_VERIFIED';
    throw error;
  }
  const registered = inspection.sources.find((entry) => entry.id === reference.sourceId);
  const relativePath = String(source.path || '').replaceAll('\\', '/').replace(/^\.\//, '');
  const target = path.resolve(registered.path, relativePath);
  const [info, resolvedTarget, resolvedRoot] = await Promise.all([
    lstat(target).catch(() => null),
    realpath(target).catch(() => null),
    realpath(registered.path).catch(() => null),
  ]);
  const contained = resolvedTarget && resolvedRoot && (resolvedTarget === resolvedRoot || resolvedTarget.startsWith(`${resolvedRoot}${path.sep}`));
  if (!info?.isFile() || info.isSymbolicLink() || !contained || info.size > 4_000_000) {
    const error = new Error('Authoritative baseline reference must resolve to a bounded source file.');
    error.code = 'BASELINE_SOURCE_FILE_INVALID';
    throw error;
  }
  const content = await readFile(target, 'utf8');
  return {
    repository: registered.repository,
    canonicalRepository: registered.canonicalRepository,
    transportRepository: registered.transportRepository,
    transportMode: registered.transportMode,
    mirrorVerified: registered.mirrorVerified,
    commit: registered.commit,
    tree: registered.tree,
    path: relativePath,
    content: content.slice(0, 96_000),
    truncated: content.length > 96_000,
  };
};

const readMaterializerWorkspaceResult = async (materializer = {}, events = []) => {
  const directory = path.resolve(String(materializer.materializationDir || ''));
  if (!materializer.materializationDir) return null;
  const runPyPath = path.join(directory, 'run.py');
  const runPyInfo = await lstat(runPyPath).catch(() => null);
  if (!runPyInfo?.isFile() || runPyInfo.isSymbolicLink() || runPyInfo.size === 0 || runPyInfo.size > 1_000_000) return null;
  const runPy = await readFile(runPyPath, 'utf8');
  if (!runPy.trim()) return null;

  const reportPath = path.join(directory, 'materializer-report.json');
  const reportInfo = await lstat(reportPath).catch(() => null);
  let report = null;
  if (reportInfo?.isFile() && !reportInfo.isSymbolicLink() && reportInfo.size > 0 && reportInfo.size <= 128_000) {
    report = JSON.parse(await readFile(reportPath, 'utf8'));
  }
  const finalResult = parseBaselineMaterializerResult(events);
  return {
    schemaVersion: 'operator-studio.baseline-materializer-result/v2',
    format: 'workspace-artifact',
    summary: report?.summary || finalResult.summary || 'Baseline materializer 已写入单文件。',
    runPy,
    report: report || finalResult.report || {},
    rawText: finalResult.rawText,
  };
};

const hasValidStatusDocument = async (target) => {
  if (!await fileExists(target)) return false;
  try {
    const document = await readJson(target);
    const status = document.status || document.state || document.task?.status;
    return Boolean(status && runtimeStatusMap[status]);
  } catch { return false; }
};

const hasValidQueue = async (target) => {
  if (!await fileExists(target)) return false;
  try {
    const lines = (await readFile(target, 'utf8')).split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    return lines.every((line) => {
      const task = JSON.parse(line);
      return task && typeof task === 'object';
    });
  } catch { return false; }
};

const hasValidCanonicalRecords = async (target) => {
  if (!await fileExists(target)) return false;
  try {
    const records = await readJson(target);
    return Array.isArray(records) ? records.length > 0 : Boolean(records && typeof records === 'object' && Object.keys(records).length > 0);
  } catch { return false; }
};

const runtimeStatusMap = {
  created: 'idle',
  planning: 'running',
  running: 'running',
  paused: 'paused',
  blocked: 'blocked',
  completed: 'completed',
  cancelled: 'cancelled',
  failed: 'failed',
  awaiting_approval: 'awaiting_approval',
};

const ACTIVE_MAIN_AGENT_STATUSES = new Set(['running', 'executing', 'awaiting_action', 'cancel_requested', 'awaiting_approval']);
const ACTIVE_RESEARCH_AGENT_STATUSES = new Set(['running', 'cancel_requested']);
const ACTIVE_BASELINE_MATERIALIZER_STATUSES = new Set(['running', 'cancel_requested']);
const MAX_CANCELLATION_RETRIES = 3;
const MAIN_AGENT_BUDGET_MS = 10 * 60 * 1000;
const NON_RECOVERABLE_MANAGED_FAILURE_CODES = new Set([
  'CLAUDE_AUTH_FAILED',
  'CLAUDE_ACCESS_DENIED',
  'CLAUDE_RATE_LIMITED',
  'CLAUDE_BILLING_UNAVAILABLE',
  'CLAUDE_NETWORK_FAILED',
  'CLAUDE_SPAWN_FAILED',
  'CODEX_AUTH_FAILED',
  'CODEX_ACCESS_DENIED',
  'CODEX_RATE_LIMITED',
  'CODEX_BILLING_UNAVAILABLE',
  'CODEX_NETWORK_FAILED',
  'CODEX_SPAWN_FAILED',
]);
const DEFAULT_MAIN_AGENT_STALL_MS = 2 * 60 * 1000;

export const isMainAgentActive = (agent = {}) => Boolean(agent?.runId && ACTIVE_MAIN_AGENT_STATUSES.has(agent?.status));
export const isResearchAgentActive = (agent = {}) => Boolean(agent?.runId && ACTIVE_RESEARCH_AGENT_STATUSES.has(agent?.status));
export function createAgentRuntime(options = {}) {
  // Claude Code is the production tester default. Codex remains available as
  // an explicit compatibility override via OPERATOR_RUNTIME_MODE=codex-cli.
  const mode = normalizeAgentRuntimeMode(options.mode || process.env.OPERATOR_RUNTIME_MODE || 'claude-code');
  const cliRoot = options.cliRoot || process.env.OPERATOR_CLI_ROOT || '';
  const bridgeDir = options.bridgeDir || process.env.OPERATOR_BRIDGE_DIR || defaultBridgeDir;
  const statusPath = cliRoot ? path.join(cliRoot, process.env.OPERATOR_CLI_STATUS_FILE || 'results/agent_status_cli_integration.json') : '';
  const queuePath = cliRoot ? path.join(cliRoot, process.env.OPERATOR_CLI_QUEUE_FILE || 'results/test_queue.jsonl') : '';
  const recordsPath = cliRoot ? path.join(cliRoot, process.env.OPERATOR_CLI_RECORDS_FILE || 'docs/optimization_records.json') : '';
  const openCodeClient = options.opencodeClient || defaultOpenCodeClient;
  const openCodeAgent = options.openCodeAgent || process.env.OPENCODE_AGENT || 'plan';
  const openCodeModel = options.openCodeModel || process.env.OPENCODE_MODEL || '';
  const codex = options.codexClient || defaultCodexClient;
  const claude = options.claudeClient || defaultClaudeClient;
  const codexWorkspace = options.codexWorkspace || process.env.OPERATOR_CODEX_WORKSPACE || rootDir;
  const runtimeDefinition = runtimeRegistry.get(mode);
  const runtimeClients = { codex, claude, opencode: openCodeClient };
  const runtimeEngine = createAgentRuntimeEngine({ registry: runtimeRegistry, clients: runtimeClients });
  const activeStartMissions = new Map();
  const managedCliMode = runtimeDefinition?.managedWorkspace === true;
  const managedMeta = managedCliMode
    ? { name: runtimeDefinition.name, slug: runtimeDefinition.slug, unavailableCode: runtimeDefinition.unavailableCode }
    : null;
  const defaultMainAgentStallMs = runtimeDefinition?.defaultStallMs || DEFAULT_MAIN_AGENT_STALL_MS;
  const configuredMainAgentStallMs = Number(options.mainAgentStallMs ?? process.env.OPERATOR_MAIN_AGENT_STALL_MS ?? defaultMainAgentStallMs);
  const mainAgentStallMs = Number.isFinite(configuredMainAgentStallMs) && configuredMainAgentStallMs > 0
    ? configuredMainAgentStallMs
    : defaultMainAgentStallMs;
  const configuredMainAgentBudgetMs = Number(options.mainAgentBudgetMs ?? process.env.OPERATOR_MAIN_AGENT_BUDGET_MS ?? MAIN_AGENT_BUDGET_MS);
  const mainAgentBudgetMs = Number.isFinite(configuredMainAgentBudgetMs) && configuredMainAgentBudgetMs > 0
    ? configuredMainAgentBudgetMs
    : MAIN_AGENT_BUDGET_MS;
  let sourceMirrorPolicyPromise = null;
  const sourceMirrorPolicy = async () => {
    if (options.sourceMirrorPolicy) return options.sourceMirrorPolicy;
    sourceMirrorPolicyPromise ||= loadSourceMirrorPolicy({ configPath: options.sourceMirrorConfigPath ?? process.env.OPERATOR_SOURCE_MIRROR_CONFIG });
    return sourceMirrorPolicyPromise;
  };
  const codexDescriptorTtlMs = Number(options.codexDescriptorTtlMs ?? 60_000);
  let codexDescriptorCache = null;
  let codexDescriptorCachedAt = 0;
  let claudeDescriptorCache = null;
  let claudeDescriptorCachedAt = 0;
  const openCodeDescriptorTtlMs = Number(options.openCodeDescriptorTtlMs ?? 5_000);
  let openCodeDescriptorCache = null;
  let openCodeDescriptorCachedAt = 0;
  const lastManagedActivityAt = (run, previous, eventAdvanced) => {
    if (eventAdvanced) return Date.now();
    const heartbeat = Date.parse(run?.lastActivityAt || '');
    return Math.max(Number(previous || 0), Number.isFinite(heartbeat) ? heartbeat : 0) || Date.now();
  };

  const describeOpenCode = async () => {
    if (openCodeDescriptorCache && Date.now() - openCodeDescriptorCachedAt < openCodeDescriptorTtlMs) return openCodeDescriptorCache;
    try {
      const [health, providers] = await Promise.all([
        runtimeEngine.invoke('opencode-server', 'health'),
        runtimeEngine.invoke('opencode-server', 'providers'),
      ]);
      const model = parseOpenCodeModel(openCodeModel);
      const configuredProviders = Array.isArray(providers?.connected) ? providers.connected : [];
      openCodeDescriptorCache = {
        mode: 'opencode-server',
        label: 'OpenCode Agent Runtime',
        status: health?.healthy ? 'connected' : 'degraded',
        connected: Boolean(health?.healthy),
        liveHardware: false,
        authority: 'opencode',
        transport: 'OpenCode HTTP API',
        actionBridge: 'mission-and-observation',
        projection: 'session-messages-tools-diff',
        version: health?.version || null,
        endpoint: openCodeClient.baseUrl,
        agent: openCodeAgent,
        model: openCodeModel || null,
        providerConfigured: model ? configuredProviders.includes(model.providerID) : configuredProviders.length > 0,
        capabilities: ['mission.run', 'session.status', 'message.read', 'tool.read', 'diff.read'],
        roleCapabilities: structuredClone(runtimeRegistry.require('opencode-server').capabilities),
        hint: model
          ? `OpenCode Server 已连接；使用 ${model.providerID}/${model.modelID}。Patch 与 Decision 回传尚未启用。`
          : 'OpenCode Server 已连接；请设置 OPENCODE_MODEL=provider/model。Patch 与 Decision 回传尚未启用。',
      };
    } catch (error) {
      openCodeDescriptorCache = {
        mode: 'opencode-server',
        label: 'OpenCode Agent Runtime',
        status: 'unavailable',
        connected: false,
        liveHardware: false,
        authority: 'opencode',
        transport: 'OpenCode HTTP API',
        actionBridge: 'none',
        projection: 'none',
        endpoint: openCodeClient.baseUrl,
        capabilities: [],
        roleCapabilities: structuredClone(runtimeRegistry.require('opencode-server').capabilities),
        error: error.message,
        hint: `请先启动 opencode serve，并确认 ${openCodeClient.baseUrl}/global/health 可访问。`,
      };
    }
    openCodeDescriptorCachedAt = Date.now();
    return openCodeDescriptorCache;
  };

  const describeCodex = async () => {
    if (codexDescriptorCache && Date.now() - codexDescriptorCachedAt < codexDescriptorTtlMs) return codexDescriptorCache;
    const probe = await runtimeEngine.invoke('codex-cli', 'describe');
    const restrictedUserContext = Boolean(probe.userContext?.restricted);
    const connected = Boolean(probe.installed) && !restrictedUserContext;
    const hint = restrictedUserContext
      ? '当前服务运行在受限自动化账户下，无法读取你的本机 Codex 配置。请从正常 Windows 用户终端启动 Operator Studio；无需向项目注入密钥。'
      : connected
        ? 'Codex CLI 已就绪；Provider、模型与认证完全沿用本机 Codex 配置。'
        : '未发现 Codex CLI，请安装并确保 codex 命令在 PATH 中。';
    codexDescriptorCache = {
      mode: 'codex-cli',
      label: 'Codex Agent Runtime',
      status: connected ? 'connected' : 'unavailable',
      connected,
      liveHardware: false,
      authority: 'codex-cli',
      transport: 'Codex stdio JSONL',
      actionBridge: 'mission-and-client-workflow',
      projection: 'thread-events-tools-artifacts',
      version: probe.version || null,
      workspace: codexWorkspace,
      stallTimeoutMs: mainAgentStallMs,
      capabilities: connected ? ['mission.run', 'mission.resume', 'event.read', 'tool.read', 'candidate.observe', 'workflow.decide', 'workflow.intervene', 'workflow.rollback'] : [],
      roleCapabilities: structuredClone(runtimeRegistry.require('codex-cli').capabilities),
      hint,
      configurationAuthority: 'local-codex',
      authProbe: restrictedUserContext ? 'restricted-user-context' : probe.loggedIn ? 'official-login-detected' : 'delegated-to-local-codex',
      probe: { installed: Boolean(probe.installed), officialLoginDetected: Boolean(probe.loggedIn), restrictedUserContext },
    };
    codexDescriptorCachedAt = Date.now();
    return codexDescriptorCache;
  };

  const describeClaude = async () => {
    if (claudeDescriptorCache && Date.now() - claudeDescriptorCachedAt < codexDescriptorTtlMs) return claudeDescriptorCache;
    const probe = await runtimeEngine.invoke('claude-code', 'describe');
    const connected = Boolean(probe.installed) && probe.loggedIn !== false;
    claudeDescriptorCache = {
      mode: 'claude-code',
      label: 'Claude Code Agent Runtime',
      status: connected ? 'connected' : 'unavailable',
      connected,
      liveHardware: false,
      authority: 'claude-code',
      transport: 'Claude Code stdio stream-json',
      actionBridge: 'mission-and-client-workflow',
      projection: 'session-events-tools-artifacts',
      version: probe.version || null,
      workspace: codexWorkspace,
      stallTimeoutMs: mainAgentStallMs,
      capabilities: connected ? ['mission.run', 'mission.resume', 'research.run', 'materializer.run', 'event.read', 'tool.read', 'candidate.observe', 'workflow.decide', 'workflow.intervene', 'workflow.rollback'] : [],
      roleCapabilities: structuredClone(runtimeRegistry.require('claude-code').capabilities),
      hint: connected
        ? 'Claude Code CLI 已就绪；模型、网关与认证沿用测试机的 Claude Code 配置。'
        : '未发现 Claude Code CLI，请安装并确保 claude 命令在 PATH 中。',
      configurationAuthority: 'local-claude-code',
      authProbe: probe.loggedIn ? 'official-login-detected' : 'authentication-unavailable',
      probe: { installed: Boolean(probe.installed), officialLoginDetected: Boolean(probe.loggedIn) },
    };
    claudeDescriptorCachedAt = Date.now();
    return claudeDescriptorCache;
  };

  const managedDescribers = { claude: describeClaude, codex: describeCodex };
  const failureClassifiers = { claude: classifyClaudeFailure, codex: classifyCodexFailure };
  const describeManagedRuntime = () => managedDescribers[runtimeDefinition.clientKey]();
  const classifyManagedFailure = (run, events) => failureClassifiers[runtimeDefinition.failureClassifier](run, events);

  const describe = async () => {
    if (mode === 'reference-fixture') {
      return {
        mode: 'reference-fixture',
        label: '本地参考 Runtime',
        status: 'ready',
        connected: true,
        liveHardware: false,
        authority: 'test-fixture-only',
        transport: 'in-process events',
        actionBridge: 'reference-only',
        projection: 'reference-state',
        capabilities: ['mission.run', 'event.sequence', 'artifact.mock', 'patch.mock', 'benchmark.mock', 'decision.mock'],
      };
    }

    if (mode === 'opencode-server') return describeOpenCode();
    if (managedCliMode) return describeManagedRuntime();

    if (mode !== 'cli-file') {
      return {
        mode: 'unavailable',
        label: 'Agent not connected',
        status: 'unavailable',
        connected: false,
        liveHardware: false,
        authority: 'none',
        transport: 'none',
        actionBridge: 'none',
        projection: 'none',
        capabilities: [],
        hint: 'Set OPERATOR_RUNTIME_MODE=cli-file and OPERATOR_CLI_ROOT to connect the validated CLI Agent.',
      };
    }

    const rootReady = Boolean(cliRoot) && await directoryExists(cliRoot);
    const probes = {
      agentStatus: Boolean(statusPath) && await hasValidStatusDocument(statusPath),
      testQueue: Boolean(queuePath) && await hasValidQueue(queuePath),
      canonicalRecords: Boolean(recordsPath) && await hasValidCanonicalRecords(recordsPath),
    };
    const connected = rootReady && probes.agentStatus && probes.testQueue && probes.canonicalRecords;
    return {
      mode: 'cli-file',
      label: 'CLI Agent Runtime',
      status: connected ? 'connected' : rootReady ? 'degraded' : 'unavailable',
      connected,
      liveHardware: false,
      authority: 'flashinfer-cli',
      transport: 'file projection',
      actionBridge: 'mission-request-only',
      projection: 'agent-status-only',
      probes,
      capabilities: ['mission.request', 'agent.status', 'queue.probe', 'canonical.probe'],
      hint: connected ? '已连接 CLI 文件投影；Patch、Benchmark、Decision 动作桥尚未启用。' : '请设置 OPERATOR_CLI_ROOT，并确认 status、queue 与 canonical records 文件存在。',
    };
  };

  const preflight = async ({ workspace }) => {
    const descriptor = await describe();
    if (!descriptor.connected) {
      return { ready: false, code: 'AGENT_RUNTIME_UNAVAILABLE', detail: descriptor.hint || 'Agent Runtime 不可用。', runtime: descriptor, workspace };
    }
    if (managedCliMode) {
      const result = await runtimeEngine.invoke(mode, 'preflight', { workspace });
      return { ...result, runtime: descriptor };
    }
    return { ready: true, code: 'AGENT_RUNTIME_READY', runtime: descriptor, workspace };
  };

  const startRun = async ({ state, mission, goal, resumeThreadId = null, workspace: requestedWorkspace = null, experienceContext = null }) => {
    assertResourcesReleased(state);
    const activeStartAt = activeStartMissions.get(mission.id);
    if (activeStartAt && Date.now() - activeStartAt < 120_000) {
      const error = new Error('该 Mission 已有 Agent 启动请求在处理中。');
      error.status = 409;
      error.code = 'AGENT_RUN_START_ALREADY_IN_FLIGHT';
      throw error;
    }
    const startGuardToken = Date.now();
    activeStartMissions.set(mission.id, startGuardToken);
    const startGuardTimer = setTimeout(() => { if (activeStartMissions.get(mission.id) === startGuardToken) activeStartMissions.delete(mission.id); }, 120_000);
    startGuardTimer.unref?.();
    try {
    if (mode === 'reference-fixture') { activeStartMissions.delete(mission.id); clearTimeout(startGuardTimer); return { handled: false }; }
    const experienceInstruction = experienceContext ? formatExperienceContext(experienceContext, {
      projectId: mission.projectId, missionId: mission.id, roundId: state.iterationStats?.roundBudget?.roundId,
    }) : '';
    if (mode === 'opencode-server') {
      if (!runtimeEngine.supports(mode, 'planning')) {
        const error = new Error(`Agent Runtime ${mode} does not support planning runs.`);
        error.status = 409;
        error.code = 'AGENT_RUNTIME_CAPABILITY_UNSUPPORTED';
        throw error;
      }
      const descriptor = await describeOpenCode();
      if (!descriptor.connected) {
        const error = new Error(descriptor.hint);
        error.status = 503;
        error.code = 'OPENCODE_RUNTIME_UNAVAILABLE';
        throw error;
      }
      const session = await runtimeEngine.invoke(mode, 'createSession', `Operator Studio · ${mission.id} · ${mission.title}`);
      const prompt = [
        'You are connected to Operator Studio as its local optimization Agent.',
        `Mission ID: ${mission.id}`,
        `Goal: ${goal}`,
        `Target hardware: ${(mission.hardware || []).join(', ') || 'not specified'}`,
        `Metric: ${mission.metric || 'not specified'}`,
        experienceInstruction,
        'Inspect the current OpenCode project in planning mode. Do not edit files in this pass.',
        'Return a concrete diagnosis, tool evidence, candidate options, risks, and the recommended next action.',
      ].join('\n');
      try {
        await runtimeEngine.invoke(mode, 'prompt', session.id, { text: prompt, agent: openCodeAgent, model: openCodeModel });
      } catch (error) {
        error.status = error.status || 502;
        error.code = error.code || 'OPENCODE_PROMPT_FAILED';
        throw error;
      }
      state.stage = 'diagnosis';
      state.patchApplied = false;
      state.agent = {
        status: 'running',
        phase: 'OpenCode 正在分析',
        progress: 5,
        missionId: mission.id,
        runId: session.id,
        runtimeKind: 'opencode',
        profileId: 'profile.operator-orchestrator',
        goal,
        startedAt: new Date().toISOString(),
        currentAction: null,
        toolCalls: [],
        messages: [{ id: `opencode-start-${session.id}`, phase: 'Mission', status: 'running', title: 'OpenCode Session 已启动', detail: `${session.id} · ${descriptor.agent}${descriptor.model ? ` · ${descriptor.model}` : ''}`, time: '刚刚' }],
        artifacts: [{ id: `opencode-session-${session.id}`, kind: 'OpenCode Session', title: session.title || mission.title, status: 'ready', meta: `OpenCode ${descriptor.version || ''} · HTTP API` }],
      };
      appendRuntimeEvent(state, 'opencode.session_started', { sessionId: session.id, agent: descriptor.agent, model: descriptor.model }, { kind: 'agent', mode: 'opencode-server' });
      activeStartMissions.delete(mission.id); clearTimeout(startGuardTimer);
      return { handled: true, state };
    }
    if (managedCliMode) {
      if (!runtimeEngine.supports(mode, 'iteration')) {
        const error = new Error(`Agent Runtime ${mode} does not support iteration runs.`);
        error.status = 409;
        error.code = 'AGENT_RUNTIME_CAPABILITY_UNSUPPORTED';
        throw error;
      }
      const descriptor = await describeManagedRuntime();
      if (!descriptor.connected) {
        const error = new Error(descriptor.hint);
        error.status = 503;
        error.code = managedMeta.unavailableCode;
        throw error;
      }
      // 同步研究员（停滞升级）在跑时主线程必须等待；异步研究员（操作员触发）可与主线程并行。
      if (isResearchAgentActive(state.researchAgent) && state.researchAgent?.synchronous) {
        const error = new Error('同步研究员正在运行，主线程需等待研究员完成。');
        error.status = 409;
        error.code = 'RESEARCH_SERIAL_BUSY';
        throw error;
      }
      // A persisted active run owns the Mission Workspace until it reaches a
      // terminal, release-confirmed state. Never start a second provider run
      // for the same Mission while the first one is still observable.
      if (isMainAgentActive(state.agent)) {
        const error = new Error('An Agent run is already active for this Mission.');
        error.status = 409;
        error.code = 'AGENT_RUN_ALREADY_ACTIVE';
        throw error;
      }
      const runId = `${managedMeta.slug}_${Date.now().toString(36).toUpperCase()}_${randomUUID().slice(0, 8).toUpperCase()}`;
      if (!requestedWorkspace || !await directoryExists(requestedWorkspace)) {
        const error = new Error(`${managedMeta.name} 只能在 Operator Studio 创建的 Mission 工作区中运行。`);
        error.status = 409;
        error.code = 'AGENT_MANAGED_WORKSPACE_REQUIRED';
        throw error;
      }
      const workspace = requestedWorkspace;
      const sourceRoot = mission.sourceRoot || null;
      const baseline = state.baseline || mission.baseline || {};
      if (sourceRoot) await mkdir(sourceRoot, { recursive: true });
      const boundary = await prepareAgentBoundary({
        workspace,
        role: 'iteration',
        roots: { workspace },
      });
      const workspaceInventory = await workspaceManager.git(
        ['ls-files', '-z', '--cached', '--others', '--exclude-standard'],
        workspace,
      ).then((result) => result.stdout.split('\0').map((file) => file.replaceAll('\\', '/')).filter(Boolean).sort());
      const prompt = buildCandidateGenerationPrompt({
        mission,
        goal,
        workspace,
        baseline,
        testMatrix: mission.testMatrix || state.testMatrix || {},
        workspaceInventory,
        experienceInstruction,
        boundaryInstruction: boundary.toolInstruction,
      });
      const run = await runtimeEngine.invoke(mode, 'start', { runId, missionId: mission.id, goal: prompt, workspace, additionalDirectories: [], sandboxMode: 'workspace-write', resumeThreadId, environment: boundary.environment });
      state.stage = 'diagnosis';
      state.patchApplied = false;
      state.agent = {
        status: 'running',
        phase: `${managedMeta.name} 正在分析`,
        progress: 5,
        missionId: mission.id,
        runId,
        runtimeKind: mode,
        threadId: run.threadId || resumeThreadId || null,
        profileId: 'profile.operator-orchestrator',
        goal,
        startedAt: run.startedAt,
        budgetMs: mainAgentBudgetMs,
        eventCount: 0,
        lastEventAt: Date.now(),
        currentAction: null,
        toolCalls: [],
        messages: [{ id: `${managedMeta.slug}-start-${runId}`, phase: 'Mission', status: 'running', title: resumeThreadId ? `${managedMeta.name} Mission 已恢复` : `${managedMeta.name} Mission 已启动`, detail: `Run ${runId} · ${descriptor.version || managedMeta.name}${resumeThreadId ? ` · session ${resumeThreadId}` : ''}`, time: '刚刚' }],
        artifacts: [{ id: `${managedMeta.slug}-run-${runId}`, kind: `${managedMeta.name} Run`, title: mission.title, status: 'running', meta: `${descriptor.transport} · 本地事件投影` }],
      };
      appendRuntimeEvent(state, resumeThreadId ? `${managedMeta.slug}.run_resumed` : `${managedMeta.slug}.run_started`, { runId, threadId: run.threadId || resumeThreadId || null, workspace: run.workspace }, { kind: 'agent', mode });
      activeStartMissions.delete(mission.id); clearTimeout(startGuardTimer);
      return { handled: true, state };
    }

    if (mode !== 'cli-file') {
      const error = new Error('Agent Runtime is not connected. Configure the validated CLI Agent before starting a Mission.');
      error.status = 503;
      error.code = 'AGENT_RUNTIME_UNAVAILABLE';
      throw error;
    }
    const descriptor = await describe();
    if (!descriptor.connected) {
      const error = new Error(descriptor.hint || 'CLI Runtime 尚未连接。');
      error.status = 503;
      throw error;
    }
    const runId = `cli_${Date.now().toString(36).toUpperCase()}_${randomUUID().slice(0, 8).toUpperCase()}`;
    const request = {
      schemaVersion: 1,
      requestId: runId,
      missionId: mission.id,
      repository: mission.repository,
      goal,
      ...(experienceContext ? { experienceContext: structuredClone(experienceContext), experienceInstruction } : {}),
      targetHardware: mission.hardware,
      metric: mission.metric,
      status: 'requested',
      createdAt: new Date().toISOString(),
    };
    const requestsDir = path.join(bridgeDir, 'requests');
    await mkdir(requestsDir, { recursive: true });
    const requestPath = path.join(requestsDir, `${runId}.json`);
    const temporaryRequestPath = `${requestPath}.${randomUUID()}.tmp`;
    await writeFile(temporaryRequestPath, `${JSON.stringify(request, null, 2)}\n`, 'utf8');
    await rename(temporaryRequestPath, requestPath);
    state.stage = 'diagnosis';
    state.patchApplied = false;
    state.agent = {
      status: 'running',
      phase: '等待 CLI 接管',
      progress: 0,
      missionId: mission.id,
      runId,
      profileId: 'profile.operator-orchestrator',
      goal,
      startedAt: request.createdAt,
      currentAction: null,
      toolCalls: [{ id: `adapter-${runId}`, toolId: 'adapter.cli-file', name: 'CLI File Adapter', version: 'v0.1.0', skillId: 'skill.context-snapshot', status: 'running', summary: 'Mission 请求已写入 Bridge，等待 CLI 状态文件更新', permission: 'bridge:write' }],
      messages: [{ id: `agent-start-${runId}`, phase: 'Mission', status: 'running', title: 'Mission 已提交到 CLI Runtime', detail: `Run ${runId} 正在等待执行端接管。`, time: '刚刚' }],
      artifacts: [{ id: 'artifact-runtime-request', kind: 'Runtime Request', title: `${mission.title} / ${runId}`, status: 'ready', meta: 'adapter · persisted · awaiting runtime' }],
    };
    appendRuntimeEvent(state, 'mission.run_requested', { runId, goal, bridge: `requests/${runId}.json` }, { kind: 'adapter', mode: 'cli-file' });
    activeStartMissions.delete(mission.id); clearTimeout(startGuardTimer);
    return { handled: true, state };
    } finally {
      activeStartMissions.delete(mission.id);
      clearTimeout(startGuardTimer);
    }
  };

  const buildResearchPrompt = ({ mission, direction, researchDir, sourceRoot, runPhase = 'acquire', sourceEvidence = null }) => {
    const base = [
      'You are the Research Agent for Operator Studio — a read-only research scout that assists operator iteration.',
      `Mission ID: ${mission.id}`,
      `Mission title: ${mission.title || '(not specified)'}`,
      `Mission goal: ${mission.goal || '(not specified)'}`,
      `Target hardware: ${(mission.hardware || []).join(', ') || 'not specified'}`,
      `Metric: ${mission.metric || 'not specified'}`,
      `Current best: ${mission.currentBest?.value || 'not established'}`,
      `Research direction: ${direction}`,
      `Research directory: ${researchDir}`,
      `Source Registry: ${sourceRoot || '(not configured)'}`,
    ];
    if (runPhase === 'experience') {
      return [...base,
        'This is an EXPERIENCE RESEARCH phase for a frozen operator test profile. You may inspect locally available documentation and use hosted web search/fetch for implementation experience, but the profile semantics, correctness cases and benchmark cases are immutable.',
        `Frozen operator contract: ${fixedOperatorPrompt(mission.operatorProfile || {})}`,
        `You may write ONLY inside the research directory: ${researchDir}. Do not modify the Mission workspace, baseline, tests, iteration repository, or any candidate implementation.`,
        'Do NOT acquire a baseline source, clone a source tree, create candidate code, submit tests, or assert that an external source is required.',
        'Return one JSON object and no Markdown fences with this shape: {\"schemaVersion\":\"operator-studio.research-notes/v2\",\"summary\":\"...\",\"findings\":[\"...\"],\"suggestedDirections\":[\"...\"],\"sources\":[{\"title\":\"...\",\"url\":\"...\",\"type\":\"paper|repo|docs\"}],\"baselineSources\":[]}. Suggestions are advisory only and must preserve the frozen contract.',
      ].join('\n');
    }
    if (runPhase === 'acquire' && sourceRoot) {
      // 两阶段·采集：分析任务 → 自主决定需要什么资料 → 拉进 Source Registry。只采集，不写最终笔记。
      return [...base,
        'You have local Source Registry read access plus hosted web search. This is the ACQUISITION phase. First inspect the local Source Registry and select a relevant existing Git source when possible. Only if local sources are insufficient, search the network for an accessible HTTPS Git repository. Gitee, GitHub, GitLab, and other credential-free HTTPS Git hosts are allowed.',
        `You may write ONLY inside the research directory: ${researchDir}. Treat the Source Registry as read-only. You MUST NOT modify the Mission workspace, Iteration Repository, existing Source files, or create any candidate patch. The fixed workflow reuses local selections or clones remote selections and records the resulting commit/tree snapshot.`,
        'Return one JSON object and no Markdown fences with this shape: {"schemaVersion":"operator-studio.source-acquisition/v2","summary":"...","sourceAcquisition":{"repositories":[{"name":"flashinfer","location":"local|remote","url":"https://accessible-host/owner/repo.git","reason":"why it matches this Mission","evidencePaths":["repo/relative/operator_file.py","repo/relative/kernel_file.cuh"]}],"semanticFallback":false,"fallbackReason":""}}. For a local selection, name must match a Source Registry child directory and url may be omitted. For a remote selection, provide a safe HTTPS Git URL. Select at most 3 repositories. If neither local nor remote source is usable, return repositories:[], semanticFallback:true, and a concise semantic specification in fallbackReason so the Materializer can implement a baseline from the Mission.',
      ].join('\n');
    }
    if (runPhase === 'synthesize') {
      // 两阶段·综合：只读已拉取的资料，写研究笔记。无网络、短、必然完成。
      return [...base,
        'This is the SYNTHESIS phase. The fixed workflow reused local sources or cloned selected repositories and copied bounded evidence below. If evidence exists, select the source path that best matches the Mission. If acquisition failed or produced no evidence, derive a semantic baseline specification from the Mission instead of stopping.',
        `Source Evidence and Acquisition Result JSON: ${JSON.stringify(sourceEvidence || {})}`,
        'Do NOT propose candidates, do not produce a "candidates" field, and do not call any benchmark or test service.',
        'Return one JSON object and no Markdown fences with this shape: {"schemaVersion":"operator-studio.research-notes/v2","summary":"...","findings":["..."],"suggestedDirections":["..."],"sources":[{"title":"...","url":"...","type":"paper|repo|docs"}],"baselineSources":[{"authority":"upstream","repository":"https://...","commit":"full cloned commit","path":"...","operator":"...","expandedSingleFile":false,"confidence":"high|medium|low","reason":"..."}],"semanticBaseline":{"operator":"...","reason":"...","inputSemantics":["..."],"outputSemantics":["..."],"correctnessInvariants":["..."]}}. Use baselineSources when evidence exists. Otherwise leave baselineSources empty and provide semanticBaseline.',
      ].join('\n');
    }
    // 单阶段（无 sourceRoot）：检索 + 产笔记（旧行为），一个 run 完成
    return [...base,
      'You have network access. Research the latest operator implementations, papers and open-source libraries relevant to the direction above. You may git clone repositories, read upstream sources, and browse documentation.',
      `You may write ONLY inside the research directory: ${researchDir} (e.g. clones/ and notes/). You MUST NOT modify the Mission workspace, the Iteration Repository, or create any candidate patch. This is a read-only research turn.`,
      'Do NOT propose candidates, do not produce a "candidates" field, and do not call any benchmark or test service.',
      'Return one JSON object and no Markdown fences with this shape: {"schemaVersion":"operator-studio.research-notes/v1","summary":"...","findings":["..."],"suggestedDirections":["..."],"sources":[{"title":"...","url":"...","type":"paper|repo|docs"}],"baselineSources":[{"authority":"upstream","repository":"https://...","commit":"...","path":"...","operator":"...","expandedSingleFile":false,"confidence":"high|medium|low","reason":"why this is an authoritative reference candidate"}]}. baselineSources are read-only source candidates only; do not decide adoption or submit tests. If no authoritative baseline source exists, return "baselineSources":[] and explain why in findings.',
    ].join('\n');
  };

  const buildBaselineMaterializerPrompt = ({ mission, source, matrix, materializationDir, sourceEvidence }) => [
    'You are the Baseline Materializer for Operator Studio.',
    `Task: materialize one ${source?.semanticFallback ? 'Mission-semantic' : 'upstream'} baseline into a single-file run.py for the current Mission.`,
    `Mission ID: ${mission.id}`,
    `Mission title: ${mission.title || mission.goal || '(not specified)'}`,
    `Operator: ${mission.operator || source?.operator || '(not specified)'}`,
    `Target hardware: ${(mission.hardware || []).join(', ') || 'not specified'}`,
    `Metric: ${mission.metric || 'not specified'}`,
    `Test matrix JSON: ${JSON.stringify(matrix || {})}`,
    `Selected source or semantic fallback JSON: ${JSON.stringify(source || {})}`,
    source?.semanticFallback
      ? 'No usable source code was available. Implement the baseline from the Mission and semantic specification below; explicitly record assumptions and unsupported semantics.'
      : 'Source Registry is not exposed to this Agent. The fixed workflow captured the selected reference and embedded its bounded contents below.',
    `Source Evidence JSON: ${JSON.stringify(sourceEvidence || {})}`,
    `Materialization directory: ${materializationDir}`,
    '',
    'Hard constraints:',
    source?.semanticFallback ? '- Use the Mission and semantic specification as the baseline authority for this test run.' : '- Use only the captured source evidence embedded in this prompt.',
    '- Write only inside the Materialization directory.',
    '- Do NOT modify the Mission workspace, Iteration Repository, candidate files, project source, or Source Registry.',
    '- Do NOT submit tests, upload packages, call runner APIs, or create optimized candidates.',
    '- The output must be baseline semantics only, not an optimized candidate.',
    '- The run.py must define get_inputs(), get_test_cases(), get_benchmark_inputs(), run(inputs), and reference(inputs).',
    '- The run.py must be single-file Python and must not import flashinfer or candidate implementation modules.',
    '- Prefer PyTorch eager operations for the reference implementation.',
    '- FIRST write the complete implementation to run.py in the Materialization directory. Do not wait until the final response to persist it.',
    '- Then write materializer-report.json with summary, sourceFiles, testSpec, assumptions, and unsupported fields.',
    '- If the baseline cannot be represented faithfully, write only materializer-report.json and explain the blocker; do not create an invalid run.py.',
    testSpecAgentInstruction(matrix),
    '',
    'After both files are persisted, return one small JSON object and no Markdown fences. Do not embed run.py source in the response:',
    '{"schemaVersion":"operator-studio.baseline-materializer-result/v2","summary":"...","runPyPath":"run.py","reportPath":"materializer-report.json"}',
  ].join('\n');

  const startBaselineMaterialization = async ({ state, mission, source, matrix = {}, workspace }) => {
    assertResourcesReleased(state);
    if (!managedCliMode || !runtimeEngine.supports(mode, 'materializer')) {
      const error = new Error(`Baseline materializer requires a managed workspace CLI runtime (current: ${mode}).`);
      error.status = 503;
      error.code = 'BASELINE_MATERIALIZER_RUNTIME_UNSUPPORTED';
      throw error;
    }
    const descriptor = await describeManagedRuntime();
    if (!descriptor.connected) {
      const error = new Error(descriptor.hint);
      error.status = 503;
      error.code = managedMeta.unavailableCode;
      throw error;
    }
    const active = state.baseline?.materializer;
    if (active?.runId && ACTIVE_BASELINE_MATERIALIZER_STATUSES.has(active.status)) {
      const error = new Error('Baseline materializer 已在运行。');
      error.status = 409;
      error.code = 'BASELINE_MATERIALIZER_ACTIVE';
      throw error;
    }
    if (!workspace) {
      const error = new Error('Baseline materializer 需要一个隔离 materialization 目录。');
      error.status = 409;
      error.code = 'BASELINE_MATERIALIZER_WORKSPACE_REQUIRED';
      throw error;
    }
    await mkdir(workspace, { recursive: true });
    const semanticFallback = source?.semanticFallback === true || source?.authority === 'agent-semantic';
    const sourceEvidence = semanticFallback
      ? {
        mode: 'semantic-fallback',
        mission: { id: mission.id, title: mission.title, goal: mission.goal, operator: mission.operator, hardware: mission.hardware, metric: mission.metric },
        specification: source.semanticSpec || null,
        reason: source.reason || 'No usable local or remote source was available.',
        verified: false,
      }
      : await loadMaterializerSourceEvidence({ sourceRoot: mission.sourceRoot, source });
    const verifiedSource = {
      ...source,
      repository: sourceEvidence.canonicalRepository || sourceEvidence.repository || source.repository,
      canonicalRepository: sourceEvidence.canonicalRepository || sourceEvidence.repository || source.canonicalRepository || source.repository,
      transportRepository: sourceEvidence.transportRepository || null,
      transportMode: sourceEvidence.transportMode || (semanticFallback ? 'semantic-fallback' : 'canonical'),
      mirrorVerified: sourceEvidence.mirrorVerified === true,
      commit: sourceEvidence.commit || source.commit,
      tree: sourceEvidence.tree || source.tree || null,
      semanticFallback,
    };
    const runId = `${managedMeta.slug}_materializer_${Date.now().toString(36).toUpperCase()}_${randomUUID().slice(0, 8).toUpperCase()}`;
    const boundary = await prepareAgentBoundary({
      workspace,
      role: 'materializer',
      roots: { workspace },
    });
    const prompt = `${buildBaselineMaterializerPrompt({ mission, source: verifiedSource, matrix, materializationDir: workspace, sourceEvidence })}\n${boundary.toolInstruction}`;
    const run = await runtimeEngine.invoke(mode, 'start', {
      runId,
      missionId: mission.id,
      goal: prompt,
      workspace,
      additionalDirectories: [],
      sandboxMode: 'workspace-write',
      environment: boundary.environment,
    });
    state.baseline = {
      ...(state.baseline || { required: true, status: 'missing' }),
      kind: 'pytorch_reference',
      source: verifiedSource,
      materializer: {
        status: 'running',
        phase: 'Baseline 单文件展开中',
        progress: 5,
        runtimeKind: mode,
        missionId: mission.id,
        runId,
        threadId: run.threadId || null,
        source: verifiedSource,
        matrix: structuredClone(matrix || {}),
        materializationDir: workspace,
        startedAt: run.startedAt,
        completedAt: null,
        budgetMs: 8 * 60 * 1000,
        eventCount: 0,
        lastEventAt: Date.now(),
        messages: [{ id: `baseline-materializer-start-${runId}`, phase: 'baseline', status: 'running', title: 'Baseline materializer 已启动', detail: `Run ${runId} · 只生成单文件 run.py`, time: '刚刚' }],
        artifacts: [{ id: `baseline-materializer-run-${runId}`, kind: 'Baseline Materializer Run', title: '单文件 baseline 展开', status: 'running', meta: `${descriptor.transport} · materializer` }],
        result: null,
        error: null,
      },
    };
    appendRuntimeEvent(state, 'baseline.materializer_started', { runId, source: verifiedSource, materializationDir: workspace }, { kind: 'baseline-materializer', mode });
    return { handled: true, state };
  };

  const startResearch = async ({ state, mission, direction, workspace, synchronous = false, runPhase = 'acquire' }) => {
    assertResourcesReleased(state);
    if (!managedCliMode || !runtimeEngine.supports(mode, 'research')) {
      const error = new Error(`Research Agent requires a managed workspace CLI runtime (current: ${mode}).`);
      error.status = 503;
      error.code = 'RESEARCH_RUNTIME_UNSUPPORTED';
      throw error;
    }
    const descriptor = await describeManagedRuntime();
    if (!descriptor.connected) {
      const error = new Error(descriptor.hint);
      error.status = 503;
      error.code = managedMeta.unavailableCode;
      throw error;
    }
    // 同步研究（停滞升级）需要主线程空闲才能启动；异步研究（操作员触发）可与主线程并行。
    if (isMainAgentActive(state.agent) && synchronous) {
      const error = new Error('主线程 Agent 正在运行，同步研究员需等待主线程空闲。');
      error.status = 409;
      error.code = 'RESEARCH_SERIAL_BUSY';
      throw error;
    }
    // 仅当当前研究员仍处于运行中才拦截；终态（采集完成）允许启动综合阶段。
    if (state.researchAgent?.runId && ['running', 'cancel_requested'].includes(state.researchAgent.status)) {
      const error = new Error('研究员已在运行。');
      error.status = 409;
      error.code = 'RESEARCH_RUN_ACTIVE';
      throw error;
    }
    const runId = `${managedMeta.slug}_research_${Date.now().toString(36).toUpperCase()}_${randomUUID().slice(0, 8).toUpperCase()}`;
    if (!workspace) {
      const error = new Error('研究员需要一个隔离调研目录。');
      error.status = 409;
      error.code = 'RESEARCH_WORKSPACE_REQUIRED';
      throw error;
    }
    if (runPhase === 'acquire' && mission.sourceRoot) await sourceMirrorPolicy();
    await mkdir(path.join(workspace, 'notes'), { recursive: true });
    await mkdir(path.join(workspace, 'clones'), { recursive: true });
    const prevResearch = state.researchAgent || {};
    const sourceEvidence = runPhase === 'synthesize'
      ? await readFile(path.join(workspace, 'acquisition-result.json'), 'utf8')
        .then((content) => JSON.parse(content))
        .catch((error) => ({
          schemaVersion: 2,
          strategy: 'semantic-fallback-after-acquisition-failure',
          acquired: [],
          failures: [{ code: prevResearch.error?.code || 'RESEARCH_ACQUISITION_UNAVAILABLE', detail: prevResearch.error?.message || error.message }],
          semanticFallback: { allowed: mission.sourcePolicy?.allowSemanticFallback === true, requested: true, reason: prevResearch.error?.message || error.message },
        }))
      : null;
    const boundary = await prepareAgentBoundary({
      workspace,
      role: `research-${runPhase}`,
      roots: { workspace, ...(runPhase === 'acquire' && mission.sourceRoot ? { sourceRoot: mission.sourceRoot } : {}) },
    });
    const prompt = `${buildResearchPrompt({ mission, direction, researchDir: workspace, sourceRoot: mission.sourceRoot, runPhase, sourceEvidence })}\n${boundary.toolInstruction}`;
    const run = await runtimeEngine.invoke(mode, 'start', {
      runId,
      missionId: mission.id,
      goal: prompt,
      workspace,
      additionalDirectories: runPhase === 'acquire' && mission.sourceRoot ? [mission.sourceRoot] : [],
      sandboxMode: 'workspace-write',
      environment: boundary.environment,
    });
    state.researchAgent = {
      status: 'running',
      runPhase,
      phase: runPhase === 'acquire' ? '研究员采集资料中' : '研究员整理笔记中',
      progress: 5,
      missionId: mission.id,
      runId,
      runtimeKind: mode,
      threadId: run.threadId || null,
      direction,
      researchDir: workspace,
      sourceRoot: mission.sourceRoot || prevResearch.sourceRoot || null,
      startedAt: run.startedAt,
      completedAt: null,
      // 采集阶段预算宽松（主要靠停滞/事件终止），综合阶段短预算（无网络，本地读）
      budgetMs: runPhase === 'acquire' ? 30 * 60 * 1000 : runPhase === 'experience' ? 6 * 60 * 1000 : 10 * 60 * 1000,
      acquireRunId: runPhase === 'acquire' ? runId : prevResearch.acquireRunId || null,
      synthesizeRunId: runPhase === 'synthesize' ? runId : null,
      lastEventAt: Date.now(),
      eventCount: 0,
      notes: [],
      messages: [{ id: `research-start-${runId}`, phase: 'research', status: 'running', title: runPhase === 'acquire' ? '研究员采集资料中' : runPhase === 'experience' ? '研究员搜寻优化经验中' : '研究员整理笔记中', detail: `Run ${runId} · ${runPhase === 'acquire' ? '联网采集外部资料' : runPhase === 'experience' ? '参考经验（不阻塞）' : '只读整理研究笔记'} · ${direction}`, time: '刚刚' }],
      artifacts: [{ id: `research-run-${runId}`, kind: 'Research Run', title: runPhase === 'acquire' ? '研究员采集' : runPhase === 'experience' ? '经验调研' : '研究员综合', status: 'running', meta: `${descriptor.transport} · ${runPhase}` }],
      injected: false,
      synchronous: Boolean(synchronous),
    };
    appendRuntimeEvent(state, 'research.run_started', { runId, runPhase, direction, researchDir: workspace, synchronous: Boolean(synchronous) }, { kind: 'research', mode });
    return { handled: true, state };
  };

  const cancellationCalls = new Map();
  const cancellationRetries = new Map();
  const cancellationTimeoutMs = Math.max(20, Number(options.cancellationTimeoutMs) || 5_000);
  const requestCancellation = async (runId) => {
    let operation = cancellationCalls.get(runId);
    if (!operation) {
      operation = Promise.resolve().then(() => runtimeEngine.invoke(mode, 'cancel', runId));
      cancellationCalls.set(runId, operation);
      operation.finally(() => { if (cancellationCalls.get(runId) === operation) cancellationCalls.delete(runId); }).catch(() => {});
    }
    // A timed-out port is quarantined, never treated as cancelled. Its eventual
    // result has no reference to the mutable Mission snapshot.
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve({ status: 'cancel_requested', resourceRelease: {
        confirmed: false, status: 'unconfirmed', code: 'AGENT_CANCEL_DEADLINE_EXCEEDED',
        reason: 'Agent cancellation did not acknowledge before its deadline.',
      } }), cancellationTimeoutMs);
      operation.then(value => { clearTimeout(timer); resolve(value || { status: 'cancel_requested' }); },
        error => { clearTimeout(timer); resolve({ status: 'cancel_requested', resourceRelease: {
          confirmed: false, status: 'unconfirmed', code: error.code || 'AGENT_CANCEL_FAILED', reason: error.message,
        } }); });
    });
  };
  const cancellationProjection = (previous, resourceRelease = {}, { timedOut = previous.timedOut, reason = 'Agent cancellation awaits process exit.' } = {}) => ({
    ...previous, status: 'cancel_requested', currentAction: null, completedAt: null,
    phase: previous.phase?.startsWith('正在取消') ? previous.phase : '正在取消 Agent，等待执行资源释放',
    timedOut: timedOut || undefined,
    resourceRelease: { confirmed: false, status: 'pending', reason,
      requestedAt: previous.resourceRelease?.requestedAt || new Date().toISOString(),
      deadline: previous.resourceRelease?.deadline || new Date(Date.now() + cancellationTimeoutMs).toISOString(),
      nextAction: 'Inspect cancellation status; no workspace mutation or new run is permitted until release is confirmed.',
      ...resourceRelease, status: resourceRelease.status === 'unconfirmed' ? 'unconfirmed' : 'pending', confirmed: false },
  });
  const settleCancellation = async (previous, run, expired = false, logicalDone = false) => {
    if (isExecutionReleased(run)) { cancellationRetries.delete(previous.runId); return { run, projection: null }; }
    const cancelling = expired || logicalDone || previous.status === 'cancel_requested' || ['completed', 'failed', 'cancelled'].includes(run.status)
      || ['pending', 'unconfirmed'].includes(run.resourceRelease?.status);
    if (!cancelling) return { run, projection: null };
    let outcome = run;
    const releasePending = ['pending', 'unconfirmed'].includes(run.resourceRelease?.status);
    const retryCount = cancellationRetries.get(previous.runId) || 0;
    const shouldRequest = (previous.status !== 'cancel_requested' && run.resourceRelease?.status !== 'unconfirmed') || releasePending;
    if (shouldRequest && retryCount < MAX_CANCELLATION_RETRIES) {
      cancellationRetries.set(previous.runId, retryCount + 1);
      outcome = await requestCancellation(previous.runId);
      if (isExecutionReleased(outcome)) return { run: { ...run, ...outcome }, projection: null };
    }
    const exhausted = releasePending && (cancellationRetries.get(previous.runId) || 0) >= MAX_CANCELLATION_RETRIES;
    const projection = cancellationProjection(previous, outcome.resourceRelease, { timedOut: expired || previous.timedOut });
    if (exhausted) {
      projection.status = 'needs_human';
      projection.phase = '取消释放需要人工确认';
      projection.resourceRelease.nextAction = '人工确认 Agent 进程树已释放后，清理该 Mission 执行占用。';
    }
    return { run: outcome, projection };
  };

  const cancellationRelease = (previous, result) => isExecutionReleased(result)
    ? { ...result.resourceRelease, confirmed: true, status: 'confirmed', reason: 'Agent process release is confirmed.', nextAction: 'No action required.' }
    : cancellationProjection(previous, result.resourceRelease).resourceRelease;

  const cancelRun = async ({ state, runId }) => {
    if (state.baseline?.materializer?.runId && runId === state.baseline.materializer.runId) {
      if (!managedCliMode || !runtimeEngine.supports(mode, 'cancellation')) {
        const error = new Error(`Baseline materializer cancellation is not supported by runtime mode ${mode}.`);
        error.status = 409;
        error.code = 'AGENT_CANCEL_UNAVAILABLE';
        throw error;
      }
      const result = await requestCancellation(runId);
      state.baseline = {
        ...(state.baseline || {}),
        materializer: { ...state.baseline.materializer, status: isExecutionReleased(result) ? result.status : 'cancel_requested', phase: 'Baseline materializer 取消已请求', resourceRelease: cancellationRelease(state.baseline.materializer, result) },
      };
      appendRuntimeEvent(state, 'baseline.materializer_cancel_requested', { runId }, { kind: 'baseline-materializer', mode });
      return { state, result };
    }
    if (state.researchAgent?.runId && runId === state.researchAgent.runId) {
      if (!managedCliMode || !runtimeEngine.supports(mode, 'cancellation')) {
        const error = new Error(`Research cancellation is not supported by runtime mode ${mode}.`);
        error.status = 409;
        error.code = 'AGENT_CANCEL_UNAVAILABLE';
        throw error;
      }
      const result = await requestCancellation(runId);
      state.researchAgent = { ...state.researchAgent, status: isExecutionReleased(result) ? result.status : 'cancel_requested', phase: '研究员取消已请求', resourceRelease: cancellationRelease(state.researchAgent, result) };
      appendRuntimeEvent(state, 'research.cancel_requested', { runId }, { kind: 'research', mode });
      return { state, result };
    }
    if (!runId || state.agent?.runId !== runId) {
      const error = new Error('The requested Agent run is not active in this Mission.');
      error.status = 409;
      error.code = 'AGENT_RUN_MISMATCH';
      throw error;
    }
    let result;
    if (runtimeDefinition && runtimeEngine.supports(mode, 'cancellation')) result = await requestCancellation(runId);
    else {
      const error = new Error(`Agent cancellation is not supported by runtime mode ${mode}.`);
      error.status = 409;
      error.code = 'AGENT_CANCEL_UNAVAILABLE';
      throw error;
    }
    state.agent = {
      ...state.agent,
      status: isExecutionReleased(result) ? result.status : 'cancel_requested',
      currentAction: null,
      resourceRelease: cancellationRelease(state.agent, result),
      phase: 'Agent cancellation requested',
    };
    appendRuntimeEvent(state, 'agent.run_cancel_requested', { runId }, { kind: 'agent', mode });
    return { state, result };
  };

  const projectState = async (state) => {
    const descriptor = await describe();
    const runtimeChanged = JSON.stringify(state.runtime) !== JSON.stringify(descriptor);
    state.runtime = descriptor;
    if (mode === 'opencode-server' && descriptor.connected && state.agent?.runtimeKind === 'opencode' && state.agent?.runId) {
      const sessionId = state.agent.runId;
      try {
        const [statuses, messages, diff] = await Promise.all([
          runtimeEngine.invoke(mode, 'readStatus'),
          runtimeEngine.invoke(mode, 'readEvents', sessionId),
          runtimeEngine.invoke(mode, 'readDiff', sessionId),
        ]);
        const sessionStatus = statuses?.[sessionId]?.type || statuses?.[sessionId]?.status || 'idle';
        const messageList = Array.isArray(messages) ? messages : [];
        const diffList = Array.isArray(diff) ? diff : [];
        const assistantMessages = messageList.filter((message) => message?.info?.role === 'assistant');
        const usageBefore = JSON.stringify(state.tokenUsage || null);
        const usageEvents = assistantMessages
          .filter((message) => message?.info?.tokens || message?.info?.usage)
          .map((message, index) => ({
            type: message.info?.error ? 'turn.failed' : 'turn.completed',
            id: message.info?.id || `opencode-usage-${index}`,
            usageId: message.info?.id || `opencode-usage-${index}`,
            provider: 'opencode-server',
            usage: message.info?.tokens || message.info?.usage,
          }));
        recordRunTokenUsage(state, { runId: sessionId, phase: 'iteration', provider: 'opencode-server', events: usageEvents });
        const usageChanged = usageBefore !== JSON.stringify(state.tokenUsage || null);
        const errors = assistantMessages.map((message) => message?.info?.error?.data?.message || message?.info?.error?.message).filter(Boolean);
        const textParts = assistantMessages.flatMap((message) => (message.parts || []).filter((part) => part.type === 'text' && part.text));
        const toolParts = messageList.flatMap((message) => (message.parts || []).filter((part) => part.type === 'tool'));
        const projectedMessages = textParts.slice(-8).map((part, index) => ({
          id: part.id || `opencode-text-${index}`,
          phase: 'OpenCode',
          status: 'completed',
          title: 'OpenCode 分析结果',
          detail: part.text,
          time: part.time?.end || part.time?.start || '刚刚',
        }));
        const projectedTools = toolParts.slice(-20).map((part, index) => ({
          id: part.id || `opencode-tool-${index}`,
          toolId: part.tool || 'opencode.tool',
          name: part.tool || 'OpenCode Tool',
          version: descriptor.version ? `v${descriptor.version}` : 'runtime',
          skillId: 'opencode.session',
          status: part.state?.status === 'completed' ? 'completed' : part.state?.status === 'error' ? 'failed' : 'running',
          summary: part.state?.title || part.state?.output || part.state?.error || 'OpenCode tool call',
          permission: 'opencode:managed',
        }));
        const busy = ['busy', 'retry'].includes(sessionStatus);
        const nextStatus = errors.length ? 'failed' : busy ? 'running' : assistantMessages.length ? (diffList.length ? 'awaiting_action' : 'completed') : 'running';
        const artifacts = [
          ...(state.agent.artifacts || []).filter((artifact) => artifact.kind !== 'OpenCode Diff'),
          ...diffList.slice(0, 20).map((file, index) => ({
            id: `opencode-diff-${index}-${file.file || file.path || 'file'}`,
            kind: 'OpenCode Diff',
            title: file.file || file.path || `Changed file ${index + 1}`,
            status: 'ready',
            meta: `${file.additions ?? 0} additions · ${file.deletions ?? 0} deletions`,
          })),
        ];
        const nextAgent = {
          ...state.agent,

          status: nextStatus,
          phase: errors.length ? 'OpenCode 执行失败' : busy ? 'OpenCode 正在执行' : diffList.length ? '候选变更待审阅' : assistantMessages.length ? 'OpenCode 分析完成' : state.agent.phase,
          progress: busy ? Math.max(10, state.agent.progress || 0) : errors.length || assistantMessages.length ? 100 : state.agent.progress,
          messages: errors.length
            ? [...projectedMessages, { id: `opencode-error-${sessionId}`, phase: 'OpenCode', status: 'waiting', title: 'OpenCode Provider 调用失败', detail: errors.at(-1), time: '刚刚' }]
            : projectedMessages.length ? projectedMessages : state.agent.messages,
          toolCalls: projectedTools.length ? projectedTools : state.agent.toolCalls,
          artifacts,
          currentAction: diffList.length ? { id: `opencode-review-${sessionId}`, type: 'candidate.plan', title: '查看 OpenCode Session Diff', reason: `${diffList.length} 个文件包含候选变更。`, expectedOutput: 'Candidate Plan · OpenCode Diff', risk: 'medium', approvalRequired: false, approvalPolicy: 'client-controlled' } : null,
          openCodeStatus: sessionStatus,
          openCodeDiffCount: diffList.length,
        };
        if (diffList.length) state.stage = 'candidate';
        const statusChanged = nextAgent.status !== state.agent.status || nextAgent.openCodeDiffCount !== state.agent.openCodeDiffCount;
        const changed = runtimeChanged || usageChanged || JSON.stringify(nextAgent) !== JSON.stringify(state.agent);
        state.agent = nextAgent;
        if (statusChanged) appendRuntimeEvent(state, errors.length ? 'opencode.session_failed' : diffList.length ? 'opencode.diff_ready' : 'opencode.session_updated', { sessionId, status: nextStatus, diffCount: diffList.length, error: errors.at(-1) || null }, { kind: 'agent', mode: 'opencode-server' });
        return { state, changed: changed || statusChanged };
      } catch (error) {
        const nextAgent = { ...state.agent, resourceRelease: observedRun.resourceRelease || { confirmed: true, status: 'confirmed' }, status: 'failed', phase: 'OpenCode 状态读取失败', progress: 100, messages: [...(state.agent.messages || []), { id: `opencode-projection-error-${sessionId}`, phase: 'OpenCode', status: 'waiting', title: '无法读取 OpenCode Session', detail: error.message, time: '刚刚' }] };
        const changed = runtimeChanged || JSON.stringify(nextAgent) !== JSON.stringify(state.agent);
        state.agent = nextAgent;
        return { state, changed };
      }
    }
    const materializerNeedsProjection = ['running', 'cancel_requested'].includes(state.baseline?.materializer?.status);
    if (managedCliMode && materializerNeedsProjection && state.baseline?.materializer?.runId && state.baseline.materializer.runtimeKind === mode) {
      let observedRun = null;
      try {
        const prev = state.baseline.materializer;
        const activeMission = state.missions?.find((mission) => mission.id === state.activeMissionId) || {};
        let run = await runtimeEngine.invoke(mode, 'readRun', prev.runId);
        observedRun = run;
        const events = await runtimeEngine.invoke(mode, 'readEvents', prev.runId);
        recordRunTokenUsage(state, { runId: prev.runId, phase: 'materializer', provider: mode, events });
        const budgetExceeded = Number(prev.budgetMs) > 0
          && prev.startedAt
          && Date.now() - new Date(prev.startedAt).getTime() >= Number(prev.budgetMs);
        const settlement = await settleCancellation(prev, run, budgetExceeded, events.some(event => event.type === 'turn.completed'));
        if (settlement.projection) {
          const changed = runtimeChanged || JSON.stringify(settlement.projection) !== JSON.stringify(prev);
          state.baseline = { ...state.baseline, materializer: settlement.projection };
          return { state, changed };
        }
        run = settlement.run; observedRun = run;
        const failed = run.status === 'failed';
        const completed = run.status === 'completed';
        const cancelled = run.status === 'cancelled';
        const nextStatus = failed ? 'failed' : completed ? 'completed' : cancelled ? (prev.timedOut ? 'timed_out' : 'cancelled') : 'running';
        let terminal = ['completed', 'failed', 'cancelled', 'timed_out'].includes(nextStatus);
        const eventCount = events.length;
        const lastEventAt = lastManagedActivityAt(run, prev.lastEventAt, eventCount > (prev.eventCount || 0));
        let result = prev.result || null;
        let materializerError = prev.error || null;
        let finalStatus = nextStatus;
        let finalPhase = failed ? 'Baseline materializer 执行失败' : completed ? 'Baseline 单文件展开完成' : cancelled ? 'Baseline materializer 已取消' : nextStatus === 'timed_out' ? 'Baseline materializer 预算耗尽' : prev.status === 'cancel_requested' ? '正在取消 baseline materializer' : 'Baseline 单文件展开中';
        let workspaceArtifact = null;
        if (!result && terminal) {
          try { workspaceArtifact = await readMaterializerWorkspaceResult(prev, events); } catch { /* Agent may still be replacing its report atomically. */ }
        }
        if (workspaceArtifact && !result) {
          try {
            const materialized = materializeBaselineSource({
              mission: activeMission,
              source: prev.source,
              matrix: prev.matrix || state.testMatrix || {},
              body: { materializerResult: workspaceArtifact },
            });
            result = {
              schemaVersion: workspaceArtifact.schemaVersion,
              summary: workspaceArtifact.summary,
              runPy: materialized.runPy,
              runPySource: materialized.runPySource,
              report: materialized.report,
              source: materialized.source,
              rawText: workspaceArtifact.rawText,
              delivery: 'workspace-artifact',
            };
            finalStatus = 'completed';
            finalPhase = 'Baseline 单文件已落盘并通过校验';
            terminal = true;
            materializerError = null;
            if (!['completed', 'failed', 'cancelled'].includes(run.status)) {
              try { await runtimeEngine.invoke(mode, 'cancel', prev.runId); } catch { /* Artifact is already authoritative. */ }
            }
          } catch (error) {
            if (terminal) {
              finalStatus = 'failed';
              finalPhase = 'Baseline materializer 结果校验失败';
              materializerError = { code: error.code || 'BASELINE_MATERIALIZER_RESULT_INVALID', message: error.message, details: error.details || null };
            }
          }
        } else if (terminal && completed && !result) {
          try {
            const parsed = parseBaselineMaterializerResult(events);
            const materialized = materializeBaselineSource({
              mission: activeMission,
              source: prev.source,
              matrix: prev.matrix || state.testMatrix || {},
              body: { materializerResult: parsed },
            });
            result = {
              schemaVersion: parsed.schemaVersion,
              summary: parsed.summary,
              runPy: materialized.runPy,
              runPySource: materialized.runPySource,
              report: materialized.report,
              source: materialized.source,
              rawText: parsed.rawText,
              delivery: 'final-response-v1',
            };
          } catch (error) {
            finalStatus = 'failed';
            finalPhase = 'Baseline materializer 结果校验失败';
            materializerError = { code: error.code || 'BASELINE_MATERIALIZER_RESULT_INVALID', message: error.message, details: error.details || null };
          }
        }
        const nextMaterializer = {
          ...prev,
          resourceRelease: run.resourceRelease || (terminal ? { confirmed: true, status: 'confirmed' } : prev.resourceRelease),
          status: finalStatus,
          phase: finalPhase,
          progress: terminal ? 100 : Math.max(5, Math.min(95, 5 + events.length * 3)),
          threadId: run.threadId || prev.threadId || null,
          completedAt: terminal ? (run.completedAt || new Date().toISOString()) : prev.completedAt || null,
          eventCount,
          lastEventAt,
          result,
          error: materializerError,
          messages: [
            ...(prev.messages || []).slice(0, 8),
            ...(materializerError ? [{ id: `baseline-materializer-error-${prev.runId}`, phase: 'baseline', status: 'waiting', title: finalPhase, detail: materializerError.message, time: '刚刚', errorCode: materializerError.code }] : []),
          ],
          artifacts: [{ id: `baseline-materializer-run-${prev.runId}`, kind: 'Baseline Materializer Run', title: '单文件 baseline 展开', status: finalStatus, meta: `${events.length} events · ${run.threadId || 'thread pending'}` }],
        };
        state.baseline = {
          ...(state.baseline || {}),
          kind: 'pytorch_reference',
          source: result?.source || state.baseline?.source || prev.source || null,
          materializer: nextMaterializer,
          resolution: result ? {
            ...(state.baseline?.resolution || {}),
            status: 'materialized',
            strategy: 'agent_assisted_materializer',
            kind: 'pytorch_reference',
            attemptedAuthority: true,
            reused: false,
            reason: '已由受控 materializer 生成权威 baseline 单文件，等待同 runner / 同 shape baseline 测试。',
            resolvedAt: nextMaterializer.completedAt,
            previousEvidenceRunId: null,
          } : state.baseline?.resolution,
        };
        if (terminal) appendRuntimeEvent(state, finalStatus === 'completed' ? 'baseline.materializer_completed' : 'baseline.materializer_failed', { runId: prev.runId, status: finalStatus, source: state.baseline.source, error: materializerError }, { kind: 'baseline-materializer', mode });
        return { state, changed: true };
      } catch (error) {
        if (!isExecutionReleased(observedRun || {})) {
          state.baseline = { ...state.baseline, materializer: cancellationProjection(state.baseline.materializer, { status: 'unconfirmed', code: error.code || 'AGENT_STATUS_UNAVAILABLE', reason: error.message }) };
          return { state, changed: true };
        }
        state.baseline = {
          ...(state.baseline || {}),
          materializer: { ...(state.baseline?.materializer || {}), resourceRelease: observedRun.resourceRelease || { confirmed: true, status: 'confirmed' }, status: 'failed', phase: 'Baseline materializer 状态读取失败', progress: 100, error: { code: 'BASELINE_MATERIALIZER_PROJECTION_FAILED', message: error.message } },
        };
        return { state, changed: true };
      }
    }

    // 研究员子 Agent 是平行 run：只投影 state.researchAgent，绝不触碰主线程的
    // stage / candidateEvaluations / patchApplied，避免干扰候选验证路径。
    // 只有 synchronous 研究（baseline/source 获取）可以阻塞主线程；fixed profile 的
    // experience 研究是旁路，即使预算耗尽或还在运行，也必须继续投影主 Agent。
    const researchNeedsProjection = ['running', 'cancel_requested'].includes(state.researchAgent?.status)
      || (['completed', 'failed', 'timed_out', 'cancelled'].includes(state.researchAgent?.status)
          && ['synthesize', 'experience'].includes(state.researchAgent?.runPhase) && !(state.researchAgent?.notes || []).length);
    if (managedCliMode && researchNeedsProjection && state.researchAgent?.runId && state.researchAgent?.runtimeKind === mode) {
      let observedRun = null;
      try {
        const prev = state.researchAgent;
        let run = await runtimeEngine.invoke(mode, 'readRun', prev.runId);
        observedRun = run;
        const events = await runtimeEngine.invoke(mode, 'readEvents', prev.runId);
        const usageBefore = JSON.stringify(state.tokenUsage || null);
        recordRunTokenUsage(state, { runId: prev.runId, phase: `research.${prev.runPhase || 'run'}`, provider: mode, events });
        const usageChanged = usageBefore !== JSON.stringify(state.tokenUsage || null);
        const budgetExceeded = Number(prev.budgetMs) > 0
          && prev.startedAt
          && Date.now() - new Date(prev.startedAt).getTime() >= Number(prev.budgetMs);
        const settlement = await settleCancellation(prev, run, budgetExceeded, false);
        if (settlement.projection) {
          const changed = runtimeChanged || usageChanged || JSON.stringify(settlement.projection) !== JSON.stringify(prev);
          state.researchAgent = settlement.projection;
          return { state, changed };
        }
        run = settlement.run; observedRun = run;
        const failed = run.status === 'failed';
        const completed = run.status === 'completed';
        const cancelled = run.status === 'cancelled';
        const nextStatus = failed ? 'failed' : completed ? 'completed' : cancelled ? (prev.timedOut ? 'timed_out' : 'cancelled') : 'running';
        const terminal = ['completed', 'failed', 'cancelled', 'timed_out'].includes(nextStatus);
        // 事件新鲜度：供循环做停滞/事件预算终止
        const eventCount = events.length;
        const lastEventAt = lastManagedActivityAt(run, prev.lastEventAt, eventCount > (prev.eventCount || 0));
        const phaseLabel = prev.runPhase === 'acquire' ? '研究员采集' : prev.runPhase === 'experience' ? '研究员经验调研' : '研究员整理笔记';
        const nextResearchAgent = {
          ...prev,
          resourceRelease: run.resourceRelease || (terminal ? { confirmed: true, status: 'confirmed' } : prev.resourceRelease),
          status: nextStatus,
          runPhase: prev.runPhase,
          phase: failed ? `${phaseLabel}失败` : completed ? (prev.runPhase === 'acquire' ? '采集完成，待整理笔记' : prev.runPhase === 'experience' ? '经验调研完成' : '研究员笔记完成') : cancelled ? '研究员已取消' : nextStatus === 'timed_out' ? '研究员预算耗尽' : prev.status === 'cancel_requested' ? '正在取消研究员' : (prev.runPhase === 'acquire' ? '研究员采集中' : prev.runPhase === 'experience' ? '研究员搜寻优化经验中' : '研究员整理笔记中'),
          progress: terminal ? 100 : prev.progress,
          messages: prev.messages,
          lastEventAt,
          eventCount,
          error: failed ? structuredClone(run.error || { code: 'CODEX_RESEARCH_FAILED', message: 'Research Agent failed.' }) : null,
        };
        // 产出笔记：综合阶段，或单阶段（无 sourceRoot 的采集=一次检索产笔记）
        const singlePhaseAcquire = prev.runPhase === 'acquire' && !prev.sourceRoot;
        if (terminal && !prev.notes?.length && (prev.runPhase === 'synthesize' || prev.runPhase === 'experience' || singlePhaseAcquire)) {
          const parsed = parseResearchResult(events);
          const note = {
            id: `note_${prev.runId}`,
            runId: prev.runId,
            direction: prev.direction,
            content: parsed.rawText,
            summary: parsed.summary,
            findings: parsed.findings,
            suggestedDirections: parsed.suggestedDirections,
            sources: parsed.sources,
            baselineSources: parsed.baselineSources || [],
            researchDir: prev.researchDir,
            startedAt: prev.startedAt,
            completedAt: new Date().toISOString(),
            value: null,
          };
          state.researchNotes = [note, ...(state.researchNotes || []).filter((n) => n.runId !== note.runId)].slice(0, 50);
          nextResearchAgent.notes = [note];
          nextResearchAgent.completedAt = note.completedAt;
          appendRuntimeEvent(state, failed ? 'research.failed' : nextStatus === 'timed_out' ? 'research.timed_out' : 'research.completed', { runId: prev.runId, direction: prev.direction, summary: parsed.summary }, { kind: 'research', mode });
        } else if (terminal && !prev.notes?.length && prev.runPhase === 'acquire') {
          if (!failed && nextStatus === 'completed' && prev.sourceRoot) {
            const activeMission = state.missions?.find((mission) => mission.id === state.activeMissionId) || {};
            const acquiredSources = await acquireSelectedSources({
              events,
              sourceRoot: prev.sourceRoot,
              researchDir: prev.researchDir,
              mirrorPolicy: await sourceMirrorPolicy(),
              allowDiscoveredSources: activeMission.sourcePolicy?.allowDiscoveredSources === true,
              allowSemanticFallback: activeMission.sourcePolicy?.allowSemanticFallback === true,
            });
            const acquiredSourceSummary = summarizeAcquiredSources(acquiredSources);
            nextResearchAgent.acquiredSources = acquiredSourceSummary;
            nextResearchAgent.phase = '采集完成，待整理笔记';
            nextResearchAgent.completedAt = new Date().toISOString();
            appendRuntimeEvent(state, 'research.acquire_completed', {
              runId: prev.runId,
              phase: 'acquire',
              acquiredSources: acquiredSourceSummary,
            }, { kind: 'research', mode });
          } else {
            appendRuntimeEvent(state, 'research.failed', {
              runId: prev.runId,
              phase: 'acquire',
              errorCode: run.error?.code || (nextStatus === 'timed_out' ? 'CODEX_RESEARCH_TIMED_OUT' : 'CODEX_RESEARCH_FAILED'),
            }, { kind: 'research', mode });
          }
        }
        const changed = runtimeChanged || usageChanged || JSON.stringify(nextResearchAgent) !== JSON.stringify(prev);
        state.researchAgent = nextResearchAgent;
        if (prev.synchronous === true) return { state, changed };
      } catch (error) {
        if (!isExecutionReleased(observedRun || {})) {
          state.researchAgent = cancellationProjection(state.researchAgent, { status: 'unconfirmed', code: error.code || 'AGENT_STATUS_UNAVAILABLE', reason: error.message });
          return { state, changed: true };
        }
        appendRuntimeEvent(state, 'research.acquire_failed', {
          runId: state.researchAgent?.runId,
          phase: state.researchAgent?.runPhase,
          errorCode: error.code || 'RESEARCH_SOURCE_ACQUISITION_FAILED',
          details: error.details || null,
        }, { kind: 'research', mode });
        state.researchAgent = { ...state.researchAgent, resourceRelease: observedRun.resourceRelease || { confirmed: true, status: 'confirmed' }, status: 'failed', phase: '研究员处理失败', progress: 100, messages: [...(state.researchAgent.messages || []), { id: `research-projection-error-${state.researchAgent.runId}`, phase: 'research', status: 'waiting', title: '研究或来源处理失败', detail: error.message, time: '刚刚' }] };
        if (state.researchAgent?.synchronous === true) return { state, changed: true };
      }
    }
    if (managedCliMode && state.agent?.runtimeKind === mode && state.agent?.runId) {
      let observedRun = null;
      try {
        let run = await runtimeEngine.invoke(mode, 'readRun', state.agent.runId);
        observedRun = run;
        const events = await runtimeEngine.invoke(mode, 'readEvents', state.agent.runId);
        const usageBefore = JSON.stringify(state.tokenUsage || null);
        recordRunTokenUsage(state, { runId: state.agent.runId, phase: 'iteration', provider: mode, events });
        const usageChanged = usageBefore !== JSON.stringify(state.tokenUsage || null);
        const agentResult = parseAgentResult(events);
        const threadEvent = events.find((event) => event.type === 'thread.started' || event.type === 'thread_start' || event.thread_id || event.threadId);
        const assistantEvents = events.filter((event) => event.item?.type === 'agent_message' || /agent_message|message.completed/i.test(event.type || ''));
        const toolEvents = events.filter((event) => /tool|command|function_call/i.test(`${event.type || ''} ${event.item?.type || ''}`));
        // The run record is the terminal source of truth. A completed Codex turn may
        // contain failed tool calls or recoverable error events without failing the run.
        let failed = run.status === 'failed';
        let completed = run.status === 'completed';
        const workflowAdvanced = state.patchApplied || ['validation', 'evidence', 'curation', 'published'].includes(state.stage);
        // 取消后进程未必立即死透：run.status 仍为 running，不能把已请求的取消覆盖回 running
        // （与研究分支同法：保留 cancel_requested，直到进程真正终结为 cancelled）。
        const eventCount = events.length;
        const lastEventAt = lastManagedActivityAt(run, state.agent.lastEventAt, eventCount > (state.agent.eventCount || 0));
        const elapsed = state.agent.startedAt ? Date.now() - new Date(state.agent.startedAt).getTime() : 0;
        const stalled = !completed && !failed && run.status !== 'cancelled' && lastEventAt && Date.now() - lastEventAt >= mainAgentStallMs;
        const budgetExceeded = !completed && !failed && run.status !== 'cancelled' && elapsed >= (state.agent.budgetMs || mainAgentBudgetMs);
        const settlement = await settleCancellation(state.agent, run, stalled || budgetExceeded);
        if (settlement.projection) {
          const changed = runtimeChanged || usageChanged || JSON.stringify(settlement.projection) !== JSON.stringify(state.agent);
          state.agent = settlement.projection;
          return { state, changed };
        }
        run = settlement.run; observedRun = run;
        failed = run.status === 'failed'; completed = run.status === 'completed';
        const timedOut = isExecutionReleased(run) && (stalled || budgetExceeded || (run.status === 'cancelled' && state.agent.timedOut === true));
        const nextStatus = failed ? 'failed' : completed ? 'completed' : timedOut ? 'completed' : run.status === 'cancelled' ? 'cancelled' : state.agent.status === 'cancel_requested' ? 'cancel_requested' : 'running';
        const failure = failed ? classifyManagedFailure(run, events) : null;
        const projectedMessages = assistantEvents.slice(-8).map((event, index) => ({ id: event.id || `${managedMeta.slug}-event-${index}`, phase: event.type || managedMeta.name, status: failed ? 'waiting' : 'completed', title: event.type || `${managedMeta.name} 事件`, detail: runtimeEngine.invoke(mode, 'eventText', event) || `${managedMeta.name} 已产生新的运行事件`, time: event.timestamp || '刚刚' }));
        if (failure) projectedMessages.push({ id: `${managedMeta.slug}-error-${state.agent.runId}`, phase: managedMeta.name, status: 'waiting', title: failure.title, detail: failure.detail, time: run.completedAt || '刚刚', errorCode: failure.code });
        const terminalCompleted = completed || timedOut;
        const terminalReached = terminalCompleted || failed;
        const recoverableGenerationFailure = timedOut || (failed && failure && !NON_RECOVERABLE_MANAGED_FAILURE_CODES.has(failure.code));
        let candidateValidation = null;
        let verifiedCandidates = agentResult.candidates;
        const activeMission = state.missions?.find((mission) => mission.id === state.activeMissionId) || {};
        const candidateInspectionEligible = terminalCompleted || recoverableGenerationFailure;
        if (candidateInspectionEligible && (agentResult.candidates.length || !workflowAdvanced)) {
          let manifest = await workspaceManager.captureDiff(run.workspace);
          if (!manifest.changedFiles?.length && agentResult.patch) {
            try {
              const applied = await workspaceManager.applyWorkspacePatch({ repository: run.workspace, patch: agentResult.patch });
              appendRuntimeEvent(state, 'candidate.patch_applied_from_result', { runId: state.agent.runId, files: applied.files }, { kind: 'candidate', mode });
              manifest = await workspaceManager.captureDiff(run.workspace);
            } catch (error) {
              appendRuntimeEvent(state, 'candidate.patch_result_rejected', { runId: state.agent.runId, errorCode: error.code || 'AGENT_PATCH_REJECTED', detail: error.message }, { kind: 'policy', mode });
            }
          }
          const stableDigest = state.workflowRecovery?.checkpoints?.at(-1)?.stableDigest || null;
          ({ candidateValidation, verifiedCandidates } = inspectCandidateDiff({
            agentResult,
            manifest,
            stableDigest,
            provider: managedMeta,
            runId: state.agent.runId,
          }));
        }
        if (terminalReached && verifiedCandidates.length && !workflowAdvanced) {
          const { requiredWorkspaceFiles, contentFiles } = candidateWorkspaceRequirements(activeMission);
          const workspaceFiles = (await Promise.all(requiredWorkspaceFiles.map(async (file) => await fileExists(path.join(run.workspace, file)) ? file : null))).filter(Boolean);
          const entryContent = (await Promise.all(contentFiles.map((file) => readFile(path.join(run.workspace, file), 'utf8').catch(() => '')))).join('\\n');
          ({ candidateValidation, verifiedCandidates } = finalizeCandidateAdmission({
            admission: { candidateValidation, verifiedCandidates },
            mission: activeMission,
            workspaceFiles,
            entryContent,
            runHistory: state.runHistory || [],
            round: state.iterationStats?.round || 0,
            provider: managedMeta,
          }));
        }
        const nextAgent = {
          ...state.agent,
          status: nextStatus,
          resourceRelease: run.resourceRelease || (isExecutionReleased(run) ? { confirmed: true, status: 'confirmed' } : state.agent.resourceRelease),
          phase: failure?.phase || (timedOut ? `${managedMeta.name} 单轮停滞，已收敛为无候选` : completed ? `${managedMeta.name} 分析完成` : state.agent.status === 'cancel_requested' ? `正在取消 ${managedMeta.name}` : `${managedMeta.name} 正在分析`),
          progress: completed || failed || timedOut ? 100 : Math.max(5, Math.min(95, 5 + events.length * 3)),
          threadId: run.threadId || threadEvent?.thread_id || threadEvent?.threadId || state.agent.threadId || null,
          messages: projectedMessages.length ? projectedMessages : state.agent.messages,
          toolCalls: [...toolEvents.reduce((latestById, event, index) => {
            const eventId = event.id || event.item?.id || `${managedMeta.slug}-tool-${index}`;
            latestById.set(eventId, event);
            return latestById;
          }, new Map()).entries()].slice(-20).map(([eventId, event]) => {
            const toolFailed = event.item?.status === 'failed' || event.status === 'failed' || Boolean(event.item?.error);
            const toolCompleted = event.type === 'item.completed' || /completed|done/i.test(event.status || event.item?.status || '');
            return { id: eventId, toolId: event.tool || event.name || event.item?.name || `${managedMeta.slug}.${event.item?.type || 'tool'}`, name: event.name || event.tool || event.item?.name || (event.item?.type === 'command_execution' ? 'Managed Tool' : event.item?.type || `${managedMeta.name} Tool`), version: descriptor.version ? `v${descriptor.version}` : 'runtime', skillId: `${managedMeta.slug}.exec`, status: toolFailed ? 'failed' : toolCompleted ? 'completed' : completed ? 'warning' : 'running', summary: runtimeEngine.invoke(mode, 'eventText', event) || `${managedMeta.name} tool call`, permission: `${managedMeta.slug}:managed` };
          }),
          artifacts: [{ id: `${managedMeta.slug}-run-${state.agent.runId}`, kind: `${managedMeta.name} Run`, title: state.agent.artifacts?.[0]?.title || `${managedMeta.name} Mission`, status: nextStatus, meta: `${events.length} events · ${run.threadId || 'session pending'}` }],
          result: agentResult,
          candidateValidation,
          activity: run.activity || state.agent.activity || null,
          eventCount,
          lastEventAt,
          timedOut: timedOut || undefined,
        };
        if (terminalReached && verifiedCandidates.length && !workflowAdvanced) {
          state.candidateEvaluations = verifiedCandidates;
          state.stage = 'candidate';
          nextAgent.status = 'awaiting_action';
          nextAgent.phase = 'Candidate Plan 已生成';
          nextAgent.currentAction = agentResult.nextAction || {
            id: `action.apply-${verifiedCandidates[0].id}`,
            type: 'candidate.plan',
            title: `应用 ${verifiedCandidates[0].id}`,
            reason: 'Agent 已在隔离工作区生成并通过 Diff 边界校验，进入固定测试流程。',
            expectedOutput: 'Patch applied and ready for correctness validation',
            risk: 'medium',
            approvalRequired: false,
            approvalPolicy: 'client-controlled',
          };
          nextAgent.artifacts = [
            ...nextAgent.artifacts,
            { id: `agent-result-${state.agent.runId}`, kind: 'Candidate Plan', title: `${verifiedCandidates.length} 个已验证 Agent Candidate`, status: 'awaiting_action', meta: `${agentResult.format} · Git Diff verified` },
          ];
        } else if (terminalReached && candidateValidation?.passed === false && !workflowAdvanced) {
          nextAgent.status = 'failed';
          nextAgent.phase = 'Candidate Diff 校验失败';
          nextAgent.currentAction = null;
          nextAgent.messages = [...nextAgent.messages, { id: `candidate-validation-${state.agent.runId}`, phase: 'Candidate', status: 'waiting', title: '候选未进入候选池', detail: candidateValidation.detail, time: '刚刚', errorCode: candidateValidation.code }];
          appendRuntimeEvent(state, 'candidate.diff_rejected', { runId: state.agent.runId, ...candidateValidation }, { kind: 'policy', mode: 'client' });
        } else if (terminalReached && !agentResult.candidates.length && !workflowAdvanced && (!failed || recoverableGenerationFailure)) {
          state.stage = 'diagnosis';
          state.candidateEvaluations = [];
          nextAgent.status = 'completed';
          nextAgent.phase = failed ? `${managedMeta.name} 执行失败，等待同轮重试` : `${managedMeta.name} 分析完成，未生成候选`;
          nextAgent.currentAction = null;
          if (!state.runtimeEvents?.some((event) => event.type === 'candidate.not_proposed' && event.payload?.runId === state.agent.runId)) {
            appendRuntimeEvent(state, 'candidate.not_proposed', {
              runId: state.agent.runId,
              summary: agentResult.summary,
              recoverable: recoverableGenerationFailure,
              errorCode: failure?.code || null,
              error: failure?.detail || null,
            }, { kind: 'agent', mode });
          }
        }
        if (workflowAdvanced) {
          nextAgent.status = state.agent.status;
          nextAgent.phase = state.agent.phase;
          nextAgent.currentAction = state.agent.currentAction;
        }
        if (run.status === 'cancelled'
            && state.stage === 'candidate'
            && !state.patchApplied
            && Array.isArray(state.candidateEvaluations)
            && state.candidateEvaluations.length > 0) {
          const candidateId = state.candidateEvaluations[0].id || 'candidate-01';
          nextAgent.status = 'awaiting_action';
          nextAgent.phase = 'Candidate Plan 已生成';
          nextAgent.currentAction = state.agent.currentAction || {
            id: `action.${candidateId}.retry`,
            type: 'candidate.plan',
            title: `提交 ${candidateId} 测试`,
            reason: `候选已在 Mission 工作区形成；上一 ${managedMeta.name} 进程已结束，客户端可继续应用并提交测试。`,
            expectedOutput: 'Correctness · Benchmark · Tracer · Profiler',
            risk: 'medium',
            approvalRequired: false,
            approvalPolicy: 'client-controlled',
          };
        }
        const previousStatus = state.agent.status;
        const changed = runtimeChanged || usageChanged || JSON.stringify(nextAgent) !== JSON.stringify(state.agent);
        state.agent = nextAgent;
        if (nextStatus === 'completed' && verifiedCandidates.length && !workflowAdvanced) state.stage = 'candidate';
        const lifecycleEventType = `${managedMeta.slug}.run_${nextStatus}`;
        const lifecycleEventRecorded = state.runtimeEvents?.some((event) => event.type === lifecycleEventType && event.payload?.runId === state.agent.runId);
        if (nextStatus !== previousStatus && !lifecycleEventRecorded) appendRuntimeEvent(state, lifecycleEventType, { runId: state.agent.runId, threadId: nextAgent.threadId, eventCount: events.length, errorCode: failure?.code || null }, { kind: 'agent', mode });
        return { state, changed };
      } catch (error) {
        if (!isExecutionReleased(observedRun || {})) {
          state.agent = cancellationProjection(state.agent, { status: 'unconfirmed', code: error.code || 'AGENT_STATUS_UNAVAILABLE', reason: error.message });
          return { state, changed: true };
        }
        const nextAgent = { ...state.agent, status: 'failed', phase: `${managedMeta.name} 状态读取失败`, progress: 100, messages: [...(state.agent.messages || []), { id: `${managedMeta.slug}-projection-error-${state.agent.runId}`, phase: managedMeta.name, status: 'waiting', title: `无法读取 ${managedMeta.name} 运行状态`, detail: error.message, time: '刚刚' }] };
        state.agent = nextAgent;
        return { state, changed: true };
      }
    }
    if (mode !== 'cli-file' || !descriptor.connected || !state.agent?.runId?.startsWith('cli_')) return { state, changed: runtimeChanged };

    let statusDocument;
    try { statusDocument = await readJson(statusPath); } catch { return { state, changed: runtimeChanged }; }
    const statusRunId = statusDocument.requestId || statusDocument.request_id || statusDocument.runId || statusDocument.run_id || statusDocument.session_id;
    const statusMissionId = statusDocument.missionId || statusDocument.mission_id || statusDocument.task?.missionId;
    const runMatches = statusRunId === state.agent.runId;
    const missionMatches = !statusMissionId || statusMissionId === state.activeMissionId;
    if (!runMatches || !missionMatches) return { state, changed: runtimeChanged };
    const sourceStatus = statusDocument.status || statusDocument.state || statusDocument.task?.status;
    const projectedStatus = runtimeStatusMap[sourceStatus] || state.agent.status;
    const sourceEvents = Array.isArray(statusDocument.events) ? statusDocument.events : [];
    const messages = sourceEvents.slice(-8).map((event, index) => ({
      id: event.event_id || event.id || `cli-event-${index}`,
      phase: event.type || event.kind || 'Mission',
      status: /failure|blocked/.test(event.type || '') ? 'waiting' : 'completed',
      title: event.summary || event.type || 'CLI Runtime 事件',
      detail: event.reason || event.detail || event.message || '状态已由 CLI 文件投影。',
      time: event.timestamp || '刚刚',
    }));
    const nextAgent = {
      ...state.agent,
      status: projectedStatus,
      phase: statusDocument.phase || statusDocument.current_action?.name || state.agent.phase,
      progress: Number(statusDocument.progress ?? state.agent.progress) || 0,
      messages: messages.length ? messages : state.agent.messages,
    };
    const changed = runtimeChanged || JSON.stringify(nextAgent) !== JSON.stringify(state.agent);
    state.agent = nextAgent;
    return { state, changed };
  };

  const projectWithResourceRelease = async (state) => {
    const projected = await projectState(state);
    const release = reconcileResourceRelease(projected.state);
    return { ...projected, state: release.state, changed: projected.changed || release.changed };
  };
  return { mode, describe, preflight, startRun, cancelRun, startResearch, startBaselineMaterialization, projectState: projectWithResourceRelease, codexClient: codex, claudeClient: claude };
}

export const agentRuntime = createAgentRuntime();
