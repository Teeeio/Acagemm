export const createSystemRoutes = ({ json, describeRuntime, testBackend }) => {
  if (typeof json !== 'function' || typeof describeRuntime !== 'function') {
    throw new TypeError('System routes require json and describeRuntime dependencies.');
  }

  return async ({ request, response, url }) => {
    if (request.method === 'OPTIONS') {
      response.writeHead(204, { Allow: 'GET,POST,PATCH,DELETE,OPTIONS' });
      response.end();
      return true;
    }
    if (request.method === 'GET' && url.pathname === '/api/health') {
      json(response, 200, {
        status: 'ok',
        service: 'operator-studio-client-runtime',
        persistence: 'local-disk',
        runtime: await describeRuntime(),
        testBackend,
        time: new Date().toISOString(),
      });
      return true;
    }
    if (request.method === 'GET' && url.pathname === '/api/runtime') {
      json(response, 200, { runtime: await describeRuntime(), testBackend });
      return true;
    }
    return false;
  };
};
