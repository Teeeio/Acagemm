export const createAutopilotContextService = ({ isFixedOperatorMission, selectCandidate, autoTick = '1' }) => {
  const prepare = (state, { autoTick: requestedAutoTick = autoTick } = {}) => {
    if (requestedAutoTick !== '1' || state.missionPaused) return { enabled: false, mission: null, candidate: null };
    const mission = state.missions?.find((item) => item.id === state.activeMissionId) || {};
    return { enabled: true, mission, candidate: selectCandidate(state), fixedOperator: isFixedOperatorMission(mission) };
  };
  return Object.freeze({ prepare });
};
