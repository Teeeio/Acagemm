// Independent, hardware-free regression for the frozen observation-stop addendum
// `docs/development/EXPERIENCE_STUDY_STOP_CONTRACT.md` §S1 ("durable experience may
// already exist"): the pure helper in `scripts/shared-gpu-acceptance.mjs` and its use
// in the real live driver `scripts/e2e-shared-gpu-agent-iteration.mjs`.
//
// Authority: the frozen stop addendum plus the existing MODEL_OBSERVATION_ACCEPTANCE.md,
// EXPERIENCE_STUDY_CONTRACT.md and EXPERIENCE_STUDY_ARTIFACT_CONTRACT.md. This file was
// written by an independent test author against the frozen interface; it edits no
// production file and no acceptance input.
//
// Two independent layers, both reported case by case:
//
// 1. The pure predicate `hasDurableCollectedExperience(collection)` is read off the REAL
//    module namespace at runtime, so a missing export is reported as an explicit
//    expected-red contract failure (never a static-import crash, never a duplicate of the
//    predicate copied into this file). Positive cases are the frozen evidence shapes the
//    production round-experience service really writes (`status: 'recorded'` for a new
//    record, for an idempotent existing-only collect, and for a mixed counter pair), and
//    every documented negative is its own case: absent/malformed collection, zero totals,
//    `failed`/`pending`/`skipped`/any other status, and negative/string/NaN/infinite/
//    non-integer counters.
//
// 2. The REAL LIVE DRIVER is executed as a child process against an explicitly inert
//    harness: a private shadow root holds a byte-identical copy of the driver and of every
//    local module it imports (each copy's SHA-256 is asserted against the repository file
//    in its own case), and the one file the driver SPAWNS - `client-runtime/local-server.mjs`
//    - is replaced by an inert loopback port double. Inside that shadow root:
//      * no client Runtime, no provider CLI and no model call: the driver's provider-CLI
//        probe is answered from a declared label, and the only child process is the
//        double, which answers the documented HTTP routes and nothing else;
//      * no Python and no GPU: `OPERATOR_GPU_PYTHON` names an absent path and the GPU
//        baseline/queue/test projections are scripted state, never a real runner;
//      * no outbound network: the only socket is the reserved loopback port of the double.
//    The double serves the real R4 evidence shape - two completed real Candidate tasks, a
//    continued second Agent round, and `experienceCollection = {status:'recorded',
//    recorded:0, existing:1}` (the idempotent existing-only collect) - with one bridge run
//    whose response model was observed and one cancelled/unobserved run. The old
//    recorded-only consumer never leaves that state and only stops after its own deadline;
//    the frozen consumer leaves the loop on the existing-only evidence, requests the
//    production stop before the later experience/audit reads, keeps the pre-stop
//    observation state, stores the confirmed stop receipt, and still runs the whole post-stop
//    path against the ORIGINAL Mission identity: the harness retains a real
//    prepared-before-send audit and the real bound execution experience of the source round,
//    so the post-stop audit read must still find and verify them under the Mission this
//    attempt really owns. The Mission identity is asserted where the producer really keeps it -
//    the retained artifact's own frozen round facts, the driver's retained family identity, and
//    the actual artifact/target-round/run binding - because the production verifier receipt
//    projects the audited facts into flat fields and returns no `target` subtree; a driver that
//    drops the Mission identity after the stop, or that only "passes" because the audit quietly
//    went missing, fails the named identity case below instead of passing on an absent artifact.
//    Every started run is still collected
//    with the unobserved one retained as unknown. A green result is
//    contract/integration evidence for the frozen interface only: no real machine,
//    stability, N=20 or publishability claim is made or implied.
//
// There is deliberately NO source-root override of any kind: the shadow root is always built
// from this repository, so the file can only ever execute the current combination candidate's
// real source. A copied or debugged stand-in driver cannot be substituted to make this file
// green.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  MODEL_OBSERVATION_PROVIDER, observeClaudeModel,
} from '../client-runtime/model-observation.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Namespace dynamic import: the predicate is read off the real module object at runtime, so
// a missing export is an explicit pending-contract failure instead of an import crash.
const acceptanceNs = await import('../scripts/shared-gpu-acceptance.mjs');
const HELPER = 'hasDurableCollectedExperience';

class PendingContractError extends Error {}

const cases = [];
const test = async (name, run) => {
  try {
    await run();
    cases.push({ name, passed: true });
  } catch (error) {
    cases.push({ name, passed: false, error });
  }
};
const helper = () => {
  const fn = acceptanceNs[HELPER];
  if (typeof fn !== 'function') {
    throw new PendingContractError(
      `${HELPER} is not an exported callable of scripts/shared-gpu-acceptance.mjs (frozen stop-condition helper pending implementation)`);
  }
  return fn;
};
// Every predicate case states the input and the expected verdict explicitly, so a wrong
// positive and a wrong negative are equally visible: durable evidence is ready only for a
// `recorded` collection whose nonnegative safe-integer counters sum to a positive total
// (a missing counter means zero); anything else keeps observing instead of stopping early.
const accept = (label, collection) => {
  assert.equal(helper()(collection), true,
    `${label}: a recorded collection with a positive durable total must be observation-ready`);
};
const reject = (label, collection) => {
  assert.equal(helper()(collection), false,
    `${label}: this collection is not durable evidence and must never be observation-ready`);
};

const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const fileDigest = async (file) => sha256(await readFile(file));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const writeJson = async (file, value) => {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
};

// ---------------------------------------------------------------------------
// 1. The frozen predicate (production helper, expected red while unimplemented)
// ---------------------------------------------------------------------------

await test('helper API: hasDurableCollectedExperience is an exported callable of the real acceptance module', () => {
  assert.equal(typeof acceptanceNs[HELPER], 'function',
    `${HELPER} must be an exported function of scripts/shared-gpu-acceptance.mjs`);
});

await test('positive: a new record (recorded=1, existing=0) is durable evidence', () => {
  accept('new record', { status: 'recorded', recorded: 1, existing: 0 });
});

await test('positive: the idempotent existing-only collect (recorded=0, existing=1) is durable evidence', () => {
  // The real R4 slot-02 shape: two completed Candidates, no NEW record in this collect,
  // the identical evidence already durably present. The recorded-only consumer waited here.
  accept('existing-only', { status: 'recorded', recorded: 0, existing: 1 });
});

await test('positive: a mixed counter pair (recorded=2, existing=3) is durable evidence', () => {
  accept('mixed counters', { status: 'recorded', recorded: 2, existing: 3 });
});

await test('positive: a missing counter means zero, so one present positive counter is enough', () => {
  accept('recorded only', { status: 'recorded', recorded: 1 });
  accept('existing only', { status: 'recorded', existing: 2 });
});

await test('positive: extra real collection fields do not change the verdict', () => {
  accept('full producer envelope', {
    status: 'recorded', recorded: 0, existing: 1, skipped: 0,
    records: [{ status: 'existing', id: 'experience-1', version: 2, evidenceKey: 'key-1' }],
  });
});

await test('negative: an absent or non-object collection is never durable evidence', () => {
  for (const value of [undefined, null, 'collected', 1, true, [], () => {}]) {
    reject(`collection=${String(value)}`, value);
  }
});

await test('negative: zero or missing counters are never durable evidence', () => {
  reject('zero totals', { status: 'recorded', recorded: 0, existing: 0 });
  reject('zero totals with skips', { status: 'recorded', recorded: 0, existing: 0, skipped: 4 });
  reject('no counters at all', { status: 'recorded' });
  reject('empty object', {});
});

await test('negative: status failed is never durable evidence, even with positive counters', () => {
  reject('failed', { status: 'failed', recorded: 1, existing: 1 });
  reject('failed with error', { status: 'failed', recorded: 0, existing: 2, error: { code: 'ROUND_EXPERIENCE_FAILED' } });
});

await test('negative: status pending is never durable evidence, even with positive counters', () => {
  reject('pending', { status: 'pending', recorded: 1, existing: 0 });
});

await test('negative: status skipped is never durable evidence, even with positive counters', () => {
  reject('skipped', { status: 'skipped', recorded: 1, existing: 1 });
});

await test('negative: status mixed is not the recorded status the frozen rule accepts', () => {
  // The production service labels a collect `mixed` when some observations were recorded
  // and others skipped. The frozen rule accepts only `recorded`, so a real neighbouring
  // status stays false instead of being read as durable evidence.
  reject('mixed', { status: 'mixed', recorded: 2, existing: 1, skipped: 1 });
});

await test('negative: a missing or unknown status is never durable evidence', () => {
  reject('no status', { recorded: 1, existing: 0 });
  reject('unknown status', { status: 'unknown', recorded: 1, existing: 0 });
  reject('blank status', { status: '   ', recorded: 1, existing: 0 });
  reject('case-variant status', { status: 'Recorded', recorded: 1, existing: 0 });
});

await test('negative: a negative counter is malformed and never durable evidence', () => {
  reject('negative recorded', { status: 'recorded', recorded: -1, existing: 2 });
  reject('negative existing', { status: 'recorded', recorded: 2, existing: -1 });
});

await test('negative: a string counter is malformed and never durable evidence', () => {
  reject('string recorded', { status: 'recorded', recorded: '1', existing: 0 });
  reject('numeric string existing', { status: 'recorded', recorded: 0, existing: '2' });
});

await test('negative: NaN is malformed and never durable evidence', () => {
  reject('NaN recorded', { status: 'recorded', recorded: Number.NaN, existing: 1 });
});

await test('negative: an infinite counter is malformed and never durable evidence', () => {
  reject('Infinity existing', { status: 'recorded', recorded: 0, existing: Number.POSITIVE_INFINITY });
  reject('-Infinity existing', { status: 'recorded', recorded: 0, existing: Number.NEGATIVE_INFINITY });
});

await test('negative: a non-integer counter is malformed and never durable evidence', () => {
  reject('fractional recorded', { status: 'recorded', recorded: 1.5, existing: 0 });
  reject('fractional existing', { status: 'recorded', recorded: 0, existing: 0.5 });
});

await test('negative: null/boolean counters are malformed and never durable evidence', () => {
  reject('null recorded', { status: 'recorded', recorded: null, existing: 1 });
  reject('boolean recorded', { status: 'recorded', recorded: true, existing: 1 });
});

await test('predicate is pure: it returns a boolean verdict and never mutates the collection', () => {
  const collection = Object.freeze({ status: 'recorded', recorded: 2, existing: 3 });
  const snapshot = JSON.stringify(collection);
  const first = helper()(collection);
  assert.equal(typeof first, 'boolean', 'the predicate returns a boolean verdict, never a receipt or an object');
  assert.equal(first, true);
  assert.equal(helper()(collection), true, 'the predicate is deterministic for the same input');
  assert.equal(JSON.stringify(collection), snapshot, 'the predicate never rewrites the observed collection');
});

// ---------------------------------------------------------------------------
// 2. The real live driver against an inert loopback port double
// ---------------------------------------------------------------------------

const SHADOW_FILES = Object.freeze([
  'scripts/e2e-shared-gpu-agent-iteration.mjs',
  'scripts/shared-gpu-acceptance.mjs',
  'scripts/experience-condition-study.mjs',
  'client-runtime/platform-runtime.mjs',
  'client-runtime/experience-selection.mjs',
  'client-runtime/experience-contract.mjs',
  'client-runtime/model-observation.mjs',
  'client-runtime/cancellation-contract.mjs',
  'client-runtime/kernel-wiki-import.mjs',
]);
const DRIVER = 'scripts/e2e-shared-gpu-agent-iteration.mjs';
// The live driver itself asserts 30s <= limit <= 30min; the harness must not weaken that
// frozen bound, so the observer deadline stays the smallest legal one. The frozen consumer
// stops long before it; the recorded-only consumer only stops when it expires.
const LIMIT_MS = 30_000;
const MISSION_ID = 'mis-harness';
const PROJECT_ID = 'project-harness';
const OBSERVED_RUN = 'run_round1';
const UNOBSERVED_RUN = 'run_round2';
const OBSERVED_MODEL = 'deepseek-v4-flash';
const ROLLBACK_EVENT = 'workflow.round_rolled_back';
// The archived source round and the continuation round it froze as its target: the post-stop
// audit read is selected by exactly this target round id and this Mission id.
const SOURCE_ROUND = 'mission-harness:round:1';
const TARGET_ROUND = 'mission-harness:round:2';

// The inert Runtime double the driver really spawns: it answers exactly the documented
// routes the driver uses, keeps every GPU/Runtime/Agent projection as scripted state, and
// starts no provider, Python, GPU test, timer or outbound socket. It writes the two
// physical bridge run records the driver must still collect after the stop.
const INERT_RUNTIME_DOUBLE = `import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const port = Number(process.env.API_PORT);
const bridgeDir = process.env.OPERATOR_BRIDGE_DIR;
const runRoot = path.dirname(bridgeDir);
const controlDir = process.env.HARNESS_CONTROL_DIR;
const logFile = process.env.HARNESS_REQUEST_LOG;
const recordsFile = process.env.HARNESS_BRIDGE_RECORDS;
const missionId = '${MISSION_ID}';
const projectId = '${PROJECT_ID}';
const observedRunId = '${OBSERVED_RUN}';
const currentRunId = '${UNOBSERVED_RUN}';
const sourceRoundId = '${SOURCE_ROUND}';
const targetRoundId = '${TARGET_ROUND}';
const queueRequestId = 'queue-harness-01';
const candidateDigest = 'sha256:' + 'c'.repeat(64);
const secondDigest = 'sha256:' + 'd'.repeat(64);

const entries = [];
let seq = 0;
let runStarted = false;
let bridgeWritten = false;
let stopped = false;
const evidenceReady = () => existsSync(path.join(controlDir, 'evidence-ready'));
const record = (method, pathname, served) => {
  seq += 1;
  entries.push({ seq, at: new Date().toISOString(), method, path: pathname, served, runStarted, stopped });
  writeFileSync(logFile, entries.map((entry) => JSON.stringify(entry)).join('\\n') + '\\n', 'utf8');
};

const resolvedTarget = { missionId, hardware: ['nvidia-gpu'], architecture: ['sm86'], capabilities: [], software: [] };
const runtimeEvents = [{ type: '${ROLLBACK_EVENT}', payload: { missionId, runId: observedRunId, workspaceClean: true } }];
const candidateId = 'candidate-harness-01';
// The frozen round facts of the archived source round: the SAME object is the archive's own
// facts, the audit sidecar and the parsed MISSION ITERATION CONTEXT block of the audited
// prompt, so the post-stop reader recomputes one real binding instead of a hand-copied one.
const roundFacts = {
  schemaVersion: 'operator-studio.round-facts/v1',
  recordedAt: '2026-09-15T08:00:00.000Z',
  target: { missionId, projectId, roundId: targetRoundId },
  previous: { missionId, projectId, runId: observedRunId, roundId: sourceRoundId,
    candidateId, candidateDigest, queueRequestId },
  candidate: { candidateId, digest: candidateDigest },
  correctness: { passed: true, cases: 4 },
  failure: null,
  gate: { result: 'reference' },
  rollback: { performed: true, from: sourceRoundId, to: targetRoundId, workspaceClean: true },
  currentBest: { candidateId, digest: candidateDigest, status: 'retained' },
};
const runHistory = [{
  roundId: sourceRoundId, runId: observedRunId, threadId: 'sess-' + observedRunId, runtimeKind: 'claude-code',
  candidateId, candidateDigest, queueRequestId,
  decisionReview: { resolution: { outcome: 'reference' } },
  roundFacts,
}];
// The durable execution experience of that source round, bound by mission, candidate id,
// patch digest and the queue request id - the only record the continuation audit accepts.
const experience = {
  id: 'experience-harness-01', source: 'execution', version: 2,
  content: 'reuse the tail-block vectorization that the verified candidate already recorded',
  evidence: { missionId, candidateId, patchDigest: candidateDigest, runId: queueRequestId },
  verification: { publishable: false },
};
// The prepared-before-send audit of the continuation round, kept REAL so that the post-stop
// audit read has something to find: an audit that exists only for the original Mission id.
// If the driver loses the Mission identity after the stop, this artifact is no longer matched
// and the driver fails the named identity case instead of passing on a missing file.
const experienceSection = {
  contextId: 'ctx-harness-01',
  items: [{ id: experience.id, version: experience.version, content: experience.content }],
  versions: {},
};
experienceSection.versions[experience.id] = experience.version;
const auditPrompt = [
  '----- BEGIN MISSION ITERATION CONTEXT -----',
  JSON.stringify(roundFacts, null, 2),
  '----- END MISSION ITERATION CONTEXT -----',
  '',
  '----- BEGIN UNTRUSTED EXPERIENCE DATA -----',
  JSON.stringify(experienceSection, null, 2),
  '----- END UNTRUSTED EXPERIENCE DATA -----',
].join('\\n');
const continuationAudit = {
  deliveryStage: 'prepared-before-send',
  missionId, projectId,
  runId: currentRunId,
  roundId: targetRoundId,
  prompt: auditPrompt,
  promptDigest: 'sha256:' + createHash('sha256').update(auditPrompt, 'utf8').digest('hex'),
  promptBytes: Buffer.byteLength(auditPrompt, 'utf8'),
  roundFacts,
  selection: { contextId: experienceSection.contextId,
    selected: [{ id: experience.id, version: experience.version, source: 'execution' }] },
};
const benchmarkRows = () => [
  { environment: 'local-shared-gpu', metric: 'latency_p50', profile: 'primary', value: 11.2, unit: 'us', samples: 10, warmup: 3,
    correctness: { passed: true, total: 4, passedCases: 4, failedCase: null, error: null } },
  { environment: 'local-shared-gpu', metric: 'latency_p50', profile: 'small', value: 9.8, unit: 'us', samples: 10, warmup: 3,
    correctness: { passed: true, total: 4, passedCases: 4, failedCase: null, error: null } },
];
const candidateTask = ({ taskId, digestValue, requestId, completedAt }) => ({
  taskId, status: 'completed', progress: 100, completedAt, durationMs: 2000,
  resourceRelease: { confirmed: true, status: 'confirmed', resources: [], missionId },
  payload: {
    missionId, purpose: 'candidate', requestId,
    candidate: { id: 'candidate-' + taskId, digest: digestValue, sourceRunId: observedRunId },
    packageDigest: 'sha256:' + 'b'.repeat(64), admissionId: 'admission-' + taskId, workspaceId: missionId,
  },
  result: {
    status: 'completed', publishable: false,
    environment: { source: 'local-shared-gpu', publishable: false, candidateDigest: digestValue, liveHardware: true, executionMode: 'gpu' },
    benchmark: benchmarkRows(),
  },
});
const tasks = [
  candidateTask({ taskId: 'task-candidate-01', digestValue: candidateDigest, requestId: queueRequestId, completedAt: '2026-09-15T08:00:00.000Z' }),
  candidateTask({ taskId: 'task-candidate-02', digestValue: secondDigest, requestId: 'queue-harness-02', completedAt: '2026-09-15T08:10:00.000Z' }),
];
// The real R4 evidence shape: an idempotent existing-only collect.
const collection = () => (evidenceReady()
  ? { status: 'recorded', recorded: 0, existing: 1, skipped: 0 }
  : { status: 'skipped', recorded: 0, existing: 0, skipped: 0 });
// The GPU baseline is scripted as already complete and the benchmark as idle: the driver's
// baseline wait is a real read of this projection, not of any real runner.
const state = ({ stage, paused, loopStatus, agent }) => ({
  activeMissionId: missionId, stage, missionPaused: paused,
  iterationStats: { loopStatus, round: 2, resolvedTarget, experienceCollection: collection() },
  agent, baseline: { status: 'complete' }, benchmark: { status: 'idle' }, runtimeEvents, runHistory,
});
const baselineState = () => state({ stage: 'baseline', paused: false, loopStatus: 'running', agent: null });
const runningState = () => state({ stage: 'running', paused: false, loopStatus: 'running', agent: {
  runId: currentRunId, missionId, runtimeKind: 'claude-code', threadId: 'sess-' + currentRunId, status: 'running' } });
const stoppedState = () => state({ stage: 'stopped', paused: true, loopStatus: 'stopped', agent: {
  runId: currentRunId, missionId, runtimeKind: 'claude-code', threadId: 'sess-' + currentRunId, status: 'stopped',
  resourceRelease: { confirmed: true, status: 'confirmed', resources: [], missionId, runId: currentRunId } } });
const withRelease = (value) => ({ ...value, workflowRecovery: { resourceRelease: {
  confirmed: true, status: 'confirmed', resources: [], missionId, runId: currentRunId } } });

const writeBridgeRecords = () => {
  if (bridgeWritten) return;
  mkdirSync(path.join(bridgeDir, 'claude-runs'), { recursive: true });
  mkdirSync(path.join(bridgeDir, 'prompt-audits'), { recursive: true });
  for (const entry of JSON.parse(readFileSync(recordsFile, 'utf8'))) {
    writeFileSync(path.join(bridgeDir, 'claude-runs', entry.fileName), JSON.stringify(entry.record, null, 2) + '\\n', 'utf8');
  }
  // The real prepared-before-send audit of the continuation round, in the frozen producer
  // layout the driver scans after it leaves the observer loop.
  writeFileSync(path.join(bridgeDir, 'prompt-audits', 'prepared-before-send-' + targetRoundId.replaceAll(':', '-') + '.json'),
    JSON.stringify(continuationAudit, null, 2) + '\\n', 'utf8');
  bridgeWritten = true;
  // Only now may the observer harness expose the durable evidence to the driver.
  writeFileSync(path.join(controlDir, 'runs-started'), '1', 'utf8');
};
const readBody = (request) => new Promise((resolve) => {
  let raw = '';
  request.on('data', (chunk) => { raw += chunk; });
  request.on('end', () => { try { resolve(raw ? JSON.parse(raw) : {}); } catch { resolve({}); } });
});
const send = (response, value) => {
  const body = JSON.stringify(value);
  response.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
  response.end(body);
};

const server = createServer(async (request, response) => {
  const url = new URL(request.url, 'http://127.0.0.1');
  const pathname = url.pathname;
  const body = request.method === 'POST' ? await readBody(request) : {};
  try {
    if (pathname === '/api/health') {
      record('GET', pathname, 'health');
      send(response, { runtime: { mode: process.env.OPERATOR_RUNTIME_MODE, connected: true, version: 'inert-harness' },
        testBackend: { kind: 'local-shared-gpu' } });
      return;
    }
    if (pathname === '/api/projects' && request.method === 'POST') {
      record('POST', pathname, 'project');
      const repository = path.join(runRoot, 'projects', String(body.name || 'project'));
      mkdirSync(repository, { recursive: true });
      try { execFileSync('git', ['init'], { cwd: repository, stdio: 'ignore' }); } catch { /* the driver's own commit step reports a missing git */ }
      send(response, { project: { id: projectId, name: body.name, repository } });
      return;
    }
    if (pathname === '/api/missions' && request.method === 'POST') {
      record('POST', pathname, 'mission');
      send(response, { state: baselineState() });
      return;
    }
    if (pathname === '/api/actions/start-benchmark') {
      record('POST', pathname, 'baseline-start');
      send(response, { accepted: true });
      return;
    }
    if (/^\\/api\\/missions\\/[^/]+\\/runs$/u.test(pathname) && request.method === 'POST') {
      runStarted = true;
      writeBridgeRecords();
      record('POST', pathname, 'agent-run-start');
      send(response, { state: runningState() });
      return;
    }
    if (pathname === '/api/operator-tests') {
      record('GET', pathname, 'tasks');
      send(response, { tasks: evidenceReady() ? tasks : [] });
      return;
    }
    if (/^\\/api\\/projects\\/[^/]+\\/experiences$/u.test(pathname)) {
      record('GET', pathname, 'experiences');
      // The one durable execution experience bound to the verified source round, so the
      // continuation audit can bind it by mission/candidate/patch/queue instead of accepting
      // any experience the project happens to hold.
      send(response, { experiences: [experience] });
      return;
    }
    if (pathname === '/api/actions/stop-mission') {
      stopped = true;
      record('POST', pathname, 'stop');
      send(response, { state: withRelease(stoppedState()) });
      return;
    }
    if (pathname === '/api/state') {
      const served = stopped ? 'stopped' : runStarted ? (evidenceReady() ? 'evidence' : 'in-progress') : 'baseline';
      record('GET', pathname, served);
      send(response, { state: withRelease(stopped ? stoppedState() : runStarted ? runningState() : baselineState()) });
      return;
    }
    record(request.method, pathname, 'unhandled');
    response.writeHead(404, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ error: 'the inert harness has no route ' + pathname }));
  } catch (error) {
    response.writeHead(500, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ error: String(error && error.message) }));
  }
});
server.listen(port, '127.0.0.1');
`;

const bridgeRecordFor = ({ runId, missionId, sessionId, model, events }) => ({
  fileName: `${runId}.json`,
  record: {
    provider: MODEL_OBSERVATION_PROVIDER, runId, missionId, sessionId, threadId: sessionId,
    status: model ? 'complete' : 'cancelled', error: null,
    modelObservation: observeClaudeModel({ runId, missionId, sessionId, events }),
  },
});

const runDriverHarness = async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'observer-stop-harness-'));
  const artifacts = path.join(root, 'artifacts');
  const control = path.join(root, 'control');
  const shadow = path.join(root, 'shadow');
  const logFile = path.join(control, 'requests.jsonl');
  const recordsFile = path.join(control, 'bridge-records.json');
  await mkdir(artifacts, { recursive: true });
  await mkdir(control, { recursive: true });
  for (const relative of SHADOW_FILES) {
    const target = path.join(shadow, relative);
    await mkdir(path.dirname(target), { recursive: true });
    await copyFile(path.join(repoRoot, relative), target);
  }
  await writeFile(path.join(shadow, 'client-runtime', 'local-server.mjs'), INERT_RUNTIME_DOUBLE, 'utf8');
  await writeJson(recordsFile, [
    bridgeRecordFor({
      runId: OBSERVED_RUN, missionId: MISSION_ID, sessionId: `sess-${OBSERVED_RUN}`, model: OBSERVED_MODEL,
      events: [{ type: 'system', subtype: 'init', session_id: `sess-${OBSERVED_RUN}`, model: 'claude-opus-5[1m]' },
        { type: 'assistant', session_id: `sess-${OBSERVED_RUN}`, message: { model: OBSERVED_MODEL } }],
    }),
    bridgeRecordFor({
      runId: UNOBSERVED_RUN, missionId: MISSION_ID, sessionId: `sess-${UNOBSERVED_RUN}`, model: null,
      events: [{ type: 'system', subtype: 'init', session_id: `sess-${UNOBSERVED_RUN}`, model: 'claude-opus-5[1m]' }],
    }),
  ]);
  const env = { ...process.env };
  // No study condition, no provider CLI probe, no Python, no real GPU runner: the driver's
  // only child is the inert double and its only socket is that child's loopback port.
  delete env.E2E_EXPERIENCE_CONDITION;
  delete env.E2E_KERNEL_WIKI_SNAPSHOT;
  Object.assign(env, {
    E2E_AGENT_RUNTIME: 'claude-code',
    E2E_AGENT_MODEL: OBSERVED_MODEL,
    E2E_AGENT_CLI_VERSION: 'inert-harness/v1',
    E2E_GPU_FAMILIES: 'affine',
    E2E_GPU_CANDIDATE_TASKS: '2',
    E2E_GPU_TIMEOUT_MS: String(LIMIT_MS),
    E2E_GPU_ARTIFACT_DIR: artifacts,
    OPERATOR_GPU_PYTHON: path.join(root, 'no-such-python.exe'),
    HARNESS_CONTROL_DIR: control,
    HARNESS_REQUEST_LOG: logFile,
    HARNESS_BRIDGE_RECORDS: recordsFile,
  });
  const result = { root, artifacts, control, shadow, logFile, recordsFile, stdout: '', stderr: '', exitCode: null, timedOut: false };
  const child = spawn(process.execPath, [path.join(shadow, DRIVER)], {
    cwd: shadow, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env,
  });
  child.stdout.on('data', (chunk) => { result.stdout += String(chunk); });
  child.stderr.on('data', (chunk) => { result.stderr += String(chunk); });
  // The durable evidence is exposed to the driver only after the real Agent run started and
  // both physical bridge records exist, so the stop decision can only be driven by the
  // existing-only collect the driver observed in its live loop.
  const armEvidence = (async () => {
    for (let attempt = 0; attempt < 600; attempt += 1) {
      if (existsSync(path.join(control, 'runs-started'))) break;
      await sleep(50);
    }
    await writeFile(path.join(control, 'evidence-ready'), '1', 'utf8');
  })();
  result.exited = await new Promise((resolve) => {
    const guard = setTimeout(() => { result.timedOut = true; child.kill(); resolve('harness-timeout'); },
      LIMIT_MS + 60_000);
    child.once('exit', (code) => { clearTimeout(guard); result.exitCode = code; resolve(code); });
    child.once('error', (error) => { clearTimeout(guard); result.stderr += `\nspawn error: ${error.message}`; resolve('spawn-error'); });
  });
  await armEvidence;
  // The driver's own attempt run root: one `shared-gpu-*` directory under the injected
  // artifact parent, discovered from the real filesystem instead of from the request log.
  const runRoots = (await readdir(artifacts, { withFileTypes: true })).filter((entry) => entry.isDirectory());
  result.runRoot = runRoots.length === 1 ? path.join(artifacts, runRoots[0].name) : null;
  const attemptFile = result.runRoot ? path.join(result.runRoot, 'attempt.json') : null;
  result.attempt = attemptFile && existsSync(attemptFile) ? JSON.parse(await readFile(attemptFile, 'utf8')) : null;
  // The per-family summaries (and therefore the retained continuation audit) live in the
  // driver's own summary.json, not in the narrower attempt projection.
  const summaryFile = result.runRoot ? path.join(result.runRoot, 'summary.json') : null;
  result.summary = summaryFile && existsSync(summaryFile) ? JSON.parse(await readFile(summaryFile, 'utf8')) : null;
  const stateFile = result.runRoot ? path.join(result.runRoot, 'affine-state.json') : null;
  result.preStopState = stateFile && existsSync(stateFile) ? JSON.parse(await readFile(stateFile, 'utf8')) : null;
  result.requests = existsSync(logFile)
    ? (await readFile(logFile, 'utf8')).split('\n').filter(Boolean).map((line) => JSON.parse(line)) : [];
  return result;
};

const harness = await runDriverHarness();
const at = (entry) => Date.parse(entry.at);
const firstOf = (served) => harness.requests.find((entry) => entry.served === served) || null;
const diagnostics = () => JSON.stringify({
  exitCode: harness.exitCode, timedOut: harness.timedOut, runRoot: harness.runRoot,
  requests: harness.requests.map((entry) => `${entry.seq}:${entry.method} ${entry.path} [${entry.served}]`),
  outcome: harness.attempt?.outcome ?? null,
  failure: harness.attempt?.failure ?? null,
  stderr: harness.stderr.split('\n').slice(-12),
}, null, 2);
// The driver's own per-family summary of the single affine family this harness ran.
const familySummary = () => (harness.summary?.summaries ?? [])[0] ?? null;
// The real pre-send audit the harness wrote for the continuation round. It only ever exists
// under the ORIGINAL Mission id, so the post-stop read must still be bound to that identity.
const auditFile = () => (harness.runRoot
  ? path.join(harness.runRoot, 'bridge', 'prompt-audits', `prepared-before-send-${TARGET_ROUND.replaceAll(':', '-')}.json`)
  : null);

await test('harness integrity: the executed driver and its module graph are the repository files', async () => {
  assert.notEqual(harness.runRoot, null, `the driver never created its artifact run root: ${diagnostics()}`);
  for (const relative of SHADOW_FILES) {
    const sourceDigest = await fileDigest(path.join(repoRoot, relative));
    const shadowDigest = await fileDigest(path.join(harness.shadow, relative));
    assert.equal(shadowDigest, sourceDigest,
      `${relative}: the harness must execute the current repository file byte for byte; there is no source override that could substitute a debugged stand-in`);
  }
  assert.equal(existsSync(path.join(harness.shadow, 'client-runtime', 'local-server.mjs')), true,
    'the inert loopback double replaced the spawned Runtime entry point');
});

await test('wiring: the live driver leaves the observer loop on recorded=0/existing=1 instead of its deadline', () => {
  const evidence = firstOf('evidence');
  assert.ok(evidence, `the driver never observed the existing-only evidence state: ${diagnostics()}`);
  assert.equal(harness.timedOut, false, `the harness child was killed instead of exiting: ${diagnostics()}`);
  const failure = harness.attempt?.failure?.message ?? '';
  assert.equal(/timed out/i.test(failure), false,
    `the driver reached its observer deadline instead of stopping on durable evidence: ${diagnostics()}`);
  // The frozen consumer really finished the whole post-stop path on that observation: an
  // unchanged recorded-only consumer never leaves the loop and reports its own deadline here.
  assert.equal(harness.attempt?.outcome, 'full_success',
    `the driver must leave the loop, stop, and finish the post-stop path: ${diagnostics()}`);
  assert.equal(harness.attempt?.failure, null, `the post-stop path must not fail: ${diagnostics()}`);
});

await test('wiring: the production stop is requested before the later experience/audit reads', () => {
  const stop = firstOf('stop');
  const experiences = firstOf('experiences');
  assert.ok(stop, `the driver never requested the production stop: ${diagnostics()}`);
  assert.ok(experiences, `the driver never reached its post-loop experience read: ${diagnostics()}`);
  assert.ok(stop.seq < experiences.seq,
    `the stop must be requested before the later experience/audit reads (stop #${stop.seq}, experiences #${experiences.seq}): ${diagnostics()}`);
  const evidence = firstOf('evidence');
  assert.ok(evidence && at(stop) - at(evidence) < LIMIT_MS / 2,
    `the stop must promptly follow the durable-evidence observation instead of a deadline: ${diagnostics()}`);
});

await test('wiring: the confirmed production stop receipt is retained with the original Mission identity', () => {
  const cleanupBlock = harness.attempt?.cleanup ?? {};
  const receipts = [...(cleanupBlock.stopReceipts ?? []), cleanupBlock.teardownStop].filter(Boolean);
  assert.ok(receipts.some((receipt) => receipt.confirmed === true && receipt.missionId === MISSION_ID),
    `an unconfirmed stop can never pass, and the retained receipt must name the Mission the attempt really owns: ${diagnostics()}`);
  assert.equal(harness.attempt?.fullSuccess, true, `a confirmed stop over a full success is the frozen green path: ${diagnostics()}`);
});

await test('wiring: the post-stop audit read still uses the original Mission identity', async () => {
  const audit = auditFile();
  assert.ok(audit && existsSync(audit), `the harness never retained its own pre-send audit: ${diagnostics()}`);
  const onDisk = JSON.parse(await readFile(audit, 'utf8'));
  assert.equal(onDisk.missionId, MISSION_ID, 'the retained audit belongs to the original Mission');
  // The Mission identity lives in the artifact's OWN frozen round facts, not in a projection of
  // them: the verifier compares those facts against the source archive under the Mission it is
  // handed, so the read is only bound to the original Mission when that identity is really on
  // disk, in the target facts the artifact was prepared with and in the source round it continues.
  assert.equal(onDisk.roundFacts?.target?.missionId, MISSION_ID,
    'the retained audit really carries the original Mission in its own frozen target facts');
  assert.equal(onDisk.roundFacts?.target?.roundId, TARGET_ROUND,
    'the retained audit is the pre-send artifact of the frozen target round of the source archive');
  assert.equal(onDisk.roundFacts?.previous?.roundId, SOURCE_ROUND,
    'the retained audit freezes the archived source round it continues');
  // The post-stop continuation audit really was found and verified under that same Mission: a
  // driver that drops the Mission id after the stop cannot select this artifact at all, and its
  // own "no retained pre-send audit" failure is exactly the wrong-identity symptom this case
  // refuses instead of accepting a missing artifact as a pass. The production receipt projects
  // the audited facts into FLAT fields (previousRunId/previousRoundId/...) and has no `target`
  // subtree, so the identity is asserted where it really lives - the family identity the driver
  // retained, the on-disk artifact above, and the actual artifact/round/run binding below -
  // instead of on a field the production receipt never returns.
  const family = familySummary();
  assert.ok(family, `the post-stop family identity was never retained: ${diagnostics()}`);
  assert.equal(family.missionId, MISSION_ID,
    'the retained family identity is still bound to the original Mission after the stop');
  assert.equal(family.sourceRoundId, SOURCE_ROUND,
    'the retained family identity still names the archived source round of this Mission');
  assert.equal(family.sourceRoundTargetRoundId, TARGET_ROUND,
    'the retained family identity still names the frozen target round the audit was selected by');
  const continuation = family?.continuationAudit ?? null;
  assert.ok(continuation, `the post-stop audit read must find the retained pre-send audit: ${diagnostics()}`);
  // The verified audit is exactly this retained artifact: selected by the source archive's own
  // frozen target round (never by "the newest run"), and the only audit matched for that round
  // and Mission is the real continuation run, never the source run.
  assert.equal(path.resolve(continuation.path ?? ''), path.resolve(audit),
    'the verified audit is the pre-send artifact this harness really retained');
  assert.equal(continuation.selectedBy, 'sourceRound.roundFacts.target.roundId',
    'the audit was selected by the frozen target round, never by the current agent run');
  assert.deepEqual(continuation.matchedAuditsForTargetRound, [UNOBSERVED_RUN],
    'the target round of this Mission matched exactly the real continuation run');
  assert.equal(continuation.runId, UNOBSERVED_RUN, 'the verified audit is the continuation run, never the source run');
  assert.equal(continuation.roundId, TARGET_ROUND, 'the verified audit is the frozen target round of the source archive');
  // The receipt's independently recomputed facts must agree, field by field, with the artifact the
  // harness wrote: the source round, its run, its candidate and its durable queue request all
  // belong to the Mission the driver verified under (`family.missionId`).
  assert.equal(continuation.facts?.previousRoundId, onDisk.roundFacts.previous.roundId,
    'the verified facts name the source round the retained artifact froze');
  assert.equal(continuation.facts?.previousRunId, onDisk.roundFacts.previous.runId,
    'the verified facts name the source run the retained artifact froze');
  assert.equal(continuation.facts?.previousCandidateId, onDisk.roundFacts.previous.candidateId,
    'the verified facts name the source candidate the retained artifact froze');
  assert.equal(continuation.facts?.previousQueueRequestId, onDisk.roundFacts.previous.queueRequestId,
    'the verified facts keep the source round durable queue binding');
  assert.equal(continuation.facts?.gateResult, onDisk.roundFacts.gate.result,
    'the verified facts keep the source round Accept Gate result');
  assert.equal(continuation.facts?.currentBestCandidateId, onDisk.roundFacts.currentBest.candidateId,
    'the verified facts keep the source round currentBest identity');
  assert.equal(continuation.selectedExperience?.id, 'experience-harness-01',
    'the verified audit binds the real execution experience of the source round');
  assert.equal(continuation.selectedExperience?.evidenceCandidateId, 'candidate-harness-01');
  assert.equal(continuation.selectedExperience?.evidenceRunId, 'queue-harness-01',
    'the bound experience is the source round queue request the artifact froze');
  const failure = harness.attempt?.failure?.message ?? '';
  assert.equal(/no retained pre-send audit/u.test(failure), false,
    `a lost Mission identity must never be masked as a missing audit: ${diagnostics()}`);
});

await test('wiring: the pre-stop observation state is preserved on disk', () => {
  const collection = harness.preStopState?.state?.iterationStats?.experienceCollection ?? null;
  assert.deepEqual(collection, { status: 'recorded', recorded: 0, existing: 1, skipped: 0 },
    `the retained pre-stop state must be the durable-evidence observation the loop stopped on: ${diagnostics()}`);
  assert.equal(harness.preStopState?.tasks?.length, 2,
    'the retained pre-stop state keeps both completed Candidate tasks the stop decision was based on');
});

await test('wiring: every started run is still collected and the unobserved one stays required and unknown', () => {
  const attempt = harness.attempt;
  assert.ok(attempt, `no terminal attempt was written: ${diagnostics()}`);
  const requiredRunIds = (attempt.modelObservationRequiredRuns ?? []).map((entry) => entry.runId).sort();
  assert.deepEqual(requiredRunIds, [OBSERVED_RUN, UNOBSERVED_RUN].sort(),
    'both started runs stay in the required denominator after the stop');
  assert.deepEqual([...(attempt.modelObservationSweep?.discoveredFiles ?? [])].sort(),
    [`${OBSERVED_RUN}.json`, `${UNOBSERVED_RUN}.json`].sort(),
    'the physical bridge sweep still sees every started run of this attempt');
  const summary = attempt.modelObservationSummary ?? {};
  assert.equal(summary.status, 'unknown', 'one unobserved required run keeps the attempt model verdict unknown');
  assert.equal(summary.requiredRunCount, 2);
  assert.equal(summary.observedRunCount, 1);
  assert.ok((summary.reasons ?? []).length > 0, 'an unknown verdict names its reason');
  const observationFor = (runId) => (attempt.modelObservations ?? []).find((entry) => entry.runId === runId) ?? null;
  assert.equal(observationFor(OBSERVED_RUN)?.model, OBSERVED_MODEL, 'the observed run keeps its provider-reported model');
  const unobserved = observationFor(UNOBSERVED_RUN);
  assert.equal(unobserved?.status, 'unknown', 'the cancelled run is retained as unknown, never guessed');
  assert.equal(unobserved?.model, null, 'an init/env label is never promoted into a responded model');
  assert.equal(attempt.provider?.modelObservationStatus, 'unknown');
  assert.equal(attempt.provider?.model, 'unknown', 'an unobserved model stays "unknown", never a borrowed label');
  assert.equal(attempt.comparable, false, 'a run without model observation is never comparable');
  assert.deepEqual(attempt.modelObservationUnboundRuns ?? [], [], 'both real started runs are bound, not dropped');
});

// ---------------------------------------------------------------------------
// Verdict
// ---------------------------------------------------------------------------

if (harness.root) await rm(harness.root, { recursive: true, force: true }).catch(() => {});

const passed = cases.filter((entry) => entry.passed).length;
const failed = cases.filter((entry) => !entry.passed);
for (const entry of failed) {
  const label = entry.error instanceof PendingContractError
    ? 'EXPECTED-RED (pending frozen interface)' : String(entry.error?.name || 'Error');
  console.log(`[observer-stop] ${label}: ${entry.name}`);
  console.log(`    ${String(entry.error?.message || entry.error).split('\n').slice(0, 80).join('\n    ')}`);
}
console.log(`[shared-gpu-observer-stop] ${passed}/${cases.length} independent cases passed; ${failed.length} failing (a missing helper export or an unchanged recorded-only driver is an expected-red pending-combination result, never a pass)`);
if (failed.length) process.exitCode = 1;
