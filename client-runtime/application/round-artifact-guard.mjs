export const createRoundArtifactGuard = ({ isStrictZeroSourceMission }) => {
  if (typeof isStrictZeroSourceMission !== 'function') throw new TypeError('Round artifact guard requires mission policy.');
  const assertReady = ({ mission, state }) => {
    if (!isStrictZeroSourceMission(mission)) return true;
    if (state.baseline?.materializer?.result?.runPy) return true;
    const error = new Error('Iteration Agent 启动前缺少本轮 Materializer 生成的 baseline run.py。');
    error.status = 409;
    error.code = 'ITERATION_BASELINE_ARTIFACT_MISSING';
    throw error;
  };
  return Object.freeze({ assertReady });
};
