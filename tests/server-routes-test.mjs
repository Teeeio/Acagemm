import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createJsonResponder, readJson } from '../client-runtime/server/http.mjs';
import { createSystemRoutes } from '../client-runtime/server/system-routes.mjs';
import { createFilesystemService } from '../client-runtime/server/filesystem-service.mjs';
import { createFilesystemRoutes } from '../client-runtime/server/filesystem-routes.mjs';

const responseRecorder = () => ({
  headers: null,
  status: null,
  body: '',
  writeHead(status, headers) { this.status = status; this.headers = headers; },
  write(chunk) { this.body += String(chunk); },
  end(chunk = '') { this.body += String(chunk); this.writableEnded = true; },
});
const request = (method, body = '') => Object.assign(Readable.from(body ? [Buffer.from(body)] : []), { method });

const bridge = { pid: 123, port: 4567 };
const json = createJsonResponder(bridge);
const jsonResponse = responseRecorder();
json(jsonResponse, 201, { value: 'ok' });
assert.equal(jsonResponse.status, 201);
assert.equal(jsonResponse.headers['Cache-Control'], 'no-store');
assert.equal(jsonResponse.headers['X-Operator-Studio-Bridge'], '123:4567');
assert.deepEqual(JSON.parse(jsonResponse.body), { value: 'ok', __bridge: bridge });

assert.deepEqual(await readJson(request('POST', '{"value":1}')), { value: 1 });
assert.deepEqual(await readJson(request('POST')), {});
await assert.rejects(readJson(request('POST', '{bad')), (error) => error.code === 'REQUEST_JSON_INVALID' && error.status === 400);
await assert.rejects(readJson(request('POST', '12345'), { maxBytes: 4 }), (error) => error.code === 'REQUEST_BODY_TOO_LARGE' && error.status === 413);

const systemRoutes = createSystemRoutes({
  json,
  describeRuntime: async () => ({ mode: 'fixture', connected: true }),
  testBackend: { kind: 'fixture', liveHardware: false },
});
const healthResponse = responseRecorder();
assert.equal(await systemRoutes({ request: request('GET'), response: healthResponse, url: new URL('http://local/api/health') }), true);
assert.equal(JSON.parse(healthResponse.body).service, 'operator-studio-client-runtime');
assert.equal(JSON.parse(healthResponse.body).runtime.mode, 'fixture');
assert.equal(await systemRoutes({ request: request('GET'), response: responseRecorder(), url: new URL('http://local/api/unknown') }), false);

const root = await mkdtemp(path.join(os.tmpdir(), 'operator-server-routes-'));
try {
  const filesystem = createFilesystemService({
    picker: { select: async (initialPath) => ({ cancelled: false, path: initialPath }) },
    homeDirectory: () => root,
  });
  const routes = createFilesystemRoutes({ json, readJson, filesystem });
  const createResponse = responseRecorder();
  assert.equal(await routes({
    request: request('POST', JSON.stringify({ parent: root, name: 'kernels' })),
    response: createResponse,
    url: new URL('http://local/api/filesystem/directories'),
  }), true);
  assert.equal(createResponse.status, 201);
  assert.equal(JSON.parse(createResponse.body).directory.path, path.join(root, 'kernels'));

  const listResponse = responseRecorder();
  await routes({ request: request('GET'), response: listResponse, url: new URL(`http://local/api/filesystem/directories?path=${encodeURIComponent(root)}`) });
  assert.deepEqual(JSON.parse(listResponse.body).directory.entries.map((entry) => entry.name), ['kernels']);

  await assert.rejects(filesystem.create({ parent: root, name: '../escape' }), (error) => error.code === 'DIRECTORY_NAME_INVALID');
  await assert.rejects(filesystem.list(path.join(root, 'missing')), (error) => error.code === 'DIRECTORY_UNAVAILABLE');
} finally {
  await rm(root, { recursive: true, force: true });
}

console.log('[server-routes] HTTP envelope, body guards, system routes, and filesystem routes passed');
