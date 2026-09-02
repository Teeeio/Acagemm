export const createMissionQueryRoutes = ({ json, missionQuery, streamEvents }) => {
  if (typeof json !== 'function' || !missionQuery || typeof streamEvents !== 'function') {
    throw new TypeError('Mission query routes require json, missionQuery, and streamEvents dependencies.');
  }
  return async ({ request, response, url }) => {
    const selectMatch = url.pathname.match(/^\/api\/missions\/([^/]+)\/select$/);
    const eventsMatch = url.pathname.match(/^\/api\/missions\/([^/]+)\/events$/);
    const streamMatch = url.pathname.match(/^\/api\/missions\/([^/]+)\/events\/stream$/);
    const notesMatch = url.pathname.match(/^\/api\/missions\/([^/]+)\/research\/notes$/);
    if (request.method === 'POST' && selectMatch) {
      json(response, 200, await missionQuery.select(decodeURIComponent(selectMatch[1])));
      return true;
    }
    if (request.method === 'GET' && eventsMatch) {
      json(response, 200, await missionQuery.events(decodeURIComponent(eventsMatch[1]), Number(url.searchParams.get('after') || 0)));
      return true;
    }
    if (request.method === 'GET' && notesMatch) {
      json(response, 200, await missionQuery.researchNotes(decodeURIComponent(notesMatch[1])));
      return true;
    }
    if (request.method === 'GET' && streamMatch) {
      await streamEvents(request, response, decodeURIComponent(streamMatch[1]), Number(url.searchParams.get('after') || 0));
      return true;
    }
    return false;
  };
};
