export const createRunRoutes = ({ json, readJson, runs }) => {
  if (typeof json !== 'function' || typeof readJson !== 'function' || !runs) throw new TypeError('Run routes require json, readJson, and runs dependencies.');
  return async ({ request, response, url }) => {
    const match = url.pathname.match(/^\/api\/missions\/([^/]+)\/runs$/);
    if (request.method !== 'POST' || !match) return false;
    const outcome = await runs.start(decodeURIComponent(match[1]), await readJson(request));
    if (outcome.payload) { json(response, outcome.statusCode, outcome.payload); return true; }
    const result = outcome.result;
    if (result.status === 'conflict') { json(response, 409, { error: '状态已变更，请刷新后重试。', code: 'STATE_VERSION_CONFLICT', retryable: true }); return true; }
    if (outcome.kind === 'research') { json(response, 202, { state: result.state, research: result.state.researchAgent, runId: result.result?.runId, ...(result.status === 'skipped_idempotent' ? { idempotent: true } : {}) }); return true; }
    json(response, 202, { state: result.state, runId: result.result?.runId, ...(result.status === 'skipped_idempotent' ? { idempotent: true } : {}) });
    return true;
  };
};
