export const createRuntimeStateRoutes = ({ json, readJson, runtimeState }) => {
  if (typeof json !== 'function' || typeof readJson !== 'function' || !runtimeState) throw new TypeError('Runtime state routes require json, readJson, and runtimeState dependencies.');
  return async ({ request, response, url }) => {
    if (request.method !== 'PATCH' || url.pathname !== '/api/state') return false;
    const outcome = await runtimeState.patch(await readJson(request));
    json(response, outcome.statusCode, outcome.payload);
    return true;
  };
};
