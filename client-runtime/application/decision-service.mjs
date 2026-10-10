export const createDecisionService = ({ loadState, persistState, executeCommand, journal, registry, guardSupportedRuntimeAction, guardMutation = () => {}, guardWorkflowTransition } = {}) => {
  if (typeof loadState !== 'function' || typeof persistState !== 'function' || typeof executeCommand !== 'function' || !journal || !registry || typeof guardSupportedRuntimeAction !== 'function' || typeof guardWorkflowTransition !== 'function') {
    throw new TypeError('Decision service requires state, command, guard, journal, and registry dependencies.');
  }

  const execute = (state, type, body = {}) => executeCommand({ journal, saveState: persistState, registry, state, type, body, expectedVersion: state.stateVersion });

  const adopt = async (body = {}) => {
    await guardSupportedRuntimeAction('Decision');
    const state = await loadState();
    guardMutation(state);
    if (state.knowledgeMaintenance?.status === 'completed' && state.publishedAssets?.length === state.knowledgeDrafts?.length) {
      return { status: 'skipped_idempotent', state };
    }
    if (state.decisionReview?.status === 'awaiting_review') {
      const error = new Error('流程已因人工审批意见阻塞，请先处理或撤回该意见。'); error.status = 409; error.code = 'DECISION_REVIEW_PENDING'; throw error;
    }
    guardWorkflowTransition(state, { stages: ['evidence'], actionType: 'adoption.decision', label: '候选采用' });
    if (state.benchmark?.status !== 'complete') {
      const error = new Error('Full Benchmark 尚未完成。'); error.status = 409; throw error;
    }
    return execute(state, 'adopt', body);
  };

  const reject = async () => {
    await guardSupportedRuntimeAction('Decision');
    const state = await loadState();
    guardMutation(state);
    guardWorkflowTransition(state, { stages: ['evidence'], actionType: 'adoption.decision', label: '候选退回' });
    return execute(state, 'reject');
  };

  const revertAdoption = async () => {
    await guardSupportedRuntimeAction('Adoption Revert');
    const state = await loadState();
    guardMutation(state);
    if (state.decisionReview?.resolution?.outcome === 'reverted') return { status: 'skipped_idempotent', state };
    guardWorkflowTransition(state, { stages: ['published'], label: '回退到上一版本' });
    return execute(state, 'revert-adoption');
  };

  return Object.freeze({ adopt, reject, revertAdoption });
};
