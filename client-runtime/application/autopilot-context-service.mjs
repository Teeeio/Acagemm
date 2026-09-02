export const createAutopilotContextService = ({ isFixedOperatorMission, selectCandidate }) => {
  const prepare = (state, { autoTick = process.env.OPERATOR_AUTO_TICK } = {}) => {
    if (autoTick !== '1' || state.missionPaused) return { enabled: false, mission: null, candidate: null };
    const mission = state.missions?.find((item) => item.id === state.activeMissionId) || {};
    return { enabled: true, mission, candidate: selectCandidate(state), fixedOperator: isFixedOperatorMission(mission) };
  };
  return Object.freeze({ prepare });
};
