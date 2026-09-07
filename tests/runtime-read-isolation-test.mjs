import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { request as openHttpRequest } from 'node:http';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

const root = await mkdtemp(path.join(os.tmpdir(), 'operator-read-isolation-'));
const dataDir = path.join(root, 'data');
const runtimeDir = path.join(root, 'runtime');
Object.assign(process.env, { OPERATOR_DATA_DIR: dataDir, OPERATOR_RUNTIME_DIR: runtimeDir, OPERATOR_RUNTIME_MODE: 'reference-fixture' });
const { createSeedState, saveState, readState } = await import('../client-runtime/state-store.mjs');
const { createOperatorTestQueue } = await import('../client-runtime/operator-test-queue.mjs');
const { createCommandJournal } = await import('../client-runtime/command-journal.mjs');

const socket = createServer();
await new Promise((resolve) => socket.listen(0, '127.0.0.1', resolve));
const port = socket.address().port;
await new Promise((resolve) => socket.close(resolve));
const baseUrl = 'http://127.0.0.1:' + port;
const statePath = path.join(dataDir, 'mock-db.json');
const queuePath = path.join(runtimeDir, 'operator-test-queue.jsonl');
const journal = createCommandJournal({ filePath: path.join(runtimeDir, 'command-journal.jsonl') });
let child = null;
let stderr = '';
const stop = async () => {
  if (!child || child.exitCode != null) return;
  const exited = new Promise((resolve) => child.once('exit', resolve));
  child.kill('SIGTERM');
  await Promise.race([exited, sleep(5000).then(() => { if (child.exitCode == null) throw new Error('Runtime did not stop'); })]);
};
const request = async (route, options = {}) => {
  const response = await fetch(baseUrl + route, options);
  const body = await response.json();
  assert.equal(response.ok, true, JSON.stringify(body));
  return body;
};
const start = async (autoTick) => {
  stderr = '';
  child = spawn(process.execPath, ['client-runtime/local-server.mjs'], {
    cwd: path.resolve(import.meta.dirname, '..'), windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'],
    env: {
      ...process.env, API_PORT: String(port), SERVE_WEB: 'false',
      OPERATOR_AUTO_TICK: autoTick, OPERATOR_AUTO_TICK_INTERVAL_MS: '1000',
      OPERATOR_RUNTIME_OWNER_PID: String(process.pid),
      OPERATOR_HARDWARE_DISABLED: '1', OPERATOR_TEST_BACKEND: 'local-c500',
      OPERATOR_LOCAL_C500_MOCK: '1', OPERATOR_LOCAL_C500_SIMULATION: '1',
      OPERATOR_LOCAL_C500_DIR: path.join(root, 'tasks'),
    },
  });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  for (let attempt = 0; attempt < 150; attempt += 1) {
    assert.equal(child.exitCode, null, stderr);
    try { await request('/api/health'); return; } catch { await sleep(100); }
  }
  throw new Error('Runtime did not start: ' + stderr);
};
const fixture = () => {
  const state = createSeedState();
  state.stage = 'diagnosis';
  state.agent = { ...state.agent, status: 'running', startedAt: '2000-01-01T00:00:00.000Z', durationMs: 1 };
  return state;
};

try {
  await saveState(fixture());
  const queue = createOperatorTestQueue({ filePath: queuePath, serviceClient: {} });
  const task = await queue.submit({
    requestId: 'read-only-task', missionId: 'query-only', operator: 'add',
    candidate: { digest: 'query-digest' }, matrix: { environments: ['C550'] },
  });
  await start('0');
  // A partial mutation body must not acquire the state lock and starve queries
  // or stop commands. This uses the real HTTP composition root, not a route mock.
  const partial = openHttpRequest(baseUrl + '/api/state', {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' },
  }, (response) => response.resume());
  partial.on('error', () => {});
  partial.write('{"missionPaused":');
  try {
    await sleep(100);
    const observed = await request('/api/state', { signal: AbortSignal.timeout(1500) });
    assert.ok(observed.state);
    const stopped = await request('/api/actions/stop-mission', {
      method: 'POST', body: '{}', signal: AbortSignal.timeout(1500),
    });
    assert.equal(stopped.state.missionPaused, true);
  } finally { partial.destroy(); }
  await saveState(fixture());
  const before = await readFile(statePath, 'utf8');
  const queueBefore = await readFile(queuePath, 'utf8');
  const initial = JSON.parse(before);
  const experienceBase = '/api/projects/' + encodeURIComponent(initial.projects[0].id) + '/experiences';
  assert.equal((await request(experienceBase)).experiences.length, 0);
  const createdExperience = await request(experienceBase, { method: 'POST', body: JSON.stringify({
    title: 'Bounded guidance', content: 'Check tail cases before vectorizing.', author: 'local engineer',
  }) });
  assert.equal(createdExperience.experience.source, 'human');
  assert.equal(createdExperience.experience.verification.publishable, false);
  const experienceFile = path.join(runtimeDir, 'experiences', 'experiences.json');
  const experienceBytes = await readFile(experienceFile, 'utf8');
  const oldGuidance = await request(experienceBase + '/' + createdExperience.experience.id + '?version=1');
  assert.equal(oldGuidance.experience.content, 'Check tail cases before vectorizing.');
  const invalidObservation = await fetch(baseUrl + experienceBase, {
    method: 'POST', body: JSON.stringify({ title: 'forged', content: 'not evidence', author: 'caller', evidence: {} }),
  });
  assert.equal(invalidObservation.status, 400);
  assert.equal(await readFile(experienceFile, 'utf8'), experienceBytes);
  assert.equal(await readFile(statePath, 'utf8'), before, 'experience CRUD does not mutate Runtime state');
  assert.equal(await readFile(queuePath, 'utf8'), queueBefore, 'experience CRUD never executes a test');
  for (let index = 0; index < 4; index += 1) {
    const state = (await request('/api/state')).state;
    assert.equal(state.agent.status, 'running');
    assert.equal(state.stateVersion, initial.stateVersion);
    await request('/api/operator-tests');
    await request('/api/operator-tests/' + task.taskId);
  }
  const abort = new AbortController();
  const stream = await fetch(baseUrl + '/api/missions/' + initial.activeMissionId + '/events/stream', { signal: abort.signal });
  const reader = stream.body.getReader();
  let text = '';
  try {
    while (!text.includes('event: state')) {
      const next = await reader.read();
      assert.equal(next.done, false);
      text += new TextDecoder().decode(next.value);
    }
    await sleep(650); // Include a periodic SSE read, not just the initial event.
  } finally { await reader.cancel(); abort.abort(); }
  assert.equal(await readFile(statePath, 'utf8'), before, 'GET/SSE must not save or progress the snapshot');
  assert.equal(await readFile(queuePath, 'utf8'), queueBefore, 'task inspection must not dispatch/poll hardware');

  const advanced = (await request('/api/runtime/advance', { method: 'POST' })).state;
  assert.equal(advanced.agent.status, 'awaiting_action');
  assert.ok(advanced.stateVersion > initial.stateVersion);
  assert.notEqual((await queue.readTask(task.taskId)).status, 'waiting', 'explicit advance drives the queue');
  const committed = await readFile(statePath, 'utf8');
  await request('/api/state');
  assert.equal(await readFile(statePath, 'utf8'), committed);

  const current = JSON.parse(committed);

  const pendingAbort = new AbortController();
  const pendingStream = await fetch(baseUrl + '/api/missions/' + current.activeMissionId + '/events/stream', {
    signal: AbortSignal.any([pendingAbort.signal, AbortSignal.timeout(10000)]),
  });
  const pendingReader = pendingStream.body.getReader();
  let pendingEvents = '';
  const readUntil = async (predicate) => {
    while (!predicate(pendingEvents)) {
      const next = await pendingReader.read();
      assert.equal(next.done, false);
      pendingEvents += new TextDecoder().decode(next.value);
    }
  };
  await readUntil((text) => text.includes('event: state'));
  await journal.append({
    schemaVersion: 2, seq: await journal.nextSeq(), commandId: 'read-pending',
    effectId: 'read-effect', idempotencyKey: 'read-key', type: 'runs',
    missionId: current.activeMissionId, stateVersionBefore: current.stateVersion,
    status: 'preparing', effectStarted: false, body: {}, intent: null,
  });
  const journalBefore = await readFile(journal.filePath, 'utf8');
  const pending = (await request('/api/state')).state;
  assert.equal(pending.workflowFailure.code, 'COMMAND_PENDING_RECOVERY');
  assert.equal(pending.missionPaused, true);
  assert.equal(await readFile(journal.filePath, 'utf8'), journalBefore, 'query cannot prepare/recover or acknowledge a command');
  assert.equal(await readFile(statePath, 'utf8'), committed);

  try {
    await readUntil((text) => text.includes('COMMAND_PENDING_RECOVERY'));
    assert.ok((pendingEvents.match(/event: state/g) || []).length >= 2, 'SSE must report a recovery overlay even without a new persisted version');
  } finally { await pendingReader.cancel(); pendingAbort.abort(); }
  await journal.reset();

  await stop();
  await writeFile(statePath, '{corrupt', 'utf8');
  await assert.rejects(readState(), { code: 'STATE_SNAPSHOT_CORRUPT' });
  assert.equal(await readFile(statePath, 'utf8'), '{corrupt', 'read cannot quarantine or overwrite a corrupt snapshot');

  await saveState(fixture());
  await start(undefined); // The default timer must work even without an environment override.
  // Observe files only: no GET/SSE request is allowed to drive this transition.
  let autonomous;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    autonomous = JSON.parse(await readFile(statePath, 'utf8'));
    if (autonomous.agent.status === 'awaiting_action') break;
    await sleep(100);
  }
  assert.equal(autonomous.agent.status, 'awaiting_action', 'background tick must progress without clients: ' + stderr);
  console.log('[runtime-read-isolation] GET/SSE/queue inspection, journal safety and autonomous tick passed');
} finally {
  await stop();
  await rm(root, { recursive: true, force: true });
}
