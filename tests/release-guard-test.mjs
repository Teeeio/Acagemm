import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const testRoot = path.join(rootDir, 'runtime', `release-guard-${process.pid}`);
const cliRoot = path.join(testRoot, 'cli');
const bridgeDir = path.join(testRoot, 'bridge');
const dataDir = path.join(testRoot, 'data');
const runtimeDir = path.join(testRoot, 'runtime');
const port = 4201;
const baseUrl = `http://127.0.0.1:${port}`;

const { createSeedState } = await import('../client-runtime/state-store.mjs');
const persistedDemoState = createSeedState();
persistedDemoState.stage = 'evidence';
persistedDemoState.missions[0].stage = 'evidence';
persistedDemoState.benchmark = { ...persistedDemoState.benchmark, status: 'complete', progress: 100, runId: 'demo-fixture-run' };
persistedDemoState.missions[0].benchmark = structuredClone(persistedDemoState.benchmark);
persistedDemoState.agent = { ...persistedDemoState.agent, runId: 'agent_demo_fixture' };
persistedDemoState.missions[0].agent = structuredClone(persistedDemoState.agent);

await mkdir(path.join(cliRoot, 'results'), { recursive: true });
await mkdir(path.join(cliRoot, 'docs'), { recursive: true });
await mkdir(dataDir, { recursive: true });
await writeFile(path.join(dataDir, 'mock-db.json'), `${JSON.stringify(persistedDemoState, null, 2)}\n`);
await writeFile(path.join(cliRoot, 'results', 'agent_status_cli_integration.json'), JSON.stringify({ schemaVersion: 2, status: 'running', phase: 'CLI queue', progress: 20, events: [] }));
await writeFile(path.join(cliRoot, 'results', 'test_queue.jsonl'), '');
await writeFile(path.join(cliRoot, 'docs', 'optimization_records.json'), '{"20003":{"current_best":"T116"}}');

const child = spawn('node', ['client-runtime/local-server.mjs'], {
  cwd: rootDir,
  stdio: ['ignore', 'pipe', 'pipe'],
  env: {
    ...process.env,
    API_PORT: String(port),
    SERVE_WEB: 'false',
    OPERATOR_DATA_DIR: dataDir,
    OPERATOR_RUNTIME_DIR: runtimeDir,
    OPERATOR_RUNTIME_MODE: 'cli-file',
    OPERATOR_CLI_ROOT: cliRoot,
    OPERATOR_BRIDGE_DIR: bridgeDir,
  },
});

const rawRequest = async (pathname, options = {}) => {
  const response = await fetch(`${baseUrl}${pathname}`, { ...options, headers: { 'Content-Type': 'application/json', ...(options.headers || {}) } });
  const payload = await response.json();
  return { response, payload };
};

const request = async (pathname, options = {}) => {
  const result = await rawRequest(pathname, options);
  if (!result.response.ok) throw new Error(result.payload.error || `HTTP ${result.response.status}`);
  return result.payload;
};

const expectFailure = async (pathname, status, code, options = {}) => {
  const result = await rawRequest(pathname, options);
  assert.equal(result.response.status, status, pathname);
  assert.equal(result.payload.code, code, pathname);
};

const waitForServer = async () => {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try { await request('/api/health'); return; } catch { await new Promise((resolve) => setTimeout(resolve, 100)); }
  }
  throw new Error('CLI guard test server did not start.');
};

try {
  await waitForServer();
  const health = await request('/api/health');
  assert.equal(health.runtime.mode, 'cli-file');
  assert.equal(health.runtime.connected, true);
  assert.equal(health.runtime.liveHardware, false);
  assert.equal(health.runtime.actionBridge, 'mission-request-only');
  assert.deepEqual(health.runtime.capabilities, ['mission.request', 'agent.status', 'queue.probe', 'canonical.probe']);
  const persistedState = await request('/api/state');
  assert.equal(persistedState.state.stage, 'evidence');
  assert.notEqual(persistedState.state.knowledgeMaintenance.status, 'completed');

  const created = await request('/api/missions', { method: 'POST', body: JSON.stringify({ title: 'CLI Guard Mission', goal: '优化 paged attention 算子在 C500 上的 latency p50 至 45 us 以下，并通过 correctness gate', repository: 'fixture-repo', hardware: ['C500'], metric: 'latency p50' }) });
  const missionId = created.state.activeMissionId;
  const started = await request(`/api/missions/${missionId}/runs`, { method: 'POST', body: '{}' });
  assert.match(started.state.agent.runId, /^cli_/);
  assert.equal(started.state.patchApplied, false);
  assert.equal(started.state.benchmark.status, 'idle');
  assert.deepEqual(started.state.runtimeEvents.map((event) => event.type), ['mission.run_requested']);
  const bridgeRequest = JSON.parse(await readFile(path.join(bridgeDir, 'requests', `${started.state.agent.runId}.json`), 'utf8'));
  assert.equal(bridgeRequest.missionId, missionId);
  await writeFile(path.join(cliRoot, 'results', 'agent_status_cli_integration.json'), JSON.stringify({ schemaVersion: 2, requestId: started.state.agent.runId, missionId, status: 'running', phase: 'CLI queue', progress: 20, events: [] }));

  const stateBefore = JSON.stringify({ stage: started.state.stage, patchApplied: started.state.patchApplied, benchmark: started.state.benchmark, publishedAssets: started.state.publishedAssets, events: started.state.runtimeEvents });
  await expectFailure('/api/actions/apply-patch', 409, 'RUNTIME_ACTION_UNAVAILABLE', { method: 'POST', body: JSON.stringify({ candidate: 'candidate-02' }) });
  await expectFailure('/api/actions/start-benchmark', 409, 'INVALID_WORKFLOW_TRANSITION', { method: 'POST', body: '{}' });
  await expectFailure('/api/actions/adopt', 409, 'RUNTIME_ACTION_UNAVAILABLE', { method: 'POST', body: '{}' });
  await expectFailure('/api/actions/reject', 409, 'RUNTIME_ACTION_UNAVAILABLE', { method: 'POST', body: '{}' });
  await expectFailure('/api/actions/rollback-stage', 409, 'RUNTIME_ACTION_UNAVAILABLE', { method: 'POST', body: '{}' });
  await expectFailure('/api/actions/revert-adoption', 409, 'RUNTIME_ACTION_UNAVAILABLE', { method: 'POST', body: '{}' });
  await expectFailure('/api/reset', 409, 'RUNTIME_ACTION_UNAVAILABLE', { method: 'POST', body: '{}' });
  await expectFailure('/api/knowledge/publish', 410, 'KNOWLEDGE_PUBLISH_RETIRED', { method: 'POST', body: '{}' });
  await expectFailure('/api/knowledge/publish-all', 410, 'KNOWLEDGE_PUBLISH_RETIRED', { method: 'POST', body: '{}' });

  const stateAfter = (await request('/api/state')).state;
  assert.equal(JSON.stringify({ stage: stateAfter.stage, patchApplied: stateAfter.patchApplied, benchmark: stateAfter.benchmark, publishedAssets: stateAfter.publishedAssets, events: stateAfter.runtimeEvents }), stateBefore);
  assert.equal(stateAfter.agent.runId, started.state.agent.runId);
  assert.equal(stateAfter.agent.phase, 'CLI queue');
  assert.ok(!stateAfter.runtimeEvents.some((event) => ['mission.run_started', 'patch.applied', 'test_task.started', 'decision.adopted'].includes(event.type)));
  await assert.rejects(stat(path.join(runtimeDir, 'workspaces', missionId, 'repository', 'kernels', 'plan_cache.hpp')));
  console.log('[release-guard] CLI authority and knowledge governance passed');
} finally {
  child.kill();
  if (child.exitCode === null) await new Promise((resolve) => child.once('exit', resolve));
  await rm(testRoot, { recursive: true, force: true });
}
