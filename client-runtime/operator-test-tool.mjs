import { canonicalJson } from './execution-package-contract.mjs';

const fail = (code, message, details = {}) => Object.assign(new Error(message), { code, status: 409, retryable: false, details });
// One port over a local or remote queue, never a second scheduler. Methods return
// task identities/snapshots; they do not await whole correctness/benchmark runs.
export const createOperatorTestTool = ({ backend, packages, requestTimeoutMs = 5000 } = {}) => {
  for (const method of ['capabilities', 'submit', 'get', 'cancel', 'findByRequestId']) {
    if (typeof backend?.[method] !== 'function') throw new TypeError('Test backend requires ' + method + '().');
  }
  if (typeof packages?.verifyAdmission !== 'function' || typeof packages?.prepare !== 'function') throw new TypeError('Test tool requires a trusted package admission port.');
  if (!Number.isFinite(requestTimeoutMs) || requestTimeoutMs <= 0) throw new TypeError('Test tool request timeout must be positive and finite.');
  const call = async (method, args) => {
    const controller = new AbortController();
    let timer;
    try {
      return await Promise.race([
        Promise.resolve().then(() => backend[method](...args, { signal: controller.signal, timeoutMs: requestTimeoutMs })),
        new Promise((_, reject) => {
          timer = setTimeout(() => {
            const error = fail('TEST_TOOL_REQUEST_TIMEOUT', 'Test backend request exceeded its deadline; reconcile by stable task/request identity before retry.', { operation: method, executionUncertain: ['submit', 'cancel'].includes(method), timeoutMs: requestTimeoutMs });
            controller.abort(error);
            reject(error);
          }, requestTimeoutMs);
        }),
      ]);
    } finally { clearTimeout(timer); }
  };
  const capabilities = async () => {
    const value = await call('capabilities', []);
    if (!value?.backendId || value.queryIsReadOnly !== true || value.idempotentSubmission !== true
      || !Array.isArray(value.targets) || !Array.isArray(value.adapters)) throw fail('TEST_BACKEND_CONTRACT_INVALID', 'Backend must declare read-only queries, idempotent submissions, targets and language adapters.');
    return structuredClone(value);
  };
  const submit = async (request) => {
    const { manifest, admission } = await packages.verifyAdmission(request);
    const caps = await capabilities();
    if (!caps.targets.some((target) => canonicalJson(target) === canonicalJson(manifest.target))
      || !caps.adapters.some((adapter) => canonicalJson(adapter) === canonicalJson(manifest.adapter))) throw fail('TEST_BACKEND_TARGET_UNSUPPORTED', 'Backend does not support the admitted target and adapter.');
    const snapshot = await call('submit', [{ ...structuredClone(request), preparedArtifactDigest: admission.preparedArtifactDigest }]);
    if (!snapshot?.taskId || !['waiting', 'queued', 'running', 'completed', 'failed', 'cancelled'].includes(snapshot.status)) throw fail('TEST_BACKEND_RESULT_INVALID', 'Backend returned an invalid task identity; reconcile the request before resubmission.', { requestId: request.requestId, executionUncertain: true });
    return snapshot;
  };
  return Object.freeze({
    capabilities, submit,
    prepare: (...args) => packages.prepare(...args),
    ...(typeof backend.advance === 'function' ? { advance: (taskId) => call('advance', [taskId]) } : {}),
    get: (taskId) => call('get', [taskId]),
    cancel: (taskId) => call('cancel', [taskId]),
    findByRequestId: (requestId, missionId, expectedPayload) => call('findByRequestId', [requestId, missionId, expectedPayload]),
  });
};
