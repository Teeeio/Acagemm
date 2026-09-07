// Contract/integration coverage using loopback only; no operator execution.
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { createTestServiceClient } from '../client-runtime/test-service-client.mjs';

const requests = [];
const sockets = new Set();
const closed = new Set();
const server = http.createServer((request, response) => {
  requests.push({ method: request.method, path: request.url });
  response.on('close', () => closed.add(request.url));
  if (request.url.includes('never-headers')) return;
  if (request.url.includes('never-body')) {
    response.writeHead(200, { 'Content-Type': 'application/json' }); response.flushHeaders(); response.write('{'); return;
  }
  if (request.url.includes('slow-body')) {
    response.writeHead(200, { 'Content-Type': 'application/json' }); response.write('{');
    const interval = setInterval(() => response.write(' '), 5);
    response.once('close', () => clearInterval(interval)); return;
  }
  if (request.url.includes('bad-json')) { response.end('{bad'); return; }
  if (request.url.includes('bad-shape')) { response.end('null'); return; }
  if (request.url.includes('array-shape')) { response.end('[]'); return; }
  if (request.url.includes('empty-error')) { response.writeHead(503); response.end(); return; }
  if (request.url.includes('custom-error')) { response.writeHead(409); response.end(JSON.stringify({ error: 'Conflict', code: 'TASK_CONFLICT' })); return; }
  const chunks = [];
  request.on('data', (chunk) => chunks.push(chunk));
  request.on('end', () => {
    if (request.method === 'POST' && Buffer.concat(chunks).toString().includes('hang-submit')) return;
    if (request.url === '/v1/operator-tests' && Buffer.concat(chunks).toString().includes('redirect-submit')) {
      response.writeHead(307, { Location: '/redirect-target' }); response.end(); return;
    }
    response.writeHead(request.method === 'POST' ? 202 : 200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ ok: true, method: request.method, path: request.url, body: Buffer.concat(chunks).toString() }));
  });
});
server.on('connection', (socket) => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const client = createTestServiceClient(base, { timeoutMs: 1000 });
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const until = async (predicate) => { for (let tries = 0; tries < 100 && !predicate(); tries++) await delay(10); assert.ok(predicate()); };
const rejects = (promise, code, status) => assert.rejects(promise, (error) => error.code === code && error.status === status);
let passed = 0;
const test = async (name, action) => { await action(); passed++; console.log(`PASS ${name}`); };
try {
  await test('legacy methods retain endpoints, JSON bodies, and encoded identifiers', async () => {
    assert.equal((await client.submit({ requestId: 'one' })).body, '{"requestId":"one"}');
    assert.equal((await client.get('a/b')).path, '/v1/operator-tests/a%2Fb');
    assert.equal((await client.events('a/b')).path, '/v1/operator-tests/a%2Fb/events');
    const cancelled = await client.cancel('one');
    assert.equal(cancelled.method, 'POST'); assert.equal(cancelled.body, '{}');
  });
  await test('malformed JSON and non-object envelopes have stable errors', async () => {
    for (const id of ['bad-json', 'bad-shape', 'array-shape']) await rejects(client.get(id), 'OPERATOR_TEST_SERVICE_JSON_INVALID', 502);
    await rejects(client.get('custom-error'), 'TASK_CONFLICT', 409);
    await rejects(client.get('empty-error'), 'OPERATOR_TEST_SERVICE_ERROR', 503);
  });
  await test('a true AbortController bounds both headers and the response body', async () => {
    for (const id of ['never-headers', 'never-body', 'slow-body']) {
      await rejects(client.get(id, { timeoutMs: 60 }), 'OPERATOR_TEST_SERVICE_TIMEOUT', 504);
      await until(() => closed.has(`/v1/operator-tests/${id}`));
    }
  });
  await test('caller cancellation composes with deadlines, including pre-aborted signals', async () => {
    const before = requests.length;
    const already = new AbortController(); already.abort('caller stopped');
    await rejects(client.get('not-sent', { signal: already.signal }), 'OPERATOR_TEST_SERVICE_ABORTED', 499);
    assert.equal(requests.length, before);
    const controller = new AbortController();
    const pending = client.get('never-body-cancel', { signal: controller.signal, timeoutMs: 1000 });
    await until(() => requests.some((request) => request.path.endsWith('never-body-cancel')));
    controller.abort(new Error('caller stopped'));
    await rejects(pending, 'OPERATOR_TEST_SERVICE_ABORTED', 499);
    await until(() => closed.has('/v1/operator-tests/never-body-cancel'));
  });
  await test('timed-out POST is never implicitly retried', async () => {
    const before = requests.filter((request) => request.method === 'POST' && request.path === '/v1/operator-tests').length;
    await rejects(client.submit({ requestId: 'hang-submit' }, { timeoutMs: 60 }), 'OPERATOR_TEST_SERVICE_TIMEOUT', 504);
    await delay(100);
    assert.equal(requests.filter((request) => request.method === 'POST' && request.path === '/v1/operator-tests').length, before + 1);
  });
  await test('HTTP redirects cannot implicitly resend a POST', async () => {
    await rejects(client.submit({ requestId: 'redirect-submit' }), 'OPERATOR_TEST_SERVICE_UNAVAILABLE', 502);
    assert.equal(requests.filter((request) => request.path === '/redirect-target').length, 0);
  });
  await test('injected fetch receives a separate live signal and no retry on transport failure', async () => {
    let calls = 0;
    let received;
    const probe = createTestServiceClient(base, { timeoutMs: 20, fetchImpl: async (_url, options) => {
      calls++; received = options.signal;
      return new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true }));
    } });
    const caller = new AbortController();
    await rejects(probe.cancel('one', { signal: caller.signal }), 'OPERATOR_TEST_SERVICE_TIMEOUT', 504);
    assert.ok(received instanceof AbortSignal); assert.notEqual(received, caller.signal); assert.equal(received.aborted, true); assert.equal(caller.signal.aborted, false); assert.equal(calls, 1);
    let failures = 0;
    const broken = createTestServiceClient(base, { fetchImpl: async () => { failures++; throw new TypeError('socket failed'); } });
    await rejects(broken.submit({ requestId: 'uncertain' }), 'OPERATOR_TEST_SERVICE_UNAVAILABLE', 502);
    assert.equal(failures, 1);
  });
  await test('invalid timeouts fail before making a request', async () => {
    assert.throws(() => createTestServiceClient(base, { timeoutMs: Infinity }), /timeoutMs/);
    const before = requests.length;
    await assert.rejects(client.get('not-sent', { timeoutMs: 0 }), /timeoutMs/);
    assert.equal(requests.length, before);
  });
  console.log(`Test service client: ${passed} checks passed.`);
} finally {
  const stopped = once(server, 'close');
  server.close();
  for (const socket of sockets) socket.destroy();
  await stopped;
}
