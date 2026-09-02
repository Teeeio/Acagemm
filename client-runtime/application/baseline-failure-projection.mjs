export const projectBaselineFailure = ({ state, appendRuntimeEvent }) => {
  if (state.benchmark?.purpose !== 'baseline' || state.benchmark?.status !== 'failed' || state.baseline?.status === 'failed') return false;
  const error = state.benchmark.lastServiceError || { code: 'BASELINE_TEST_FAILED', message: 'Baseline operator test failed.' };
  state.baseline = { ...(state.baseline || {}), status: 'failed', error: structuredClone(error), failedAt: state.benchmark.completedAt || new Date().toISOString() };
  if (!(state.runtimeEvents || []).some((event) => event.type === 'baseline.failure_projected')) appendRuntimeEvent(state, 'baseline.failure_projected', { error }, { kind: 'migration', mode: 'client' });
  return true;
};
