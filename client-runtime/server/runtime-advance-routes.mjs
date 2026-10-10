export const createRuntimeAdvanceRoutes = ({ json, advanceRuntime }) => async ({ request, response, url }) => {
  if (request.method !== 'POST' || url.pathname !== '/api/runtime/advance') return false;
  json(response, 200, { state: await advanceRuntime() });
  return true;
};
