export const createBaselineMaterializerCommandService = ({ executeCommand, journal, saveState, registry }) => {
  const start = async ({ state, baselineSource, matrix }) => {
    const result = await executeCommand({ journal, saveState, registry, state, type: 'materialize-baseline', body: { baselineSource, matrix }, expectedVersion: state.stateVersion });
    return result.state || state;
  };
  return Object.freeze({ start });
};
