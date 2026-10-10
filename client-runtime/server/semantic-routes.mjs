export const createSemanticRoutes = ({ json, readJson, semantic }) => {
  if (typeof json !== 'function' || typeof readJson !== 'function' || !semantic) throw new TypeError('Semantic routes require json, readJson, and semantic dependencies.');
  return async ({ request, response, url }) => {
    const match = url.pathname.match(/^\/api\/missions\/([^/]+)\/semantic\/freeze$/);
    if (request.method !== 'POST' || !match) return false;
    try {
      json(response, 200, await semantic.freeze(decodeURIComponent(match[1]), await readJson(request)));
    } catch (error) {
      json(response, error.status || 409, { error: error.message, code: error.code || 'SEMANTIC_FREEZE_BLOCKED', issues: error.issues || [] });
    }
    return true;
  };
};
