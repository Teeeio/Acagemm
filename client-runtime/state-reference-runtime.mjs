import { capabilityRegistry } from './state-reference-data.mjs';

import { addAuditEvent, appendRuntimeEvent } from './runtime-events.mjs';

import { createDecisionReviewState } from './evidence-state.mjs';



export function refreshReferenceBenchmark(state) {
  if (state.benchmark?.status !== 'running' || !state.benchmark.startedAt) return state;
  const elapsed = Date.now() - new Date(state.benchmark.startedAt).getTime();
  const progress = Math.min(100, Math.max(0, Math.floor((elapsed / state.benchmark.durationMs) * 100 / 10) * 10));
  state.benchmark.progress = progress;
  state.benchmark.logs = buildBenchmarkLogsForMatrix(progress, state.benchmark.matrix || state.testMatrix);
  if (progress >= 100) {
    state.benchmark.status = 'complete';
    state.stage = 'evidence';
    if (!state.benchmark.completedAt) {
      state.benchmark.completedAt = new Date().toISOString();
      addAuditEvent(state, 'Full Benchmark 已完成', 'C550 41.8μs · CUDA 36.1μs · 24/24', 'green', 'CheckCircle2');
      appendRuntimeEvent(state, 'test_task.completed', { runId: state.benchmark.runId, correctness: '24/24', evidenceLevel: 'Level 3' }, { kind: 'queue', mode: 'reference-fixture' });
    }
    if (state.decisionReview?.status === 'awaiting_review') {
      state.decisionReview = { ...state.decisionReview, recommendation: 'adopt', gateEvaluatedAt: state.benchmark.completedAt };
      state.agent = {
        ...state.agent,
        status: 'awaiting_approval',
        phase: '人工介入待处理',
        currentAction: { ...(state.agent?.currentAction || {}), type: 'review.resolve', approvalRequired: true, reviewMode: 'human_requested' },
      };
    } else {
      state.decisionReview = {
        ...(state.decisionReview || createDecisionReviewState('auto_ready')),
        status: 'auto_ready',
        recommendation: 'adopt',
        requiresApproval: false,
        gateEvaluatedAt: state.benchmark.completedAt,
      };
      state.agent = {
        ...state.agent,
        status: 'awaiting_action',
        phase: '效果决策可查看',
        currentAction: { id: 'action.adoption-decision', type: 'adoption.decision', title: 'Accept Gate 已完成，等待策略执行', reason: '证据已经形成，下一次状态推进将按策略自动采用。', expectedOutput: 'Policy Decision · current best update', risk: 'medium', approvalRequired: false, reviewMode: 'conditional' },
      };
    }
  }
  return state;
}

export function refreshReferenceAgent(state) {
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
    [20, '知识检索', 'Research Agent 已找到 3 条适用于 C550 的 Experience。', 'research'],
    [40, '瓶颈分析', 'Bottleneck Agent 正在对齐 plan、workspace 和 host mirror 的时间线。', 'diagnosis'],
    [60, '候选规划', 'Candidate Agent 正在生成有界变更和验证约束。', 'candidate'],
    [80, '补丁准备', 'Candidate Plan 已生成，正在准备自动策略检查。', 'candidate'],
    [100, '策略检查就绪', 'Candidate 02 已准备好，可自动检查变更边界并写入隔离工作区。', 'candidate'],
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
    next.status = 'awaiting_action';
    next.currentAction = {
      id: 'action.candidate-02',
      type: 'candidate.plan',
      title: `自动检查 Candidate 02 · ${candidateName}`,
      reason: `${metric} 的主要瓶颈已定位，候选变更限定在当前 Mission 的受控工作区。`,
      expectedOutput: '2 个文件 · 受控 Patch · Correctness Matrix',
      risk: 'medium',
      approvalRequired: false,
      approvalPolicy: 'client-controlled',
    };
    next.artifacts = [
      ...artifacts,
      { id: 'artifact-candidate', kind: 'Candidate Plan', title: `Candidate 02 · ${candidateName}`, status: 'ready', meta: '2 files · +37 −18 · digest recorded' },
    ];
    if (state.stage === 'diagnosis') state.stage = 'candidate';
    if (!state.auditEvents?.some((event) => event.detail === 'agent run completed')) addAuditEvent(state, 'Candidate Agent 已完成计划', 'agent run completed · Candidate 02 ready for policy check', 'blue', 'Code2');
    if (!state.runtimeEvents?.some((event) => event.type === 'candidate.plan_created' && event.payload?.runId === next.runId)) {
      appendRuntimeEvent(state, 'candidate.plan_created', { runId: next.runId, candidate: 'candidate-02', artifactId: 'artifact-candidate' }, { kind: 'agent', mode: 'reference-fixture' });
    }
  }
  return { state: { ...state, agent: next }, changed: JSON.stringify(agent) !== JSON.stringify(next) };
}

export function buildBenchmarkLogsForMatrix(progress, matrix = {}) {
  const environments = Array.isArray(matrix?.environments) && matrix.environments.length ? matrix.environments : ['C550', 'CUDA'];
  const primary = environments[0];
  const secondary = environments[1] || environments[0];
  const entries = [
    [0, `\u8c03\u5ea6\u5668\u5df2\u9501\u5b9a ${environments.length} \u4e2a\u73af\u5883\u5feb\u7167`],
    [20, `${primary} Correctness 12 / 12 \u901a\u8fc7`],
    [40, `${secondary} Correctness 12 / 12 \u901a\u8fc7`],
    [60, `${primary} Full Benchmark \u5b8c\u6210`],
    [80, `${secondary} Full Benchmark \u5b8c\u6210`],
    [100, '\u8bc1\u636e\u5305\u5df2\u751f\u6210\uff1aLevel 3'],
  ];
  return entries.filter(([threshold]) => progress >= threshold).map(([threshold, message], index) => ({ sequence: index + 1, progress: threshold, message }));
}

export function buildBenchmarkLogs(progress) {
  const entries = [
    [0, '调度器已锁定 2 个环境快照'],
    [20, 'C550 Correctness 12 / 12 通过'],
    [40, 'CUDA Correctness 12 / 12 通过'],
    [60, 'C550 Full Benchmark 完成：41.8μs'],
    [80, 'CUDA Full Benchmark 完成：36.1μs'],
    [100, '证据包已生成：Level 3'],
  ];
  return entries.filter(([threshold]) => progress >= threshold).map(([threshold, message], index) => ({ sequence: index + 1, progress: threshold, message }));
}
