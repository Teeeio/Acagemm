import { cp, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const serverDir = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(serverDir, '..');
const dataDir = process.env.OPERATOR_DATA_DIR ? path.resolve(process.env.OPERATOR_DATA_DIR) : path.join(rootDir, 'data');
const runtimeDir = process.env.OPERATOR_RUNTIME_DIR ? path.resolve(process.env.OPERATOR_RUNTIME_DIR) : path.join(rootDir, 'runtime');
const statePath = path.join(dataDir, 'mock-db.json');
const workspaceTemplate = path.join(rootDir, 'demo-assets', 'mla-kernels');
export const workspaceDir = path.join(runtimeDir, 'mla-kernels');

export const knowledgeDrafts = [
  { id: 'exp.async-plan-cache', code: 'EXP-01', category: '通用优化经验', title: '短序列下的 Async plan descriptor cache', conclusion: '当设备 Kernel 已低于 50μs 时，缓存 plan descriptor 并将 host mirror 移出热路径，可以稳定降低固定开销。', scope: 'C500 / CUDA · paged_attention · batch 1–8 · seq_len ≤ 1024', constraints: '保留 host mirror fallback；必须通过 24 / 24 Correctness Gate。', hardware: ['C500', 'CUDA'], evidence: '2 个 Level 3 Run' },
  { id: 'exp.c500-plan-cache-boundary', code: 'EXP-02', category: '沐曦 C500 专项准则', title: '沐曦 C500 plan cache 与 host mirror 边界准则', conclusion: '在 MXMACA 1.4+ 环境中，descriptor cache 应按 Shape signature 分桶，host mirror 仅在缓存未就绪时回退同步路径。', scope: 'MetaX C500 · MXMACA 1.4+ · paged_attention · small batch', constraints: '缓存容量受控；环境指纹变化后必须失效；保留同步回退。', hardware: ['C500'], evidence: 'C500 41.8μs · Level 3' },
  { id: 'exp.cross-platform-adoption-gate', code: 'EXP-03', category: '跨平台验证准则', title: 'C500 / CUDA 跨平台候选采用门禁', conclusion: '跨平台候选只有在 Correctness、目标平台性能和固定环境证据同时通过后，才能替换 current best。', scope: 'C500 / CUDA · operator candidate adoption · Full Benchmark', constraints: 'Probe 结果不得用于最终采用；每个平台必须绑定 Environment Snapshot。', hardware: ['C500', 'CUDA'], evidence: '24 / 24 · 2 个固定环境' },
];

const agentProfiles = [
  { id: 'profile.operator-orchestrator', name: 'Operator Orchestrator', version: 'v3.2.0', role: '目标拆解与路线调度', status: 'active', tools: 6, skills: 4 },
  { id: 'profile.result-analyst', name: 'Result Analyst', version: 'v2.4.1', role: '证据审查与采用判断', status: 'available', tools: 4, skills: 3 },
  { id: 'profile.experience-curator', name: 'Experience Curator', version: 'v1.8.0', role: '经验提炼与发布治理', status: 'available', tools: 3, skills: 2 },
];

const capabilityRegistry = {
  skills: [
    { id: 'skill.context-snapshot', name: '仓库上下文快照', version: 'v2.1.0', permission: 'repository:read' },
    { id: 'skill.bottleneck-segmentation', name: '性能瓶颈分段分析', version: 'v2.3.1', permission: 'artifact:write' },
    { id: 'skill.candidate-planning', name: '有界候选规划', version: 'v1.9.0', permission: 'candidate:create' },
    { id: 'skill.experience-curation', name: '经验沉淀', version: 'v1.6.0', permission: 'knowledge:draft' },
  ],
  tools: [
    { id: 'tool.repository-inspect', name: 'Repository Inspector', version: 'v1.5.0', permission: 'repository:read', risk: 'low' },
    { id: 'tool.experience-search', name: 'Experience Search', version: 'v2.0.3', permission: 'knowledge:read', risk: 'low' },
    { id: 'tool.profile-timeline', name: 'Profile Timeline', version: 'v1.8.0', permission: 'worker:execute', risk: 'medium' },
    { id: 'tool.patch-workspace', name: 'Patch Workspace', version: 'v1.4.2', permission: 'repository:write', risk: 'medium' },
    { id: 'tool.test-matrix', name: 'Test Matrix Runner', version: 'v2.2.0', permission: 'worker:execute', risk: 'medium' },
    { id: 'tool.evidence-compare', name: 'Evidence Comparator', version: 'v1.7.1', permission: 'artifact:read', risk: 'low' },
  ],
};

const createIdleAgent = (missionId = 'MIS_01JH7R', goal = '优化 MLA Paged KV Cache 在 C500 上的 small batch 延迟') => ({
  status: 'idle', phase: '待启动', progress: 0, missionId, runId: null, profileId: 'profile.operator-orchestrator', goal, startedAt: null, durationMs: 7200, currentAction: null, toolCalls: [],
  messages: [{ id: `agent-ready-${missionId}`, phase: 'Mission', status: 'ready', title: 'Mission 已准备就绪', detail: '目标、仓库和验证边界已固定。', time: '刚刚' }],
  artifacts: [
    { id: 'artifact-context', kind: 'Context Snapshot', title: 'Mission context', status: 'ready', meta: 'repository · constraints · baseline' },
    { id: 'artifact-knowledge', kind: 'Knowledge Pack', title: '3 条相关 Experience', status: 'ready', meta: 'C500 · paged_attention · validated' },
  ],
});

const createAwaitingAgent = (missionId, goal, candidateName, hardware = 'C500') => ({
  ...createIdleAgent(missionId, goal),
  status: 'awaiting_approval',
  phase: '等待审批',
  progress: 100,
  currentAction: {
    id: 'action.candidate-02',
    type: 'candidate.plan',
    title: `审阅 Candidate 02 · ${candidateName}`,
    reason: '已完成上下文、知识和性能证据对齐，候选变更限定在受控工作区。',
    expectedOutput: '2 个文件 · 受控 Patch · Correctness Matrix',
    risk: 'medium',
    approvalRequired: true,
  },
  messages: [
    { id: `agent-context-${missionId}`, phase: 'context', status: 'completed', title: '上下文读取完成', detail: '已固定仓库、基线和验证边界。', time: '7 分钟前' },
    { id: `agent-research-${missionId}`, phase: 'research', status: 'completed', title: '知识检索完成', detail: `已引用 3 条 ${hardware} 相关 Experience。`, time: '6 分钟前' },
    { id: `agent-diagnosis-${missionId}`, phase: 'diagnosis', status: 'completed', title: '瓶颈分析完成', detail: '已生成可审阅的候选变更范围。', time: '4 分钟前' },
    { id: `agent-approval-${missionId}`, phase: 'approval', status: 'waiting', title: '等待人工审批', detail: '候选方案已经准备好，尚未写入工作区。', time: '刚刚' },
  ],
  artifacts: [
    { id: 'artifact-context', kind: 'Context Snapshot', title: `${candidateName} / context`, status: 'ready', meta: 'repository · constraints · baseline' },
    { id: 'artifact-knowledge', kind: 'Knowledge Pack', title: `3 条 ${hardware} 相关 Experience`, status: 'ready', meta: `${hardware} · validated` },
    { id: 'artifact-candidate', kind: 'Candidate Plan', title: `Candidate 02 · ${candidateName}`, status: 'awaiting_approval', meta: '2 files · +37 −18 · digest recorded' },
  ],
  toolCalls: [
    { id: `tool.repository-inspect-${missionId}`, toolId: 'tool.repository-inspect', name: 'Repository Inspector', version: 'v1.5.0', skillId: 'skill.context-snapshot', status: 'completed', summary: '读取仓库、Git 状态和当前最佳', permission: 'repository:read' },
    { id: `tool.experience-search-${missionId}`, toolId: 'tool.experience-search', name: 'Experience Search', version: 'v2.0.3', skillId: 'skill.context-snapshot', status: 'completed', summary: `检索到 3 条 ${hardware} 相关经验`, permission: 'knowledge:read' },
    { id: `tool.profile-timeline-${missionId}`, toolId: 'tool.profile-timeline', name: 'Profile Timeline', version: 'v1.8.0', skillId: 'skill.bottleneck-segmentation', status: 'completed', summary: '定位固定开销和关键时间线', permission: 'worker:execute' },
    { id: `tool.patch-workspace-${missionId}`, toolId: 'tool.patch-workspace', name: 'Patch Workspace', version: 'v1.4.2', skillId: 'skill.candidate-planning', status: 'completed', summary: '生成有界候选变更计划', permission: 'repository:write' },
  ],
});

const createSeedMissions = () => [
  { id: 'MIS_01JH7R', title: 'MLA Paged KV Cache', goal: '优化 MLA Paged KV Cache 在 C500 上的 small batch 延迟', repository: 'mla-kernels', hardware: ['C500', 'CUDA'], metric: 'latency p50', stage: 'candidate', status: 'awaiting_approval', updatedLabel: '刚刚', result: { value: '41.8 μs', improvement: '−22.3%' }, patchApplied: false, benchmark: { status: 'idle', progress: 0, runId: null, startedAt: null, durationMs: 2600, logs: [] }, agent: createAwaitingAgent('MIS_01JH7R', '优化 MLA Paged KV Cache 在 C500 上的 small batch 延迟', 'Async plan descriptor cache') },
  { id: 'MIS_01JGA4', title: 'Paged Decode Shape Fast Path', goal: '降低 Paged Decode 在 C500 长尾 shape 下的 P95 延迟', repository: 'flashinfer-c500', hardware: ['C500'], metric: 'latency p95', stage: 'validation', status: 'awaiting_approval', updatedLabel: '18 分钟前', result: { value: '2.87 ms', improvement: '−8.6%' }, patchApplied: true, benchmark: { status: 'idle', progress: 0, runId: null, startedAt: null, durationMs: 2600, logs: [] }, agent: { ...createAwaitingAgent('MIS_01JGA4', '降低 Paged Decode 在 C500 长尾 shape 下的 P95 延迟', 'Decode shape fast path'), phase: '异构验证', currentAction: { id: 'action.decode-validation', type: 'test.plan', title: '运行 C500 Full Benchmark', reason: '30 / 30 Correctness 已通过，需要确认长尾收益。', expectedOutput: 'Full Benchmark · P50 / P95 compare', risk: 'medium', approvalRequired: true } } },
  { id: 'MIS_01JDX9', title: 'Ragged Prefill Vector Layout', goal: '优化 Ragged Prefill 的向量化访存和片上复用', repository: 'flashinfer-c500', hardware: ['C500'], metric: 'throughput', stage: 'published', status: 'completed', updatedLabel: '昨天', result: { value: '1.42×', improvement: '+42.1%' }, patchApplied: true, benchmark: { status: 'complete', progress: 100, runId: 'run_ARCHIVED', startedAt: null, durationMs: 2600, logs: [] }, agent: { ...createAwaitingAgent('MIS_01JDX9', '优化 Ragged Prefill 的向量化访存和片上复用', 'Vector layout reuse'), status: 'completed', phase: 'Mission 完成', progress: 100, currentAction: null } },
];

export const createSeedState = () => {
  const missions = createSeedMissions();
  const activeMission = missions[0];
  return {
  schemaVersion: 1,
  updatedAt: new Date().toISOString(),
  stage: activeMission.stage,
  patchApplied: activeMission.patchApplied,
  agent: structuredClone(activeMission.agent),
  activeMissionId: activeMission.id,
  missions,
  agentProfiles: structuredClone(agentProfiles),
  capabilityRegistry: structuredClone(capabilityRegistry),
  benchmark: structuredClone(activeMission.benchmark),
  testMatrix: { environments: ['C500', 'CUDA'], stages: ['Correctness', 'Probe', 'Full Benchmark'] },
  knowledgeDrafts: structuredClone(knowledgeDrafts),
  publishedAssets: [],
  workspace: 'Matrix Lab',
  unreadCount: 2,
  missionPaused: false,
  auditEvents: [
    { time: '10:42:23', title: 'Policy Engine 等待代码审批', detail: 'approval.apl_01JH7R · patch apply', tone: 'warning', icon: 'ShieldCheck' },
    { time: '10:42:19', title: 'Candidate Agent 生成 Candidate 02', detail: '2 files · +37 −18 · digest recorded', tone: 'blue', icon: 'Code2' },
    { time: '10:42:11', title: 'Research Agent 引用固定开销 Experience', detail: 'exp.short-seq.fixed-overhead@1.2 · validated', tone: 'green', icon: 'Search' },
  ],
  };
};

const exists = async (target) => {
  try { await stat(target); return true; } catch { return false; }
};

export async function ensureStorage() {
  await mkdir(dataDir, { recursive: true });
  await mkdir(runtimeDir, { recursive: true });
  if (!(await exists(statePath))) await saveState(createSeedState());
  if (!(await exists(workspaceDir))) await cp(workspaceTemplate, workspaceDir, { recursive: true });
}

function ensureDomainState(state) {
  if (!Array.isArray(state.missions) || !state.missions.length) {
    const fallback = { id: state.agent?.missionId || 'MIS_01JH7R', title: 'MLA Paged KV Cache', goal: state.agent?.goal || '优化 MLA Paged KV Cache 在 C500 上的 small batch 延迟', repository: 'mla-kernels', hardware: ['C500', 'CUDA'], metric: 'latency p50', stage: state.stage || 'diagnosis', status: state.agent?.status || 'ready', updatedLabel: '刚刚', result: { value: '41.8 μs', improvement: '−22.3%' }, patchApplied: Boolean(state.patchApplied), benchmark: structuredClone(state.benchmark || {}), agent: structuredClone(state.agent || createIdleAgent()) };
    state.missions = [fallback];
    state.activeMissionId = fallback.id;
  }
  if (!state.activeMissionId || !state.missions.some((mission) => mission.id === state.activeMissionId)) state.activeMissionId = state.missions[0].id;
  if (!Array.isArray(state.agentProfiles)) state.agentProfiles = structuredClone(agentProfiles);
  if (!state.capabilityRegistry) state.capabilityRegistry = structuredClone(capabilityRegistry);
  if (!Array.isArray(state.agent?.toolCalls)) state.agent = { ...state.agent, toolCalls: [] };
  return state;
}

function projectActiveMission(state) {
  if (!Array.isArray(state.missions)) return state;
  const index = state.missions.findIndex((mission) => mission.id === state.activeMissionId);
  if (index === -1) return state;
  const statusMap = { idle: 'ready', running: 'running', executing: 'running', awaiting_approval: 'awaiting_approval', completed: 'completed' };
  state.missions[index] = {
    ...state.missions[index],
    goal: state.agent?.goal || state.missions[index].goal,
    stage: state.stage,
    status: statusMap[state.agent?.status] || state.missions[index].status,
    patchApplied: state.patchApplied,
    benchmark: structuredClone(state.benchmark),
    agent: structuredClone(state.agent),
    updatedLabel: '刚刚',
  };
  return state;
}

export function selectMission(state, missionId) {
  projectActiveMission(state);
  const mission = state.missions.find((item) => item.id === missionId);
  if (!mission) {
    const error = new Error('Mission 不存在。');
    error.status = 404;
    throw error;
  }
  state.activeMissionId = mission.id;
  state.stage = mission.stage || 'diagnosis';
  state.patchApplied = Boolean(mission.patchApplied);
  state.benchmark = structuredClone(mission.benchmark || { status: 'idle', progress: 0, runId: null, startedAt: null, durationMs: 2600, logs: [] });
  state.agent = structuredClone(mission.agent || createIdleAgent(mission.id, mission.goal));
  addAuditEvent(state, 'Mission 已切换', `${mission.id} · ${mission.title}`, 'blue', 'GitBranch');
  return state;
}

export function createMission(state, input) {
  projectActiveMission(state);
  const id = `MIS_${Date.now().toString(36).toUpperCase()}`;
  const title = input.title?.trim() || input.goal.trim().slice(0, 30);
  const hardware = Array.isArray(input.hardware) && input.hardware.length ? input.hardware : ['C500'];
  const mission = {
    id,
    title,
    goal: input.goal.trim(),
    repository: input.repository?.trim() || 'mla-kernels',
    hardware,
    metric: input.metric?.trim() || 'latency p50',
    stage: 'diagnosis',
    status: 'ready',
    updatedLabel: '刚刚',
    result: { value: '—', improvement: 'new' },
    patchApplied: false,
    benchmark: { status: 'idle', progress: 0, runId: null, startedAt: null, durationMs: 2600, logs: [] },
    agent: createIdleAgent(id, input.goal.trim()),
  };
  state.missions = [mission, ...state.missions];
  return selectMission(state, id);
}

export async function loadState() {
  await ensureStorage();
  let state = JSON.parse(await readFile(statePath, 'utf8'));
  const needsMigration = !Array.isArray(state.missions) || !state.capabilityRegistry || !Array.isArray(state.agent?.toolCalls);
  state = ensureDomainState(state);
  const benchmarkBefore = JSON.stringify(state.benchmark);
  state = refreshBenchmark(state);
  const refreshedAgent = refreshAgent(state);
  if (needsMigration || refreshedAgent.changed || benchmarkBefore !== JSON.stringify(state.benchmark)) return saveState(refreshedAgent.state);
  return state;
}

export async function saveState(state) {
  await mkdir(dataDir, { recursive: true });
  const next = { ...projectActiveMission(ensureDomainState(state)), updatedAt: new Date().toISOString() };
  const temporaryPath = `${statePath}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  await rename(temporaryPath, statePath);
  return next;
}

export async function resetDemoData() {
  const state = await saveState(createSeedState());
  if (await exists(workspaceDir)) await rm(workspaceDir, { recursive: true, force: true });
  await cp(workspaceTemplate, workspaceDir, { recursive: true });
  return state;
}

export function addAuditEvent(state, title, detail, tone = 'blue', icon = 'Activity') {
  const event = { time: new Date().toLocaleTimeString('zh-CN', { hour12: false }), title, detail, tone, icon };
  state.auditEvents = [event, ...(state.auditEvents || [])].slice(0, 30);
  return event;
}

function refreshBenchmark(state) {
  if (state.benchmark?.status !== 'running' || !state.benchmark.startedAt) return state;
  const elapsed = Date.now() - new Date(state.benchmark.startedAt).getTime();
  const progress = Math.min(100, Math.max(0, Math.floor((elapsed / state.benchmark.durationMs) * 100 / 10) * 10));
  state.benchmark.progress = progress;
  state.benchmark.logs = buildBenchmarkLogs(progress);
  if (progress >= 100) {
    state.benchmark.status = 'complete';
    state.stage = 'evidence';
    state.agent = {
      ...state.agent,
      status: 'awaiting_approval',
      phase: '效果决策',
      currentAction: { id: 'action.adoption-decision', type: 'adoption.decision', title: '决定是否采用 Candidate 02', reason: 'Correctness 和两个固定环境的 Full Benchmark 已满足 Level 3 证据门禁。', expectedOutput: 'Adoption Decision · current best update', risk: 'high', approvalRequired: true },
    };
    if (!state.benchmark.completedAt) {
      state.benchmark.completedAt = new Date().toISOString();
      addAuditEvent(state, 'Full Benchmark 已完成', 'C500 41.8μs · CUDA 36.1μs · 24/24', 'green', 'CheckCircle2');
    }
  }
  return state;
}

function refreshAgent(state) {
  const agent = state.agent;
  if (!agent || agent.status !== 'running' || !agent.startedAt) return { state, changed: false };
  const mission = state.missions?.find((item) => item.id === state.activeMissionId) || {};
  const missionTitle = mission.title || '当前算子';
  const hardware = mission.hardware?.[0] || '目标硬件';
  const metric = mission.metric || '性能指标';
  const candidateName = `${missionTitle} ${metric} fast path`;
  const elapsed = Date.now() - new Date(agent.startedAt).getTime();
  const progress = Math.min(100, Math.max(0, Math.floor((elapsed / agent.durationMs) * 100 / 10) * 10));
  const phases = [
    [0, '上下文读取', 'Context Agent 正在读取仓库、Git 状态和当前最佳。', 'context'],
    [20, '知识检索', 'Research Agent 已找到 3 条适用于 C500 的 Experience。', 'research'],
    [40, '瓶颈分析', 'Bottleneck Agent 正在对齐 plan、workspace 和 host mirror 的时间线。', 'diagnosis'],
    [60, '候选规划', 'Candidate Agent 正在生成有界变更和验证约束。', 'candidate'],
    [80, '补丁准备', 'Candidate Plan 已生成，等待写入受控工作区。', 'approval'],
    [100, '等待审批', 'Candidate 02 已准备好，下一步需要用户审阅 Diff。', 'approval'],
  ];
  const current = phases.reduce((selected, item) => (progress >= item[0] ? item : selected), phases[0]);
  const messages = phases.filter(([threshold]) => progress >= threshold).map(([threshold, title, detail, phase], index) => ({
    id: `agent-${threshold}`,
    phase,
    status: threshold === 100 ? 'waiting' : 'completed',
    title,
    detail,
    time: threshold === 0 ? '刚刚' : `${Math.max(1, Math.floor((elapsed - (threshold / 100) * agent.durationMs) / 1000))}s 前`,
  }));
  const artifacts = [
    { id: 'artifact-context', kind: 'Context Snapshot', title: progress >= 20 ? `${missionTitle} / context` : '正在读取仓库上下文', status: progress >= 20 ? 'ready' : 'running', meta: `${mission.repository || 'repository'} · constraints · baseline` },
    { id: 'artifact-knowledge', kind: 'Knowledge Pack', title: progress >= 40 ? `3 条 ${hardware} 相关 Experience` : '等待知识检索', status: progress >= 40 ? 'ready' : progress >= 20 ? 'running' : 'queued', meta: `${hardware} · ${metric} · validated` },
  ];
  const toolDefinitions = [
    [0, 'tool.repository-inspect', 'Repository Inspector', 'v1.5.0', '读取仓库、Git 状态和当前最佳', 'skill.context-snapshot'],
    [20, 'tool.experience-search', 'Experience Search', 'v2.0.3', `检索到 3 条 ${hardware} 相关经验`, 'skill.context-snapshot'],
    [40, 'tool.profile-timeline', 'Profile Timeline', 'v1.8.0', '定位 plan、workspace 和 host mirror 固定开销', 'skill.bottleneck-segmentation'],
    [60, 'tool.patch-workspace', 'Patch Workspace', 'v1.4.2', `生成 ${missionTitle} 的有界变更计划`, 'skill.candidate-planning'],
  ];
  const toolCalls = toolDefinitions.filter(([threshold]) => progress >= threshold).map(([threshold, id, name, version, summary, skillId]) => ({ id: `${id}-${agent.runId}`, toolId: id, name, version, skillId, status: progress >= Math.min(100, threshold + 20) ? 'completed' : 'running', summary, permission: capabilityRegistry.tools.find((tool) => tool.id === id)?.permission || 'read' }));
  const next = { ...agent, progress, phase: current[1], messages, artifacts, toolCalls };
  if (progress >= 100) {
    next.status = 'awaiting_approval';
    next.currentAction = {
      id: 'action.candidate-02',
      type: 'candidate.plan',
      title: `审阅 Candidate 02 · ${candidateName}`,
      reason: `${metric} 的主要瓶颈已定位，候选变更限定在当前 Mission 的受控工作区。`,
      expectedOutput: '2 个文件 · 受控 Patch · Correctness Matrix',
      risk: 'medium',
      approvalRequired: true,
    };
    next.artifacts = [
      ...artifacts,
      { id: 'artifact-candidate', kind: 'Candidate Plan', title: `Candidate 02 · ${candidateName}`, status: 'awaiting_approval', meta: '2 files · +37 −18 · digest recorded' },
    ];
    if (state.stage === 'diagnosis') state.stage = 'candidate';
    if (!state.auditEvents?.some((event) => event.detail === 'agent run completed')) addAuditEvent(state, 'Candidate Agent 已完成计划', 'agent run completed · Candidate 02 awaiting approval', 'blue', 'Code2');
  }
  return { state: { ...state, agent: next }, changed: JSON.stringify(agent) !== JSON.stringify(next) };
}

export function startAgentRun(state, goal) {
  const runId = `agent_${Date.now().toString(36).toUpperCase()}`;
  state.stage = 'diagnosis';
  state.patchApplied = false;
  state.agent = {
    status: 'running',
    phase: '上下文读取',
    progress: 0,
    missionId: state.agent?.missionId || 'MIS_01JH7R',
    runId,
    profileId: 'profile.operator-orchestrator',
    goal: goal.trim(),
    startedAt: new Date().toISOString(),
    durationMs: 7200,
    currentAction: null,
    toolCalls: [],
    messages: [{ id: `agent-start-${runId}`, phase: 'Mission', status: 'running', title: 'Orchestrator 已接管 Mission', detail: `Run ${runId} 已启动，正在建立 Context Snapshot。`, time: '刚刚' }],
    artifacts: [
      { id: 'artifact-context', kind: 'Context Snapshot', title: '正在读取仓库上下文', status: 'running', meta: 'repository · constraints · baseline' },
      { id: 'artifact-knowledge', kind: 'Knowledge Pack', title: '等待知识检索', status: 'queued', meta: 'C500 · paged_attention · validated' },
    ],
  };
  addAuditEvent(state, 'Orchestrator 已启动 Agent Run', `${runId} · ${goal.trim()}`, 'blue', 'Activity');
  return state;
}

export function buildBenchmarkLogs(progress) {
  const entries = [
    [0, '调度器已锁定 2 个环境快照'],
    [20, 'C500 Correctness 12 / 12 通过'],
    [40, 'CUDA Correctness 12 / 12 通过'],
    [60, 'C500 Full Benchmark 完成：41.8μs'],
    [80, 'CUDA Full Benchmark 完成：36.1μs'],
    [100, '证据包已生成：Level 3'],
  ];
  return entries.filter(([threshold]) => progress >= threshold).map(([threshold, message], index) => ({ sequence: index + 1, progress: threshold, message }));
}

export const workspaceFiles = [
  { id: 'paged_attention.cu', path: 'kernels/paged_attention.cu', status: 'M', lines: [['context', '188', 'auto plan = build_attention_plan(args);'], ['remove', '189', 'auto workspace = allocate_workspace(plan.size());'], ['remove', '190', 'mirror_to_host(plan, host_plan);'], ['add', '189', 'auto& plan = plan_cache.get_or_build(args.signature());'], ['add', '190', 'if (LIKELY(plan.host_mirror_ready())) {'], ['add', '191', '  launch_paged_kernel(plan.device_view(), kv_cache);'], ['add', '192', '} else {'], ['add', '193', '  plan_cache.enqueue_host_mirror(plan);'], ['add', '194', '}'], ['context', '195', 'return plan;']], rationale: '缓存 descriptor 避免热路径重复分配；同步回退只保留在 host mirror 尚未就绪的边界场景。' },
  { id: 'plan_cache.hpp', path: 'kernels/plan_cache.hpp', status: 'A', lines: [['context', '1', '#pragma once'], ['add', '2', 'class PlanCache {'], ['add', '3', ' public:'], ['add', '4', '  Plan& get_or_build(Signature signature);'], ['add', '5', '  void enqueue_host_mirror(const Plan& plan);'], ['add', '6', '};']], rationale: '新增轻量 descriptor cache，将 plan 生命周期与请求 signature 绑定，避免重复构建。' },
  { id: 'paged_attention_cases.yaml', path: 'tests/paged_attention_cases.yaml', status: 'T', lines: [['context', '1', 'suite: paged_attention'], ['context', '2', 'platforms: [C500, CUDA]'], ['add', '3', 'correctness_cases: 24'], ['add', '4', 'shape: [1, 4, 128, 1024]'], ['add', '5', 'assert: max_abs_error <= 1e-3']], rationale: 'Correctness Gate 固定 24 个边界与回归用例，先通过正确性再进入性能阶段。' },
  { id: 'mla_paged_attention.yaml', path: 'benchmarks/mla_paged_attention.yaml', status: 'B', lines: [['context', '1', 'benchmark: mla_paged_attention'], ['context', '2', 'warmup: 50'], ['add', '3', 'repeats: 200'], ['add', '4', 'metric: latency_p50'], ['add', '5', 'environment_snapshot: fixed']], rationale: 'Benchmark 固定预热、重复次数与 Environment Snapshot，保证跨硬件结果可比。' },
];

export async function applyCandidatePatch() {
  await ensureStorage();
  await mkdir(path.join(workspaceDir, 'kernels'), { recursive: true });
  const patchedSource = `#include "paged_attention.hpp"\n#include "plan_cache.hpp"\n\nPlan run_paged_attention(const AttentionArgs& args, const KvCache& kv_cache) {\n  auto& plan = plan_cache.get_or_build(args.signature());\n  if (LIKELY(plan.host_mirror_ready())) {\n    launch_paged_kernel(plan.device_view(), kv_cache);\n  } else {\n    plan_cache.enqueue_host_mirror(plan);\n  }\n  return plan;\n}\n`;
  const cacheHeader = `#pragma once\n\nclass PlanCache {\n public:\n  Plan& get_or_build(Signature signature);\n  void enqueue_host_mirror(const Plan& plan);\n};\n`;
  await writeFile(path.join(workspaceDir, 'kernels', 'paged_attention.cu'), patchedSource, 'utf8');
  await writeFile(path.join(workspaceDir, 'kernels', 'plan_cache.hpp'), cacheHeader, 'utf8');
  return { workspace: path.relative(rootDir, workspaceDir).replaceAll('\\', '/'), files: workspaceFiles };
}
