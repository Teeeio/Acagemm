const notFound = () => { const error = new Error('Mission 不存在。'); error.status = 404; error.code = 'MISSION_NOT_FOUND'; return error; };
const mismatch = (message) => { const error = new Error(message); error.status = 409; error.code = 'AGENT_MISSION_MISMATCH'; return error; };

export const createResearchService = ({ loadState, persistState, executeCommand, journal, registry, agentRuntime, guardMutation = () => {}, missionState } = {}) => {
  if (typeof missionState?.selectMission !== 'function' || typeof loadState !== 'function' || typeof persistState !== 'function' || typeof executeCommand !== 'function' || !journal || !registry || !agentRuntime) {
    throw new TypeError('Research service requires state, command, journal, registry, and Agent Runtime dependencies.');
  }
  const start = async (missionId, body = {}) => {
    const state = await loadState();
    guardMutation(state);
    if (!state.missions.find((mission) => mission.id === missionId)) throw notFound();
    if (state.activeMissionId !== missionId) missionState.selectMission(state, missionId);
    const result = await executeCommand({ journal, saveState: persistState, registry, state, type: 'research', body, expectedVersion: state.stateVersion });
    return result;
  };
  const cancel = async (missionId, runId) => {
    const state = await loadState();
    if (state.activeMissionId !== missionId) throw mismatch('The requested research run does not belong to the active Mission.');
    const cancelled = await agentRuntime.cancelRun({ state, runId });
    return { state: await persistState(cancelled.state), result: cancelled.result };
  };
  return Object.freeze({ start, cancel });
};
