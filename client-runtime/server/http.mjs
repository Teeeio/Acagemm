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

export const createJsonResponder = (bridge) => (response, status, payload) => {
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Operator-Studio-Bridge': `${bridge.pid}:${bridge.port}`,
  });
  response.end(JSON.stringify({ ...payload, __bridge: bridge }));
};

export const readJson = async (request, { maxBytes = 1_000_000 } = {}) => {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maxBytes) {
      const error = new Error(`Request body exceeds the ${Math.floor(maxBytes / 1_000_000) || maxBytes} MB limit.`);
      error.status = 413;
      error.code = 'REQUEST_BODY_TOO_LARGE';
      throw error;
    }
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch (cause) {
    const error = new Error('Request body must be valid JSON.');
    error.status = 400;
    error.code = 'REQUEST_JSON_INVALID';
    error.cause = cause;
    throw error;
  }
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
