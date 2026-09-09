import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// Keep the server's isolated data outside the packaged repository. Some
// deployments make the repository runtime directory read-only; a boundary
// test must exercise HTTP ownership rather than depend on that ACL.
const testRoot = await mkdtemp(path.join(os.tmpdir(), 'operator-boundary-'));
const port = 4202;
const baseUrl = `http://127.0.0.1:${port}`;
const localServerSource = await readFile(path.join(rootDir, 'client-runtime', 'local-server.mjs'), 'utf8');
const runServiceSource = await readFile(path.join(rootDir, 'client-runtime', 'application', 'run-service.mjs'), 'utf8');
assert.match(runServiceSource, /body\.resume === true/, 'Codex thread resume must require an explicit resume=true request');
assert.doesNotMatch(runServiceSource, /body\.resume === false \? null/, 'rerun must not resume a previous Codex thread by default');
assert.doesNotMatch(localServerSource, /body\.resume === true/, 'Mission run policy must stay in the Run application service');
const child = spawn(process.execPath, ['client-runtime/local-server.mjs'], {
  cwd: rootDir,
  stdio: 'ignore',
  env: {
    ...process.env,
    API_PORT: String(port),
    SERVE_WEB: 'false',
    OPERATOR_RUNTIME_MODE: 'unavailable',
    OPERATOR_AUTO_TICK: '0',
    OPERATOR_DATA_DIR: path.join(testRoot, 'data'),
    OPERATOR_RUNTIME_DIR: path.join(testRoot, 'runtime'),
  },
});

const rawRequest = async (pathname, options = {}) => {
  const response = await fetch(`${baseUrl}${pathname}`, { ...options, headers: { 'Content-Type': 'application/json', ...(options.headers || {}) } });
  let payload = {};
  try { payload = await response.json(); } catch { /* static fallback is irrelevant to this test */ }
  return { response, payload };
};

try {
  // Windows process startup can briefly exceed three seconds when the release
  // gate has just exercised many child processes. Keep the probe bounded but
  // give the production server a normal cold-start window before classifying
  // the boundary as unavailable.
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const health = await rawRequest('/api/health');
      if (health.response.ok) break;
    } catch { /* retry while process starts */ }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const health = await rawRequest('/api/health');
  assert.equal(health.payload.service, 'operator-studio-client-runtime');
  assert.equal(health.payload.runtime.mode, 'unavailable');
  assert.equal(health.payload.runtime.connected, false);

  const stateResponse = await rawRequest('/api/state');
  assert.equal(stateResponse.response.status, 200);
  const state = stateResponse.payload.state;
  assert.equal(state.stage, 'diagnosis');
  assert.equal(state.candidateEvaluations.length, 0);
  assert.equal(state.benchmark.status, 'idle');

  const streamAbort = new AbortController();
  const streamResponse = await fetch(`${baseUrl}/api/missions/${encodeURIComponent(state.activeMissionId)}/events/stream`, { signal: streamAbort.signal });
  assert.match(streamResponse.headers.get('content-type') || '', /text\/event-stream/);
  const firstStreamChunk = await streamResponse.body.getReader().read();
  assert.match(Buffer.from(firstStreamChunk.value).toString('utf8'), /event: ready/);
  const healthDuringStream = await rawRequest('/api/health');
  assert.equal(healthDuringStream.response.status, 200, 'SSE must not block the serialized API mutation queue');
  streamAbort.abort();

  const created = await rawRequest('/api/missions', { method: 'POST', body: JSON.stringify({ title: 'Real mission', goal: 'inspect a real operator', repository: 'operator-repo', hardware: ['C500'] }) });
  assert.equal(created.response.status, 201);
  assert.equal(created.payload.state.candidateEvaluations.length, 0);
  assert.equal(created.payload.state.failureRecords.length, 0);
  assert.equal(created.payload.state.knowledgeDrafts.length, 0);
  assert.equal(created.payload.state.currentBest.candidateId, null);

  const run = await rawRequest(`/api/missions/${created.payload.state.activeMissionId}/runs`, { method: 'POST', body: '{}' });
  assert.equal(run.response.status, 503);
  assert.equal(run.payload.code, 'AGENT_RUNTIME_UNAVAILABLE');

  const remoteOnlyRoute = await rawRequest('/v1/operator-tests');
  assert.equal(remoteOnlyRoute.response.status, 404);
  console.log('[boundary] client/runtime/test-service ownership passed');
} finally {
  child.kill();
  if (child.exitCode === null) await new Promise((resolve) => child.once('exit', resolve));
  await rm(testRoot, { recursive: true, force: true });
}
