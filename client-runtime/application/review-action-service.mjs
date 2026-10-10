import { assertResourcesReleased } from '../cancellation-contract.mjs';

export const createReviewActionService = ({ loadState, persistState, executeCommand, journal, registry, guardSupportedRuntimeAction, guardMutation = () => {}, guardWorkflowTransition } = {}) => {
  if (typeof loadState !== 'function' || typeof persistState !== 'function' || typeof executeCommand !== 'function' || !journal || !registry || typeof guardSupportedRuntimeAction !== 'function' || typeof guardWorkflowTransition !== 'function') {
    throw new TypeError('Review action service requires state, command, guard, journal, and registry dependencies.');
  }
  const command = async ({ type, body, action, stages, label, actionType = undefined }) => {
    await guardSupportedRuntimeAction(action);
    const state = await loadState();
    guardMutation(state);
    guardWorkflowTransition(state, { stages, ...(actionType ? { actionType } : {}), label });
    const result = await executeCommand({ journal, saveState: persistState, registry, state, type, body, expectedVersion: state.stateVersion });
    return result;
  };
  const resume = async (body = {}) => {
    await guardSupportedRuntimeAction('Mission Resume');
    const state = await loadState();
    assertResourcesReleased(state);
    return executeCommand({ journal, saveState: persistState, registry, state, type: 'resume-mission', body, expectedVersion: state.stateVersion });
  };
  const requestReview = async (body = {}) => {
    await guardSupportedRuntimeAction('Decision Review');
    const state = await loadState();
    guardMutation(state);
    guardWorkflowTransition(state, { stages: ['candidate', 'validation', 'evidence'], label: '人工介入发起' });
    if (state.decisionReview?.status === 'awaiting_review') {
      const error = new Error('当前已有待处理的人工介入事项。'); error.status = 409; error.code = 'DECISION_REVIEW_PENDING'; throw error;
    }
    return executeCommand({ journal, saveState: persistState, registry, state, type: 'request-review', body, expectedVersion: state.stateVersion });
  };
  const cancelReview = () => command({ type: 'cancel-review', body: {}, action: 'Decision Review', stages: ['candidate', 'validation', 'evidence'], actionType: 'review.resolve', label: '人工介入撤回' });
  const resolveReview = async (body = {}) => {
    await guardSupportedRuntimeAction('Decision Review');
    const state = await loadState();
    guardMutation(state);
    guardWorkflowTransition(state, { stages: ['candidate', 'validation', 'evidence'], actionType: 'review.resolve', label: '人工介入处理' });
    if (state.decisionReview?.status !== 'awaiting_review' || !state.decisionReview.request) {
      const error = new Error('当前没有待处理的效果决策审批意见。'); error.status = 409; error.code = 'DECISION_REVIEW_NOT_PENDING'; throw error;
    }
    const outcome = body.outcome || state.decisionReview.request.outcome;
    if (outcome === 'adopt' && (state.stage !== 'evidence' || state.benchmark?.status !== 'complete')) {
      const error = new Error('当前尚未形成可采用的 Level 3 证据。'); error.status = 409; error.code = 'INTERVENTION_ADOPTION_UNAVAILABLE'; throw error;
    }
    if (!['adopt', 'supplement', 'redirect'].includes(outcome)) {
      const error = new Error('人工介入处理结果仅支持采用、补充验证或调整优化方向。'); error.status = 400; error.code = 'DECISION_REVIEW_OUTCOME_INVALID'; throw error;
    }
    const result = await executeCommand({ journal, saveState: persistState, registry, state, type: 'resolve-review', body, expectedVersion: state.stateVersion });
    return { result, outcome };
  };
  return Object.freeze({ resume, requestReview, cancelReview, resolveReview });
};
