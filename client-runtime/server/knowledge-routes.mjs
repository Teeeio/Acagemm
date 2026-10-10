export const createKnowledgeRoutes = ({ json, readJson, knowledge }) => {
  if (typeof json !== 'function' || typeof readJson !== 'function' || !knowledge) throw new TypeError('Knowledge routes require json, readJson, and knowledge dependencies.');
  return async ({ request, response, url }) => {
    if (request.method === 'PATCH' && url.pathname.startsWith('/api/knowledge/drafts/')) {
      const outcome = await knowledge.patchDraft(decodeURIComponent(url.pathname.slice('/api/knowledge/drafts/'.length)), await readJson(request));
      json(response, outcome.statusCode, outcome.payload || { state: outcome.state });
      return true;
    }
    if (request.method === 'POST' && (url.pathname === '/api/knowledge/publish' || url.pathname === '/api/knowledge/publish-all')) {
      const outcome = knowledge.retiredPublish(url.pathname.endsWith('publish-all'));
      json(response, outcome.statusCode, outcome.payload);
      return true;
    }
    if (request.method === 'POST' && url.pathname === '/api/knowledge/references') {
      const outcome = await knowledge.addReference(await readJson(request));
      json(response, outcome.statusCode, outcome.payload || { state: outcome.state, reference: outcome.reference });
      return true;
    }
    return false;
  };
};
