const defaultTestServiceUrl = process.env.OPERATOR_TEST_SERVICE_URL || `http://127.0.0.1:${process.env.TEST_SERVICE_PORT || 4180}`;

const requestJson = async (url, options = {}) => {
  const response = await fetch(url, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
  });
  let payload = {};
  try { payload = await response.json(); } catch { /* service may return an empty error body */ }
  if (!response.ok) {
    const error = new Error(payload.error || `Operator test service returned ${response.status}`);
    error.status = response.status;
    error.code = payload.code || 'OPERATOR_TEST_SERVICE_ERROR';
    throw error;
  }
  return payload;
};

export const createTestServiceClient = (baseUrl = defaultTestServiceUrl) => ({
  submit: (task) => requestJson(`${baseUrl}/v1/operator-tests`, { method: 'POST', body: JSON.stringify(task) }),
  get: (taskId) => requestJson(`${baseUrl}/v1/operator-tests/${encodeURIComponent(taskId)}`),
  events: (taskId) => requestJson(`${baseUrl}/v1/operator-tests/${encodeURIComponent(taskId)}/events`),
  cancel: (taskId) => requestJson(`${baseUrl}/v1/operator-tests/${encodeURIComponent(taskId)}/cancel`, { method: 'POST', body: '{}' }),
});

export const testServiceClient = createTestServiceClient();
