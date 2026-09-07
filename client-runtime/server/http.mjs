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
