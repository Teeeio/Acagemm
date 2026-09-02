export const createCandidateValidationService = ({ loadState, persistState, executeCommand, journal, registry, guardSupportedRuntimeAction, guardMutation = () => {}, guardWorkflowTransition } = {}) => {
  if (typeof loadState !== 'function' || typeof persistState !== 'function' || typeof executeCommand !== 'function' || !journal || !registry || typeof guardSupportedRuntimeAction !== 'function' || typeof guardWorkflowTransition !== 'function') {
    throw new TypeError('Candidate validation service requires state, command, guard, journal, and registry dependencies.');
  }

  const execute = (state, type, body = {}) => executeCommand({ journal, saveState: persistState, registry, state, type, body, expectedVersion: state.stateVersion });

  const applyPatch = async (body = {}) => {
    await guardSupportedRuntimeAction('Patch');
    const state = await loadState();
    guardMutation(state);
    guardWorkflowTransition(state, { stages: ['candidate'], actionType: 'candidate.plan', label: 'Patch 自动策略检查' });
    if (!body.candidate) {
      const error = new Error('候选标识不能为空。'); error.status = 409; error.code = 'CANDIDATE_MISMATCH'; throw error;
    }
    return execute(state, 'apply-patch', body);
  };

  const startBenchmark = async (body = {}) => {
    const state = await loadState();
    guardMutation(state);
    const purpose = body.purpose === 'baseline' || body.testPurpose === 'baseline' ? 'baseline' : 'candidate';
    if (purpose === 'baseline') {
      guardWorkflowTransition(state, { stages: ['diagnosis', 'candidate', 'validation'], label: 'Baseline 提交' });
    } else {
      guardWorkflowTransition(state, { stages: ['validation'], actionType: 'test.plan', label: 'Benchmark 提交' });
      if (!state.patchApplied) return { statusCode: 409, payload: { error: '请先应用候选补丁。', code: 'PATCH_REQUIRED_BEFORE_CANDIDATE_BENCHMARK' } };
    }
    const matrix = body.matrix || state.testMatrix;
    if (!Array.isArray(matrix?.environments) || !matrix.environments.length || !Array.isArray(matrix?.stages) || !matrix.stages.length) {
      return { statusCode: 400, payload: { error: '本次测试矩阵至少需要一个环境和一个验证阶段。', code: 'TEST_MATRIX_INVALID' } };
    }
    const candidateId = body.candidate || state.appliedCandidateId;
    if (purpose !== 'baseline' && !candidateId) {
      return { statusCode: 409, payload: { error: '无法确定本次测试对应的候选，请重新应用候选 Patch。', code: 'TEST_CANDIDATE_MISSING' } };
    }
    return { result: await execute(state, 'start-benchmark', body) };
  };

  const rollbackStage = async () => {
    await guardSupportedRuntimeAction('Workflow Rollback');
    const state = await loadState();
    guardMutation(state);
    if (state.decisionReview?.status === 'awaiting_review') {
      const error = new Error('请先撤回待处理的人工意见，再返回上一步。'); error.status = 409; error.code = 'DECISION_REVIEW_PENDING'; throw error;
    }
    guardWorkflowTransition(state, { stages: ['validation', 'evidence'], label: '返回上一步' });
    return execute(state, 'rollback-stage');
  };

  return Object.freeze({ applyPatch, startBenchmark, rollbackStage });
};
