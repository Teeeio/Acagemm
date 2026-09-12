// Independent, hardware-free acceptance for the frozen consumer helpers in
// scripts/shared-gpu-acceptance.mjs (docs/development/MODEL_OBSERVATION_ACCEPTANCE.md,
// §"Frozen consumer helper acceptance"):
//   - collectModelObservationEvidence({provider, missionIds, knownRuns, records})
//   - evaluateMissionStopReceipt({missionId, receipt})
// plus the frozen ledger boundary additions in scripts/summarize-gpu-agent-runs.mjs
// (malformed declared modelObservationSummary; contradictory duplicate aliases whose
// config/outcome match but whose per-run model proof disagrees).
//
// This file is written BEFORE the consumer rework. It dynamically imports the real
// acceptance namespace and reports an explicit expected-red verdict while the two
// helpers are not yet exported. It creates no production stub and edits no production
// file. It starts no Runtime, provider, Agent, GPU, filesystem collection or N=20
// batch: every record/receipt below is an in-memory fixture, so a pass here is
// contract/ledger evidence only and never a hardware or stability sample.
//
// Authority: docs/development/MODEL_OBSERVATION_ACCEPTANCE.md (frozen; this test must
// not edit it), client-runtime/model-observation.mjs (DTO authority),
// scripts/summarize-gpu-agent-runs.mjs (existing ledger entry point).
import assert from 'node:assert/strict';
import {
  MODEL_OBSERVATION_SCHEMA_VERSION, observeClaudeModel, summarizeModelObservations,
} from '../client-runtime/model-observation.mjs';
import {
  GPU_ATTEMPT_SCHEMA_VERSION, GPU_SUMMARY_SCHEMA_VERSION, ROUND_FACTS_SCHEMA_VERSION,
  buildConfigFingerprint,
} from '../scripts/shared-gpu-acceptance.mjs';
import { summarizeAcceptanceRuns } from '../scripts/summarize-gpu-agent-runs.mjs';

// Namespace dynamic import: the helpers are read off the real module object at
// runtime, so a missing export is reported as an explicit expected-red contract
// failure instead of a static import crash.
const acceptanceNs = await import('../scripts/shared-gpu-acceptance.mjs');

const COLLECT_HELPER = 'collectModelObservationEvidence';
const STOP_HELPER = 'evaluateMissionStopReceipt';

class PendingContractError extends Error {}

const helper = (name) => {
  const fn = acceptanceNs[name];
  if (typeof fn !== 'function') {
    throw new PendingContractError(
      `${name} is not an exported callable of scripts/shared-gpu-acceptance.mjs (frozen consumer helper pending implementation)`);
  }
  return fn;
};

const cases = [];
const test = (name, fn) => {
  try {
    fn();
    cases.push({ name, passed: true });
  } catch (error) {
    cases.push({ name, passed: false, error });
  }
};

const deepFreeze = (value) => {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value)) deepFreeze(value[key]);
  }
  return value;
};

// ---------------------------------------------------------------------------
// Shared observation fixtures (assistant.message.model is the only response
// identity; init/usage labels stay diagnostic).
// ---------------------------------------------------------------------------

const PROVIDER = 'claude-code';
const RESPONSE_MODEL = 'deepseek-v4-flash';
const INIT_MODEL = 'claude-opus-5[1m]';

const assistant = (sessionId, model) => ({
  type: 'assistant', session_id: sessionId, message: { model, content: [] },
});
const eventsFor = (sessionId, model) => [
  { type: 'system', subtype: 'init', session_id: sessionId, model: INIT_MODEL },
  assistant(sessionId, model),
  { type: 'result', session_id: sessionId, modelUsage: { [INIT_MODEL]: { input_tokens: 1 } } },
];
const dtoFor = ({ runId, missionId, sessionId }, model = RESPONSE_MODEL) => observeClaudeModel({
  runId, missionId, sessionId, events: eventsFor(sessionId, model),
});
const unknownDtoFor = ({ runId, missionId, sessionId }) => observeClaudeModel({
  runId, missionId, sessionId, events: [],
});
const conflictDtoFor = ({ runId, missionId, sessionId }) => observeClaudeModel({
  runId, missionId, sessionId,
  events: [assistant(sessionId, 'model-a'), assistant(sessionId, 'model-b')],
});

const start = (runId, missionId, sessionId) => ({
  provider: PROVIDER, runId, missionId, ...(sessionId === undefined ? {} : { sessionId }),
});

const runRecord = ({ fileName, provider = PROVIDER, runId, missionId, sessionId, threadId, modelObservation = null }) => ({
  fileName,
  error: null,
  record: {
    provider,
    runId,
    missionId,
    ...(sessionId === undefined ? {} : { sessionId }),
    ...(threadId === undefined ? {} : { threadId }),
    modelObservation,
  },
});

const unreadableRecord = (fileName, reason = 'unreadable: EACCES') => ({ fileName, record: null, error: reason });
const malformedRecord = (fileName) => ({ fileName, record: null, error: 'invalid JSON at position 0' });

const ID_A = { runId: 'run_a', missionId: 'MIS_A', sessionId: 'sess_a' };
const ID_B = { runId: 'run_b', missionId: 'MIS_B', sessionId: 'sess_b' };

// ---------------------------------------------------------------------------
// Frozen helper API presence (expected red while unimplemented)
// ---------------------------------------------------------------------------

test('helper API: both frozen consumer helpers are exported callables', () => {
  for (const name of [COLLECT_HELPER, STOP_HELPER]) {
    assert.equal(typeof acceptanceNs[name], 'function',
      `${name} must be an exported function of scripts/shared-gpu-acceptance.mjs`);
  }
});

// ---------------------------------------------------------------------------
// collectModelObservationEvidence — complete multi-Mission evidence
// ---------------------------------------------------------------------------

test('collector: complete two-Mission final records yield the observed summary', () => {
  const collect = helper(COLLECT_HELPER);
  const knownRuns = [start('run_a', 'MIS_A', 'sess_a'), start('run_b', 'MIS_B', 'sess_b')];
  const records = [
    runRecord({ fileName: 'run_a.json', ...ID_A, threadId: 'sess_a', modelObservation: dtoFor(ID_A) }),
    runRecord({ fileName: 'run_b.json', ...ID_B, threadId: 'sess_b', modelObservation: dtoFor(ID_B) }),
  ];
  const result = collect({ provider: PROVIDER, missionIds: ['MIS_A', 'MIS_B'], knownRuns, records });
  assert.equal(result.summary.status, 'observed');
  assert.equal(result.summary.model, RESPONSE_MODEL);
  assert.equal(result.summary.modelSource, 'observed');
  assert.equal(result.summary.requiredRunCount, 2);
  assert.equal(result.summary.observedRunCount, 2);
  assert.equal(result.requiredRuns.length, 2, 'one required identity per started run');
  assert.equal(result.observations.length, 2, 'one bound DTO per required run');
  assert.equal(result.unboundRuns.length, 0, 'a fully bound run set has no unbound evidence');
  const missions = [...new Set(result.observations.map((dto) => dto.missionId))].sort();
  assert.deepEqual(missions, ['MIS_A', 'MIS_B'], 'each observation keeps its own Mission binding');
});

test('collector: duplicate state observations never increase the required count', () => {
  const collect = helper(COLLECT_HELPER);
  // The same start is reported twice and the same final state is observed twice.
  const knownRuns = [start('run_a', 'MIS_A', 'sess_a'), start('run_a', 'MIS_A', 'sess_a'), start('run_b', 'MIS_B', 'sess_b')];
  const recordA = runRecord({ fileName: 'run_a.json', ...ID_A, modelObservation: dtoFor(ID_A) });
  const records = [recordA, structuredClone(recordA), runRecord({ fileName: 'run_b.json', ...ID_B, modelObservation: dtoFor(ID_B) })];
  const result = collect({ provider: PROVIDER, missionIds: ['MIS_A', 'MIS_B'], knownRuns, records });
  assert.equal(result.summary.status, 'observed');
  assert.equal(result.summary.requiredRunCount, 2, 'known starts dedupe by provider/run identity');
  assert.equal(result.summary.observedRunCount, 2);
  assert.equal(result.requiredRuns.length, 2);
});

test('collector: the same final state written with different key order is one duplicate', () => {
  const collect = helper(COLLECT_HELPER);
  const base = runRecord({ fileName: 'run_a.json', ...ID_A, threadId: 'sess_a', modelObservation: dtoFor(ID_A) });
  const reordered = {
    error: base.error,
    record: Object.fromEntries(Object.entries(base.record).reverse()),
    fileName: base.fileName,
  };
  assert.notEqual(JSON.stringify(base), JSON.stringify(reordered), 'fixture must differ in serialization order');
  const result = collect({ provider: PROVIDER, missionIds: ['MIS_A'], knownRuns: [start('run_a', 'MIS_A', 'sess_a')], records: [base, reordered] });
  assert.equal(result.summary.status, 'observed', 'semantically identical duplicates must not conflict');
  assert.equal(result.summary.requiredRunCount, 1);
  assert.equal(result.summary.observedRunCount, 1);
});

// ---------------------------------------------------------------------------
// collectModelObservationEvidence — the three Root-reproduced false observations
// ---------------------------------------------------------------------------

test('collector: a later unknown final record invalidates an earlier observed snapshot', () => {
  const collect = helper(COLLECT_HELPER);
  const knownRuns = [start('run_a', 'MIS_A', 'sess_a')];
  const earlierObserved = runRecord({ fileName: 'run_a.json', ...ID_A, modelObservation: dtoFor(ID_A) });
  const finalUnknown = runRecord({ fileName: 'run_a.json', ...ID_A, modelObservation: unknownDtoFor(ID_A) });
  const result = collect({ provider: PROVIDER, missionIds: ['MIS_A'], knownRuns, records: [earlierObserved, finalUnknown] });
  assert.notEqual(result.summary.status, 'observed',
    'a later unknown final state must never be masked by an earlier observed snapshot');
  assert.equal(result.summary.requiredRunCount, 1);
  assert.equal(result.summary.observedRunCount, 0);
});

test('collector: a later conflict final record invalidates an earlier observed snapshot', () => {
  const collect = helper(COLLECT_HELPER);
  const knownRuns = [start('run_a', 'MIS_A', 'sess_a')];
  const earlierObserved = runRecord({ fileName: 'run_a.json', ...ID_A, modelObservation: dtoFor(ID_A) });
  const finalConflict = runRecord({ fileName: 'run_a.json', ...ID_A, modelObservation: conflictDtoFor(ID_A) });
  const result = collect({ provider: PROVIDER, missionIds: ['MIS_A'], knownRuns, records: [earlierObserved, finalConflict] });
  assert.notEqual(result.summary.status, 'observed');
  assert.equal(result.summary.observedRunCount, 0);
});

test('collector: a DTO never supplies the expected session that the record lacks', () => {
  const collect = helper(COLLECT_HELPER);
  const knownRuns = [start('run_a', 'MIS_A', 'sess_record')];
  const mismatched = dtoFor({ runId: 'run_a', missionId: 'MIS_A', sessionId: 'sess_dto' });
  const records = [runRecord({
    fileName: 'run_a.json', runId: 'run_a', missionId: 'MIS_A', sessionId: 'sess_record',
    modelObservation: mismatched,
  })];
  const result = collect({ provider: PROVIDER, missionIds: ['MIS_A'], knownRuns, records });
  assert.notEqual(result.summary.status, 'observed',
    'the actual record session is the expected identity; the DTO may not supply its own');
  assert.equal(result.summary.observedRunCount, 0);
  assert.ok(!JSON.stringify(result.observations).includes('sess_dto'),
    'the mismatched DTO must not survive as bound evidence');
});

test('collector: an unreadable second run file cannot disappear from the denominator', () => {
  const collect = helper(COLLECT_HELPER);
  const knownRuns = [start('run_a', 'MIS_A', 'sess_a'), start('run_b', 'MIS_B', 'sess_b')];
  const records = [
    runRecord({ fileName: 'run_a.json', ...ID_A, modelObservation: dtoFor(ID_A) }),
    unreadableRecord('run_b.json'),
  ];
  const result = collect({ provider: PROVIDER, missionIds: ['MIS_A', 'MIS_B'], knownRuns, records });
  assert.equal(result.summary.requiredRunCount, 2, 'a started run without readable evidence stays required');
  assert.notEqual(result.summary.status, 'observed');
  assert.equal(result.summary.observedRunCount, 1);
  assert.ok(result.unboundRuns.some((entry) => JSON.stringify(entry).includes('run_b')),
    'the unreadable run must be retained as unbound evidence with its identity');
  assert.ok(result.unboundRuns.every((entry) => (typeof entry.reason === 'string' && entry.reason.trim().length > 0)
    || (Array.isArray(entry.reasons) && entry.reasons.length > 0 && entry.reasons.every((reason) => typeof reason === 'string' && reason.trim().length > 0))),
  'every unbound run must carry a nonblank reason');
});

test('collector: a malformed second run file cannot disappear from the denominator', () => {
  const collect = helper(COLLECT_HELPER);
  const knownRuns = [start('run_a', 'MIS_A', 'sess_a'), start('run_b', 'MIS_B', 'sess_b')];
  const records = [
    runRecord({ fileName: 'run_a.json', ...ID_A, modelObservation: dtoFor(ID_A) }),
    malformedRecord('run_b.json'),
  ];
  const result = collect({ provider: PROVIDER, missionIds: ['MIS_A', 'MIS_B'], knownRuns, records });
  assert.equal(result.summary.requiredRunCount, 2);
  assert.notEqual(result.summary.status, 'observed');
  assert.ok(result.unboundRuns.some((entry) => JSON.stringify(entry).includes('run_b')));
});

test('collector: a new safe unreadable run file stays unbound and blocks observation', () => {
  const collect = helper(COLLECT_HELPER);
  const knownRuns = [start('run_a', 'MIS_A', 'sess_a')];
  const records = [
    runRecord({ fileName: 'run_a.json', ...ID_A, modelObservation: dtoFor(ID_A) }),
    unreadableRecord('run_extra.json'),
  ];
  const result = collect({ provider: PROVIDER, missionIds: ['MIS_A'], knownRuns, records });
  assert.notEqual(result.summary.status, 'observed',
    'an unreadable new run file must block the summary instead of being silently skipped');
  assert.ok(result.unboundRuns.some((entry) => JSON.stringify(entry).includes('run_extra')),
    'the new run file must remain unbound evidence with its filename identity');
});

test('collector: a known run with no final record keeps its required identity', () => {
  const collect = helper(COLLECT_HELPER);
  const knownRuns = [start('run_a', 'MIS_A', 'sess_a'), start('run_b', 'MIS_B', 'sess_b')];
  const records = [runRecord({ fileName: 'run_a.json', ...ID_A, modelObservation: dtoFor(ID_A) })];
  const result = collect({ provider: PROVIDER, missionIds: ['MIS_A', 'MIS_B'], knownRuns, records });
  assert.equal(result.summary.requiredRunCount, 2, 'a started run with no retained final record stays required');
  assert.equal(result.summary.observedRunCount, 1);
  assert.notEqual(result.summary.status, 'observed');
});

// ---------------------------------------------------------------------------
// collectModelObservationEvidence — binding conflicts
// ---------------------------------------------------------------------------

test('collector: two Missions keep their own binding and a foreign-Mission file is ignored', () => {
  const collect = helper(COLLECT_HELPER);
  const knownRuns = [start('run_a', 'MIS_A', 'sess_a'), start('run_b', 'MIS_B', 'sess_b')];
  const records = [
    runRecord({ fileName: 'run_a.json', ...ID_A, modelObservation: dtoFor(ID_A) }),
    runRecord({ fileName: 'run_b.json', ...ID_B, modelObservation: dtoFor(ID_B) }),
    runRecord({
      fileName: 'run_c.json', runId: 'run_c', missionId: 'MIS_C', sessionId: 'sess_c',
      threadId: 'sess_c', modelObservation: dtoFor({ runId: 'run_c', missionId: 'MIS_C', sessionId: 'sess_c' }),
    }),
  ];
  const result = collect({ provider: PROVIDER, missionIds: ['MIS_A', 'MIS_B'], knownRuns, records });
  assert.equal(result.summary.status, 'observed', 'an unrelated foreign-Mission file is not evidence for this attempt');
  assert.equal(result.summary.requiredRunCount, 2, 'foreign files never relabel or extend the current Mission set');
  const missions = [...new Set(result.observations.map((dto) => dto.missionId))].sort();
  assert.deepEqual(missions, ['MIS_A', 'MIS_B'], 'no current-active Mission may relabel historical runs');
});

test('collector: a foreign provider record cannot bind a known claude-code start', () => {
  const collect = helper(COLLECT_HELPER);
  const knownRuns = [start('run_a', 'MIS_A', 'sess_a')];
  const records = [runRecord({
    fileName: 'run_a.json', provider: 'codex-cli', runId: 'run_a', missionId: 'MIS_A',
    sessionId: 'sess_a', modelObservation: dtoFor(ID_A),
  })];
  const result = collect({ provider: PROVIDER, missionIds: ['MIS_A'], knownRuns, records });
  assert.notEqual(result.summary.status, 'observed');
  assert.equal(result.summary.requiredRunCount, 1);
});

test('collector: a conflicting Mission on a known run cannot be overwritten', () => {
  const collect = helper(COLLECT_HELPER);
  const knownRuns = [start('run_a', 'MIS_A', 'sess_a')];
  const records = [runRecord({
    fileName: 'run_a.json', runId: 'run_a', missionId: 'MIS_B', sessionId: 'sess_a',
    modelObservation: dtoFor({ runId: 'run_a', missionId: 'MIS_B', sessionId: 'sess_a' }),
  })];
  const result = collect({ provider: PROVIDER, missionIds: ['MIS_A', 'MIS_B'], knownRuns, records });
  assert.notEqual(result.summary.status, 'observed');
  assert.equal(result.summary.requiredRunCount, 1, 'a concrete known Mission is never overwritten by the record');
});

test('collector: a conflicting record session is rejected', () => {
  const collect = helper(COLLECT_HELPER);
  const knownRuns = [start('run_a', 'MIS_A', 'sess_one')];
  const records = [runRecord({
    fileName: 'run_a.json', runId: 'run_a', missionId: 'MIS_A', sessionId: 'sess_two',
    modelObservation: dtoFor({ runId: 'run_a', missionId: 'MIS_A', sessionId: 'sess_two' }),
  })];
  const result = collect({ provider: PROVIDER, missionIds: ['MIS_A'], knownRuns, records });
  assert.notEqual(result.summary.status, 'observed');
  assert.equal(result.summary.observedRunCount, 0);
});

test('collector: a record whose session and thread disagree is rejected', () => {
  const collect = helper(COLLECT_HELPER);
  const knownRuns = [start('run_a', 'MIS_A', 'sess_a')];
  const records = [runRecord({
    fileName: 'run_a.json', runId: 'run_a', missionId: 'MIS_A', sessionId: 'sess_a', threadId: 'thread_other',
    modelObservation: dtoFor(ID_A),
  })];
  const result = collect({ provider: PROVIDER, missionIds: ['MIS_A'], knownRuns, records });
  assert.notEqual(result.summary.status, 'observed', 'nonblank session/thread must agree');
});

test('collector: an unsafe filename is not admissible run evidence', () => {
  const collect = helper(COLLECT_HELPER);
  const knownRuns = [start('run_a', 'MIS_A', 'sess_a')];
  for (const fileName of ['../run_a.json', 'nested/run_a.json', 'run_a.txt', '-run_a.json']) {
    const records = [runRecord({ fileName, ...ID_A, modelObservation: dtoFor(ID_A) })];
    const result = collect({ provider: PROVIDER, missionIds: ['MIS_A'], knownRuns, records });
    assert.notEqual(result.summary.status, 'observed', `unsafe filename ${fileName} must not be admitted`);
    assert.equal(result.summary.requiredRunCount, 1);
  }
});

test('collector: a blank or missing record runId cannot bind', () => {
  const collect = helper(COLLECT_HELPER);
  const knownRuns = [start('run_a', 'MIS_A', 'sess_a')];
  for (const runId of ['', '   ']) {
    const records = [runRecord({
      fileName: 'run_a.json', runId, missionId: 'MIS_A', sessionId: 'sess_a', modelObservation: dtoFor(ID_A),
    })];
    const result = collect({ provider: PROVIDER, missionIds: ['MIS_A'], knownRuns, records });
    assert.notEqual(result.summary.status, 'observed');
  }
});

test('collector: a missing session may be completed only from the actual record', () => {
  const collect = helper(COLLECT_HELPER);
  const knownRuns = [{ provider: PROVIDER, runId: 'run_a', missionId: 'MIS_A' }];
  const records = [runRecord({
    fileName: 'run_a.json', runId: 'run_a', missionId: 'MIS_A', sessionId: 'sess_a', modelObservation: dtoFor(ID_A),
  })];
  const result = collect({ provider: PROVIDER, missionIds: ['MIS_A'], knownRuns, records });
  assert.equal(result.summary.status, 'observed', 'a blank known session is completed by the current-attempt record');
  assert.equal(result.summary.requiredRunCount, 1);
});

test('collector: a blank final-record session is never completed from the DTO', () => {
  const collect = helper(COLLECT_HELPER);
  const knownRuns = [start('run_a', 'MIS_A', 'sess_a')];
  const records = [runRecord({
    fileName: 'run_a.json', runId: 'run_a', missionId: 'MIS_A', sessionId: '', modelObservation: dtoFor(ID_A),
  })];
  const result = collect({ provider: PROVIDER, missionIds: ['MIS_A'], knownRuns, records });
  assert.notEqual(result.summary.status, 'observed');
  assert.equal(result.summary.observedRunCount, 0);
});

test('collector: a blank known run identity is never observed', () => {
  const collect = helper(COLLECT_HELPER);
  const knownRuns = [start('', 'MIS_A', 'sess_a')];
  const records = [runRecord({ fileName: 'run_a.json', ...ID_A, modelObservation: dtoFor(ID_A) })];
  const result = collect({ provider: PROVIDER, missionIds: ['MIS_A'], knownRuns, records });
  assert.notEqual(result.summary.status, 'observed');
});

// ---------------------------------------------------------------------------
// Frozen additions: contradictory known-start identities never resolve first-wins
// ---------------------------------------------------------------------------

test('collector: contradictory known-start Missions for one run never resolve first-wins in either order', () => {
  const collect = helper(COLLECT_HELPER);
  const starts = [start('run_a', 'MIS_A', 'sess_a'), start('run_a', 'MIS_B', 'sess_a')];
  for (const ordered of [starts, [...starts].reverse()]) {
    const records = [runRecord({ fileName: 'run_a.json', ...ID_A, threadId: 'sess_a', modelObservation: dtoFor(ID_A) })];
    const result = collect({ provider: PROVIDER, missionIds: ['MIS_A', 'MIS_B'], knownRuns: ordered, records });
    assert.notEqual(result.summary.status, 'observed',
      'two concrete Missions on one provider/run start contradict; neither may win by list order');
    assert.equal(result.summary.observedRunCount, 0, 'a contradictory known start must not be observed');
    assert.equal(result.summary.requiredRunCount, 1, 'the contradictory pair still dedupes to one required run');
    assert.ok(result.unboundRuns.length > 0, 'the contradiction must be retained as unbound evidence');
    assert.ok(result.unboundRuns.every((entry) => (typeof entry.reason === 'string' && entry.reason.trim().length > 0)
      || (Array.isArray(entry.reasons) && entry.reasons.length > 0 && entry.reasons.every((reason) => typeof reason === 'string' && reason.trim().length > 0))),
    'every unbound run must carry a nonblank reason');
  }
});

test('collector: contradictory known-start sessions for one run never resolve first-wins in either order', () => {
  const collect = helper(COLLECT_HELPER);
  const starts = [start('run_a', 'MIS_A', 'sess_a'), start('run_a', 'MIS_A', 'sess_other')];
  for (const ordered of [starts, [...starts].reverse()]) {
    const records = [runRecord({ fileName: 'run_a.json', ...ID_A, threadId: 'sess_a', modelObservation: dtoFor(ID_A) })];
    const result = collect({ provider: PROVIDER, missionIds: ['MIS_A'], knownRuns: ordered, records });
    assert.notEqual(result.summary.status, 'observed',
      'two concrete sessions on one provider/run start contradict; neither may win by list order');
    assert.equal(result.summary.observedRunCount, 0);
    assert.equal(result.summary.requiredRunCount, 1, 'the contradictory pair still dedupes to one required run');
    assert.ok(result.unboundRuns.length > 0, 'the contradiction must be retained as unbound evidence');
  }
});

test('collector: a known start missing Mission and session is completed only by the current actual record', () => {
  const collect = helper(COLLECT_HELPER);
  const record = runRecord({
    fileName: 'run_a.json', runId: 'run_a', missionId: 'MIS_A', sessionId: 'sess_a', modelObservation: dtoFor(ID_A),
  });
  const result = collect({
    provider: PROVIDER, missionIds: ['MIS_A'],
    knownRuns: [{ provider: PROVIDER, runId: 'run_a' }, { provider: PROVIDER, runId: 'run_a' }],
    records: [record, structuredClone(record)],
  });
  assert.equal(result.summary.status, 'observed',
    'the current actual record supplies the unknown Mission and session of the known start');
  assert.equal(result.summary.requiredRunCount, 1, 'consistent duplicate starts and duplicate records add no denominator entry');
  assert.equal(result.summary.observedRunCount, 1);
  assert.equal(result.unboundRuns.length, 0);
});

test('collector: a DTO never supplies an unknown known-start Mission or session', () => {
  const collect = helper(COLLECT_HELPER);
  const knownRuns = [{ provider: PROVIDER, runId: 'run_a' }];
  const recordWithoutSession = runRecord({
    fileName: 'run_a.json', runId: 'run_a', missionId: 'MIS_A', modelObservation: dtoFor(ID_A),
  });
  const recordWithoutMission = runRecord({
    fileName: 'run_a.json', runId: 'run_a', sessionId: 'sess_a', modelObservation: dtoFor(ID_A),
  });
  for (const record of [recordWithoutSession, recordWithoutMission]) {
    const result = collect({ provider: PROVIDER, missionIds: ['MIS_A'], knownRuns, records: [structuredClone(record)] });
    assert.notEqual(result.summary.status, 'observed',
      'a DTO field may never supply an expected identity the actual current record lacks');
    assert.equal(result.summary.observedRunCount, 0);
    assert.ok(!JSON.stringify(result.observations).includes('sess_a')
      && !JSON.stringify(result.observations).includes('MIS_A'),
    'no DTO-supplied identity may survive as bound evidence');
  }
});

// ---------------------------------------------------------------------------
// Frozen additions: duplicate final-record content fails closed in any order
// ---------------------------------------------------------------------------

const reverseKeysDeep = (value) => {
  if (Array.isArray(value)) return value.map(reverseKeysDeep);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).reverse().map(([key, inner]) => [key, reverseKeysDeep(inner)]));
  }
  return value;
};

test('collector: semantically identical duplicates with nested key order are not a conflict', () => {
  const collect = helper(COLLECT_HELPER);
  const base = runRecord({ fileName: 'run_a.json', ...ID_A, threadId: 'sess_a', modelObservation: dtoFor(ID_A) });
  const reordered = reverseKeysDeep(structuredClone(base));
  assert.notEqual(JSON.stringify(base), JSON.stringify(reordered), 'fixture must differ only in JSON key order');
  const result = collect({
    provider: PROVIDER, missionIds: ['MIS_A'], knownRuns: [start('run_a', 'MIS_A', 'sess_a')],
    records: [base, reordered],
  });
  assert.equal(result.summary.status, 'observed', 'semantically identical duplicates must never conflict');
  assert.equal(result.summary.requiredRunCount, 1);
  assert.equal(result.summary.observedRunCount, 1);
});

test('collector: conflicting duplicate final records fail closed in either order', () => {
  const collect = helper(COLLECT_HELPER);
  const knownRuns = [start('run_a', 'MIS_A', 'sess_a')];
  const observed = runRecord({ fileName: 'run_a.json', ...ID_A, modelObservation: dtoFor(ID_A) });
  const unknown = runRecord({ fileName: 'run_a.json', ...ID_A, modelObservation: unknownDtoFor(ID_A) });
  const conflict = runRecord({ fileName: 'run_a.json', ...ID_A, modelObservation: conflictDtoFor(ID_A) });
  const otherModel = runRecord({ fileName: 'run_a.json', ...ID_A, modelObservation: dtoFor(ID_A, 'model-other') });
  const pairs = [
    ['unknown then observed', unknown, observed],
    ['observed then unknown', observed, unknown],
    ['conflict then observed', conflict, observed],
    ['observed then conflict', observed, conflict],
    ['model-a then model-b', observed, otherModel],
    ['model-b then model-a', otherModel, observed],
  ];
  for (const [label, first, second] of pairs) {
    const result = collect({
      provider: PROVIDER, missionIds: ['MIS_A'], knownRuns,
      records: [structuredClone(first), structuredClone(second)],
    });
    assert.notEqual(result.summary.status, 'observed',
      `${label}: two final records with conflicting content for one file must fail closed`);
    assert.equal(result.summary.requiredRunCount, 1, `${label}: the run stays in the denominator exactly once`);
    assert.equal(result.summary.observedRunCount, 0, `${label}: no conflicting duplicate may be observed`);
  }
});

// ---------------------------------------------------------------------------
// Frozen additions: invalid extra safe run files may not be dropped
// ---------------------------------------------------------------------------

test('collector: an invalid extra safe run file stays unbound and required', () => {
  const collect = helper(COLLECT_HELPER);
  const knownRuns = [start('run_a', 'MIS_A', 'sess_a')];
  const validA = runRecord({ fileName: 'run_a.json', ...ID_A, modelObservation: dtoFor(ID_A) });
  const extraDto = dtoFor({ runId: 'run_extra', missionId: 'MIS_A', sessionId: 'sess_x' });
  const variants = [
    ['a parsed empty object', { fileName: 'run_extra.json', record: {}, error: null }],
    ['a parsed array', { fileName: 'run_extra.json', record: [], error: null }],
    ['a record without a Mission', runRecord({
      fileName: 'run_extra.json', runId: 'run_extra', sessionId: 'sess_x', modelObservation: extraDto,
    })],
    ['an expected-Mission record with a foreign provider', runRecord({
      fileName: 'run_extra.json', provider: 'codex-cli', runId: 'run_extra', missionId: 'MIS_A',
      sessionId: 'sess_x', modelObservation: extraDto,
    })],
  ];
  for (const [label, extra] of variants) {
    const result = collect({
      provider: PROVIDER, missionIds: ['MIS_A'], knownRuns,
      records: [structuredClone(validA), extra],
    });
    assert.notEqual(result.summary.status, 'observed', `${label}: an invalid extra run file must block observation`);
    assert.equal(result.summary.requiredRunCount, 2,
      `${label}: the invalid extra file stays in the denominator instead of disappearing`);
    assert.ok(result.unboundRuns.some((entry) => JSON.stringify(entry).includes('run_extra')),
      `${label}: the invalid extra file must remain unbound evidence with its identity`);
    assert.ok(result.unboundRuns.every((entry) => (typeof entry.reason === 'string' && entry.reason.trim().length > 0)
      || (Array.isArray(entry.reasons) && entry.reasons.length > 0)),
    `${label}: every unbound run must carry a nonblank reason`);
  }
});

test('collector: a concrete unrelated foreign-Mission file is still ignored, never miscounted', () => {
  const collect = helper(COLLECT_HELPER);
  const knownRuns = [start('run_a', 'MIS_A', 'sess_a'), start('run_b', 'MIS_B', 'sess_b')];
  const records = [
    runRecord({ fileName: 'run_a.json', ...ID_A, modelObservation: dtoFor(ID_A) }),
    runRecord({ fileName: 'run_b.json', ...ID_B, modelObservation: dtoFor(ID_B) }),
    runRecord({
      fileName: 'run_z.json', runId: 'run_z', missionId: 'MIS_Z', sessionId: 'sess_z',
      modelObservation: dtoFor({ runId: 'run_z', missionId: 'MIS_Z', sessionId: 'sess_z' }),
    }),
  ];
  const result = collect({ provider: PROVIDER, missionIds: ['MIS_A', 'MIS_B'], knownRuns, records });
  assert.equal(result.summary.status, 'observed',
    'a concrete unrelated foreign-Mission file not referenced by a known start is not current-attempt evidence');
  assert.equal(result.summary.requiredRunCount, 2);
  assert.equal(result.summary.observedRunCount, 2);
  assert.equal(result.unboundRuns.length, 0, 'an ignored foreign-Mission file must not become unbound evidence');
});

// ---------------------------------------------------------------------------
// evaluateMissionStopReceipt — real {state} HTTP shape
// ---------------------------------------------------------------------------

const STOP_MISSION = 'MIS_STOP';
const STOP_RUN = 'run_stop';

const stopState = () => ({
  activeMissionId: STOP_MISSION,
  missionPaused: true,
  missions: [{ id: STOP_MISSION, status: 'stopped' }],
  iterationStats: { loopStatus: 'stopped', loopStatusReason: 'stopped_by_tester', stoppedAt: '2026-09-13T00:00:00.000Z' },
  workflowRecovery: {
    resourceRelease: {
      confirmed: true, status: 'confirmed', blocked: false, quarantined: false, reason: 'mission_stop',
      resources: [{ kind: 'agent', id: STOP_RUN, confirmed: true, status: 'confirmed' }],
    },
  },
  agent: {
    runId: STOP_RUN, missionId: STOP_MISSION, status: 'cancelled',
    resourceRelease: { confirmed: true, status: 'confirmed' },
  },
});

test('stop receipt: a confirmed current-Mission release is accepted', () => {
  const evaluate = helper(STOP_HELPER);
  const result = evaluate({ missionId: STOP_MISSION, receipt: { state: stopState() } });
  assert.equal(result.confirmed, true);
  assert.ok(Array.isArray(result.reasons));
  assert.equal(result.reasons.length, 0, 'a confirmed receipt needs no rejection reason');
});

test('stop receipt: a released Mission with no current Agent run is accepted', () => {
  const evaluate = helper(STOP_HELPER);
  const state = stopState();
  delete state.agent;
  state.workflowRecovery.resourceRelease.resources = [{ kind: 'test', id: 'task_1', confirmed: true, status: 'confirmed' }];
  assert.equal(evaluate({ missionId: STOP_MISSION, receipt: { state } }).confirmed, true);
});

test('stop receipt: HTTP 202 only becomes confirmed with a proving state', () => {
  const evaluate = helper(STOP_HELPER);
  assert.equal(evaluate({ missionId: STOP_MISSION, receipt: { statusCode: 202, state: stopState() } }).confirmed, true,
    'a 202 body whose state proves release may be confirmed from that state');
  const pending = stopState();
  pending.workflowRecovery.resourceRelease = {
    confirmed: false, status: 'pending', resources: [{ kind: 'agent', id: STOP_RUN, confirmed: false, status: 'pending' }],
  };
  pending.agent.resourceRelease = { confirmed: false, status: 'pending' };
  assert.equal(evaluate({ missionId: STOP_MISSION, receipt: { statusCode: 202, state: pending } }).confirmed, false,
    'a 202 without release proof is never confirmed');
});

test('stop receipt: the helper is pure and never mutates its input', () => {
  const evaluate = helper(STOP_HELPER);
  const accepted = deepFreeze(stopState());
  const acceptedBefore = JSON.stringify(accepted);
  assert.equal(evaluate({ missionId: STOP_MISSION, receipt: { state: accepted } }).confirmed, true);
  assert.equal(JSON.stringify(accepted), acceptedBefore, 'a confirmed evaluation must not mutate the receipt state');

  const rejected = deepFreeze((() => { const state = stopState(); state.missionPaused = false; return state; })());
  const rejectedBefore = JSON.stringify(rejected);
  assert.equal(evaluate({ missionId: STOP_MISSION, receipt: { state: rejected } }).confirmed, false);
  assert.equal(JSON.stringify(rejected), rejectedBefore, 'a rejected evaluation must not mutate the receipt state');
});

const rejectStop = (name, mutate, { missionId = STOP_MISSION } = {}) => test(`stop receipt rejects: ${name}`, () => {
  const evaluate = helper(STOP_HELPER);
  const state = stopState();
  mutate(state);
  const frozen = deepFreeze(state);
  const before = JSON.stringify(frozen);
  const result = evaluate({ missionId, receipt: { state: frozen } });
  assert.equal(result.confirmed, false, `${name} must not confirm`);
  assert.ok(Array.isArray(result.reasons) && result.reasons.length > 0, `${name} must retain a reason`);
  assert.equal(JSON.stringify(frozen), before, `${name} must not mutate the receipt state`);
});

rejectStop('a missing workflowRecovery.resourceRelease', (state) => { delete state.workflowRecovery.resourceRelease; });
rejectStop('a top-level resourceRelease only', (state) => {
  delete state.workflowRecovery.resourceRelease;
  state.resourceRelease = { confirmed: true, status: 'confirmed', resources: [{ kind: 'agent', id: STOP_RUN, confirmed: true, status: 'confirmed' }] };
});
rejectStop('a pending mission release', (state) => {
  state.workflowRecovery.resourceRelease = { confirmed: false, status: 'pending', resources: [{ kind: 'agent', id: STOP_RUN, confirmed: false, status: 'pending' }] };
  state.agent.resourceRelease = { confirmed: false, status: 'pending' };
});
rejectStop('an unconfirmed resource status', (state) => {
  state.workflowRecovery.resourceRelease.resources = [{ kind: 'agent', id: STOP_RUN, confirmed: true, status: 'unconfirmed' }];
});
rejectStop('a resource without an explicit confirmed flag', (state) => {
  state.workflowRecovery.resourceRelease.resources = [{ kind: 'agent', id: STOP_RUN, status: 'confirmed' }];
});
rejectStop('a resource with confirmed false', (state) => {
  state.workflowRecovery.resourceRelease.resources = [{ kind: 'agent', id: STOP_RUN, confirmed: false, status: 'confirmed' }];
});
rejectStop('a blocked resource', (state) => {
  state.workflowRecovery.resourceRelease.resources = [{ kind: 'agent', id: STOP_RUN, confirmed: true, status: 'confirmed', blocked: true }];
});
rejectStop('a quarantined resource', (state) => {
  state.workflowRecovery.resourceRelease.resources = [{ kind: 'agent', id: STOP_RUN, confirmed: true, status: 'confirmed', quarantined: true }];
});
rejectStop('a missing resources array', (state) => {
  state.workflowRecovery.resourceRelease = { confirmed: true, status: 'confirmed' };
});
rejectStop('missionPaused false', (state) => { state.missionPaused = false; });
rejectStop('a running loop intent', (state) => { state.iterationStats.loopStatus = 'running'; });
rejectStop('a foreign activeMissionId', (state) => { state.activeMissionId = 'MIS_OTHER'; });
rejectStop('a missing activeMissionId', (state) => { delete state.activeMissionId; });
rejectStop('a current Agent release barrier', (state) => {
  state.agent.resourceRelease = { confirmed: false, status: 'unconfirmed' };
});
rejectStop('a current Agent bound to a foreign Mission', (state) => { state.agent.missionId = 'MIS_OTHER'; });
rejectStop('a terminal Agent without release proof', (state) => {
  state.agent = { runId: STOP_RUN, missionId: STOP_MISSION, status: 'cancelled' };
});
rejectStop('a mismatched requested Mission', (state) => {}, { missionId: 'MIS_OTHER' });

// A confirmed Mission aggregate is not enough: any other current execution
// resource still in a barrier state must be rejected through the existing
// cancellation contract (researchAgent / baseline.materializer / benchmark).
rejectStop('a cancel_requested research Agent despite a confirmed Mission aggregate', (state) => {
  state.researchAgent = {
    runId: 'run_research', missionId: STOP_MISSION, status: 'cancel_requested',
    resourceRelease: { confirmed: true, status: 'confirmed' },
  };
});
rejectStop('a pending research Agent release', (state) => {
  state.researchAgent = {
    runId: 'run_research', missionId: STOP_MISSION, status: 'running',
    resourceRelease: { confirmed: false, status: 'pending' },
  };
});
rejectStop('an unconfirmed materializer release', (state) => {
  state.baseline = {
    materializer: {
      runId: 'run_materializer', missionId: STOP_MISSION, status: 'running',
      resourceRelease: { confirmed: false, status: 'unconfirmed' },
    },
  };
});
rejectStop('a quarantined benchmark release', (state) => {
  state.benchmark = {
    testTaskId: 'task_benchmark', missionId: STOP_MISSION, status: 'running',
    resourceRelease: { confirmed: true, status: 'quarantined', quarantined: true },
  };
});
rejectStop('a cancel_requested benchmark despite a confirmed Mission aggregate', (state) => {
  state.benchmark = {
    testTaskId: 'task_benchmark', missionId: STOP_MISSION, status: 'cancel_requested',
    resourceRelease: { confirmed: true, status: 'confirmed' },
  };
});
// paused / idle are not an explicit stopped intent.
rejectStop('a paused loop intent', (state) => { state.iterationStats.loopStatus = 'paused'; });
rejectStop('an idle loop intent', (state) => { state.iterationStats.loopStatus = 'idle'; });

test('stop receipt: an idle null-run Agent with a stopped Mission and explicit empty release confirms', () => {
  const evaluate = helper(STOP_HELPER);
  const state = stopState();
  state.agent = { runId: null, status: 'idle', missionId: null };
  state.workflowRecovery.resourceRelease = {
    confirmed: true, status: 'confirmed', blocked: false, quarantined: false, reason: 'mission_stop', resources: [],
  };
  const frozen = deepFreeze(state);
  const before = JSON.stringify(frozen);
  const result = evaluate({ missionId: STOP_MISSION, receipt: { state: frozen } });
  assert.equal(result.confirmed, true,
    'an idle Agent without a current run must not fabricate an Agent release requirement');
  assert.equal(result.reasons.length, 0, 'a confirmed no-current-run baseline needs no rejection reason');
  assert.equal(JSON.stringify(frozen), before, 'the baseline evaluation must stay pure');
});

rejectStop('a current Agent run that is idle but has no release proof', (state) => {
  state.agent = { runId: STOP_RUN, missionId: STOP_MISSION, status: 'idle' };
});

test('stop receipt: a missing or malformed receipt is rejected', () => {
  const evaluate = helper(STOP_HELPER);
  assert.equal(evaluate({ missionId: STOP_MISSION, receipt: null }).confirmed, false);
  assert.equal(evaluate({ missionId: STOP_MISSION, receipt: {} }).confirmed, false);
  assert.equal(evaluate({ missionId: STOP_MISSION, receipt: { state: null } }).confirmed, false);
  assert.equal(evaluate({ missionId: '', receipt: { state: stopState() } }).confirmed, false);
});

// ---------------------------------------------------------------------------
// Ledger additions: declared summary shape and contradictory duplicate aliases
// ---------------------------------------------------------------------------

const LEDGER_MISSION = 'MIS_LEDGER';

const baseConfig = (model = RESPONSE_MODEL) => ({
  provider: {
    runtime: 'claude-code', cliVersion: '1.2.3', cliVersionSource: 'runtime-descriptor',
    model, modelSource: 'observed',
    modelObservationStatus: 'observed', modelObservationVersion: MODEL_OBSERVATION_SCHEMA_VERSION,
  },
  backend: { kind: 'local-shared-gpu', executionMode: 'gpu', publishable: false },
  hardware: ['nvidia-gpu'], architecture: ['sm86'],
  device: 'NVIDIA GeForce RTX 3060 Laptop GPU', driverVersion: '555.99',
  families: ['affine'], candidateTasks: 2,
  matrix: {
    environments: ['local-shared-gpu'], stages: ['Correctness', 'Full Benchmark'],
    correctnessCases: 4, warmup: 3, repeats: 10,
  },
  promptPolicy: {
    experienceSelectionPolicyVersion: 'operator-studio.experience-selection/v1',
    roundFactsSchemaVersion: ROUND_FACTS_SCHEMA_VERSION,
  },
  budgets: { missionBudgetMs: 720_000, mainAgentBudgetMs: 180_000 },
  code: { commit: 'a'.repeat(40), dirty: false, contentDigest: `sha256:${'b'.repeat(64)}` },
});

const proofFor = (runIds, { model = RESPONSE_MODEL } = {}) => {
  const requiredRuns = runIds.map((runId) => ({
    provider: PROVIDER, runId, missionId: LEDGER_MISSION, sessionId: `sess_${runId}`,
  }));
  const modelObservations = requiredRuns.map((binding) => dtoFor(binding, model));
  return { requiredRuns, modelObservations, summary: summarizeModelObservations(modelObservations, { requiredRuns }) };
};

const ledgerRecord = ({ runDir, attemptId, proof, config }) => {
  const fingerprint = buildConfigFingerprint(config, { code: config.code }).fingerprint;
  const familyOutcome = { family: 'affine', outcome: 'full_success', fullSuccess: true };
  const evidence = {
    modelObservations: proof.modelObservations,
    modelObservationRequiredRuns: proof.requiredRuns,
    modelObservationSummary: proof.summary,
  };
  return {
    runDir,
    attempt: {
      schemaVersion: GPU_ATTEMPT_SCHEMA_VERSION, attemptId, runRoot: runDir,
      phase: 'terminal', status: 'terminal', outcome: 'full_success', fullSuccess: true,
      config, code: config.code, configFingerprint: fingerprint,
      families: ['affine'], candidateTasks: 2, familyOutcomes: [{ ...familyOutcome }],
      ...structuredClone(evidence),
    },
    summary: {
      schemaVersion: GPU_SUMMARY_SCHEMA_VERSION, status: 'passed', outcome: 'full_success', fullSuccess: true,
      config, code: config.code, configFingerprint: fingerprint, families: ['affine'],
      summaries: [{ ...familyOutcome }],
      ...structuredClone(evidence),
    },
  };
};

test('ledger: a complete observed proof stays comparable', () => {
  const proof = proofFor(['run_ledger_positive']);
  const record = ledgerRecord({ runDir: 'C:/ledger/positive', attemptId: 'attempt-positive', proof, config: baseConfig() });
  const ledger = summarizeAcceptanceRuns([record]);
  assert.equal(ledger.groups.length, 1);
  assert.equal(ledger.groups[0].comparable, true);
  assert.equal(ledger.groups[0].counts.runs, 1);
  assert.equal(ledger.groups[0].n20.eligible, false);
});

test('ledger: a declared modelObservationSummary without reasons is not comparable', () => {
  const proof = proofFor(['run_ledger_missing_reasons']);
  const malformed = structuredClone(proof.summary);
  delete malformed.reasons;
  const record = ledgerRecord({ runDir: 'C:/ledger/missing-reasons', attemptId: 'attempt-missing-reasons', proof, config: baseConfig() });
  record.attempt.modelObservationSummary = structuredClone(malformed);
  record.summary.modelObservationSummary = structuredClone(malformed);
  const ledger = summarizeAcceptanceRuns([record]);
  assert.equal(ledger.groups[0].comparable, false, 'a declared summary missing its required reasons array is malformed');
  assert.equal(ledger.groups[0].n20.eligible, false);
});

test('ledger: a declared modelObservationSummary with a non-array reasons is not comparable', () => {
  const proof = proofFor(['run_ledger_bad_reasons']);
  const malformed = { ...structuredClone(proof.summary), reasons: 'observed' };
  const record = ledgerRecord({ runDir: 'C:/ledger/bad-reasons', attemptId: 'attempt-bad-reasons', proof, config: baseConfig() });
  record.attempt.modelObservationSummary = structuredClone(malformed);
  record.summary.modelObservationSummary = structuredClone(malformed);
  assert.equal(summarizeAcceptanceRuns([record]).groups[0].comparable, false);
});

test('ledger: an observed summary carrying a reason is not comparable', () => {
  const proof = proofFor(['run_ledger_observed_reason']);
  const malformed = { ...structuredClone(proof.summary), status: 'observed', reasons: ['stale snapshot retained'] };
  const record = ledgerRecord({ runDir: 'C:/ledger/observed-reason', attemptId: 'attempt-observed-reason', proof, config: baseConfig() });
  record.attempt.modelObservationSummary = structuredClone(malformed);
  record.summary.modelObservationSummary = structuredClone(malformed);
  assert.equal(summarizeAcceptanceRuns([record]).groups[0].comparable, false,
    'an observed summary with a retained reason is contradictory and cannot support comparability');
});

test('ledger: duplicate aliases with contradictory per-run model proof are a conflict', () => {
  const config = baseConfig(RESPONSE_MODEL);
  const first = ledgerRecord({
    runDir: 'C:/ledger/alias', attemptId: 'attempt-alias',
    proof: proofFor(['run_alias'], { model: RESPONSE_MODEL }), config,
  });
  const second = ledgerRecord({
    runDir: 'C:/ledger/alias', attemptId: 'attempt-alias',
    proof: proofFor(['run_alias'], { model: 'model-other' }), config,
  });
  const ledger = summarizeAcceptanceRuns([first, second]);
  assert.equal(ledger.totals.runs, 1, 'a duplicate alias never adds a sample to the denominator');
  assert.equal(ledger.totals.duplicateRuns, 1);
  assert.equal(ledger.duplicates[0].conflict, true,
    'same config/outcome but contradictory model proof must be a duplicate conflict');
  assert.equal(ledger.groups[0].counts.runs, 1);
  assert.equal(ledger.groups[0].comparable, false,
    'a contradictory duplicate must not be silently deduped to the first good record');
  assert.equal(ledger.groups[0].n20.eligible, false);
});

// ---------------------------------------------------------------------------
// Verdict
// ---------------------------------------------------------------------------

const passed = cases.filter((entry) => entry.passed).length;
const failed = cases.filter((entry) => !entry.passed);
for (const entry of failed) {
  const label = entry.error instanceof PendingContractError ? 'EXPECTED-RED (pending contract)'
    : `${entry.error?.name || 'Error'} (pending contract)`;
  const message = String(entry.error?.message || entry.error).split('\n')[0];
  console.log(`[collector-acceptance] ${label}: ${entry.name}`);
  console.log(`    ${message}`);
}
console.log(`[shared-gpu-model-collector] ${passed}/${cases.length} independent cases passed; ${failed.length} expected-red pending the frozen collect/stop-receipt helpers and the ledger model-proof boundaries`);
if (failed.length) process.exitCode = 1;
