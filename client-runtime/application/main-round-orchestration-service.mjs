export const createMainRoundOrchestrationService = ({ agentRuntime, preflight, recovery, artifactGuard, agentRound, appendRuntimeEvent, addAuditEvent }) => {
  const start = async ({ state, goal, retryMode = 'generation' }) => {
    const runtimeDescriptor = await agentRuntime.describe();
    const prepared = await preflight.prepare({ state, goal, retryMode });
    if (prepared.blocked) return state;
    const { mission, preflight: runtimePreflight } = prepared;
    const workspace = runtimePreflight.workspace;
    const rollback = await recovery.restoreRejectedRound({ state, workspace, runtimeMode: runtimeDescriptor.mode });
    artifactGuard.assertReady({ mission, state });
    if (rollback) {
      state.workflowRecovery = { ...(state.workflowRecovery || {}), lastRecovery: { type: 'round_rollback', ...rollback } };
      appendRuntimeEvent(state, 'workflow.round_rolled_back', rollback, { kind: 'recovery', mode: 'client' });
      addAuditEvent(state, '未采纳候选已回退', `${rollback.candidateId || 'candidate'} · ${rollback.checkpointId} · workspace clean`, 'warning', 'History');
    }
    return agentRound.startRound({ state, mission, goal, workspace, runtimeMode: runtimeDescriptor.mode });
  };

  return Object.freeze({ start });
};
