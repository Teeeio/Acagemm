export const createOperatorTestRoutes = ({ json, operatorTests }) => {
  if (typeof json !== 'function' || !operatorTests) throw new TypeError('Operator test routes require json and operatorTests dependencies.');
  return async ({ request, response, url }) => {
    if (request.method === 'GET' && url.pathname === '/api/operator-tests') {
      json(response, 200, await operatorTests.list());
      return true;
    }
    const cancelMatch = url.pathname.match(/^\/api\/operator-tests\/([^/]+)\/cancel$/);
    if (request.method === 'POST' && cancelMatch) {
      json(response, 200, { task: await operatorTests.cancel(decodeURIComponent(cancelMatch[1])) });
      return true;
    }
    const taskMatch = url.pathname.match(/^\/api\/operator-tests\/([^/]+)$/);
    if (request.method === 'GET' && taskMatch) {
      json(response, 200, { task: await operatorTests.get(decodeURIComponent(taskMatch[1])) });
      return true;
    }
    return false;
  };
};
