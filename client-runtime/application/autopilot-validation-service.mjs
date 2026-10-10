export const createAutopilotValidationService = ({ executeCommand, journal, saveState, registry, inferMissionMatrix }) => {
  const startCandidateTest = async ({ state, mission }) => {
    const matrix = inferMissionMatrix(mission, state.testMatrix || mission.testMatrix || {});
    const result = await executeCommand({ journal, saveState, registry, state, type: 'start-benchmark', body: { purpose: 'candidate', candidate: state.appliedCandidateId, matrix }, expectedVersion: state.stateVersion });
    return result.state || state;
  };
  return Object.freeze({ startCandidateTest });
};
