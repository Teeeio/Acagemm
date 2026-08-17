import http from 'node:http';
import https from 'node:https';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const remoteError = (message, code = 'OPERATOR_TEST_SERVICE_ERROR', status = 500) => {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  return error;
};

/**
 * operator-iteration-platform 远程 API 客户端。
 *
 * 传输层使用 node:https / node:http 而非全局 fetch：Node v20 的 fetch 无法注入自定义 TLS agent，
 * 而远程服务使用自签名证书（需 rejectUnauthorized:false，由 OPERATOR_TLS_ALLOW_SELF_SIGNED 门控）。
 * 支持 token 缓存与 401 刷新、GET 幂等请求的指数退避重试。
 */
export const createRemoteApiClient = ({
  baseUrl = process.env.OPERATOR_API_BASE_URL || 'https://frp-act.com:61110',
  username = process.env.OPERATOR_API_USERNAME || 'demo_admin',
  password = process.env.OPERATOR_API_PASSWORD || 'demo123',
  systemId = process.env.OPERATOR_API_SYSTEM_ID || 'system-demo',
  tlsAllowSelfSigned = process.env.OPERATOR_TLS_ALLOW_SELF_SIGNED !== '0',
  timeoutMs = 10_000,
} = {}) => {
  let token = null;
  let tokenExpiresAt = 0;

  const requestJson = async (method, path, { body, headers = {}, retries = 2 } = {}) => {
    const attempt = async (remaining) => {
      let resolve;
      let reject;
      const promise = new Promise((res, rej) => { resolve = res; reject = rej; });

      const payload = body === undefined ? undefined : JSON.stringify(body);
      const url = new URL(path, baseUrl);
      const transport = url.protocol === 'https:' ? https : http;
      const requestOptions = {
        method,
        hostname: url.hostname,
        port: url.port || (url.protocol === 'https:' ? 443 : 80),
        path: `${url.pathname}${url.search}`,
        headers: {
          'Content-Type': 'application/json',
          ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
          ...headers,
        },
        ...(url.protocol === 'https:' && tlsAllowSelfSigned ? { agent: new https.Agent({ rejectUnauthorized: false }) } : {}),
      };

      const request = transport.request(requestOptions, (response) => {
        const chunks = [];
        response.on('data', (chunk) => chunks.push(chunk));
        response.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let parsed = {};
          try { parsed = text ? JSON.parse(text) : {}; } catch { /* non-JSON error body */ }
          if (response.statusCode >= 200 && response.statusCode < 300) {
            resolve(parsed);
            return;
          }
          if (response.statusCode === 401 && remaining > 0) {
            // 令牌失效：刷新一次后重试
            refreshToken().then(() => attempt(0), reject);
            return;
          }
          const retryable = remaining > 0 && (response.statusCode === 429 || response.statusCode >= 500);
          if (retryable) {
            setTimeout(() => attempt(remaining - 1).then(resolve, reject), 250 * (3 - remaining));
            return;
          }
          if (response.statusCode === 404) {
            reject(remoteError(parsed.error || 'remote operator test job not found', 'OPERATOR_TEST_NOT_FOUND', 404));
            return;
          }
          reject(remoteError(parsed.error || `remote API returned ${response.statusCode}`, 'OPERATOR_TEST_SERVICE_ERROR', response.statusCode));
        });
      });
      request.setTimeout(timeoutMs, () => request.destroy(remoteError('remote API request timed out', 'REMOTE_TIMEOUT', 504)));
      request.on('error', (error) => {
        if (remaining > 0) {
          setTimeout(() => attempt(remaining - 1).then(resolve, reject), 250 * (3 - remaining));
          return;
        }
        reject(remoteError(`remote API unreachable: ${error.message}`, 'REMOTE_UNREACHABLE', 502));
      });
      if (payload) request.write(payload);
      request.end();
      return promise;
    };
    return attempt(retries);
  };

  const refreshToken = async () => {
    const result = await requestJson('POST', '/api/v1/auth/login', {
      body: { username, password },
      retries: 1,
    });
    if (!result.access_token) throw remoteError('remote login returned no access_token', 'AUTH_FAILED', 401);
    token = result.access_token;
    const expiresIn = Number(result.expires_in || 86400);
    tokenExpiresAt = Date.now() + expiresIn * 1000 - 5 * 60_000; // 提前 5 分钟过期
    return token;
  };

  const ensureToken = async () => {
    if (token && Date.now() < tokenExpiresAt) return token;
    return refreshToken();
  };

  const authedJson = async (method, path, { body, headers = {} } = {}) => {
    const bearer = await ensureToken();
    return requestJson(method, path, { body, headers: { ...headers, Authorization: `Bearer ${bearer}` } });
  };

  const listPlatforms = () => authedJson('GET', '/api/v1/test-platforms');
  const submitJob = (body, idempotencyKey) => authedJson('POST', '/api/v1/test-jobs', {
    body,
    headers: { 'Idempotency-Key': idempotencyKey },
  });
  const getJob = (id) => authedJson('GET', `/api/v1/test-jobs/${encodeURIComponent(id)}?system_id=${encodeURIComponent(systemId)}`);

  return {
    baseUrl,
    systemId,
    login: refreshToken,
    listPlatforms,
    submitJob,
    getJob,
    /** 启动时非致命探测：记录目标平台在线状态 */
    warmup: async () => {
      try {
        const platforms = await listPlatforms();
        const online = (platforms.items || []).filter((item) => item.status === 'available');
        console.log(`[remote-adapter] remote platform check: ${online.length}/${(platforms.items || []).length} available (${online.map((item) => item.platform_id).join(', ') || 'none'})`);
        return platforms;
      } catch (error) {
        console.warn(`[remote-adapter] warmup platform check failed (${error.code || error.message}); remote calls will retry at request time.`);
        return null;
      }
    },
  };
};
