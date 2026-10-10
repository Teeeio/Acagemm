const writeConflict = (json, response) => {
  json(response, 409, { error: '状态已变更，请刷新后重试。', code: 'STATE_VERSION_CONFLICT', retryable: true });
};

export const createCandidateValidationRoutes = ({ json, readJson, workflow }) => {
  if (typeof json !== 'function' || typeof readJson !== 'function' || !workflow) throw new TypeError('Candidate validation routes require json, readJson, and workflow dependencies.');
  return async ({ request, response, url }) => {
    const pendingMatch = url.pathname.match(/^\/api\/missions\/([^/]+)\/pending-candidate$/);
    if (request.method === 'GET' && pendingMatch) {
      json(response, 200, await workflow.getPendingCandidate(decodeURIComponent(pendingMatch[1])));
      return true;
    }
    const bestMatch = url.pathname.match(/^\/api\/missions\/([^/]+)\/best-candidate$/);
    if (request.method === 'GET' && bestMatch) {
      json(response, 200, await workflow.getBestCandidate(decodeURIComponent(bestMatch[1])));
      return true;
    }
    if (request.method !== 'POST') return false;
    const newAttempt = url.pathname.match(/^\/api\/missions\/([^/]+)\/pending-candidate\/new-attempt$/);
    if (newAttempt) {
      const result = await workflow.newPendingAttempt(decodeURIComponent(newAttempt[1]), await readJson(request));
      if (result.status === 'conflict') { writeConflict(json, response); return true; }
      json(response, 201, { state: result.state, ...result.result,
        ...(result.status === 'skipped_idempotent' ? { idempotent: true } : {}) });
      return true;
    }
    const feedbackMatch = url.pathname.match(/^\/api\/missions\/([^/]+)\/pending-candidate\/(settle|continue)$/);
    if (feedbackMatch) {
      const continuing = feedbackMatch[2] === 'continue';
      const result = await workflow[continuing ? 'continuePendingCandidate' : 'settlePendingCandidate'](decodeURIComponent(feedbackMatch[1]), await readJson(request));
      if (result.status === 'conflict') { writeConflict(json, response); return true; }
      json(response, continuing ? 202 : 200, { state: result.state, ...result.result,
        ...(result.status === 'skipped_idempotent' ? { idempotent: true } : {}) });
      return true;
    }
    const submitPendingMatch = url.pathname.match(/^\/api\/missions\/([^/]+)\/pending-candidate\/submit$/);
    if (submitPendingMatch) {
      const result = await workflow.submitPendingCandidate(decodeURIComponent(submitPendingMatch[1]), await readJson(request));
      if (result.status === 'conflict') { writeConflict(json, response); return true; }
      json(response, 202, { state: result.state, runId: result.result?.runId, taskId: result.result?.taskId,
        ...(result.status === 'skipped_idempotent' ? { idempotent: true } : {}) });
      return true;
    }
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
