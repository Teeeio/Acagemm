export const createAutopilotService = ({ contextService, fixedProfileService, strictSourceService, candidateBaselineService, candidateActionService, validationService, iteration, isFixedOperatorMission, isStrictZeroSourceMission, runtimeMode }) => {
  const advance = async (state) => {
    const context = contextService.prepare(state);
    if (!context.enabled) return { state, action: 'none' };
    const { mission, candidate } = context;
    const actionType = state.agent?.currentAction?.type;

    if (isFixedOperatorMission(mission)) {
      if (state.baseline?.status !== 'complete') {
        const nextState = await iteration.startBaseline({ state, mission, reason: 'fixed operator profile baseline' });
        return { state: nextState, action: nextState.benchmark?.status === 'running' ? 'baseline_started' : 'wait_baseline' };
      }
      return fixedProfileService.advance({ state, mission });
    }
    if (isStrictZeroSourceMission(mission)) return (await strictSourceService.advance({ state, mission, candidate })) || { state, action: 'none' };
    if (state.stage === 'candidate' && state.agent?.status === 'awaiting_action' && state.baseline?.status !== 'complete') return (await candidateBaselineService.advance({ state, mission })) || { state, action: 'none' };
    if (state.stage === 'candidate' && state.agent?.status === 'awaiting_action' && state.baseline?.status === 'complete') {
      const simulationCandidate = runtimeMode() === 'reference-fixture' && candidate?.id && !candidate.patchDigest;
      if ((simulationCandidate || candidate?.patchDigest) && actionType === 'candidate.plan') {
        const nextState = await candidateActionService.applyCandidate({ state, candidateId: candidate.id });
        return { state: nextState, action: nextState.iterationStats?.loopStatusReason === 'patch_policy_rejected' ? 'needs_human' : simulationCandidate ? 'simulation_candidate_applied' : 'candidate_applied' };
      }
      if (!candidate?.patchDigest) return { state: await candidateActionService.resumeCandidate({ state, mission, startMainRound: iteration.startMainRound }), action: 'candidate_resumed' };
    }
    if (state.stage === 'validation' && state.patchApplied && state.baseline?.status === 'complete' && state.agent?.status === 'awaiting_action' && actionType === 'test.plan') return { state: await validationService.startCandidateTest({ state, mission }), action: 'candidate_test_started' };
    return { state, action: 'none' };
  };
  return Object.freeze({ advance });
};
