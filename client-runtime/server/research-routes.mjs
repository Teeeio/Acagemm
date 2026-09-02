export const createResearchRoutes = ({ json, readJson, research }) => {
  if (typeof json !== 'function' || typeof readJson !== 'function' || !research) throw new TypeError('Research routes require json, readJson, and research dependencies.');
  return async ({ request, response, url }) => {
    const startMatch = url.pathname.match(/^\/api\/missions\/([^/]+)\/research$/);
    const cancelMatch = url.pathname.match(/^\/api\/missions\/([^/]+)\/research\/([^/]+)\/cancel$/);
    if (request.method === 'POST' && startMatch) {
      const result = await research.start(decodeURIComponent(startMatch[1]), await readJson(request));
      if (result.status === 'conflict') { json(response, 409, { error: '状态已变更，请刷新后重试。', code: 'STATE_VERSION_CONFLICT', retryable: true }); return true; }
      json(response, 202, { state: result.state, research: result.state.researchAgent, ...(result.status === 'skipped_idempotent' ? { idempotent: true } : {}) });
      return true;
    }
    if (request.method === 'POST' && cancelMatch) {
      json(response, 202, await research.cancel(decodeURIComponent(cancelMatch[1]), decodeURIComponent(cancelMatch[2])));
      return true;
    }
    return false;
  };
};
