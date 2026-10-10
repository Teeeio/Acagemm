export const createReviewActionRoutes = ({ json, readJson, actions }) => {
  if (typeof json !== 'function' || typeof readJson !== 'function' || !actions) throw new TypeError('Review action routes require json, readJson, and actions dependencies.');
  return async ({ request, response, url }) => {
    if (request.method !== 'POST') return false;
    if (url.pathname === '/api/actions/resolve-review') {
      const { result, outcome } = await actions.resolveReview(await readJson(request));
      if (result.status === 'conflict') { json(response, 409, { error: '状态已变更，请刷新后重试。', code: 'STATE_VERSION_CONFLICT', retryable: true }); return true; }
      json(response, 200, {
        state: result.state,
        ...(outcome === 'adopt' ? { maintenance: result.state.knowledgeMaintenance } : { review: result.state.decisionReview }),
        ...(outcome === 'redirect' ? { recovery: result.result?.recovery } : {}),
        ...(result.status === 'skipped_idempotent' ? { idempotent: true } : {}),
      });
      return true;
    }
    const map = { '/api/actions/resume-mission': ['resume', 200], '/api/actions/request-review': ['requestReview', 202], '/api/actions/cancel-review': ['cancelReview', 200] };
    const target = map[url.pathname];
    if (!target) return false;
    const result = await actions[target[0]](target[0] === 'requestReview' ? await readJson(request) : target[0] === 'resume' ? await readJson(request) : undefined);
    if (result.status === 'conflict') { json(response, 409, { error: '状态已变更，请刷新后重试。', code: 'STATE_VERSION_CONFLICT', retryable: true }); return true; }
    const payload = { state: result.state, ...(target[0] === 'requestReview' ? { review: result.state.decisionReview } : target[0] === 'cancelReview' ? { review: result.state.decisionReview } : {}), ...(result.status === 'skipped_idempotent' ? { idempotent: true } : {}) };
    json(response, target[1], payload);
    return true;
  };
};
