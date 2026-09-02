const decodeId = (match) => decodeURIComponent(match[1]);

export const createProjectRoutes = ({ json, readJson, projects }) => {
  if (typeof json !== 'function' || typeof readJson !== 'function' || !projects) {
    throw new TypeError('Project routes require json, readJson, and projects dependencies.');
  }

  return async ({ request, response, url }) => {
    if (request.method === 'GET' && url.pathname === '/api/projects') {
      json(response, 200, await projects.list());
      return true;
    }
    if (request.method === 'POST' && url.pathname === '/api/projects') {
      json(response, 201, await projects.create(await readJson(request)));
      return true;
    }

    const projectMatch = url.pathname.match(/^\/api\/projects\/([^/]+)$/);
    const selectMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/select$/);
    const sourcesMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/sources$/);
    const bootstrapMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/bootstrap$/);
    const reinitializeMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/reinitialize$/);

    if (request.method === 'POST' && bootstrapMatch) {
      json(response, 200, await projects.bootstrap(decodeId(bootstrapMatch), await readJson(request)));
      return true;
    }
    if (request.method === 'POST' && reinitializeMatch) {
      json(response, 200, await projects.reinitialize(decodeId(reinitializeMatch)));
      return true;
    }
    if (request.method === 'GET' && sourcesMatch) {
      json(response, 200, await projects.sources(decodeId(sourcesMatch)));
      return true;
    }
    if (request.method === 'POST' && selectMatch) {
      json(response, 200, await projects.select(decodeId(selectMatch)));
      return true;
    }
    if (request.method === 'PATCH' && projectMatch) {
      json(response, 200, await projects.update(decodeId(projectMatch), await readJson(request)));
      return true;
    }
    if (request.method === 'DELETE' && projectMatch) {
      json(response, 200, await projects.remove(decodeId(projectMatch)));
      return true;
    }
    return false;
  };
};
