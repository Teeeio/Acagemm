export const createRuntimeQueryRoutes = ({ json, runtimeQuery }) => {
  if (typeof json !== 'function' || !runtimeQuery) {
    throw new TypeError('Runtime query routes require json and runtimeQuery dependencies.');
  }
  return async ({ request, response, url }) => {
    if (request.method === 'GET' && url.pathname === '/api/runtime/preflight') {
      const outcome = await runtimeQuery.preflight(url.searchParams.get('missionId'));
      json(response, outcome.statusCode, outcome.payload);
      return true;
    }
    if (request.method === 'GET' && url.pathname === '/api/state') {
      json(response, 200, await runtimeQuery.getState());
      return true;
    }
    if (request.method === 'GET' && url.pathname === '/api/workspace') {
      json(response, 200, await runtimeQuery.workspace());
      return true;
    }
    return false;
  };
};
