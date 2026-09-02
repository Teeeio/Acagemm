export const createAgentRoundService = ({ resetMissionRunState, resetMissionWorkspace, createWorkspaceCheckpoint, startAgentRun, appendRuntimeEvent, isManagedWorkspaceRuntimeMode, agentRuntime }) => {
  if (!resetMissionRunState || !resetMissionWorkspace || !createWorkspaceCheckpoint || !startAgentRun || !appendRuntimeEvent || typeof isManagedWorkspaceRuntimeMode !== 'function' || !agentRuntime) throw new TypeError('Agent round service dependencies are required.');
  const startRound = async ({ state, mission, goal, workspace, runtimeMode }) => {
    resetMissionRunState(state, goal, { referenceFixture: runtimeMode === 'reference-fixture' });
    if (runtimeMode === 'reference-fixture') await resetMissionWorkspace(state.activeMissionId);
    if (isManagedWorkspaceRuntimeMode(runtimeMode)) {
      const checkpoint = await createWorkspaceCheckpoint(state.activeMissionId, 'agent-run-baseline');
      state.workflowRecovery = { ...(state.workflowRecovery || {}), checkpoints: [...(state.workflowRecovery?.checkpoints || []), checkpoint].slice(-5) };
    }
    const runtimeRun = await agentRuntime.startRun({ state, mission, goal, resumeThreadId: null, workspace });
    if (!runtimeRun.handled) {
      startAgentRun(state, goal, { reset: false });
      appendRuntimeEvent(state, 'mission.run_started', { runId: state.agent.runId, goal }, { kind: 'adapter', mode: 'reference-fixture' });
    }
    return runtimeRun.state || state;
  };
  return Object.freeze({ startRound });
};
