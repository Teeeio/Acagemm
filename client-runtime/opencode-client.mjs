const normalizeBaseUrl = (value) => String(value || 'http://127.0.0.1:4096').replace(/\/+$/, '');

const parseResponse = async (response) => {
  if (response.status === 204) return null;
  const text = await response.text();
  if (!response.ok) {
    const error = new Error(text || `OpenCode request failed with HTTP ${response.status}`);
    error.status = response.status;
    error.code = 'OPENCODE_REQUEST_FAILED';
    throw error;
  }
  if (!text) return null;
  try { return JSON.parse(text); } catch { return text; }
};

export const parseOpenCodeModel = (value) => {
  const model = String(value || '').trim();
  const separator = model.indexOf('/');
  if (separator <= 0 || separator === model.length - 1) return null;
  return { providerID: model.slice(0, separator), modelID: model.slice(separator + 1) };
};

export function createOpenCodeClient(options = {}) {
  const baseUrl = normalizeBaseUrl(options.baseUrl || process.env.OPENCODE_SERVER_URL);
  const fetchImpl = options.fetchImpl || fetch;
  const username = options.username || process.env.OPENCODE_SERVER_USERNAME || 'opencode';
  const password = options.password ?? process.env.OPENCODE_SERVER_PASSWORD;

  const request = async (pathname, init = {}) => {
    const headers = { Accept: 'application/json', ...(init.body ? { 'Content-Type': 'application/json' } : {}), ...(init.headers || {}) };
    if (password) headers.Authorization = `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;
    const response = await fetchImpl(`${baseUrl}${pathname}`, { ...init, headers, signal: init.signal || AbortSignal.timeout(8_000) });
    return parseResponse(response);
  };

  return {
    baseUrl,
    health: () => request('/global/health'),
    providers: () => request('/provider'),
    createSession: (title) => request('/session', { method: 'POST', body: JSON.stringify({ title }) }),
    promptAsync: (sessionId, { text, agent = 'plan', model, tools }) => {
      const body = { agent, parts: [{ type: 'text', text }] };
      const parsedModel = typeof model === 'string' ? parseOpenCodeModel(model) : model;
      if (parsedModel) body.model = parsedModel;
      if (tools) body.tools = tools;
      return request(`/session/${encodeURIComponent(sessionId)}/prompt_async`, { method: 'POST', body: JSON.stringify(body) });
    },
    sessionStatus: () => request('/session/status'),
    messages: (sessionId, limit = 50) => request(`/session/${encodeURIComponent(sessionId)}/message?limit=${limit}`),
    diff: (sessionId) => request(`/session/${encodeURIComponent(sessionId)}/diff`),
    abort: (sessionId) => request(`/session/${encodeURIComponent(sessionId)}/abort`, { method: 'POST', body: '{}' }),
  };
}

export const opencodeClient = createOpenCodeClient();
