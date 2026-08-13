import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { opencodeClient as defaultOpenCodeClient, parseOpenCodeModel } from './opencode-client.mjs';
import { classifyCodexFailure, codexClient as defaultCodexClient } from './codex-client.mjs';
import { parseAgentResult, parseResearchResult } from './agent-result.mjs';
import { runtimeDir } from './storage-paths.mjs';
import { workspaceManager } from './workspace-manager.mjs';

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

export function appendRuntimeEvent(state, type, payload = {}, source = { kind: 'adapter' }) {
  const events = Array.isArray(state.runtimeEvents) ? state.runtimeEvents : [];
  const sequence = events.reduce((maximum, event) => Math.max(maximum, Number(event.sequence) || 0), 0) + 1;
  const event = {
    eventId: `evt_${Date.now().toString(36).toUpperCase()}_${sequence}`,
    missionId: state.activeMissionId,
    sequence,
    type,
    timestamp: new Date().toISOString(),
    source,
    payload,
  };
  state.runtimeEvents = [...events, event].slice(-500);
  return event;
}

export function createAgentRuntime(options = {}) {
  const mode = options.mode || process.env.OPERATOR_RUNTIME_MODE || 'codex-cli';
  const cliRoot = options.cliRoot || process.env.OPERATOR_CLI_ROOT || '';
  const bridgeDir = options.bridgeDir || process.env.OPERATOR_BRIDGE_DIR || defaultBridgeDir;
  const statusPath = cliRoot ? path.join(cliRoot, process.env.OPERATOR_CLI_STATUS_FILE || 'results/agent_status_cli_integration.json') : '';
  const queuePath = cliRoot ? path.join(cliRoot, process.env.OPERATOR_CLI_QUEUE_FILE || 'results/test_queue.jsonl') : '';
  const recordsPath = cliRoot ? path.join(cliRoot, process.env.OPERATOR_CLI_RECORDS_FILE || 'docs/optimization_records.json') : '';
  const openCodeClient = options.opencodeClient || defaultOpenCodeClient;
  const openCodeAgent = options.openCodeAgent || process.env.OPENCODE_AGENT || 'plan';
  const openCodeModel = options.openCodeModel || process.env.OPENCODE_MODEL || '';
  const codex = options.codexClient || defaultCodexClient;
  const codexWorkspace = options.codexWorkspace || process.env.OPERATOR_CODEX_WORKSPACE || rootDir;
  const codexDescriptorTtlMs = Number(options.codexDescriptorTtlMs ?? 60_000);
  let codexDescriptorCache = null;
  let codexDescriptorCachedAt = 0;
  const openCodeDescriptorTtlMs = Number(options.openCodeDescriptorTtlMs ?? 5_000);
  let openCodeDescriptorCache = null;
  let openCodeDescriptorCachedAt = 0;

  const describeOpenCode = async () => {
    if (openCodeDescriptorCache && Date.now() - openCodeDescriptorCachedAt < openCodeDescriptorTtlMs) return openCodeDescriptorCache;
    try {
      const [health, providers] = await Promise.all([openCodeClient.health(), openCodeClient.providers()]);
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
        error: error.message,
        hint: `请先启动 opencode serve，并确认 ${openCodeClient.baseUrl}/global/health 可访问。`,
      };
    }
    openCodeDescriptorCachedAt = Date.now();
    return openCodeDescriptorCache;
  };

  const describeCodex = async () => {
    if (codexDescriptorCache && Date.now() - codexDescriptorCachedAt < codexDescriptorTtlMs) return codexDescriptorCache;
    const probe = await codex.describe();
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
      capabilities: connected ? ['mission.run', 'mission.resume', 'event.read', 'tool.read', 'candidate.observe', 'workflow.decide', 'workflow.intervene', 'workflow.rollback'] : [],
      hint,
      configurationAuthority: 'local-codex',
      authProbe: restrictedUserContext ? 'restricted-user-context' : probe.loggedIn ? 'official-login-detected' : 'delegated-to-local-codex',
      probe: { installed: Boolean(probe.installed), officialLoginDetected: Boolean(probe.loggedIn), restrictedUserContext },
    };
    codexDescriptorCachedAt = Date.now();
    return codexDescriptorCache;
  };

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
    if (mode === 'codex-cli') return describeCodex();

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
    if (mode === 'codex-cli') {
      const result = typeof codex.preflight === 'function'
        ? await codex.preflight({ workspace })
        : { ready: true, code: 'CODEX_READY', workspace };
      return { ...result, runtime: descriptor };
    }
    return { ready: true, code: 'AGENT_RUNTIME_READY', runtime: descriptor, workspace };
  };

  const startRun = async ({ state, mission, goal, resumeThreadId = null, workspace: requestedWorkspace = null }) => {
    if (mode === 'reference-fixture') return { handled: false };
    if (mode === 'opencode-server') {
      const descriptor = await describeOpenCode();
      if (!descriptor.connected) {
        const error = new Error(descriptor.hint);
        error.status = 503;
        error.code = 'OPENCODE_RUNTIME_UNAVAILABLE';
        throw error;
      }
      const session = await openCodeClient.createSession(`Operator Studio · ${mission.id} · ${mission.title}`);
      const prompt = [
        'You are connected to Operator Studio as its local optimization Agent.',
        `Mission ID: ${mission.id}`,
        `Goal: ${goal}`,
        `Target hardware: ${(mission.hardware || []).join(', ') || 'not specified'}`,
        `Metric: ${mission.metric || 'not specified'}`,
        'Inspect the current OpenCode project in planning mode. Do not edit files in this pass.',
        'Return a concrete diagnosis, tool evidence, candidate options, risks, and the recommended next action.',
      ].join('\n');
      try {
        await openCodeClient.promptAsync(session.id, { text: prompt, agent: openCodeAgent, model: openCodeModel });
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
      return { handled: true, state };
    }
    if (mode === 'codex-cli') {
      const descriptor = await describeCodex();
      if (!descriptor.connected) {
        const error = new Error(descriptor.hint);
        error.status = 503;
        error.code = 'CODEX_RUNTIME_UNAVAILABLE';
        throw error;
      }
      if (state.researchAgent?.runId) {
        const error = new Error('研究员正在运行，主线程与研究员串行执行。');
        error.status = 409;
        error.code = 'RESEARCH_SERIAL_BUSY';
        throw error;
      }
      const runId = `codex_${Date.now().toString(36).toUpperCase()}_${randomUUID().slice(0, 8).toUpperCase()}`;
      if (!requestedWorkspace || !await directoryExists(requestedWorkspace)) {
        const error = new Error('Codex 只能在 Operator Studio 创建的 Mission 工作区中运行。');
        error.status = 409;
        error.code = 'CODEX_MANAGED_WORKSPACE_REQUIRED';
        throw error;
      }
      const workspace = requestedWorkspace;
      const sourceRoot = mission.sourceRoot || null;
      if (sourceRoot) await mkdir(sourceRoot, { recursive: true });
      const prompt = [
        'You are the local optimization Agent for Operator Studio.',
        `Mission ID: ${mission.id}`,
        `Goal: ${goal}`,
        `Target hardware: ${(mission.hardware || []).join(', ') || 'not specified'}`,
        `Metric: ${mission.metric || 'not specified'}`,
        `Workspace: ${workspace}`,
        `Source Registry: ${sourceRoot || 'not configured'}`,
        'The Workspace is the isolated snapshot of the project-owned Iteration Repository. Only files changed inside this Workspace may become Candidate files.',
        sourceRoot ? 'Third-party or upstream repositories must be cloned under the Source Registry. They are reference sources, never Candidate files. Record their repository URL, commit and referenced paths in sourceReferences.' : 'Do not clone third-party repositories into the Iteration Repository workspace.',
        'Inspect the repository and available local evidence. You may create a bounded candidate patch, but project code writes must stay inside the isolated Mission workspace. Do not call a remote benchmark service in this turn; Operator Studio owns the serialized test queue.',
        'Return one JSON object and no Markdown fences with this shape: {"schemaVersion":"operator-studio.agent-result/v1","summary":"...","diagnosis":{"summary":"...","bottlenecks":[]},"candidates":[{"id":"candidate-01","title":"...","hypothesis":"...","change":"...","files":["relative/path"],"sourceReferences":[{"repository":"https://...","commit":"...","path":"upstream/path"}],"risks":[]}],"recommendedCandidate":"candidate-01","nextAction":{"type":"candidate.plan","title":"...","reason":"...","expectedOutput":"...","risk":"medium"},"risks":[]}. List only files actually changed in the Mission workspace. If no candidate is justified, do not edit files; return an empty candidates array and explain why in summary.',
        'Do not decide whether human approval is required. Operator Studio applies its own policy to evidence and risk signals.',
        'For a resumed thread, follow the new user goal while keeping all work inside this isolated Mission workspace.',
      ].join('\n');
      const run = await codex.start({ runId, missionId: mission.id, goal: prompt, workspace, additionalDirectories: sourceRoot ? [sourceRoot] : [], resumeThreadId });
      state.stage = 'diagnosis';
      state.patchApplied = false;
      state.agent = {
        status: 'running',
        phase: 'Codex 正在分析',
        progress: 5,
        missionId: mission.id,
        runId,
        runtimeKind: 'codex-cli',
        threadId: run.threadId || resumeThreadId || null,
        profileId: 'profile.operator-orchestrator',
        goal,
        startedAt: run.startedAt,
        currentAction: null,
        toolCalls: [],
        messages: [{ id: `codex-start-${runId}`, phase: 'Mission', status: 'running', title: resumeThreadId ? 'Codex Mission 已恢复' : 'Codex Mission 已启动', detail: `Run ${runId} · ${descriptor.version || 'Codex CLI'}${resumeThreadId ? ` · thread ${resumeThreadId}` : ''}`, time: '刚刚' }],
        artifacts: [{ id: `codex-run-${runId}`, kind: 'Codex Run', title: mission.title, status: 'running', meta: 'Codex exec --json · 本地事件投影' }],
      };
      appendRuntimeEvent(state, resumeThreadId ? 'codex.run_resumed' : 'codex.run_started', { runId, threadId: run.threadId || resumeThreadId || null, workspace: run.workspace }, { kind: 'agent', mode: 'codex-cli' });
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
    return { handled: true, state };
  };

  const buildResearchPrompt = ({ mission, direction, researchDir }) => [
    'You are the Research Agent for Operator Studio — a read-only research scout that assists operator iteration.',
    `Mission ID: ${mission.id}`,
    `Target hardware: ${(mission.hardware || []).join(', ') || 'not specified'}`,
    `Metric: ${mission.metric || 'not specified'}`,
    `Current best: ${mission.currentBest?.value || 'not established'}`,
    `Research direction: ${direction}`,
    `Research directory: ${researchDir}`,
    'You have network access. Research the latest operator implementations, papers and open-source libraries relevant to the direction above. You may git clone repositories, read upstream sources, and browse documentation.',
    `You may write ONLY inside the research directory: ${researchDir} (e.g. clones/ and notes/). You MUST NOT modify the Mission workspace, the Iteration Repository, or create any candidate patch. This is a read-only research turn.`,
    'Do NOT propose candidates, do not produce a "candidates" field, and do not call any benchmark or test service.',
    'Return one JSON object and no Markdown fences with this shape: {"schemaVersion":"operator-studio.research-notes/v1","summary":"...","findings":["..."],"suggestedDirections":["..."],"sources":[{"title":"...","url":"...","type":"paper|repo|docs"}]}. If no structured material can be gathered, return a plain-text summary instead.',
  ].join('\n');

  const startResearch = async ({ state, mission, direction, workspace }) => {
    if (mode !== 'codex-cli') {
      const error = new Error(`Research Agent is only supported by runtime mode codex-cli (current: ${mode}).`);
      error.status = 503;
      error.code = 'RESEARCH_RUNTIME_UNSUPPORTED';
      throw error;
    }
    const descriptor = await describeCodex();
    if (!descriptor.connected) {
      const error = new Error(descriptor.hint);
      error.status = 503;
      error.code = 'CODEX_RUNTIME_UNAVAILABLE';
      throw error;
    }
    if (state.agent?.runId) {
      const error = new Error('主线程 Agent 正在运行，研究员与主线程串行执行。');
      error.status = 409;
      error.code = 'RESEARCH_SERIAL_BUSY';
      throw error;
    }
    if (state.researchAgent?.runId) {
      const error = new Error('研究员已在运行。');
      error.status = 409;
      error.code = 'RESEARCH_RUN_ACTIVE';
      throw error;
    }
    const runId = `codex_research_${Date.now().toString(36).toUpperCase()}_${randomUUID().slice(0, 8).toUpperCase()}`;
    if (!workspace) {
      const error = new Error('研究员需要一个隔离调研目录。');
      error.status = 409;
      error.code = 'RESEARCH_WORKSPACE_REQUIRED';
      throw error;
    }
    await mkdir(path.join(workspace, 'notes'), { recursive: true });
    await mkdir(path.join(workspace, 'clones'), { recursive: true });
    const prompt = buildResearchPrompt({ mission, direction, researchDir: workspace });
    const run = await codex.start({
      runId,
      missionId: mission.id,
      goal: prompt,
      workspace,
      additionalDirectories: mission.sourceRoot ? [mission.sourceRoot] : [],
      sandboxMode: 'danger-full-access',
    });
    state.researchAgent = {
      status: 'running',
      phase: '研究员调研中',
      progress: 5,
      missionId: mission.id,
      runId,
      runtimeKind: 'codex-cli',
      threadId: run.threadId || null,
      direction,
      researchDir: workspace,
      startedAt: run.startedAt,
      completedAt: null,
      budgetMs: 20 * 60 * 1000,
      notes: [],
      messages: [{ id: `research-start-${runId}`, phase: 'research', status: 'running', title: '研究员已启动', detail: `Run ${runId} · 开放沙箱 · ${direction}`, time: '刚刚' }],
      artifacts: [{ id: `research-run-${runId}`, kind: 'Research Run', title: '研究员调研', status: 'running', meta: 'Codex exec --json · research-notes/v1' }],
      injected: false,
    };
    appendRuntimeEvent(state, 'research.run_started', { runId, direction, researchDir: workspace }, { kind: 'research', mode: 'codex-cli' });
    return { handled: true, state };
  };

  const cancelRun = async ({ state, runId }) => {
    if (state.researchAgent?.runId && runId === state.researchAgent.runId) {
      if (mode !== 'codex-cli') {
        const error = new Error(`Research cancellation is not supported by runtime mode ${mode}.`);
        error.status = 409;
        error.code = 'AGENT_CANCEL_UNAVAILABLE';
        throw error;
      }
      const result = await codex.cancel(runId);
      state.researchAgent = { ...state.researchAgent, status: 'cancel_requested', phase: '研究员取消已请求' };
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
    if (mode === 'codex-cli') result = await codex.cancel(runId);
    else if (mode === 'opencode-server') result = await openCodeClient.abort(runId);
    else {
      const error = new Error(`Agent cancellation is not supported by runtime mode ${mode}.`);
      error.status = 409;
      error.code = 'AGENT_CANCEL_UNAVAILABLE';
      throw error;
    }
    state.agent = {
      ...state.agent,
      status: 'cancel_requested',
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
          openCodeClient.sessionStatus(),
          openCodeClient.messages(sessionId),
          openCodeClient.diff(sessionId),
        ]);
        const sessionStatus = statuses?.[sessionId]?.type || statuses?.[sessionId]?.status || 'idle';
        const messageList = Array.isArray(messages) ? messages : [];
        const diffList = Array.isArray(diff) ? diff : [];
        const assistantMessages = messageList.filter((message) => message?.info?.role === 'assistant');
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
        const changed = runtimeChanged || JSON.stringify(nextAgent) !== JSON.stringify(state.agent);
        state.agent = nextAgent;
        if (statusChanged) appendRuntimeEvent(state, errors.length ? 'opencode.session_failed' : diffList.length ? 'opencode.diff_ready' : 'opencode.session_updated', { sessionId, status: nextStatus, diffCount: diffList.length, error: errors.at(-1) || null }, { kind: 'agent', mode: 'opencode-server' });
        return { state, changed: changed || statusChanged };
      } catch (error) {
        const nextAgent = { ...state.agent, status: 'failed', phase: 'OpenCode 状态读取失败', progress: 100, messages: [...(state.agent.messages || []), { id: `opencode-projection-error-${sessionId}`, phase: 'OpenCode', status: 'waiting', title: '无法读取 OpenCode Session', detail: error.message, time: '刚刚' }] };
        const changed = runtimeChanged || JSON.stringify(nextAgent) !== JSON.stringify(state.agent);
        state.agent = nextAgent;
        return { state, changed };
      }
    }
    // 研究员子 Agent 是平行 run：只投影 state.researchAgent，绝不触碰主线程的
    // stage / candidateEvaluations / patchApplied，避免干扰候选验证路径。
    if (mode === 'codex-cli' && state.researchAgent?.runId && state.researchAgent?.runtimeKind === 'codex-cli') {
      try {
        const prev = state.researchAgent;
        const run = await codex.readRun(prev.runId);
        const events = await codex.readEvents(prev.runId);
        const failed = run.status === 'failed';
        const completed = run.status === 'completed';
        const cancelled = run.status === 'cancelled';
        const budgetExceeded = prev.startedAt && Date.now() - new Date(prev.startedAt).getTime() >= (prev.budgetMs || 0);
        const nextStatus = failed ? 'failed' : completed ? 'completed' : cancelled ? 'cancelled' : (budgetExceeded && prev.status !== 'cancel_requested') ? 'timed_out' : prev.status === 'cancel_requested' ? 'cancel_requested' : 'running';
        if (nextStatus === 'timed_out') {
          try { await codex.cancel(prev.runId); } catch { /* 下一 tick 由 readRun 收敛 */ }
        }
        const terminal = ['completed', 'failed', 'cancelled', 'timed_out'].includes(nextStatus);
        const nextResearchAgent = {
          ...prev,
          status: nextStatus,
          phase: failed ? '研究员调研失败' : completed ? '研究员调研完成' : cancelled ? '研究员已取消' : nextStatus === 'timed_out' ? '研究员预算耗尽' : prev.status === 'cancel_requested' ? '正在取消研究员' : '研究员调研中',
          progress: terminal ? 100 : prev.progress,
          messages: prev.messages,
        };
        if (terminal && !prev.notes?.length) {
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
            researchDir: prev.researchDir,
            startedAt: prev.startedAt,
            completedAt: new Date().toISOString(),
            value: null,
          };
          state.researchNotes = [note, ...(state.researchNotes || []).filter((n) => n.runId !== note.runId)].slice(0, 50);
          nextResearchAgent.notes = [note];
          nextResearchAgent.completedAt = note.completedAt;
          appendRuntimeEvent(state, failed ? 'research.failed' : nextStatus === 'timed_out' ? 'research.timed_out' : 'research.completed', { runId: prev.runId, direction: prev.direction, summary: parsed.summary }, { kind: 'research', mode: 'codex-cli' });
        }
        const changed = runtimeChanged || JSON.stringify(nextResearchAgent) !== JSON.stringify(prev);
        state.researchAgent = nextResearchAgent;
        return { state, changed };
      } catch (error) {
        state.researchAgent = { ...state.researchAgent, status: 'failed', phase: '研究员状态读取失败', progress: 100, messages: [...(state.researchAgent.messages || []), { id: `research-projection-error-${state.researchAgent.runId}`, phase: 'research', status: 'waiting', title: '无法读取研究员运行状态', detail: error.message, time: '刚刚' }] };
        return { state, changed: true };
      }
    }
    if (mode === 'codex-cli' && state.agent?.runtimeKind === 'codex-cli' && state.agent?.runId) {
      try {
        const run = await codex.readRun(state.agent.runId);
        const events = await codex.readEvents(state.agent.runId);
        const agentResult = parseAgentResult(events);
        const threadEvent = events.find((event) => event.type === 'thread.started' || event.type === 'thread_start' || event.thread_id || event.threadId);
        const assistantEvents = events.filter((event) => event.item?.type === 'agent_message' || /agent_message|message.completed/i.test(event.type || ''));
        const toolEvents = events.filter((event) => /tool|command|function_call/i.test(`${event.type || ''} ${event.item?.type || ''}`));
        // The run record is the terminal source of truth. A completed Codex turn may
        // contain failed tool calls or recoverable error events without failing the run.
        const failed = run.status === 'failed';
        const completed = run.status === 'completed';
        const workflowAdvanced = state.patchApplied || ['validation', 'evidence', 'curation', 'published'].includes(state.stage);
        const nextStatus = failed ? 'failed' : completed ? 'completed' : run.status === 'cancelled' ? 'cancelled' : 'running';
        const failure = failed ? classifyCodexFailure(run, events) : null;
        const projectedMessages = assistantEvents.slice(-8).map((event, index) => ({ id: event.id || `codex-event-${index}`, phase: event.type || 'Codex', status: failed ? 'waiting' : 'completed', title: event.type || 'Codex 事件', detail: codex.eventText(event) || 'Codex 已产生新的运行事件', time: event.timestamp || '刚刚' }));
        if (failure) projectedMessages.push({ id: `codex-error-${state.agent.runId}`, phase: 'Codex', status: 'waiting', title: failure.title, detail: failure.detail, time: run.completedAt || '刚刚', errorCode: failure.code });
        let candidateValidation = null;
        let verifiedCandidates = agentResult.candidates;
        if (completed && agentResult.candidates.length) {
          const activeMission = state.missions?.find((mission) => mission.id === state.activeMissionId) || {};
          const selectedCandidate = agentResult.candidates.find((candidate) => candidate.id === agentResult.recommendedCandidate) || agentResult.candidates[0];
          const declaredFiles = String(selectedCandidate.files || '').split(',').map((file) => file.trim().replaceAll('\\', '/')).filter(Boolean);
          const manifest = await workspaceManager.captureDiff(run.workspace);
          const sourceInspection = await workspaceManager.inspectSources(activeMission.sourceRoot, selectedCandidate.sourceReferences || []);
          const actualFiles = manifest.changedFiles.map((file) => file.replaceAll('\\', '/'));
          const undeclaredFiles = actualFiles.filter((file) => !declaredFiles.includes(file));
          const missingFiles = declaredFiles.filter((file) => !actualFiles.includes(file));
          if (!manifest.dirty || !manifest.diff) {
            candidateValidation = { passed: false, code: 'CODEX_CANDIDATE_DIFF_EMPTY', detail: 'Codex 返回了候选，但 Mission 工作区没有真实 Git Diff。' };
            verifiedCandidates = [];
          } else if (undeclaredFiles.length || missingFiles.length) {
            candidateValidation = { passed: false, code: 'CODEX_CANDIDATE_FILES_MISMATCH', detail: `候选文件清单与真实 Diff 不一致。未声明：${undeclaredFiles.join(', ') || '无'}；未修改：${missingFiles.join(', ') || '无'}。`, undeclaredFiles, missingFiles };
            verifiedCandidates = [];
          } else if (!sourceInspection.ready) {
            candidateValidation = { passed: false, code: 'CODEX_SOURCE_REGISTRY_INVALID', detail: `Source Registry 未通过固定来源检查：${sourceInspection.errors.map((error) => error.detail).join('；')}`, sourceErrors: sourceInspection.errors };
            verifiedCandidates = [];
          } else {
            candidateValidation = { passed: true, code: 'CODEX_CANDIDATE_DIFF_VERIFIED', digest: manifest.digest, files: actualFiles, sources: sourceInspection.sources, sourceReferences: sourceInspection.references };
            verifiedCandidates = [{ ...selectedCandidate, files: actualFiles.join(', '), sourceReferences: sourceInspection.references, patchDigest: manifest.digest, sourceRunId: state.agent.runId }];
          }
        }
        const nextAgent = {
          ...state.agent,
          status: nextStatus,
          phase: failure?.phase || (completed ? 'Codex 分析完成' : run.status === 'cancel_requested' ? '正在取消 Codex' : 'Codex 正在分析'),
          progress: completed || failed ? 100 : Math.max(5, Math.min(95, 5 + events.length * 3)),
          threadId: run.threadId || threadEvent?.thread_id || threadEvent?.threadId || state.agent.threadId || null,
          messages: projectedMessages.length ? projectedMessages : state.agent.messages,
          toolCalls: [...toolEvents.reduce((latestById, event, index) => {
            const eventId = event.id || event.item?.id || `codex-tool-${index}`;
            latestById.set(eventId, event);
            return latestById;
          }, new Map()).entries()].slice(-20).map(([eventId, event]) => {
            const toolFailed = event.item?.status === 'failed' || event.status === 'failed' || Boolean(event.item?.error);
            const toolCompleted = event.type === 'item.completed' || /completed|done/i.test(event.status || event.item?.status || '');
            return { id: eventId, toolId: event.tool || event.name || event.item?.name || `codex.${event.item?.type || 'tool'}`, name: event.name || event.tool || event.item?.name || (event.item?.type === 'command_execution' ? 'Shell Command' : event.item?.type || 'Codex Tool'), version: descriptor.version ? `v${descriptor.version}` : 'runtime', skillId: 'codex.exec', status: toolFailed ? 'failed' : toolCompleted ? 'completed' : completed ? 'warning' : 'running', summary: codex.eventText(event) || 'Codex tool call', permission: 'codex:managed' };
          }),
          artifacts: [{ id: `codex-run-${state.agent.runId}`, kind: 'Codex Run', title: state.agent.artifacts?.[0]?.title || 'Codex Mission', status: nextStatus, meta: `${events.length} events · ${run.threadId || 'thread pending'}` }],
          result: agentResult,
          candidateValidation,
        };
        if (completed && verifiedCandidates.length && !workflowAdvanced) {
          state.candidateEvaluations = verifiedCandidates;
          state.stage = 'candidate';
          nextAgent.status = 'awaiting_action';
          nextAgent.phase = 'Candidate Plan 已生成';
          nextAgent.currentAction = agentResult.nextAction;
          nextAgent.artifacts = [
            ...nextAgent.artifacts,
            { id: `agent-result-${state.agent.runId}`, kind: 'Candidate Plan', title: `${verifiedCandidates.length} 个已验证 Agent Candidate`, status: 'awaiting_action', meta: `${agentResult.format} · Git Diff verified` },
          ];
        } else if (completed && candidateValidation?.passed === false && !workflowAdvanced) {
          nextAgent.status = 'failed';
          nextAgent.phase = 'Candidate Diff 校验失败';
          nextAgent.currentAction = null;
          nextAgent.messages = [...nextAgent.messages, { id: `candidate-validation-${state.agent.runId}`, phase: 'Candidate', status: 'waiting', title: '候选未进入候选池', detail: candidateValidation.detail, time: '刚刚', errorCode: candidateValidation.code }];
          appendRuntimeEvent(state, 'candidate.diff_rejected', { runId: state.agent.runId, ...candidateValidation }, { kind: 'policy', mode: 'client' });
        } else if (completed && !agentResult.candidates.length && !workflowAdvanced) {
          state.stage = 'diagnosis';
          state.candidateEvaluations = [];
          nextAgent.status = 'completed';
          nextAgent.phase = 'Codex 分析完成，未生成候选';
          nextAgent.currentAction = null;
          if (!state.runtimeEvents?.some((event) => event.type === 'candidate.not_proposed' && event.payload?.runId === state.agent.runId)) {
            appendRuntimeEvent(state, 'candidate.not_proposed', { runId: state.agent.runId, summary: agentResult.summary }, { kind: 'agent', mode: 'codex-cli' });
          }
        }
        if (workflowAdvanced) {
          nextAgent.status = state.agent.status;
          nextAgent.phase = state.agent.phase;
          nextAgent.currentAction = state.agent.currentAction;
        }
        const previousStatus = state.agent.status;
        const changed = runtimeChanged || JSON.stringify(nextAgent) !== JSON.stringify(state.agent);
        state.agent = nextAgent;
        if (nextStatus === 'completed' && verifiedCandidates.length && !workflowAdvanced) state.stage = 'candidate';
        if (nextStatus !== previousStatus) appendRuntimeEvent(state, `codex.run_${nextStatus}`, { runId: state.agent.runId, threadId: nextAgent.threadId, eventCount: events.length, errorCode: failure?.code || null }, { kind: 'agent', mode: 'codex-cli' });
        return { state, changed };
      } catch (error) {
        const nextAgent = { ...state.agent, status: 'failed', phase: 'Codex 状态读取失败', progress: 100, messages: [...(state.agent.messages || []), { id: `codex-projection-error-${state.agent.runId}`, phase: 'Codex', status: 'waiting', title: '无法读取 Codex 运行状态', detail: error.message, time: '刚刚' }] };
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

  return { mode, describe, preflight, startRun, cancelRun, startResearch, projectState, codexClient: codex };
}

export const agentRuntime = createAgentRuntime();
