export const createBaselineBenchmarkService = ({ executeCommand, journal, saveState, registry }) => {
  const start = async ({ state, mission, baselineSource, matrix, strictZeroSource, fixedOperator }) => {
    const result = await executeCommand({ journal, saveState, registry, state, type: 'start-benchmark', body: { purpose: 'baseline', operator: mission.operator || mission.title || 'operator', baselineSource, ...((strictZeroSource || fixedOperator) ? { strictZeroSource, materializerResult: state.baseline?.materializer?.result } : {}), matrix, warmup: matrix.warmup, repeats: matrix.repeats, correctnessCases: matrix.correctnessCases, timeoutSeconds: Number(process.env.OPERATOR_LOCAL_C500_TIMEOUT_SECONDS || 600) }, expectedVersion: state.stateVersion });
    return result.state || state;
  };
  return Object.freeze({ start });
};
