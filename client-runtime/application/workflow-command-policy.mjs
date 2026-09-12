import { assertResourcesReleased } from '../cancellation-contract.mjs';
import { validateEvidenceDecision } from '../knowledge-state.mjs';

const isPlainObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

// 决策只在其显式绑定身份与当前候选/运行一致时可用，绝不把别的候选/运行的决策
// 复制到 currentBest 或 review。
const decisionMatchesIdentity = (decision, candidateId, candidateDigest, runId) => {
  if (!validateEvidenceDecision(decision).valid || !candidateId || !candidateDigest || !runId) return false;
  const binding = decision.binding;
  return binding.candidateId === candidateId && binding.candidateDigest === candidateDigest && binding.runId === runId;
};

export const createWorkflowCommandPolicy = ({ addAuditEvent, agentRuntime, appendRuntimeEvent, createCurrentBestState, createDecisionReviewState, isManagedWorkspaceRuntimeMode, markCandidateAccepted, normalizeMissionBudgetMs, now = () => new Date() }) => {
  const guardMutation = (state) => {
    assertResourcesReleased(state);
    if (state.missionPaused) {
      const error = new Error('Mission 已暂停，请先恢复任务。');
      error.status = 409;
      throw error;
    }
    const budgetMs = normalizeMissionBudgetMs(state.missionBudgetMs);
    state.missionBudgetMs = budgetMs;
    if (!budgetMs) {
      state.missionBudgetStartedAt = null;
      return;
    }
    if (!state.missionBudgetStartedAt) {
      state.missionBudgetStartedAt = now().toISOString();
      return;
    }
    const startedAtMs = Date.parse(state.missionBudgetStartedAt);
    if (!Number.isFinite(startedAtMs)) {
      state.missionBudgetStartedAt = now().toISOString();
      return;
    }
    const elapsedMs = now().getTime() - startedAtMs;
    if (elapsedMs >= budgetMs) {
      const error = new Error('Mission 时间预算已耗尽，请调整预算后继续。');
      error.status = 409;
      error.code = 'MISSION_BUDGET_EXCEEDED';
      error.details = { budgetMs, elapsedMs, startedAt: state.missionBudgetStartedAt };
      throw error;
    }
  };
  
  const missionBudgetRawValue = (valueOrInput) => {
    if (!valueOrInput || typeof valueOrInput !== 'object' || Array.isArray(valueOrInput)) return valueOrInput;
    if (Object.hasOwn(valueOrInput, 'missionBudgetMs')) return valueOrInput.missionBudgetMs;
    if (Object.hasOwn(valueOrInput, 'timeBudgetMs')) return valueOrInput.timeBudgetMs;
    if (Object.hasOwn(valueOrInput, 'missionBudgetHours')) return Number(valueOrInput.missionBudgetHours) * 60 * 60 * 1000;
    if (Object.hasOwn(valueOrInput, 'timeBudgetHours')) return Number(valueOrInput.timeBudgetHours) * 60 * 60 * 1000;
    return null;
  };
  
  const hasMissionBudgetInput = (valueOrInput) => Boolean(valueOrInput && typeof valueOrInput === 'object' && !Array.isArray(valueOrInput) && ['missionBudgetMs', 'timeBudgetMs', 'missionBudgetHours', 'timeBudgetHours'].some((key) => Object.hasOwn(valueOrInput, key)));
  
  const isMissionBudgetDisableValue = (valueOrInput) => {
    if (!hasMissionBudgetInput(valueOrInput) && valueOrInput && typeof valueOrInput === 'object' && !Array.isArray(valueOrInput)) return true;
    const raw = missionBudgetRawValue(valueOrInput);
    return raw === null || raw === undefined || raw === '' || raw === false || Number(raw) === 0;
  };
  
  const validateMissionBudgetInput = (valueOrInput) => {
    if (isMissionBudgetDisableValue(valueOrInput)) return { ok: true, value: null };
    const normalized = normalizeMissionBudgetMs(valueOrInput);
    return normalized ? { ok: true, value: normalized } : { ok: false, value: null };
  };
  
  const guardSupportedRuntimeAction = async (action) => {
    const runtime = await agentRuntime.describe();
    if (runtime.mode === 'reference-fixture') return runtime;
    // Codex owns reasoning and workspace changes; all workflow decisions remain
    // client-owned so the local harness can inspect, pause, adopt, redirect, and
    // roll back a verified candidate without asking the Agent adapter to mutate state.
    if (isManagedWorkspaceRuntimeMode(runtime.mode)) return runtime;
    const error = new Error(`${runtime.label || 'Agent Runtime'} 尚未实现 ${action} 动作桥；已拒绝生成本地参考结果。`);
    error.status = 409;
    error.code = 'RUNTIME_ACTION_UNAVAILABLE';
    throw error;
  };
  
  const guardWorkflowTransition = (state, { stages, actionType, label }) => {
    const stageAllowed = stages.includes(state.stage);
    const actionAllowed = !actionType || state.agent?.currentAction?.type === actionType;
    if (stageAllowed && actionAllowed) return;
    const error = new Error(`${label} 与当前 Mission 状态不一致，操作已拒绝。`);
    error.status = 409;
    error.code = 'INVALID_WORKFLOW_TRANSITION';
    throw error;
  };
  
  const interventionOutcomeMeta = {
    adopt: { label: '允许采用', expectedOutput: '确认采用并更新 current best' },
    supplement: { label: '补充验证', expectedOutput: '补充验证并重新形成证据' },
    redirect: { label: '调整优化方向', expectedOutput: '恢复候选工作区并生成新的 Candidate Plan' },
  };
  
  const adoptCandidateState = (state, note, source = 'policy') => {
    const candidateId = state.appliedCandidateId || state.decisionReview?.candidateId;
    const candidate = (state.candidateEvaluations || []).find((item) => item.id === candidateId);
    const review = state.decisionReview || {};
    const reviewMatchesCandidate = !review.candidateId || review.candidateId === candidateId;
    const gate = (reviewMatchesCandidate && review.gate) || candidate?.acceptGate || null;
    const runId = state.benchmark?.runId || null;
    const rawDecision = isPlainObject(gate?.decision) ? gate.decision : null;
    // 旧 Gate 与新的 benchmark 决策错配时，宁可不带决策也不复制其他候选/运行的决策。
    const decision = rawDecision && decisionMatchesIdentity(rawDecision, candidateId, candidate?.patchDigest, runId) ? rawDecision : null;
    const decisionClone = decision ? structuredClone(decision) : null;
    const resolvedAt = markCandidateAccepted(state, note, source);
    state.stage = 'curation';
    // 人工采用不改写原 Gate 结论，只记录采用处置；review 保留同一 Gate/decision 事实。
    const reviewGate = gate;
    state.decisionReview = {
      ...(review || createDecisionReviewState('resolved')),
      status: 'resolved',
      recommendation: 'adopt',
      requiresApproval: false,
      gate: reviewGate,
      evidenceDecision: decisionClone,
      resolution: { outcome: 'adopt', source, note, resolvedAt },
      resolvedAt,
    };
    const primaryMeasurement = state.benchmark?.result?.benchmark?.[0];
    const publicationAllowed = decisionClone?.publication?.status === 'allowed';
    state.currentBest = candidateId
      ? {
          candidateId,
          candidateDigest: candidate?.patchDigest || null,
          evidenceRunId: state.benchmark?.runId || null,
          version: candidate?.version || 'agent.1',
          value: primaryMeasurement ? `${primaryMeasurement.value} ${primaryMeasurement.unit}` : '--',
          improvement: candidate?.delta || 'new',
          status: 'active',
          evidenceSource: decisionClone?.execution?.source || gate?.evidenceSource || 'unknown',
          // 真实硬件与可发布是两个维度：verified 只由 decision.publication 决定；
          // 旧无决策记录不可发布授权。
          verified: publicationAllowed,
          liveHardware: decisionClone ? decisionClone.execution?.liveHardware === true : false,
          evidenceDecision: decisionClone,
        }
      : createCurrentBestState('candidate-02');
    state.workflowRecovery = {
      ...(state.workflowRecovery || {}),
      worktree: { ...(state.workflowRecovery?.worktree || {}), status: 'adopted', adoptedAt: resolvedAt },
      lastRecovery: null,
    };
    state.agent = { ...state.agent, status: 'executing', phase: '知识自动维护', currentAction: null };
    appendRuntimeEvent(state, 'decision.adopted', { candidate: candidateId, note, source }, { kind: 'policy', mode: 'client' });
    addAuditEvent(state, source === 'human_review' ? `审批意见已处理并采用 ${candidateId}` : `策略建议已执行并采用 ${candidateId}`, `Level 3 · ${note}`, 'green', 'CheckCircle2');
    state.knowledgeMaintenance = { ...(state.knowledgeMaintenance || {}), status: 'ready' };
    return state;
  };
  return Object.freeze({ guardMutation, hasMissionBudgetInput, validateMissionBudgetInput, guardSupportedRuntimeAction, guardWorkflowTransition, interventionOutcomeMeta, adoptCandidateState });
};
