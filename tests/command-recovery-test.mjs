import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createCommandJournal, executeCommand, reconcileCommandJournal, hashKey } from '../client-runtime/command-journal.mjs';
import { createOperatorTestQueue } from '../client-runtime/operator-test-queue.mjs';
import { createBenchmarkCommands } from '../client-runtime/application/benchmark-command.mjs';

const root = await mkdtemp(path.join(os.tmpdir(), 'operator-command-recovery-'));
const initial = () => ({ activeMissionId: 'mission', stateVersion: 0, commandJournalSeq: 0, counter: 0 });
const failOnce = (journal, method, predicate) => {
  let failed = false;
  return { ...journal, [method]: async (...args) => {
    if (!failed && predicate(...args)) { failed = true; throw new Error('injected persistence failure'); }
    return journal[method](...args);
  } };
};
const harness = (name) => {
  const filePath = path.join(root, name, 'journal.jsonl');
  const journal = createCommandJournal({ filePath });
  const external = new Map();
  let persisted = initial();
  let effects = 0;
  let prepares = 0;
  const registry = { task: {
    tracksEffects: true,
    keyFor: () => 'same-command',
    isApplied: (state, payload) => state.taskId === payload.taskId,
    plan: ({ effectId }) => ({ taskId: effectId }),
    prepare: async ({ intent, runEffect }) => {
      prepares += 1;
      return runEffect(async () => {
        effects += 1;
        const prepared = { payload: { taskId: intent.taskId }, result: { taskId: intent.taskId, receipt: 'original' } };
        external.set(intent.taskId, prepared);
        return prepared;
      });
    },
    recover: async ({ intent }) => external.has(intent.taskId)
      ? { status: 'prepared', prepared: external.get(intent.taskId) } : { status: 'not_started' },
    apply: (state, payload) => { state.taskId = payload.taskId; state.counter += 1; },
  } };
  const saveState = async (state) => {
    persisted = { ...structuredClone(state), stateVersion: state.stateVersion + 1 };
    return structuredClone(persisted);
  };
  return {
    journal, registry, external, filePath, saveState,
    load: () => structuredClone(persisted), effects: () => effects, prepares: () => prepares,
    execute: (overrides = {}) => executeCommand({ journal, registry, saveState, state: structuredClone(persisted), type: 'task', body: {}, ...overrides }),
  };
};

try {
  const intentWrite = harness('intent-write');
  await assert.rejects(intentWrite.execute({ journal: failOnce(intentWrite.journal, 'append', () => true) }), /injected/);
  assert.equal(intentWrite.effects(), 0, 'intent must be durable before any external effect');
  assert.equal(intentWrite.prepares(), 0);

  const effectMarker = harness('effect-marker');
  await assert.rejects(effectMarker.execute({ journal: failOnce(effectMarker.journal, 'patch', (seq, fields) => fields.effectStarted === true) }), /injected/);
  assert.equal(effectMarker.effects(), 0);
  assert.equal((await effectMarker.journal.findByKey('same-command')).status, 'failed');
  await effectMarker.execute();
  assert.equal(effectMarker.effects(), 1, 'a confirmed pre-effect failure can be retried');

  const resultWrite = harness('result-write');
  await assert.rejects(resultWrite.execute({ journal: failOnce(resultWrite.journal, 'patch', (seq, fields) => fields.status === 'prepared') }), /injected/);
  const originalIntent = await resultWrite.journal.findByKey('same-command');
  assert.equal(originalIntent.status, 'preparing');
  const restartedJournal = createCommandJournal({ filePath: resultWrite.filePath });
  const recovered = await reconcileCommandJournal(resultWrite.load(), { journal: restartedJournal, registry: resultWrite.registry });
  assert.deepEqual(recovered.blocked, []);
  assert.equal(recovered.state.counter, 1);
  assert.equal(resultWrite.effects(), 1, 'lost prepared result must be recovered without repeating the effect');
  assert.equal((await restartedJournal.findByKey('same-command')).effectId, originalIntent.effectId);
  await resultWrite.saveState(recovered.state);
  assert.equal((await resultWrite.execute()).result.receipt, 'original');
  assert.equal(resultWrite.effects(), 1);

  const stateWrite = harness('state-write');
  await assert.rejects(stateWrite.execute({ saveState: async () => { throw new Error('injected state failure'); } }), /injected/);
  const replay = await reconcileCommandJournal(stateWrite.load(), { journal: stateWrite.journal, registry: stateWrite.registry });
  assert.equal(replay.state.counter, 1);
  assert.equal(stateWrite.effects(), 1, 'prepared state replay must not launch external work');
  assert.equal(stateWrite.prepares(), 1);

  const acknowledgement = harness('acknowledgement');
  await assert.rejects(acknowledgement.execute({ journal: failOnce(acknowledgement.journal, 'patch', (seq, fields) => fields.status === 'applied') }), /injected/);
  const acknowledged = await acknowledgement.execute();
  assert.equal(acknowledged.status, 'skipped_idempotent');
  assert.equal(acknowledged.result.receipt, 'original');
  assert.equal(acknowledgement.effects(), 1);

  const unknown = harness('unknown');
  delete unknown.registry.task.recover;
  await assert.rejects(unknown.execute({ journal: failOnce(unknown.journal, 'patch', (seq, fields) => fields.status === 'prepared') }), /injected/);
  const blocked = await reconcileCommandJournal(unknown.load(), { journal: unknown.journal, registry: unknown.registry });
  assert.equal(blocked.blocked[0].code, 'COMMAND_EFFECT_OUTCOME_UNKNOWN');
  assert.equal(unknown.effects(), 1);
  await assert.rejects(unknown.execute(), (error) => error.code === 'COMMAND_EFFECT_OUTCOME_UNKNOWN');
  await assert.rejects(unknown.execute({ type: 'other', registry: { ...unknown.registry, other: { apply() { throw new Error('must not execute'); } } } }), (error) => error.code === 'COMMAND_PENDING_RECOVERY');
  assert.equal(unknown.effects(), 1);


  const confirmedAbsent = harness('confirmed-absent');
  await confirmedAbsent.journal.append({
    schemaVersion: 2, seq: 1, commandId: 'cmd_1_task', effectId: 'stable-before-submit',
    idempotencyKey: 'same-command', type: 'task', missionId: 'mission',
    body: {}, intent: { taskId: 'stable-before-submit' }, stateVersionBefore: 0,
    status: 'preparing', effectStarted: true,
  });
  const resumed = await reconcileCommandJournal(confirmedAbsent.load(), { journal: confirmedAbsent.journal, registry: confirmedAbsent.registry });
  assert.deepEqual(resumed.blocked, []);
  assert.equal(resumed.state.taskId, 'stable-before-submit');
  assert.equal(confirmedAbsent.effects(), 1, 'confirmed absence resumes the same operation ID');

  const missingHandler = await reconcileCommandJournal(unknown.load(), { journal: unknown.journal, registry: {} });
  assert.equal(missingHandler.blocked[0].code, 'COMMAND_RECOVERY_HANDLER_MISSING');
  const applyFailure = harness('apply-failure');
  await assert.rejects(applyFailure.execute({ journal: failOnce(applyFailure.journal, 'patch', (seq, fields) => fields.status === 'prepared') }), /injected/);
  applyFailure.registry.task.apply = (state) => { state.counter = 99; throw new Error('injected apply failure'); };
  const rejectedApply = await reconcileCommandJournal(applyFailure.load(), { journal: applyFailure.journal, registry: applyFailure.registry });
  assert.equal(rejectedApply.blocked.length, 1);
  assert.equal(rejectedApply.state.counter, 0, 'failed replay must not expose partially applied state');
  assert.equal(applyFailure.effects(), 1);

  const queryFailure = harness('query-failure');
  await assert.rejects(queryFailure.execute({ journal: failOnce(queryFailure.journal, 'patch', (seq, fields) => fields.status === 'prepared') }), /injected/);
  queryFailure.registry.task.recover = async () => { throw new Error('query unavailable'); };
  const queryBlocked = await reconcileCommandJournal(queryFailure.load(), { journal: queryFailure.journal, registry: queryFailure.registry });
  assert.equal(queryBlocked.blocked[0].code, 'COMMAND_RECOVERY_QUERY_FAILED');
  assert.equal(queryFailure.effects(), 1, 'a failed query does not prove absence');
  const changed = await reconcileCommandJournal({ ...queryFailure.load(), stateVersion: 5 }, { journal: queryFailure.journal, registry: queryFailure.registry });
  assert.equal(changed.blocked[0].code, 'COMMAND_RECOVERY_STATE_CHANGED');
  const wrongMission = await reconcileCommandJournal({ ...queryFailure.load(), activeMissionId: 'another-mission' }, { journal: queryFailure.journal, registry: queryFailure.registry });
  assert.equal(wrongMission.blocked[0].code, 'COMMAND_RECOVERY_MISSION_MISMATCH');

  // Integration: the production Benchmark handler and real serialized queue.
  let hardwareCalls = 0;
  let reads = 0;
  const queueFile = path.join(root, 'benchmark', 'queue.jsonl');
  const queue = createOperatorTestQueue({ filePath: queueFile, serviceClient: { submit() { hardwareCalls += 1; throw new Error('hardware must not run'); } } });
  let loseSubmitResponse = true;
  const queuePort = { ...queue, submit: async (request) => {
    const task = await queue.submit(request);
    if (loseSubmitResponse) { loseSubmitResponse = false; throw new Error('injected lost queue acknowledgement'); }
    return task;
  } };
  const matrix = { environments: ['C550'], stages: ['Correctness', 'Full Benchmark'], warmup: 50, repeats: 200, correctnessCases: 24 };
  const state = { ...initial(), missions: [{ id: 'mission', hardware: ['C550'] }], testMatrix: matrix, appliedCandidateId: 'candidate',
    candidateEvaluations: [{ id: 'candidate', patchDigest: 'sha256:verified' }], baseline: { oracleRunPy: 'independent baseline oracle' }, agent: { messages: [] }, stage: 'validation' };
  const benchmarkRegistry = createBenchmarkCommands({
    addAuditEvent() {}, appendRuntimeEvent() {}, baselineMatchesMatrix: () => true,
    createSemanticTaskBinding: () => { throw new Error('not needed'); }, hashKey,
    isFixedOperatorMission: () => false, localC500Config: { enabled: true, mock: true },
    missionShapeKeyFor: () => 'shape', normalizeBaselineKind: (value) => value,
    operatorTestQueue: queuePort, readMissionRunPy: async () => { reads += 1; return { content: 'verified candidate source', source: 'workspace' }; },
    resolveBaselineRunPlan: () => { throw new Error('candidate test'); },
  });
  const benchmarkJournal = createCommandJournal({ filePath: path.join(root, 'benchmark', 'journal.jsonl') });
  await assert.rejects(executeCommand({ journal: benchmarkJournal, registry: benchmarkRegistry, state: structuredClone(state), type: 'start-benchmark', body: {}, saveState: async (next) => next }), /lost queue/);
  const queueBytes = await readFile(queueFile, 'utf8');
  const intent = (await benchmarkJournal.readAll())[0];
  assert.equal(intent.intent.request.oracleRunPy, state.baseline.oracleRunPy);
  assert.deepEqual(intent.intent.request.matrix, matrix);
  const benchmarkRecovery = await reconcileCommandJournal(structuredClone(state), { journal: createCommandJournal({ filePath: benchmarkJournal.filePath }), registry: benchmarkRegistry });
  assert.deepEqual(benchmarkRecovery.blocked, []);
  assert.equal(benchmarkRecovery.state.benchmark.runId, intent.intent.runId);
  assert.equal(benchmarkRecovery.state.benchmark.candidate.digest, 'sha256:verified');
  assert.equal(reads, 1, 'recovery uses frozen execution content without reading a changed workspace');
  assert.equal(await readFile(queueFile, 'utf8'), queueBytes, 'lookup must not process or rewrite the queue');
  assert.equal(hardwareCalls, 0);
  assert.equal(await queue.findByRequestId(intent.intent.runId, 'another-mission'), null);
  await assert.rejects(queue.submit({ ...intent.intent.request, candidate: { id: 'candidate', digest: 'sha256:other' } }), (error) => error.code === 'OPERATOR_TEST_REQUEST_CONFLICT');
  assert.equal((await readFile(queueFile, 'utf8')).trim().split('\n').length, 1);

  console.log('[command-recovery] write failures, restart recovery, unknown effects, frozen Benchmark identity and read-only queue lookup passed');
} finally {
  await rm(root, { recursive: true, force: true });
}
