export const createIterationTraceRoutes = ({ json, traces }) => async ({ request, response, url }) => {
  const evaluation = url.pathname.match(/^\/api\/missions\/([^/]+)\/evaluation(\/export)?$/);
  if (request.method === 'GET' && evaluation) {
    json(response, 200, await traces.evaluate(decodeURIComponent(evaluation[1]), { includeRecords: Boolean(evaluation[2]) }));
    return true;
  }
  const match = url.pathname.match(/^\/api\/missions\/([^/]+)\/traces$/);
  if (request.method !== 'GET' || !match) return false;
  json(response, 200, await traces.query(decodeURIComponent(match[1]), {
    kind: url.searchParams.get('kind'),
    view: url.searchParams.get('view') || 'latest',
    limit: url.searchParams.has('limit') ? Number(url.searchParams.get('limit')) : 100,
    cursor: url.searchParams.get('cursor'),
  }));
  return true;
};
