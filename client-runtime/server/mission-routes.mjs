export const createMissionRoutes = ({ json, readJson, missions }) => {
  if (typeof json !== 'function' || typeof readJson !== 'function' || !missions) {
    throw new TypeError('Mission routes require json, readJson, and missions dependencies.');
  }

  return async ({ request, response, url }) => {
    if (request.method === 'POST' && url.pathname === '/api/mission-drafts') {
      json(response, 200, await missions.saveDraft(await readJson(request)));
      return true;
    }
    const draftMatch = url.pathname.match(/^\/api\/mission-drafts\/([^/]+)$/u);
    if (request.method === 'GET' && draftMatch) {
      json(response, 200, await missions.getDraft(decodeURIComponent(draftMatch[1])));
      return true;
    }
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
