import { agentProfiles, capabilityRegistry } from './state-reference-data.mjs';
import { createIdleAgent, createAwaitingAgent, createResearchAgentState, createIterationStats } from './mission-state-shapes.mjs';
import { createBaselineRequirementState } from './evidence-state.mjs';
import { normalizeMissionObjective } from './mission-objective.mjs';
import { emptyTokenUsage } from './token-usage.mjs';
import { MLA_OPTIMIZATION_TEST_GOAL } from './mission-intent.mjs';

export const createStateInitialization = ({ createMissionDomainState } = {}) => {
  if (typeof createMissionDomainState !== 'function') throw new TypeError('State initialization requires a Mission domain factory.');

  const createSeedMissions = () => [
    { id: 'MIS_01JH7R', ...createMissionDomainState('MIS_01JH7R', 'candidate'), title: 'MLA Paged KV Cache', goal: '优化 MLA Paged KV Cache 在 C550 上的 small batch 延迟', repository: 'mla-kernels', hardware: ['C550', 'CUDA'], metric: 'latency p50', stage: 'candidate', status: 'awaiting_approval', updatedLabel: '刚刚', result: { value: '41.8 μs', improvement: '−22.3%' }, patchApplied: false, benchmark: { status: 'idle', progress: 0, runId: null, startedAt: null, durationMs: 2600, logs: [] }, agent: createAwaitingAgent('MIS_01JH7R', '优化 MLA Paged KV Cache 在 C550 上的 small batch 延迟', 'Async plan descriptor cache') },
    { id: 'MIS_01JGA4', ...createMissionDomainState('MIS_01JGA4', 'validation'), title: 'Paged Decode Shape Fast Path', goal: '降低 Paged Decode 在 C550 长尾 shape 下的 P95 延迟', repository: 'flashinfer-c550', hardware: ['C550'], metric: 'latency p95', stage: 'validation', status: 'awaiting_approval', updatedLabel: '18 分钟前', result: { value: '2.87 ms', improvement: '−8.6%' }, patchApplied: true, benchmark: { status: 'idle', progress: 0, runId: null, startedAt: null, durationMs: 2600, logs: [] }, agent: { ...createAwaitingAgent('MIS_01JGA4', '降低 Paged Decode 在 C550 长尾 shape 下的 P95 延迟', 'Decode shape fast path'), phase: '异构验证', currentAction: { id: 'action.decode-validation', type: 'test.plan', title: '运行 C550 Full Benchmark', reason: '30 / 30 Correctness 已通过，需要确认长尾收益。', expectedOutput: 'Full Benchmark · P50 / P95 compare', risk: 'medium', approvalRequired: true } } },
    { id: 'MIS_01JDX9', ...createMissionDomainState('MIS_01JDX9', 'published'), title: 'Ragged Prefill Vector Layout', goal: '优化 Ragged Prefill 的向量化访存和片上复用', repository: 'flashinfer-c550', hardware: ['C550'], metric: 'throughput', stage: 'published', status: 'completed', updatedLabel: '昨天', result: { value: '1.42×', improvement: '+42.1%' }, patchApplied: true, benchmark: { status: 'complete', progress: 100, runId: 'run_ARCHIVED', startedAt: null, durationMs: 2600, logs: [] }, agent: { ...createAwaitingAgent('MIS_01JDX9', '优化 Ragged Prefill 的向量化访存和片上复用', 'Vector layout reuse'), status: 'completed', phase: 'Mission 完成', progress: 100, currentAction: null } },
  ];
  const createSeedState = () => {
    const missions = createSeedMissions();
    const activeMission = missions[0];
    return {
    schemaVersion: 7,
    stateVersion: 0,
    commandJournalSeq: 0,
    updatedAt: new Date().toISOString(),
    stage: activeMission.stage,
    patchApplied: activeMission.patchApplied,
    agent: structuredClone(activeMission.agent),
    activeMissionId: activeMission.id,
    missions,
    agentProfiles: structuredClone(agentProfiles),
    capabilityRegistry: structuredClone(capabilityRegistry),
    runtimeEvents: structuredClone(activeMission.runtimeEvents),
    benchmark: structuredClone(activeMission.benchmark),
    baseline: structuredClone(activeMission.baseline || createBaselineRequirementState()),
    objective: structuredClone(activeMission.objective || normalizeMissionObjective({}, activeMission)),
    testMatrix: structuredClone(activeMission.testMatrix),
    tokenUsage: structuredClone(activeMission.tokenUsage || emptyTokenUsage()),
    knowledgeDrafts: structuredClone(activeMission.knowledgeDrafts),
    candidateEvaluations: structuredClone(activeMission.candidateEvaluations),
    failureRecords: structuredClone(activeMission.failureRecords),
    publishedAssets: structuredClone(activeMission.publishedAssets),
    knowledgeMaintenance: structuredClone(activeMission.knowledgeMaintenance),
    decisionReview: structuredClone(activeMission.decisionReview),
    workflowRecovery: structuredClone(activeMission.workflowRecovery),
    currentBest: structuredClone(activeMission.currentBest),
    runHistory: [],
    knowledgeReferences: [
      { assetId: 'exp.fixed-overhead', missionId: activeMission.id, version: 'v1.2', referencedAt: '2026-08-03T10:42:11.000Z', reason: '短序列固定开销与当前 Profile 症状一致' },
      { assetId: 'skill.segmentation', missionId: activeMission.id, version: 'v2.3.1', referencedAt: '2026-08-03T10:42:12.000Z', reason: '用于拆分 host/device 时间线' },
      { assetId: 'tool.profile-timeline', missionId: activeMission.id, version: 'v1.8.0', referencedAt: '2026-08-03T10:42:13.000Z', reason: '用于生成可审计 Profile 工件' },
    ],
    workspace: 'Matrix Lab',
    unreadCount: 2,
    missionPaused: false,
    missionBudgetMs: activeMission.missionBudgetMs ?? null,
    missionBudgetStartedAt: activeMission.missionBudgetStartedAt ?? null,
    researchNotes: structuredClone(activeMission.researchNotes || []),
    researchAgent: structuredClone(activeMission.researchAgent || createResearchAgentState()),
    iterationStats: structuredClone(activeMission.iterationStats || createIterationStats()),
    auditEvents: [
      { time: '10:42:23', title: 'Policy Engine 等待代码审批', detail: 'approval.apl_01JH7R · patch apply', tone: 'warning', icon: 'ShieldCheck' },
      { time: '10:42:19', title: 'Candidate Agent 生成 Candidate 02', detail: '2 files · +37 −18 · digest recorded', tone: 'blue', icon: 'Code2' },
      { time: '10:42:11', title: 'Research Agent 引用固定开销 Experience', detail: 'exp.short-seq.fixed-overhead@1.2 · validated', tone: 'green', icon: 'Search' },
    ],
    };
  };
  const createProductState = () => {
    const fixture = createSeedState();
    const missionId = 'MIS_01JH7R';
    const goal = MLA_OPTIMIZATION_TEST_GOAL;
    const agent = {
      ...createIdleAgent(missionId, goal),
      phase: '等待启动实际优化任务',
      messages: [{ id: `agent-ready-${missionId}`, phase: 'Mission', status: 'ready', title: '实际优化测试例已就绪', detail: '任务已固定算子、Shape、目标硬件、指标、测试矩阵和 Accept Gate。', time: '刚刚' }],
      artifacts: [],
      toolCalls: [],
    };
    const domain = createMissionDomainState(missionId, 'diagnosis');
    const mission = {
      id: missionId,
      ...domain,
      title: 'MLA Paged KV Cache',
      goal,
      repository: 'mla-kernels',
      hardware: ['C550', 'CUDA'],
      metric: 'latency p50',
      stage: 'diagnosis',
      status: 'ready',
      updatedLabel: 'new',
      result: { value: '—', improvement: '—' },
      patchApplied: false,
      benchmark: { status: 'idle', progress: 0, runId: null, testTaskId: null, startedAt: null, completedAt: null, durationMs: 0, logs: [], result: null },
      agent,
      knowledgeDrafts: [],
      candidateEvaluations: [],
      failureRecords: [],
      publishedAssets: [],
      knowledgeReferences: [],
      runtimeEvents: [],
      auditEvents: [],
      currentBest: { candidateId: null, version: null, value: '—', improvement: '—', status: 'empty' },
      baseline: createBaselineRequirementState(),
    };
    return {
      ...fixture,
      stage: mission.stage,
      patchApplied: false,
      agent: structuredClone(agent),
      activeMissionId: missionId,
      missions: [mission],
      runtimeEvents: [],
      benchmark: structuredClone(mission.benchmark),
      testMatrix: structuredClone(mission.testMatrix),
      knowledgeDrafts: [],
      candidateEvaluations: [],
      failureRecords: [],
      publishedAssets: [],
      knowledgeMaintenance: structuredClone(mission.knowledgeMaintenance),
      decisionReview: structuredClone(mission.decisionReview),
      workflowRecovery: structuredClone(mission.workflowRecovery),
      currentBest: { candidateId: null, version: null, value: '—', improvement: '—', status: 'empty' },
      runHistory: [],
      knowledgeReferences: [],
      unreadCount: 0,
      auditEvents: [],
      researchNotes: [],
      researchAgent: createResearchAgentState(),
      iterationStats: createIterationStats(),
    };
  };

  return Object.freeze({ createSeedState, createProductState });
};
