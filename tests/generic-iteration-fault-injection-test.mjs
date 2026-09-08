// Integration/robustness: inject failures at each durable boundary of the
// generic operator loop. No model, hardware, or simulation evidence is used.
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createExecutionPackageStore, contentDigest } from '../client-runtime/execution-package-store.mjs';
import { createOperatorTestQueue } from '../client-runtime/operator-test-queue.mjs';
import { createCommandJournal, executeCommand, reconcileCommandJournal } from '../client-runtime/command-journal.mjs';

const root = await mkdtemp(path.join(os.tmpdir(), 'operator-generic-faults-'));
const queues = [];
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const eventually = async (read, predicate, timeout = 3000) => {
  const deadline = Date.now() + timeout;
  let value;
  while (Date.now() < deadline) {
    value = await read();
    if (predicate(value)) return value;
    await wait(15);
  }
  throw new Error('fault-injection observation deadline: ' + JSON.stringify(value));
};

const h = contentDigest('generic-fault-fixture');
const target = { platform: 'test-x64', device: 'cpu' };
const adapter = {
  version: '1', languages: ['test-language'],
  verifyPreparedArtifact: async () => ({ valid: true }),
  prepare: async ({ packageDigest, environment: environment }) => ({
    status: 'ready', packageDigest, environmentDigest: environment.digest,
    preparedArtifactDigest: h, resourceRelease: { confirmed: true },
  }),
};
const packageInput = {
  language: 'test-language', adapter: { id: 'fault-adapter', version: '1' },
  binding: { missionId: 'fault-mission', workspaceId: 'fault-workspace', candidateId: 'candidate-1', candidateDigest: h },
  environmentId: 'fault-runtime', candidateEntrypoint: 'src/operator.code',
  candidateFiles: { 'src/operator.code': 'candidate' }, dependencyFiles: { 'deps/runtime.code': 'dependency' },
  acceptance: { entrypoint: 'suite/oracle.code', files: { 'suite/oracle.code': 'oracle' }, testSpec: { cases: ['minimal'] }, semanticDigest: h },
};
const request = (id) => ({ requestId: id, purpose: 'candidate', missionId: 'fault-mission', workspaceId: 'fault-workspace', operator: 'generic_fault_operator', candidate: { id: 'candidate-1', digest: h }, matrix: { environments: ['CPU'] }, packageDigest: 'sha256:' + '0'.repeat(64), admissionId: 'admission', environmentDigest: h, acceptanceDigest: h, target, deadline: new Date(Date.now() + 30_000).toISOString(), checks: ['correctness', 'benchmark'], limits: { timeoutSeconds: 5 } });

const makePackages = () => ({
  verifyAdmission: async (value) => ({ manifest: { target, adapter: { id: 'fault-adapter', version: '1' }, environment: { digest: h } }, admission: { preparedArtifactDigest: h }, request: value }),
  prepare: async () => ({ status: 'ready' }),
});
const makeBackend = (mode) => {
  const tasks = new Map();
  let submitCount = 0;
  return {
    tasks, get submitCount() { return submitCount; },
    capabilities: async () => ({ backendId: 'fault-backend', queryIsReadOnly: true, idempotentSubmission: true, targets: [target], adapters: [{ id: 'fault-adapter', version: '1' }] }),
    submit: async (payload) => {
      submitCount += 1;
      const taskId = 'remote-' + payload.requestId;
      if (!tasks.has(payload.requestId)) tasks.set(payload.requestId, { taskId, status: 'queued', requestId: payload.requestId });
      if (mode === 'lost-submit' && submitCount === 1) throw Object.assign(new Error('response lost after acceptance'), { code: 'ECONNRESET' });
      return tasks.get(payload.requestId);
    },
    findByRequestId: async (id) => tasks.get(id) || null,
    get: async (taskId) => [...tasks.values()].find((task) => task.taskId === taskId) || null,
    advance: async (taskId) => {
      const task = [...tasks.values()].find((item) => item.taskId === taskId);
      if (!task) return null;
      if (mode === 'runner-failure') return Object.assign(task, { status: 'failed', error: { code: 'RUNNER_EXECUTION_FAILED', category: 'validation', phase: 'correctness', role: 'candidate', message: 'candidate raised ValueError' }, resourceRelease: { confirmed: true, status: 'confirmed' } });
      if (mode === 'cancel-quarantine') return Object.assign(task, { status: 'running', resourceRelease: { confirmed: false, status: 'active' } });
      return Object.assign(task, { status: 'completed', result: { benchmark: [], environment: { source: 'fault-fixture', liveHardware: false } }, resourceRelease: { confirmed: true, status: 'confirmed' } });
    },
    cancel: async (taskId) => {
      const task = [...tasks.values()].find((item) => item.taskId === taskId);
      return Object.assign(task, { status: 'cancelled', resourceRelease: { confirmed: false, status: 'quarantined', reason: 'fault injected' } });
    },
  };
};

try {
  // A hanging environment inspection is a bounded, explicit package failure.
  const stalled = createExecutionPackageStore({
    rootDir: path.join(root, 'package-timeout'), inspectionTimeoutMs: 100,
    environments: { resolve: async () => new Promise(() => {}) }, adapters: { 'fault-adapter': adapter },
  });
  await assert.rejects(() => stalled.assemble(packageInput), (error) => error.code === 'PACKAGE_INSPECTION_TIMEOUT');

  // Lost submit responses reconcile by request identity and never duplicate.
  const lostBackend = makeBackend('lost-submit');
  const lostQueue = createOperatorTestQueue({ serviceClient: lostBackend, filePath: path.join(root, 'lost.jsonl'), ioTimeoutMs: 200, maxAttempts: 3 }); queues.push(lostQueue);
  const lost = await lostQueue.submit(request('lost-submit'));
  assert.equal((await lostQueue.process()).status, 'quarantined');
  await lostQueue.process();
  const lostDone = await eventually(async () => { await lostQueue.process(); return lostQueue.readTask(lost.taskId); }, (value) => value.status === 'completed');
  assert.equal(lostDone.remoteTaskId, 'remote-lost-submit');
  assert.equal(lostBackend.submitCount, 1);

  // Runner failures preserve structured phase/category/role and become terminal.
  const failedBackend = makeBackend('runner-failure');
  const failedQueue = createOperatorTestQueue({ serviceClient: failedBackend, filePath: path.join(root, 'failed.jsonl'), ioTimeoutMs: 200 }); queues.push(failedQueue);
  const failed = await failedQueue.submit(request('runner-failure'));
  await failedQueue.process();
  const failedDone = await failedQueue.process();
  assert.equal(failedDone.status, 'failed');
  assert.equal(failedDone.error.code, 'RUNNER_EXECUTION_FAILED');
  assert.equal(failedDone.error.phase, 'correctness');

  // A cancellation result without release proof is quarantined, never terminal.
  const cancelBackend = makeBackend('cancel-quarantine');
  const cancelQueue = createOperatorTestQueue({ serviceClient: cancelBackend, filePath: path.join(root, 'cancel.jsonl'), ioTimeoutMs: 200 }); queues.push(cancelQueue);
  const cancellable = await cancelQueue.submit(request('cancel-quarantine'));
  await cancelQueue.process();
  await cancelQueue.process();
  await cancelQueue.cancel(cancellable.taskId);
  const quarantined = await eventually(() => cancelQueue.process().then(() => cancelQueue.readTask(cancellable.taskId)), (value) => value.status === 'quarantined');
  assert.equal(quarantined.status, 'quarantined');
  assert.equal(quarantined.resourceRelease.confirmed, false);
  assert.equal(quarantined.error.code, 'OPERATOR_TEST_RELEASE_UNCONFIRMED');

  // Crash after a durable effect but before acknowledgement replays exactly once.
  const journal = createCommandJournal({ filePath: path.join(root, 'journal.jsonl') });
  const external = new Map(); let effects = 0; let persisted = { activeMissionId: 'fault-mission', stateVersion: 0, commandJournalSeq: 0 };
  const registry = { fault: {
    tracksEffects: true, keyFor: () => 'fault-key', plan: ({ effectId }) => ({ id: effectId }),
    prepare: async ({ intent, runEffect }) => runEffect(async () => { effects += 1; const result = { payload: { id: intent.id }, result: { ok: true } }; external.set(intent.id, result); return result; }),
    recover: async ({ intent }) => external.has(intent.id) ? { status: 'prepared', prepared: external.get(intent.id) } : { status: 'not_started' },
    apply: (state, payload) => { state.faultId = payload.id; }, isApplied: (state, payload) => state.faultId === payload.id,
  } };
  const saveState = async (state) => { persisted = { ...structuredClone(state), stateVersion: state.stateVersion + 1 }; return persisted; };
  const originalPatch = journal.patch;
  let failAck = true;
  const flakyJournal = { ...journal, patch: async (...args) => { if (failAck && args[1]?.status === 'prepared') { failAck = false; throw new Error('injected prepared write loss'); } return originalPatch(...args); } };
  await assert.rejects(() => executeCommand({ journal: flakyJournal, registry, saveState, state: structuredClone(persisted), type: 'fault', body: {} }));
  const recovered = await reconcileCommandJournal(persisted, { journal, registry });
  assert.deepEqual(recovered.blocked, []);
  assert.equal(effects, 1);
  assert.equal(recovered.state.faultId, (await journal.findByKey('fault-key')).payload.id);
  console.log('[generic-iteration-fault-injection] package timeout, lost submit, runner failure, cancellation quarantine, and command replay passed');
} finally {
  await Promise.all(queues.map((queue) => queue.dispose()));
  await rm(root, { recursive: true, force: true });
}
