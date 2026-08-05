import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const serverDir = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(serverDir, '..');
const defaultBridgeDir = path.join(rootDir, 'runtime', 'agent-bridge');

const fileExists = async (target) => {
  try { return (await stat(target)).isFile(); } catch { return false; }
};

const directoryExists = async (target) => {
  try { return (await stat(target)).isDirectory(); } catch { return false; }
};

const readJson = async (target) => JSON.parse(await readFile(target, 'utf8'));

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
  const mode = options.mode || process.env.OPERATOR_RUNTIME_MODE || 'demo';
  const cliRoot = options.cliRoot || process.env.OPERATOR_CLI_ROOT || '';
  const bridgeDir = options.bridgeDir || process.env.OPERATOR_BRIDGE_DIR || defaultBridgeDir;
  const statusPath = cliRoot ? path.join(cliRoot, process.env.OPERATOR_CLI_STATUS_FILE || 'results/agent_status_cli_integration.json') : '';
  const queuePath = cliRoot ? path.join(cliRoot, process.env.OPERATOR_CLI_QUEUE_FILE || 'results/test_queue.jsonl') : '';
  const recordsPath = cliRoot ? path.join(cliRoot, process.env.OPERATOR_CLI_RECORDS_FILE || 'docs/optimization_records.json') : '';

  const describe = async () => {
    if (mode !== 'cli-file') {
      return {
        mode: 'demo',
        label: '本地参考 Runtime',
        status: 'ready',
        connected: true,
        liveHardware: false,
        authority: 'operator-studio-reference',
        transport: 'in-process events',
        capabilities: ['mission.run', 'event.sequence', 'artifact.mock', 'benchmark.mock'],
      };
    }

    const rootReady = Boolean(cliRoot) && await directoryExists(cliRoot);
    const probes = {
      agentStatus: Boolean(statusPath) && await fileExists(statusPath),
      testQueue: Boolean(queuePath) && await fileExists(queuePath),
      canonicalRecords: Boolean(recordsPath) && await fileExists(recordsPath),
    };
    const connected = rootReady && probes.agentStatus && probes.testQueue && probes.canonicalRecords;
    return {
      mode: 'cli-file',
      label: 'CLI Agent Runtime',
      status: connected ? 'connected' : rootReady ? 'degraded' : 'unavailable',
      connected,
      liveHardware: connected,
      authority: 'flashinfer-cli',
      transport: 'file projection',
      probes,
      capabilities: ['mission.request', 'agent.status', 'queue.observe', 'canonical.read'],
      hint: connected ? '' : '请设置 OPERATOR_CLI_ROOT，并确认 status、queue 与 canonical records 文件存在。',
    };
  };

  const startRun = async ({ state, mission, goal }) => {
    if (mode !== 'cli-file') return { handled: false };
    const descriptor = await describe();
    if (!descriptor.connected) {
      const error = new Error(descriptor.hint || 'CLI Runtime 尚未连接。');
      error.status = 503;
      throw error;
    }
    const runId = `cli_${Date.now().toString(36).toUpperCase()}`;
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
    await writeFile(path.join(requestsDir, `${runId}.json`), `${JSON.stringify(request, null, 2)}\n`, 'utf8');
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

  const projectState = async (state) => {
    const descriptor = await describe();
    const runtimeChanged = JSON.stringify(state.runtime) !== JSON.stringify(descriptor);
    state.runtime = descriptor;
    if (mode !== 'cli-file' || !descriptor.connected || !state.agent?.runId?.startsWith('cli_')) return { state, changed: runtimeChanged };

    let statusDocument;
    try { statusDocument = await readJson(statusPath); } catch { return { state, changed: runtimeChanged }; }
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

  return { mode, describe, startRun, projectState };
}

export const agentRuntime = createAgentRuntime();
