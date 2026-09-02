export const createRoundRecoveryService = ({ isManagedWorkspaceRuntimeMode, restoreWorkspaceCheckpoint, captureDiff }) => {
  if (typeof isManagedWorkspaceRuntimeMode !== 'function' || typeof restoreWorkspaceCheckpoint !== 'function' || typeof captureDiff !== 'function') {
    throw new TypeError('Round recovery service requires runtime and workspace dependencies.');
  }
  const restoreRejectedRound = async ({ state, workspace, runtimeMode }) => {
    const checkpoint = state.workflowRecovery?.checkpoints?.at(-1) || null;
    const gate = state.decisionReview?.gate || null;
    if (!isManagedWorkspaceRuntimeMode(runtimeMode) || !checkpoint || (gate?.passed !== false && state.decisionReview?.resolution?.outcome !== 'reject')) return null;
    const recovery = await restoreWorkspaceCheckpoint(checkpoint, state.activeMissionId);
    const restoredDiff = await captureDiff(workspace);
    if (!checkpoint.stableDigest || restoredDiff.digest !== checkpoint.stableDigest) {
      const error = new Error('上一轮候选恢复后工作区未回到 baseline checkpoint，已阻止下一轮 Agent。');
      error.status = 409;
      error.code = 'ROUND_ROLLBACK_WORKSPACE_DIRTY';
      throw error;
    }
    const candidateId = state.appliedCandidateId || state.decisionReview?.candidateId || state.benchmark?.candidate?.id || null;
    const candidateDigest = state.benchmark?.candidate?.digest || (state.candidateEvaluations || []).find((item) => item.id === candidateId)?.patchDigest || null;
    return { checkpointId: checkpoint.id, candidateId, candidateDigest, workspaceClean: true, restoredAt: recovery.restoredAt };
  };
  return Object.freeze({ restoreRejectedRound });
};
