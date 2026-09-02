export const createIterationResearchService = ({ mkdir, agentRuntime, isManagedWorkspaceRuntimeMode }) => {
  if (typeof mkdir !== 'function' || !agentRuntime || typeof agentRuntime.startResearch !== 'function' || typeof isManagedWorkspaceRuntimeMode !== 'function') {
    throw new TypeError('Iteration research service requires workspace and Agent runtime dependencies.');
  }
  const startResearch = async ({ state, mission, direction, workspace, synchronous = true, runPhase = 'acquire' }) => {
    if (!isManagedWorkspaceRuntimeMode(agentRuntime.mode)) return state;
    await mkdir(workspace, { recursive: true });
    const started = await agentRuntime.startResearch({ state, mission, direction, workspace, synchronous, runPhase });
    return started.state;
  };
  const cancelResearch = async ({ state, runId }) => agentRuntime.cancelRun({ state, runId });
  return Object.freeze({ startResearch, cancelResearch });
};
