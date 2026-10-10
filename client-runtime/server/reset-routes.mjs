export const createResetRoutes = ({ json, reset }) => {
  if (typeof json !== 'function' || !reset) {
    throw new TypeError('Reset routes require json and reset dependencies.');
  }

  return async ({ request, response, url }) => {
    if (request.method !== 'POST' || url.pathname !== '/api/reset') return false;
    json(response, 200, await reset.reset());
    return true;
  };
};
