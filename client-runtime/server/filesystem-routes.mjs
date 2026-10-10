export const createFilesystemRoutes = ({ json, readJson, filesystem }) => {
  if (typeof json !== 'function' || typeof readJson !== 'function' || !filesystem) {
    throw new TypeError('Filesystem routes require json, readJson, and filesystem dependencies.');
  }

  return async ({ request, response, url }) => {
    if (request.method === 'GET' && url.pathname === '/api/filesystem/directories') {
      json(response, 200, { directory: await filesystem.list(url.searchParams.get('path') || '') });
      return true;
    }
    if (request.method === 'POST' && url.pathname === '/api/filesystem/select-directory') {
      const body = await readJson(request);
      json(response, 200, await filesystem.select(body.initialPath));
      return true;
    }
    if (request.method === 'POST' && url.pathname === '/api/filesystem/directories') {
      const body = await readJson(request);
      json(response, 201, { directory: await filesystem.create(body) });
      return true;
    }
    return false;
  };
};
