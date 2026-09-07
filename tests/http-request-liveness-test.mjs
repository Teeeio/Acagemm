// Transport contract + loopback integration; no Runtime, state, Agent, or hardware.
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { PassThrough, Readable } from 'node:stream';
import { createJsonResponder, readJson } from '../client-runtime/server/http.mjs';

const body = (value) => Readable.from(value === undefined ? [] : [Buffer.from(value)]);
const rejects = (promise, code, status) => assert.rejects(promise, (error) => error.code === code && error.status === status);
let passed = 0;
const test = async (name, action) => { await action(); passed++; console.log(`PASS ${name}`); };
await test('same request shares one parsing Promise, including resolved/error cache', async () => {
  const request = new PassThrough();
  const first = readJson(request, { timeoutMs: 300 });
  const second = readJson(request, { timeoutMs: 1, maxBytes: 1 });
  assert.equal(first, second);
  request.end('{"value":1}');
  assert.deepEqual(await first, { value: 1 });
  assert.equal(readJson(request), first);
  const invalid = body('{bad');
  const failed = readJson(invalid);
  await rejects(failed, 'REQUEST_JSON_INVALID', 400);
  assert.equal(readJson(invalid), failed);
  await rejects(readJson(invalid), 'REQUEST_JSON_INVALID', 400);
});
await test('empty bodies, JSON compatibility, and byte limits are retained', async () => {
  assert.deepEqual(await readJson(body()), {});
  assert.equal(await readJson(body('null')), null);
  assert.equal(await readJson(body('"text"')), 'text');
  const exact = '"' + 'x'.repeat(999998) + '"';
  assert.equal((await readJson(body(exact))).length, 999998);
  await rejects(readJson(body(' ' + exact)), 'REQUEST_BODY_TOO_LARGE', 413);
  await rejects(readJson(body('"汉"'), { maxBytes: 4 }), 'REQUEST_BODY_TOO_LARGE', 413);
});
await test('never-ending and continuously slow in-memory bodies time out and are destroyed', async () => {
  for (const streaming of [false, true]) {
    const request = new PassThrough();
    const pending = readJson(request, { timeoutMs: 40 });
    const interval = streaming ? setInterval(() => request.write(' '), 5) : null;
    try { await rejects(pending, 'REQUEST_BODY_TIMEOUT', 408); assert.equal(request.destroyed, true); }
    finally { if (interval) clearInterval(interval); request.destroy(); }
    assert.equal(request.listenerCount('data'), 0);
    assert.equal(request.listenerCount('end'), 0);
  }
});
await test('premature body close returns a stable terminal error', async () => {
  const request = new PassThrough();
  const pending = readJson(request, { timeoutMs: 300 });
  request.write('{'); request.destroy();
  await rejects(pending, 'REQUEST_BODY_ABORTED', 400);
});
await test('default body deadline is finite and remains five seconds', async () => {
  const request = new PassThrough();
  const started = Date.now();
  await rejects(readJson(request), 'REQUEST_BODY_TIMEOUT', 408);
  assert.ok(Date.now() - started >= 4500);
  assert.ok(Date.now() - started < 12000);
  assert.equal(request.destroyed, true);
});

const sockets = new Set();
const json = createJsonResponder({ pid: 123, port: 456 });
let timedOutRequest;
let parseCount = 0;
const server = http.createServer(async (request, response) => {
  if (request.url === '/health') { json(response, 200, { ok: true }); return; }
  try {
    const first = readJson(request, { timeoutMs: 80, ...(request.url === '/large' ? { maxBytes: 4 } : {}) });
    const cached = readJson(request);
    assert.equal(first, cached);
    await first;
    parseCount++;
    json(response, 200, { body: await readJson(request) });
  } catch (error) {
    timedOutRequest = request;
    json(response, error.status || 500, { error: error.message, code: error.code });
  }
});
server.on('connection', (socket) => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;
const sendIncomplete = (pathname, chunk) => new Promise((resolve, reject) => {
  const client = http.request({ host: '127.0.0.1', port, path: pathname, method: 'POST', headers: { 'Content-Type': 'application/json', 'Transfer-Encoding': 'chunked', Connection: 'keep-alive' } });
  const deadline = setTimeout(() => { client.destroy(); reject(new Error('incomplete request did not terminate')); }, 2500);
  client.on('error', reject);
  client.on('response', (response) => {
    const chunks = [];
    response.on('data', (part) => chunks.push(part));
    response.on('error', reject);
    response.on('end', () => {
      const socket = client.socket;
      const finish = () => { clearTimeout(deadline); resolve({ status: response.statusCode, headers: response.headers, payload: JSON.parse(Buffer.concat(chunks).toString()) }); };
      if (socket.destroyed) finish(); else socket.once('close', finish);
    });
  });
  client.write(chunk);
});
try {
  await test('408 response is delivered before closing a never-ending HTTP connection', async () => {
    const result = await sendIncomplete('/slow', '{');
    assert.equal(result.status, 408); assert.equal(result.payload.code, 'REQUEST_BODY_TIMEOUT');
    assert.equal(result.headers.connection, 'close');
    assert.deepEqual(result.payload.__bridge, { pid: 123, port: 456 });
    for (let attempts = 0; attempts < 150 && !timedOutRequest.destroyed; attempts++) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(timedOutRequest.destroyed, true);
    assert.equal(parseCount, 0);
  });
  await test('oversized incomplete bodies also respond and close, and unrelated requests stay live', async () => {
    const pending = sendIncomplete('/slow', '{');
    const health = await fetch(`http://127.0.0.1:${port}/health`);
    assert.equal(health.status, 200); await health.json();
    const large = await sendIncomplete('/large', '12345');
    assert.equal(large.status, 413); assert.equal(large.headers.connection, 'close');
    assert.equal((await pending).status, 408);
    const completed = await fetch(`http://127.0.0.1:${port}/done`, { method: 'POST', body: '{"ok":1}' });
    assert.equal((await completed.json()).body.ok, 1);
    assert.equal(parseCount, 1);
  });
  console.log(`HTTP request liveness: ${passed} checks passed.`);
} finally {
  const stopped = once(server, 'close'); server.close();
  for (const socket of sockets) socket.destroy();
  await stopped;
}
