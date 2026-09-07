const defaultTestServiceUrl = process.env.OPERATOR_TEST_SERVICE_URL || `http://127.0.0.1:${process.env.TEST_SERVICE_PORT || 4180}`;

const assertTimeout = (timeoutMs) => {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 120000) throw new TypeError('timeoutMs must be positive, finite, and no greater than 120000');
  return timeoutMs;
};

const requestJson = async (url, options, { fetchImpl, defaultTimeoutMs }, { signal, timeoutMs = defaultTimeoutMs } = {}) => {
  assertTimeout(timeoutMs);
  if (signal != null && (typeof signal.aborted !== 'boolean' || typeof signal.addEventListener !== 'function' || typeof signal.removeEventListener !== 'function')) throw new TypeError('signal must be an AbortSignal');
  const controller = new AbortController();
  const knownErrors = new Set();
  let attempted = false;
  let abortError;
  const error = (code, message, status, cause) => {
    const result = Object.assign(new Error(message), { code, status, retryable: false, effectUnknown: attempted && options.method === 'POST', ...(cause === undefined ? {} : { cause }) });
    knownErrors.add(result);
    return result;
  };
  const abort = (reason) => {
    if (controller.signal.aborted) return;
    abortError = reason;
    controller.abort(reason);
  };
  const onCallerAbort = () => abort(error('OPERATOR_TEST_SERVICE_ABORTED', 'Operator test service request was cancelled by its caller.', 499, signal.reason));
  const onTimeout = () => abort(error('OPERATOR_TEST_SERVICE_TIMEOUT', 'Operator test service request exceeded its transport deadline.', 504));
  if (signal?.aborted) onCallerAbort();
  else signal?.addEventListener('abort', onCallerAbort, { once: true });
  const startedAt = performance.now();
  const timer = setTimeout(onTimeout, timeoutMs);
  try {
    if (controller.signal.aborted) throw abortError;
    attempted = true;
    const response = await fetchImpl(url, {
      ...options,
      redirect: 'error',
      signal: controller.signal,
      headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    });
    // Keep the same abort signal and deadline active until the entire body is read.
    const body = await response.text();
    if (performance.now() - startedAt >= timeoutMs) onTimeout();
    if (controller.signal.aborted) throw abortError;
    let payload;
    if (!body.trim() && !response.ok) payload = {}; // Preserve empty HTTP error responses.
    else {
      try { payload = JSON.parse(body); }
      catch (cause) { throw error('OPERATOR_TEST_SERVICE_JSON_INVALID', 'Operator test service returned invalid JSON.', 502, cause); }
    }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)
      || (payload.error != null && typeof payload.error !== 'string')
      || (payload.code != null && typeof payload.code !== 'string')) {
      throw error('OPERATOR_TEST_SERVICE_JSON_INVALID', 'Operator test service returned an invalid JSON response envelope.', 502);
    }
    if (!response.ok) throw error(payload.code || 'OPERATOR_TEST_SERVICE_ERROR', payload.error || `Operator test service returned ${response.status}`, response.status);
    return payload;
  } catch (cause) {
    if (abortError) throw abortError;
    if (knownErrors.has(cause)) throw cause;
    throw error('OPERATOR_TEST_SERVICE_UNAVAILABLE', 'Operator test service transport failed; no automatic retry was attempted.', 502, cause);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onCallerAbort);
  }
};

export const createTestServiceClient = (baseUrl = defaultTestServiceUrl, { timeoutMs = 5000, fetchImpl = globalThis.fetch } = {}) => {
  assertTimeout(timeoutMs);
  if (typeof fetchImpl !== 'function') throw new TypeError('fetchImpl must be a fetch-compatible function');
  const ports = { fetchImpl, defaultTimeoutMs: timeoutMs };
  return {
    submit: (task, options) => requestJson(`${baseUrl}/v1/operator-tests`, { method: 'POST', body: JSON.stringify(task) }, ports, options),
    get: (taskId, options) => requestJson(`${baseUrl}/v1/operator-tests/${encodeURIComponent(taskId)}`, {}, ports, options),
    events: (taskId, options) => requestJson(`${baseUrl}/v1/operator-tests/${encodeURIComponent(taskId)}/events`, {}, ports, options),
    cancel: (taskId, options) => requestJson(`${baseUrl}/v1/operator-tests/${encodeURIComponent(taskId)}/cancel`, { method: 'POST', body: '{}' }, ports, options),
  };
};

export const testServiceClient = createTestServiceClient();
