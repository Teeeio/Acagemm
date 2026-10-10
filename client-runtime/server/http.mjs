import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';

const defaultMimeTypes = Object.freeze({
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.json': 'application/json; charset=utf-8',
});

const bodyPromises = new WeakMap();
const stoppedBodies = new WeakMap();
const bodyError = (code, message, status, cause) => Object.assign(new Error(message), { code, status, ...(cause === undefined ? {} : { cause }) });

// Do not destroy a live HTTP socket before its 408/413 response can be flushed.
// Pause input immediately; the JSON responder closes after finish. The fallback
// also bounds callers that fail to respond. Plain in-memory streams close now.
const stopBodyInput = (request) => {
  request.pause?.();
  const ignoreError = () => {};
  request.once('error', ignoreError);
  request.once('close', () => request.removeListener('error', ignoreError));
  const socket = request.socket;
  if (!socket || typeof socket.end !== 'function') { request.destroy?.(); return; }
  socket.pause?.();
  const state = { socket, timer: undefined };
  stoppedBodies.set(request, state);
  if (socket.destroyed) { request.destroy?.(); return; }
  state.timer = setTimeout(() => socket.destroy(), 1000);
  state.timer.unref?.();
  socket.once('close', () => {
    clearTimeout(state.timer);
    request.destroy?.();
  });
};

// Local browser trust is a transport boundary, not remote-user authentication.
// dev.mjs selects WEB_PORT (5173 by default) through WEB_PORT + 19; Vite's
// /api proxy preserves that Host and Origin. Never trust forwarded headers.
export const createLocalHttpRequestValidator = ({ port, serveWeb = true, webPort = 5173, runtimeInstance = null }) => {
  const validPort = (value) => Number.isInteger(value) && value > 0 && value <= 65535;
  if (!validPort(port) || (!serveWeb && !validPort(webPort))) throw new TypeError('Local HTTP trust requires valid listener and Web ports.');
  const ports = new Set([port]);
  if (!serveWeb) for (let offset = 0; offset < 20 && webPort + offset <= 65535; offset++) ports.add(webPort + offset);
  const authorities = new Set();
  const origins = new Set();
  for (const trustedPort of ports) for (const host of ['127.0.0.1', 'localhost', '[::1]']) {
    authorities.add(`${host}:${trustedPort}`);
    if (trustedPort === 80) authorities.add(host);
    origins.add(new URL(`http://${host}:${trustedPort}`).origin);
  }
  const headerCount = (request, name) => {
    let count = 0;
    for (let index = 0; index < (request.rawHeaders?.length || 0); index += 2) {
      if (request.rawHeaders[index].toLowerCase() === name) count++;
    }
    return count;
  };
  return (request) => {
    try {
      const host = request.headers.host;
      if (typeof host !== 'string' || headerCount(request, 'host') > 1
        || !/^(?:[a-z0-9.-]+|\[[a-f0-9:]+\])(?::[1-9][0-9]{0,4})?$/i.test(host)) {
        throw bodyError('REQUEST_HOST_INVALID', 'Request Host must be one valid local authority.', 400);
      }
      let base;
      try { base = new URL(`http://${host}/`); }
      catch { throw bodyError('REQUEST_HOST_INVALID', 'Request Host must be one valid local authority.', 400); }
      // Compare the literal authority, not a URL-normalized alias such as 127.1.
      if (!authorities.has(host.toLowerCase())) throw bodyError('REQUEST_HOST_UNTRUSTED', 'Request Host is not a trusted local endpoint.', 403);
      const target = request.url;
      if (typeof target !== 'string' || !target.startsWith('/') || target.startsWith('//') || /[\s\\#]/.test(target)) {
        throw bodyError('REQUEST_URL_INVALID', 'Request target must be a local absolute path.', 400);
      }
      let url;
      try { url = new URL(target, base); }
      catch { throw bodyError('REQUEST_URL_INVALID', 'Request target must be a local absolute path.', 400); }
      const instance=request.headers['x-operator-runtime-instance'];
      if(instance!==undefined&&(headerCount(request,'x-operator-runtime-instance')!==1
        ||typeof instance!=='string'||instance!==runtimeInstance)) {
        throw bodyError('RUNTIME_ATTACHMENT_CONFLICT','The request belongs to a different Runtime bootstrap.',409);
      }
      const origin = request.headers.origin;
      if (origin !== undefined) {
        if (typeof origin !== 'string' || headerCount(request, 'origin') > 1 || !origins.has(origin)) {
          throw bodyError('REQUEST_ORIGIN_UNTRUSTED', 'Request Origin is not a trusted local Web origin.', 403);
        }
      }
      const writesApi = url.pathname.startsWith('/api/') && !['GET', 'HEAD', 'OPTIONS'].includes(request.method);
      if (writesApi) {
        const site = request.headers['sec-fetch-site'];
        if (site === 'cross-site') throw bodyError('REQUEST_ORIGIN_UNTRUSTED', 'Cross-site browser writes are not allowed.', 403);
        if (site !== undefined && origin === undefined) throw bodyError('REQUEST_ORIGIN_REQUIRED', 'Browser writes require a trusted Origin.', 403);
        // Native TUI/CLI requests have no Origin and retain their existing body
        // contract. Browser writes must not use HTML form/simple-request types.
        if (origin !== undefined && (headerCount(request, 'content-type') > 1
          || String(request.headers['content-type'] || '').split(';', 1)[0].trim().toLowerCase() !== 'application/json')) {
          throw bodyError('REQUEST_CONTENT_TYPE_UNSUPPORTED', 'Browser API writes require application/json.', 415);
        }
      }
      return url;
    } catch (error) {
      // Refuse before body parsing or state locks, and close after the error is
      // flushed even when the caller never finishes sending its request body.
      stopBodyInput(request);
      throw error;
    }
  };
};

export const createJsonResponder = (bridge) => (response, status, payload) => {
  const stopped = response.req && stoppedBodies.get(response.req);
  if (stopped) {
    response.shouldKeepAlive = false;
    response.once?.('finish', () => {
      if (stopped.socket.destroyed) return;
      if (typeof stopped.socket.destroySoon === 'function') stopped.socket.destroySoon();
      else if (!stopped.socket.writableEnded) stopped.socket.end(() => stopped.socket.destroy());
    });
  }
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Operator-Studio-Bridge': `${bridge.pid}:${bridge.port}`,
    ...(stopped ? { Connection: 'close' } : {}),
  });
  response.end(JSON.stringify({ ...payload, __bridge: bridge }));
};

export const readJson = (request, { maxBytes = 1_000_000, timeoutMs = 5000 } = {}) => {
  if (bodyPromises.has(request)) return bodyPromises.get(request);
  const promise = new Promise((resolve, reject) => {
    if (!request || typeof request.on !== 'function' || typeof request.removeListener !== 'function') throw new TypeError('request must be a readable request stream');
    if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw new TypeError('maxBytes must be a positive safe integer');
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 120000) throw new TypeError('timeoutMs must be positive, finite, and no greater than 120000');
    const chunks = [];
    let size = 0;
    let settled = false;
    const cleanup = () => {
      clearTimeout(timer);
      request.removeListener('data', onData);
      request.removeListener('end', onEnd);
      request.removeListener('error', onError);
      request.removeListener('aborted', onAborted);
      request.removeListener('close', onClose);
    };
    const fail = (error, stop = true) => {
      if (settled) return;
      settled = true;
      cleanup();
      chunks.length = 0;
      if (stop) stopBodyInput(request);
      reject(error);
    };
    const onData = (chunk) => {
      if (settled) return;
      if (typeof chunk !== 'string' && !(chunk instanceof Uint8Array)) {
        fail(bodyError('REQUEST_JSON_INVALID', 'Request body must contain JSON bytes.', 400)); return;
      }
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += bytes.length;
      if (size > maxBytes) {
        fail(bodyError('REQUEST_BODY_TOO_LARGE', `Request body exceeds the ${Math.floor(maxBytes / 1_000_000) || maxBytes} MB limit.`, 413)); return;
      }
      chunks.push(bytes);
    };
    const onEnd = () => {
      if (settled) return;
      let payload;
      try { payload = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}; }
      catch (cause) { fail(bodyError('REQUEST_JSON_INVALID', 'Request body must be valid JSON.', 400, cause), false); return; }
      settled = true;
      cleanup();
      chunks.length = 0;
      resolve(payload);
    };
    const onError = (cause) => fail(bodyError('REQUEST_BODY_ABORTED', 'Request body stream ended before completion.', 400, cause));
    const onAborted = () => onError();
    const onClose = () => { if (!request.readableEnded) onError(); };
    const timer = setTimeout(() => fail(bodyError('REQUEST_BODY_TIMEOUT', 'Request body exceeded its read deadline.', 408)), timeoutMs);
    request.once('end', onEnd);
    request.once('error', onError);
    request.once('aborted', onAborted);
    request.once('close', onClose);
    request.on('data', onData);
    if (request.readableEnded) onEnd();
    else if (request.destroyed) onError();
  });
  if (request && (typeof request === 'object' || typeof request === 'function')) bodyPromises.set(request, promise);
  return promise;
};

export const sendSse = (response, event, payload) => {
  if (response.destroyed || response.writableEnded) return false;
  response.write(`event: ${event}\n`);
  response.write(`data: ${JSON.stringify(payload)}\n\n`);
  return true;
};

export const createStaticFileHandler = ({ distDir, serveWeb, json, mimeTypes = defaultMimeTypes }) => async (response, url) => {
  if (!serveWeb) {
    json(response, 404, { error: 'Web serving disabled in API-only mode.' });
    return;
  }
  const requested = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname.slice(1));
  let target = path.resolve(distDir, requested);
  if (target !== distDir && !target.startsWith(`${distDir}${path.sep}`)) {
    json(response, 403, { error: 'Forbidden path.' });
    return;
  }
  try {
    if (!(await stat(target)).isFile()) throw new Error('not a file');
  } catch {
    target = path.join(distDir, 'index.html');
  }
  const content = await readFile(target);
  response.writeHead(200, { 'Content-Type': mimeTypes[path.extname(target)] || 'application/octet-stream' });
  response.end(content);
};
