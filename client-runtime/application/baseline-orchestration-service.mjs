export const createBaselineOrchestrationService = ({ inferMissionMatrix, isFixedOperatorMission, isStrictZeroSourceMission, isResearchAgentActive, sourceService, sourceInspection, materializerPolicy, materializerRecovery, materializerCommand, benchmark, appendRuntimeEvent }) => {
  const start = async ({ state, mission, reason }) => {
    const matrix = inferMissionMatrix(mission, state.testMatrix || mission.testMatrix || {});
    const fixedOperator = isFixedOperatorMission(mission);
    const strictZeroSource = isStrictZeroSourceMission(mission);
    if (fixedOperator && state.iterationStats?.loopStatus === 'needs_human') {
      state.iterationStats = { ...(state.iterationStats || {}), loopStatus: 'running', loopStatusReason: null };
      appendRuntimeEvent(state, 'workflow.stale_block_cleared', { reason: 'fixed-profile baseline restarted' }, { kind: 'workflow-kernel', mode: 'client' });
    }
    if (state.benchmark?.purpose === 'baseline' && ['queued', 'running'].includes(state.benchmark.status)) return state;
    if (state.benchmark?.purpose === 'baseline' && state.benchmark.status === 'failed') {
      state.iterationStats = { ...(state.iterationStats || {}), loopStatus: 'needs_human', loopStatusReason: 'baseline_test_failed' };
      return state;
    }
    if (!fixedOperator && isResearchAgentActive(state.researchAgent || {})) return state;
    const { source: baselineSource, semanticFallback } = sourceService.select({ state, mission, reason });
    if (!baselineSource) return state;
    if (semanticFallback) {
      state.baseline = { ...(state.baseline || {}), source: baselineSource, sourcePolicy: { ...(state.baseline?.sourcePolicy || {}), requireAuthority: false, requireSingleFileExpansion: true, allowAgentSemantic: true } };
      appendRuntimeEvent(state, 'baseline.semantic_fallback_selected', { missionId: state.activeMissionId, reason: baselineSource.reason }, { kind: 'baseline', mode: 'agent-semantic' });
    }
    if (strictZeroSource) {
      if (!semanticFallback && !(await sourceInspection.inspect({ state, mission, baselineSource })).valid) return state;
      const materializer = state.baseline?.materializer || {};
      const policy = materializerPolicy.inspect({ state, materializer, baselineSource });
      if (policy.action === 'wait') return state;
      if (policy.action === 'redirect' || policy.action === 'needs_human') return (await materializerRecovery.recover({ state, mission, baselineSource, materializer })).state;
      if (policy.action === 'materialize') return materializerCommand.start({ state, baselineSource, matrix });
    }
    return benchmark.start({ state, mission, baselineSource, matrix, strictZeroSource, fixedOperator });
  };
  return Object.freeze({ start });
};
