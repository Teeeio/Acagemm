export const createMissionRoutes = ({ json, readJson, missions }) => {
  if (typeof json !== 'function' || typeof readJson !== 'function' || !missions) {
    throw new TypeError('Mission routes require json, readJson, and missions dependencies.');
  }

  return async ({ request, response, url }) => {
    if (request.method === 'GET' && url.pathname === '/api/missions') {
      json(response, 200, await missions.list());
      return true;
    }
    if (request.method === 'POST' && url.pathname === '/api/missions') {
      json(response, 201, await missions.create(await readJson(request)));
      return true;
    }
    return false;
  };
};
