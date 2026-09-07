export function createExperienceRoutes({ json, readJson, experiences } = {}) {
  if (typeof json !== 'function' || typeof readJson !== 'function' || !experiences) throw new TypeError('Experience routes require HTTP helpers and an application service.');
  return async ({ request, response, url }) => {
    const match = /^\/api\/projects\/([^/]+)\/experiences(?:\/([^/]+))?$/.exec(url.pathname);
    if (!match) return false;
    const projectId = decodeURIComponent(match[1]);
    const id = match[2] ? decodeURIComponent(match[2]) : null;
    let outcome;
    if (request.method === 'GET') {
      const version = url.searchParams?.get('version');
      outcome = id ? await experiences.get(projectId, id, version === null || version === undefined ? {} : { version: Number(version) }) : await experiences.list(projectId);
    } else if (request.method === 'POST' && !id) {
      outcome = await experiences.create(projectId, await readJson(request));
    } else if (request.method === 'PATCH' && id) {
      outcome = await experiences.update(projectId, id, await readJson(request));
    } else return false;
    json(response, outcome.statusCode, outcome.payload);
    return true;
  };
}
