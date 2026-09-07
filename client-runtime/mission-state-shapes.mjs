export const normalizeMissionBudgetMs = (valueOrInput = null) => {
  const raw = valueOrInput && typeof valueOrInput === 'object' && !Array.isArray(valueOrInput)
    ? (Object.hasOwn(valueOrInput, 'missionBudgetMs') ? valueOrInput.missionBudgetMs
      : Object.hasOwn(valueOrInput, 'timeBudgetMs') ? valueOrInput.timeBudgetMs
        : Object.hasOwn(valueOrInput, 'missionBudgetHours') ? Number(valueOrInput.missionBudgetHours) * 60 * 60 * 1000
          : Object.hasOwn(valueOrInput, 'timeBudgetHours') ? Number(valueOrInput.timeBudgetHours) * 60 * 60 * 1000
            : null)
    : valueOrInput;
  if (raw === null || raw === undefined || raw === '' || raw === false || raw === true || Number(raw) === 0) return null;
  const numeric = Number(raw);
  if (!Number.isFinite(numeric) || numeric < 0) return null;
  return Math.floor(numeric);
};

export const createCurrentBestState = (candidateId = 'candidate-01') => candidateId === 'candidate-02'
  ? { candidateId: 'candidate-02', version: 'cnd.02', value: '41.8 μs', improvement: '−22.3%', status: 'active' }
  : { candidateId: 'candidate-01', version: 'cnd.01', value: '49.6 μs', improvement: '−7.8%', status: 'active' };

export const createResearchAgentState = () => ({
  status: 'idle', phase: '待调研', progress: 0, missionId: null, runId: null,
  runtimeKind: null, threadId: null, direction: null, researchDir: null,
  startedAt: null, completedAt: null, budgetMs: 20 * 60 * 1000,
  notes: [], messages: [], artifacts: [], injected: false,
  synchronous: false, // true=停滞升级（主循环串行等待）；false=操作员触发（并行不阻塞）
});

export const createIterationStats = () => ({
  round: 0, consecutiveNoAdopt: 0, lastRoundOutcome: null,
  lastCountedRunId: null, researchRounds: 0, lastResearchRunId: null,
  correctnessEstablished: false, correctnessAttempts: 0,
  currentRoundCorrectnessAttempts: 0, totalCorrectnessAttempts: 0,
  lastCorrectnessAttemptRunId: null, lastGenerationAttemptRunId: null,
  performanceRounds: 0,
  pendingInjection: null,
  loopStatus: 'running', loopStatusReason: null, loopStartedAt: null,
  roundBudget: null, // No retrospective clock is inferred for legacy snapshots.
});

export const createResearchNote = ({ runId, direction, content, summary, findings = [], suggestedDirections = [], sources = [], researchDir, startedAt, completedAt, value = null }) => ({
  id: `note_${runId}`,
  runId, direction, content, summary, findings, suggestedDirections, sources,
  researchDir, startedAt, completedAt, value,
});

export function appendResearchNote(state, note) {
  state.researchNotes = [note, ...(state.researchNotes || []).filter((n) => n.runId !== note.runId)].slice(0, 50);
  return note;
}

export const createIdleAgent = (missionId = 'MIS_01JH7R', goal = '优化 MLA Paged KV Cache 在 C550 上的 small batch 延迟') => ({
  status: 'idle', phase: '待启动', progress: 0, missionId, runId: null, profileId: 'profile.operator-orchestrator', goal, startedAt: null, durationMs: 7200, currentAction: null, toolCalls: [],
  messages: [{ id: `agent-ready-${missionId}`, phase: 'Mission', status: 'ready', title: 'Mission 已准备就绪', detail: '目标、仓库和验证边界已固定。', time: '刚刚' }],
  artifacts: [
    { id: 'artifact-context', kind: 'Context Snapshot', title: 'Mission context', status: 'ready', meta: 'repository · constraints · baseline' },
    { id: 'artifact-knowledge', kind: 'Knowledge Pack', title: '3 条相关 Experience', status: 'ready', meta: 'C550 · paged_attention · validated' },
  ],
});

export const createAwaitingAgent = (missionId, goal, candidateName, hardware = 'C550') => ({
  ...createIdleAgent(missionId, goal),
  status: 'awaiting_action',
  phase: '等待自动策略检查',
  progress: 100,
  currentAction: {
    id: 'action.candidate-02',
    type: 'candidate.plan',
    title: `自动检查 Candidate 02 · ${candidateName}`,
    reason: '已完成上下文、知识和性能证据对齐，候选变更限定在受控工作区。',
    expectedOutput: '2 个文件 · 受控 Patch · Correctness Matrix',
    risk: 'medium',
    approvalRequired: false,
    approvalPolicy: 'client-controlled',
  },
  messages: [
    { id: `agent-context-${missionId}`, phase: 'context', status: 'completed', title: '上下文读取完成', detail: '已固定仓库、基线和验证边界。', time: '7 分钟前' },
    { id: `agent-research-${missionId}`, phase: 'research', status: 'completed', title: '知识检索完成', detail: `已引用 3 条 ${hardware} 相关 Experience。`, time: '6 分钟前' },
    { id: `agent-diagnosis-${missionId}`, phase: 'diagnosis', status: 'completed', title: '瓶颈分析完成', detail: '已生成可审阅的候选变更范围。', time: '4 分钟前' },
    { id: `agent-approval-${missionId}`, phase: 'candidate', status: 'waiting', title: '等待自动策略检查', detail: '候选方案已经准备好，将先检查变更边界、工作区状态和风险策略。', time: '刚刚' },
  ],
  artifacts: [
    { id: 'artifact-context', kind: 'Context Snapshot', title: `${candidateName} / context`, status: 'ready', meta: 'repository · constraints · baseline' },
    { id: 'artifact-knowledge', kind: 'Knowledge Pack', title: `3 条 ${hardware} 相关 Experience`, status: 'ready', meta: `${hardware} · validated` },
    { id: 'artifact-candidate', kind: 'Candidate Plan', title: `Candidate 02 · ${candidateName}`, status: 'ready', meta: '2 files · +37 −18 · digest recorded' },
  ],
  toolCalls: [
    { id: `tool.repository-inspect-${missionId}`, toolId: 'tool.repository-inspect', name: 'Repository Inspector', version: 'v1.5.0', skillId: 'skill.context-snapshot', status: 'completed', summary: '读取仓库、Git 状态和当前最佳', permission: 'repository:read' },
    { id: `tool.experience-search-${missionId}`, toolId: 'tool.experience-search', name: 'Experience Search', version: 'v2.0.3', skillId: 'skill.context-snapshot', status: 'completed', summary: `检索到 3 条 ${hardware} 相关经验`, permission: 'knowledge:read' },
    { id: `tool.profile-timeline-${missionId}`, toolId: 'tool.profile-timeline', name: 'Profile Timeline', version: 'v1.8.0', skillId: 'skill.bottleneck-segmentation', status: 'completed', summary: '定位固定开销和关键时间线', permission: 'worker:execute' },
    { id: `tool.patch-workspace-${missionId}`, toolId: 'tool.patch-workspace', name: 'Patch Workspace', version: 'v1.4.2', skillId: 'skill.candidate-planning', status: 'completed', summary: '生成有界候选变更计划', permission: 'repository:write' },
  ],
});
