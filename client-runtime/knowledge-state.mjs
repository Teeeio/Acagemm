import { candidateEvaluations } from './state-reference-data.mjs';

import { isMaximizeMission } from './mission-objective.mjs';

import { isManagedWorkspaceRuntimeMode } from './agent-runtime/capabilities.mjs';

import { createDecisionReviewState } from './evidence-state.mjs';

import { addAuditEvent, appendRuntimeEvent } from './runtime-events.mjs';



const knowledgeChangePlan = [
  { draftId: 'exp.async-plan-cache', action: 'update', targetId: 'exp.fixed-overhead', targetTitle: '短序列下优先量化固定开销', previousVersion: 'v1.2', nextVersion: 'v1.3', scopeDelta: '适用范围未扩大', reason: '命中已有固定开销经验，补充 plan cache、host mirror 与双平台证据。' },
  { draftId: 'exp.c550-plan-cache-boundary', action: 'create', targetId: 'exp.c550-plan-cache-boundary', targetTitle: '沐曦 C550 plan cache 与 host mirror 边界准则', previousVersion: null, nextVersion: 'v1.0', scopeDelta: 'C550 专项范围', reason: '未发现等价硬件专项经验，创建新的 C550 经验资产。' },
  { draftId: 'exp.cross-platform-adoption-gate', action: 'update', targetId: 'policy.cross-platform-adoption-gate', targetTitle: 'C550 / CUDA 跨平台候选采用门禁', previousVersion: 'v2.3', nextVersion: 'v2.4', scopeDelta: '策略适用范围未扩大', reason: '合并本次失败候选与 Level 3 双平台验证证据。' },
];

export const createKnowledgeMaintenanceState = (status = 'idle') => {
  const completed = status === 'completed';
  const ready = status === 'ready';
  return {
    status,
    trigger: 'decision.adopted',
    triggerLabel: status === 'idle' ? '等待效果决策' : '效果决策 · Candidate 02 已采用',
    policy: {
      id: 'policy.knowledge.level3.same-scope',
      label: 'Level 3 同范围自动发布',
      version: 'v2.1',
      rule: 'evidence.level = 3 AND scope.expanded = false',
      exception: '适用范围扩大、证据降级或发生冲突时转人工治理',
    },
    startedAt: completed ? new Date().toISOString() : null,
    completedAt: completed ? new Date().toISOString() : null,
    summary: { extracted: completed ? 3 : 0, matched: completed ? 2 : 0, created: completed ? 1 : 0, autoPublished: completed ? 3 : 0, reviewRequired: 0 },
    steps: [
      { id: 'extract', label: '经验提取', detail: completed ? '3 个结构化经验对象' : '等待效果决策', status: completed ? 'completed' : (ready ? 'queued' : 'idle') },
      { id: 'deduplicate', label: '查重与合并', detail: completed ? '2 条合并 · 1 条新建' : '等待经验提取', status: completed ? 'completed' : 'idle' },
      { id: 'evidence', label: '证据与边界校验', detail: completed ? 'Level 3 · 13 个证据引用' : '等待匹配结果', status: completed ? 'completed' : 'idle' },
      { id: 'publish', label: '策略发布', detail: completed ? '3 条自动发布 · 0 条需复核' : '等待策略判定', status: completed ? 'completed' : 'idle' },
    ],
    changes: completed ? knowledgeChangePlan.map((change) => ({ ...change, outcome: 'auto_published' })) : knowledgeChangePlan.map((change) => ({ ...change, outcome: 'pending' })),
  };
};

export const toPublishedKnowledgeAsset = (draft, version = 'v1.0') => {
  const hardwareKeys = draft.hardware.map((item) => ({ C550: 'c550', CUDA: 'nvidia', 'ROCm MI300': 'amd' }[item])).filter(Boolean);
  const publishable = draft.status === 'validated' && draft.evidenceLevel === 'Level 3';
  return {
    ...draft,
    kind: 'Experience',
    version,
    description: draft.conclusion,
    tags: [draft.category, draft.operator, draft.dtype, ...draft.hardware, draft.evidenceLevel].filter(Boolean),
    tone: 'ochre',
    icon: 'Lightbulb',
    hardwareKeys,
    permissions: 'organization:read',
    status: publishable ? 'published' : 'simulation',
    updated: new Date().toISOString().slice(0, 10),
  };
};

export function runKnowledgeMaintenance(state) {
  const mission = state.missions?.find((item) => item.id === state.activeMissionId) || {};
  const maximizeObjective = isMaximizeMission({ ...mission, objective: state.objective || mission.objective, goal: mission.goal });
  const liveEvidence = state.benchmark?.result?.environment?.liveHardware === true;
  const expectedAssetStatus = liveEvidence ? 'published' : 'simulation';
  if (state.knowledgeMaintenance?.status === 'completed'
    && state.publishedAssets?.length === state.knowledgeDrafts?.length
    && state.publishedAssets.every((asset) => asset.status === expectedAssetStatus)) return state;
  const startedAt = new Date().toISOString();
  const activeCandidateId = state.appliedCandidateId || state.currentBest?.candidateId || 'candidate';
  const maintainedDrafts = (state.knowledgeDrafts || []).map((draft) => liveEvidence ? draft : {
    ...draft,
    evidenceLevel: '模拟证据',
    confidence: '仅供流程验证',
    status: 'simulation',
    evidence: `${state.benchmark?.runId || 'mock-run'} · Mock Benchmark / Tracer / Profiler`,
  });
  state.knowledgeDrafts = maintainedDrafts;
  const activeChanges = maintainedDrafts.map((draft) => knowledgeChangePlan.find((change) => change.draftId === draft.id) || {
    draftId: draft.id,
    action: 'create',
    targetId: draft.id,
    targetTitle: draft.title,
    previousVersion: null,
    nextVersion: 'v1.0',
    scopeDelta: '当前 Mission 验证范围',
    reason: `由 ${activeCandidateId} 的 Patch 与测试证据自动提取。`,
  });
  const versionByDraft = new Map(activeChanges.map((change) => [change.draftId, change.nextVersion]));
  state.publishedAssets = maintainedDrafts.map((draft) => toPublishedKnowledgeAsset(draft, versionByDraft.get(draft.id) || 'v1.0'));
  const publishedCount = state.publishedAssets.filter((asset) => asset.status === 'published').length;
  const simulationCount = state.publishedAssets.length - publishedCount;
  state.knowledgeMaintenance = {
    ...createKnowledgeMaintenanceState('completed'),
    startedAt,
    completedAt: new Date().toISOString(),
    summary: {
      extracted: state.knowledgeDrafts.length,
      matched: activeChanges.filter((change) => change.action === 'update').length,
      created: activeChanges.filter((change) => change.action === 'create').length,
      autoPublished: publishedCount,
      reviewRequired: simulationCount,
    },
    changes: activeChanges.map((change) => ({ ...change, outcome: liveEvidence ? 'auto_published' : 'simulation_only' })),
    triggerLabel: liveEvidence
      ? `效果决策 · ${activeCandidateId} 已采用`
      : `仿真闭环 · ${activeCandidateId} 仅生成预览资产`,
  };
  state.stage = maximizeObjective ? 'evidence' : 'published';
  state.decisionReview = {
    ...(state.decisionReview || createDecisionReviewState('resolved')),
    status: 'resolved',
    requiresApproval: false,
    recommendation: 'adopt',
    resolution: state.decisionReview?.resolution || { outcome: 'adopt', source: 'policy' },
    resolvedAt: state.decisionReview?.resolvedAt || new Date().toISOString(),
  };
  state.agent = {
    ...state.agent,
    status: 'completed',
    phase: maximizeObjective ? 'Current best 已更新，继续优化' : '知识自动维护完成',
    progress: 100,
    currentAction: null,
    messages: [...(state.agent?.messages || []), { id: `knowledge-${Date.now()}`, phase: 'knowledge', status: 'completed', title: maximizeObjective ? 'Current best 经验已记录' : liveEvidence ? '知识资产已自动维护' : '仿真经验预览已生成', detail: maximizeObjective ? `${state.currentBest?.value || 'current best'} 已记录，Mission 继续优化。` : liveEvidence ? `${publishedCount} 条经验已完成查重、版本化和策略发布。` : `${simulationCount} 条经验仅用于验证客户端闭环，不会进入正式知识资产库。`, time: '刚刚' }],
  };
  appendRuntimeEvent(state, 'knowledge.maintenance_completed', { policyId: state.knowledgeMaintenance.policy.id, summary: state.knowledgeMaintenance.summary, changes: state.knowledgeMaintenance.changes, liveEvidence, objectiveMode: maximizeObjective ? 'maximize' : 'gate' }, { kind: 'knowledge', mode: 'client' });
  addAuditEvent(state, maximizeObjective ? 'Current best 经验已记录，继续优化' : liveEvidence ? '知识资产已按策略自动维护' : '仿真经验预览已生成', `${state.publishedAssets.length} Experiences · ${state.knowledgeMaintenance.policy.version} · ${simulationCount} simulation only`, liveEvidence ? 'green' : 'warning', 'BookOpen');
  return state;
}

export function markCandidateAccepted(state, note, source = 'policy') {
  const acceptedAt = new Date().toISOString();
  const candidateId = state.appliedCandidateId || state.decisionReview?.candidateId || 'candidate-02';
  state.candidateEvaluations = (state.candidateEvaluations || candidateEvaluations).map((candidate) => candidate.id === candidateId
    ? {
        ...candidate,
        classification: 'accepted',
        status: source === 'human_review' ? '已按人工处置采用' : '已自动采用',
        tone: 'adopted',
        decision: source === 'human_review' ? '人工介入采用为 current best' : '策略自动采用为 current best',
        decisionReason: note,
        acceptedAt,
        acceptGate: { ...candidate.acceptGate, passed: true, result: 'accepted' },
      }
    : candidate);
  return acceptedAt;
}

export function runAutomaticAdoption(state, note = 'Accept Gate 全部通过，策略自动采用 Candidate 02。') {
  const candidateId = state.appliedCandidateId || state.decisionReview?.candidateId;
  const candidate = (state.candidateEvaluations || []).find((item) => item.id === candidateId);
  const isCodexCandidate = isManagedWorkspaceRuntimeMode(state.agent?.runtimeKind);
  const gate = state.decisionReview?.gate || candidate?.acceptGate || { passed: true, passedRules: [], evaluatedRules: 0 };
  if (state.decisionReview?.status === 'awaiting_review' || !candidateId || (isCodexCandidate && (!candidate?.patchDigest || gate?.passed !== true))) return state;
  const mission = state.missions?.find((item) => item.id === state.activeMissionId) || {};
  const maximizeObjective = isMaximizeMission({ ...mission, objective: state.objective || mission.objective, goal: mission.goal });
  const resolvedAt = markCandidateAccepted(state, note, 'policy');
  state.stage = maximizeObjective ? 'evidence' : 'curation';
  const primaryMeasurement = state.benchmark?.result?.benchmark?.[0];
  state.currentBest = {
    candidateId,
    version: candidate.version || 'agent.1',
    value: primaryMeasurement ? `${primaryMeasurement.value} ${primaryMeasurement.unit}` : '--',
    improvement: candidate.delta || 'new',
    status: 'active',
    evidenceSource: gate.evidenceSource || 'unknown',
    verified: gate.publishable === true,
    liveHardware: gate.publishable === true && state.benchmark?.result?.environment?.liveHardware === true,
    evidenceRunId: state.benchmark?.runId || null,
    measurements: (state.benchmark?.result?.benchmark || []).map((measurement) => ({
      profile: measurement.profile || measurement.environment,
      value: measurement.value,
      unit: measurement.unit || 'us',
    })),
  };
  state.decisionReview = {
    ...createDecisionReviewState('resolved'),
    recommendation: 'adopt',
    resolution: { outcome: 'adopt', source: 'policy', note, resolvedAt },
    resolvedAt,
  };
  state.knowledgeMaintenance = createKnowledgeMaintenanceState('ready');
  state.agent = {
    ...state.agent,
    status: maximizeObjective ? 'completed' : 'executing',
    phase: maximizeObjective ? 'Accept Gate 自动采用，继续优化' : 'Accept Gate 自动采用',
    currentAction: null,
    messages: [...(state.agent?.messages || []), { id: `auto-adopt-${Date.now()}`, phase: 'decision', status: 'completed', title: `Accept Gate 已自动采用 ${candidateId}`, detail: `${gate.passedRules?.length || 0} / ${gate.evaluatedRules || gate.passedRules?.length || 0} 条必需规则通过 · current best 已更新${maximizeObjective ? ' · Mission 继续优化' : ''}`, time: '刚刚' }],
  };
  appendRuntimeEvent(state, 'decision.auto_adopted', { candidate: candidateId, policyId: state.decisionReview.policy.id, passedRules: gate.passedRules || [], gate, objectiveMode: maximizeObjective ? 'maximize' : 'gate' }, { kind: 'policy', mode: 'client' });
  addAuditEvent(state, maximizeObjective ? 'Accept Gate 自动采用候选，继续优化' : 'Accept Gate 自动采用候选', `${candidateId} · ${gate.passedRules?.length || 0}/${gate.evaluatedRules || gate.passedRules?.length || 0} required rules passed`, 'green', 'ShieldCheck');
  return state;
}
