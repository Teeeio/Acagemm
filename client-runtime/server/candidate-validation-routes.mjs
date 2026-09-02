const writeConflict = (json, response) => {
  json(response, 409, { error: '状态已变更，请刷新后重试。', code: 'STATE_VERSION_CONFLICT', retryable: true });
};

export const createCandidateValidationRoutes = ({ json, readJson, workflow }) => {
  if (typeof json !== 'function' || typeof readJson !== 'function' || !workflow) throw new TypeError('Candidate validation routes require json, readJson, and workflow dependencies.');
  return async ({ request, response, url }) => {
    if (request.method !== 'POST') return false;
    if (url.pathname === '/api/actions/apply-patch') {
      const result = await workflow.applyPatch(await readJson(request));
      if (result.status === 'conflict') { writeConflict(json, response); return true; }
      json(response, 200, { state: result.state, workspace: result.result?.workspace, policyChecks: result.result?.policyChecks, ...(result.status === 'skipped_idempotent' ? { idempotent: true } : {}) });
      return true;
    }
    if (url.pathname === '/api/actions/start-benchmark') {
      const outcome = await workflow.startBenchmark(await readJson(request));
      if (outcome.payload) { json(response, outcome.statusCode, outcome.payload); return true; }
      const result = outcome.result;
      if (result.status === 'conflict') { writeConflict(json, response); return true; }
      json(response, 202, { state: result.state, runId: result.result?.runId, taskId: result.result?.taskId, ...(result.status === 'skipped_idempotent' ? { idempotent: true } : {}) });
      return true;
    }
    if (url.pathname === '/api/actions/rollback-stage') {
      const result = await workflow.rollbackStage();
      if (result.status === 'conflict') { writeConflict(json, response); return true; }
      json(response, 200, { state: result.state, recovery: result.result?.recovery, ...(result.status === 'skipped_idempotent' ? { idempotent: true } : {}) });
      return true;
    }
    return false;
  };
};
