const conflict = (json, response) => {
  json(response, 409, { error: '状态已变更，请刷新后重试。', code: 'STATE_VERSION_CONFLICT', retryable: true });
};

export const createDecisionRoutes = ({ json, readJson, decisions }) => {
  if (typeof json !== 'function' || typeof readJson !== 'function' || !decisions) throw new TypeError('Decision routes require json, readJson, and decisions dependencies.');
  return async ({ request, response, url }) => {
    if (request.method !== 'POST') return false;
    if (url.pathname === '/api/actions/adopt') {
      const result = await decisions.adopt(await readJson(request));
      if (result.status === 'conflict') { conflict(json, response); return true; }
      json(response, 200, { state: result.state, maintenance: result.state.knowledgeMaintenance, ...(result.status === 'skipped_idempotent' ? { idempotent: true } : {}) });
      return true;
    }
    if (url.pathname === '/api/actions/reject') {
      const result = await decisions.reject();
      if (result.status === 'conflict') { conflict(json, response); return true; }
      json(response, 200, { state: result.state, ...(result.status === 'skipped_idempotent' ? { idempotent: true } : {}) });
      return true;
    }
    if (url.pathname === '/api/actions/revert-adoption') {
      const result = await decisions.revertAdoption();
      if (result.status === 'conflict') { conflict(json, response); return true; }
      json(response, 200, { state: result.state, recovery: result.result?.recovery, repositoryRevert: result.result?.repositoryRevert, ...(result.status === 'skipped_idempotent' ? { idempotent: true } : {}) });
      return true;
    }
    return false;
  };
};
