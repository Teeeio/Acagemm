export const createRuntimeMaintenanceService = ({ isManagedWorkspaceRuntimeMode, runKnowledgeMaintenance, runAutomaticAdoption, isMaximizeMission, refreshReferenceBenchmark, refreshReferenceAgent }) => {
  const advance = ({ state, runtimeMode }) => {
    const effectiveRuntimeMode = runtimeMode || 'unavailable';
    const usesReferenceRuntime = effectiveRuntimeMode === 'reference-fixture' && !state.agent?.runId?.startsWith('cli_');
    const usesVerifiedCodexRuntime = isManagedWorkspaceRuntimeMode(effectiveRuntimeMode) && state.agent?.runtimeKind === effectiveRuntimeMode;
    const staleMockPublication = state.benchmark?.result?.environment?.liveHardware === false
      && state.knowledgeMaintenance?.status === 'completed'
      && state.publishedAssets?.some((asset) => asset.status === 'published');
    const knowledgeChanged = (usesReferenceRuntime || usesVerifiedCodexRuntime)
      && ((state.stage === 'curation' && state.knowledgeMaintenance.status === 'ready') || staleMockPublication);
    if (knowledgeChanged) state = runKnowledgeMaintenance(state);
    const referenceAutoAdoption = usesReferenceRuntime && state.stage === 'evidence' && state.benchmark?.status === 'complete' && state.decisionReview?.status !== 'awaiting_review';
    const activeMissionForAdoption = state.missions?.find((mission) => mission.id === state.activeMissionId);
    // Three-layer projects must commit the verified patch to the Iteration
    // Repository in the client runtime before policy adoption is recorded.
    const codexAutoAdoption = usesVerifiedCodexRuntime
      && !activeMissionForAdoption?.projectRoot
      && state.stage === 'evidence'
      && state.benchmark?.status === 'complete'
      && state.decisionReview?.status === 'auto_ready'
      && state.decisionReview?.recommendation === 'adopt'
      && state.decisionReview?.gate?.passed === true
      && state.decisionReview?.status !== 'awaiting_review';
    const policyAutoAdopted = referenceAutoAdoption || codexAutoAdoption;
    if (policyAutoAdopted) {
      state = runAutomaticAdoption(state);
      const adoptedMission = state.missions?.find((mission) => mission.id === state.activeMissionId) || {};
      const adoptedMaximize = isMaximizeMission({ ...adoptedMission, objective: state.objective || adoptedMission.objective, goal: adoptedMission.goal });
      if (adoptedMaximize && state.knowledgeMaintenance?.status === 'ready') state = runKnowledgeMaintenance(state);
    }
    const benchmarkBefore = JSON.stringify(state.benchmark);
    if (usesReferenceRuntime && !state.benchmark?.testTaskId) state = refreshReferenceBenchmark(state);
    const refreshedAgent = usesReferenceRuntime ? refreshReferenceAgent(state) : { state, changed: false };
    return { state: refreshedAgent.state, changed: policyAutoAdopted || knowledgeChanged || refreshedAgent.changed || benchmarkBefore !== JSON.stringify(state.benchmark) };
  };
  return Object.freeze({ advance });
};
