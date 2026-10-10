export const projectBaselineFailure = ({ state, appendRuntimeEvent }) => {
  const benchmark = state.benchmark || {};
  if (benchmark.purpose !== 'baseline' || !['failed', 'cancelled'].includes(benchmark.status)
    || benchmark.resourceRelease?.confirmed === false || state.baseline?.status === benchmark.status) return false;
  const cancelled = benchmark.status === 'cancelled';
  const error = benchmark.lastServiceError || { code: cancelled ? 'BASELINE_TEST_CANCELLED' : 'BASELINE_TEST_FAILED',
    message: cancelled ? 'Baseline operator test was cancelled; retry the same frozen baseline through the existing test action.' : 'Baseline operator test failed.' };
  state.baseline = { ...(state.baseline || {}), status: benchmark.status, error: structuredClone(error),
    [cancelled ? 'cancelledAt' : 'failedAt']: benchmark.completedAt || new Date().toISOString() };
  const eventType = cancelled ? 'baseline.cancellation_projected' : 'baseline.failure_projected';
  if (!(state.runtimeEvents || []).some(event => event.type === eventType && event.payload?.runId === (benchmark.runId || null))) {
    appendRuntimeEvent(state, eventType, { error, runId: benchmark.runId || null, taskId: benchmark.testTaskId || null }, { kind: 'migration', mode: 'client' });
  }
  return true;
};
