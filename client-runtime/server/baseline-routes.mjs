export const createBaselineRoutes = ({ json, readJson, baseline }) => {
  if (typeof json !== 'function' || typeof readJson !== 'function' || !baseline) throw new TypeError('Baseline routes require json, readJson, and baseline dependencies.');
  return async ({ request, response, url }) => {
    if (request.method !== 'POST' || url.pathname !== '/api/actions/materialize-baseline') return false;
    const result = await baseline.materialize(await readJson(request));
    if (result.status === 'conflict') {
      json(response, 409, { error: '状态已变更，请刷新后重试。', code: 'STATE_VERSION_CONFLICT', retryable: true });
      return true;
    }
    json(response, 202, { state: result.state, materializer: result.state.baseline?.materializer, runId: result.result?.runId, ...(result.status === 'skipped_idempotent' ? { idempotent: true } : {}) });
    return true;
  };
};
