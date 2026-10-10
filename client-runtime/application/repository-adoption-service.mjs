export const createRepositoryAdoptionService = ({ isManagedWorkspaceRuntimeMode, adoptPatch, runAutomaticAdoption, runKnowledgeMaintenance, appendRuntimeEvent }) => {
  const adopt = async ({ state }) => {
    const mission = state.missions?.find((item) => item.id === state.activeMissionId);
    const candidateId = state.appliedCandidateId || state.decisionReview?.candidateId;
    const candidate = (state.candidateEvaluations || []).find((item) => item.id === candidateId);
    const eligible = isManagedWorkspaceRuntimeMode(state.agent?.runtimeKind) && mission?.projectRoot && state.stage === 'evidence' && state.benchmark?.status === 'complete' && state.decisionReview?.status === 'auto_ready' && state.decisionReview?.gate?.passed === true && candidate?.artifacts?.patch && !state.workflowRecovery?.repositoryAdoption?.commit;
    if (!eligible) return { changed: false, state };
    try {
      const adoption = await adoptPatch({ repository: mission.repository, patchPath: candidate.artifacts.patch, candidateId });
      state.workflowRecovery = { ...(state.workflowRecovery || {}), repositoryAdoption: { status: 'completed', ...adoption } };
      runAutomaticAdoption(state, `Accept Gate 已通过，${candidateId} 已提交到 Iteration Repository。`);
      runKnowledgeMaintenance(state);
      return { changed: true, state };
    } catch (error) {
      state.workflowRecovery = { ...(state.workflowRecovery || {}), repositoryAdoption: { status: 'blocked', code: error.code || 'ITERATION_REPOSITORY_ADOPTION_FAILED', detail: error.message, blockedAt: new Date().toISOString() } };
      state.agent = { ...state.agent, status: 'failed', phase: 'Iteration Repository 采用失败', currentAction: null, messages: [...(state.agent?.messages || []), { id: `repository-adoption-${Date.now()}`, phase: 'decision', status: 'waiting', title: '无法写回 Iteration Repository', detail: error.message, time: '刚刚', errorCode: error.code }] };
      appendRuntimeEvent(state, 'repository.adoption_blocked', { candidate: candidateId, code: error.code, detail: error.message }, { kind: 'repository', mode: 'client' });
      return { changed: true, state };
    }
  };
  return Object.freeze({ adopt });
};
