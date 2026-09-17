// Independent hardware-free regression for the failed-execution acceptance
// boundaries Root reproduced on the current snapshot: the trusted failed-observation
// verifier accepted a control failed candidate and seven erroneous variants of it.
// Frozen authority: docs/development/FAILED_EXECUTION_FEEDBACK_ACCEPTANCE.md
// (sha256 55727780c161a2068b27702339df702737d9eaed78e5c2c29d6a1d72b182fbbb).
//
// This file is a SEPARATE author's deliverable. It never imports or executes
// tests/failed-execution-feedback-test.mjs and never parses production function
// source; it drives the real public entries instead:
//   1. createSharedGpuExperienceVerifier with the same fully bound failed-candidate
//      DTO/port fixture style: one control positive, then each listed boundary as a
//      single targeted mutation whose result/queue/observation copies stay in sync,
//      so a rejection is attributable to the mutated boundary and not to an
//      unrelated queue-vs-projection disagreement.
//   2. createMissionProjectState / resetMissionRunState for the "benchmark failed but
//      top-level correctness passed" archive case.
//
// Coverage is the upstream matrix, not a redefinition: environment identity
// (source=mock, hardware=cpu, publishable=true, liveHardware=false), queue payload
// binding (target/build/adapter vs the selected package) and purpose=baseline,
// the typed first failure in all three places (retryable=true, empty message,
// missing details), a preceding passed case without a name, the bounded
// proof.summary (5000-repeat case name/category/error fields triggered at once,
// complete failure-detail suffix <=2000 characters with code/phase/role/counts
// and the real error prefix retained) and the passed-correctness archive.
//
// Honesty rules:
// - Every case runs; a red control positive does not skip the rest of the matrix.
// - A negative whose control positive did not verify is reported BLOCKED, never
//   green: rejection by an unrelated pre-integration precondition is not evidence
//   that the boundary itself was rejected.
// - The result is reported faithfully: with the failed-observation consumer v2
//   integrated this snapshot runs 16/16 green. The file must never be weakened to
//   match a pre-integration tree, and a red case must never be reported green.
// - No GPU, driver, model, network, Python runner or N=20 batch is started. All
//   ports are in-process doubles; only temporary directories under the OS temp
//   root are written and they are removed in finally.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

// Explicit scratch isolation must happen before any production module is imported.
const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'operator-failed-boundary-'));
process.env.OPERATOR_RUNTIME_DIR = path.join(tempRoot, 'runtime');
process.env.OPERATOR_DATA_DIR = path.join(tempRoot, 'data');
process.env.OPERATOR_BRIDGE_DIR = path.join(tempRoot, 'bridge');
delete process.env.OPERATOR_RUNTIME_MODE;

const { createSharedGpuExperienceVerifier } = await import('../client-runtime/application/shared-gpu-experience-verifier.mjs');
const { createMissionProjectState } = await import('../client-runtime/mission-project-state.mjs');

try {

const sha256Hex = (value) => createHash('sha256').update(value, 'utf8').digest('hex');
const digest = (label) => `sha256:${sha256Hex(label)}`;
const prefixed = (value) => `sha256:${String(value).replace(/^sha256:/iu, '').toLowerCase()}`;
const clock = Date.parse('2026-09-13T00:00:00.000Z');
const iso = (ms = clock) => new Date(ms).toISOString();

const FAILED_CANDIDATE_CODES = ['OPERATOR_CORRECTNESS_MISMATCH', 'OPERATOR_CANDIDATE_EXCEPTION'];
const MISMATCH_METRICS = Object.freeze({ maxDiff: 3.2e-4, rmse: 2.4e-4, cosDiff: 0.9997 });
const MISMATCH_MESSAGE = 'maxDiff 3.2e-4 exceeds the frozen 1e-5 tolerance on case boundary (rmse 2.4e-4, cosDiff 0.9997)';
const BENCHMARK_ERROR = Object.freeze({
  code: 'SHARED_GPU_BENCHMARK_FAILED',
  message: 'benchmark stage failed after the correctness cases passed',
  phase: 'benchmark',
  role: 'backend',
  retryable: true,
  details: { runStage: 'benchmark' },
});

// ---------------------------------------------------------------------------
// Per-case harness. Cases never abort the suite: the aggregated report is the
// submission surface and every matrix entry is executable in one run.
// ---------------------------------------------------------------------------
class Blocked extends Error {}
const blocked = (detail) => { const error = new Blocked(detail); error.name = 'Blocked'; throw error; };

const outcomes = [];
const record = (name, outcome, detail) => { outcomes.push({ name, outcome, detail }); };
const runCase = async (name, body) => {
  try {
    const detail = await body();
    record(name, 'passed', typeof detail === 'string' && detail ? detail : 'ok');
  } catch (error) {
    if (error instanceof Blocked) record(name, 'blocked', error.message);
    else record(name, 'failed', `${error?.name || 'Error'}: ${error?.message ?? String(error)}`);
  }
};

// ---------------------------------------------------------------------------
// Result-envelope fixtures (same public DTO shape as the frozen acceptance).
// ---------------------------------------------------------------------------
const typedError = ({ code = FAILED_CANDIDATE_CODES[0], message = MISMATCH_MESSAGE, role = 'candidate', phase = 'correctness' } = {}) => ({
  code, message, phase, role, retryable: false, details: { runStage: 'correctness' },
});
const passedCase = (name) => ({ case: name, dtype: 'float32', maxDiff: 1e-6, rmse: 1e-7, cosDiff: 1e-8, passed: true });
const failedCase = (name, error, metrics) => ({
  case: name, dtype: 'float32',
  maxDiff: metrics?.maxDiff ?? null, rmse: metrics?.rmse ?? null, cosDiff: metrics?.cosDiff ?? null,
  passed: false,
  error: error.message, // real string error.message
  failure: structuredClone(error), // typed first failure
});
const makeCorrectness = ({ error, total = 4, metrics = MISMATCH_METRICS, failedCaseName = 'boundary', failedCaseCategory = 'boundary' } = {}) => ({
  status: 'failed', passed: false, total, executedCases: 3, passedCases: 2,
  failedCase: 3, failedCaseName, failedCaseCategory,
  caseResults: [passedCase('minimal'), passedCase('representative'), failedCase(failedCaseName, error, metrics)],
  failure: structuredClone(error), // typed first failure
  error: error.message, // real string error.message
});
const makeEnvironment = () => ({
  requested: ['local-shared-gpu'], runtime: 'local-shared-gpu-runner/v1', service: 'local-shared-gpu-adapter',
  source: 'local-shared-gpu', hardware: 'nvidia-gpu', executionMode: 'gpu', liveHardware: true, publishable: false,
  architecture: 'sm86',
  device: 'NVIDIA GeForce RTX 3060 Laptop GPU', driverVersion: '551.78',
  targetProbe: { deviceName: 'NVIDIA GeForce RTX 3060 Laptop GPU', driverVersion: '551.78', architecture: 'sm86' },
});
// Complete, identical executionPackage binding: the payload, the projected result,
// the persisted benchmark state and the queue receipt carry the same
// target/build/adapter that admission and prepared-artifact validation require.
const makeBinding = (label, workspaceId) => ({
  packageDigest: digest(`${label}-package`), admissionId: `admission-${label}`,
  preparedArtifactDigest: digest(`${label}-artifact`), environmentDigest: digest(`${label}-environment`),
  acceptanceDigest: digest(`${label}-acceptance`), workspaceId,
  target: { platform: 'nvidia-cuda', device: 'gpu', hardware: ['nvidia-gpu'], architecture: 'sm86' },
  build: { kind: 'prepared-artifact', format: 'source-tree' },
  adapter: { id: 'python-shared-gpu', version: '1', languages: ['python'] },
});

const buildFailedFixture = ({ code = FAILED_CANDIDATE_CODES[0], message = MISMATCH_MESSAGE, role = 'candidate', phase = 'correctness', metrics = MISMATCH_METRICS, failedCaseName = 'boundary', failedCaseCategory = 'boundary' } = {}) => {
  const candidateId = 'candidate-boundary';
  const runId = 'run-boundary';
  const mission = { id: 'MIS_BOUNDARY', projectId: 'PROJ_BOUNDARY', hardware: ['nvidia-gpu'], architecture: ['sm86'], operator: 'generic_affine', tags: ['affine'] };
  const binding = makeBinding('boundary', mission.id);
  const error = typedError({ code, role, phase, message });
  const correctness = makeCorrectness({ error, metrics, failedCaseName, failedCaseCategory });
  const environment = makeEnvironment();
  const patchDigest = digest('boundary-patch');
  const evidence = {
    missionId: mission.id, candidateId, runId, patchDigest,
    packageDigest: binding.packageDigest, environmentDigest: binding.environmentDigest, acceptanceDigest: binding.acceptanceDigest,
    hardware: 'nvidia-gpu', executionMode: 'gpu', outcome: 'failed', operation: 'test', liveHardware: true, architecture: 'sm86',
  };
  const result = {
    schemaVersion: 'operator-studio.shared-gpu-result/v1', status: 'failed', benchmark: [], publishable: false,
    correctness: structuredClone(correctness), error: structuredClone(error), environment,
    executionPackage: structuredClone(binding), experienceEvidence: structuredClone(evidence),
  };
  const task = {
    taskId: 'queue-boundary', status: 'failed',
    resourceRelease: { confirmed: true, status: 'confirmed', resources: [] },
    payload: {
      missionId: mission.id, requestId: runId, purpose: 'candidate',
      candidate: { id: candidateId, digest: patchDigest },
      packageDigest: binding.packageDigest, admissionId: binding.admissionId, preparedArtifactDigest: binding.preparedArtifactDigest,
      environmentDigest: binding.environmentDigest, acceptanceDigest: binding.acceptanceDigest,
      workspaceId: mission.id, target: structuredClone(binding.target), build: structuredClone(binding.build), adapter: structuredClone(binding.adapter),
    },
    result: structuredClone(result),
    executionPackage: structuredClone(binding),
  };
  const state = {
    activeMissionId: mission.id, appliedCandidateId: candidateId,
    benchmark: {
      status: 'failed', purpose: 'candidate', testTaskId: task.taskId, runId, requestId: runId,
      resourceRelease: { confirmed: true, status: 'confirmed' },
      candidate: { id: candidateId, digest: patchDigest },
      matrix: { correctnessCases: 4 },
      executionPackage: structuredClone(binding),
      result: structuredClone(result),
    },
  };
  const observation = { evidence: structuredClone(evidence), evidenceRefs: ['result.json'] };
  const admitted = new Map([[binding.admissionId, binding.preparedArtifactDigest]]);
  return { binding, mission, candidateId, runId, patchDigest, error, correctness, result, evidence, task, state, observation, admitted };
};

// The admission port validates the actual request the verifier assembled; it never
// approves unconditionally. The prepared-artifact port reports the injected verdict
// only, so an artifact failure is never confused with a binding-digest failure.
const fixtureVerifier = (fixture, { readTask = true, artifactValid = true } = {}) => createSharedGpuExperienceVerifier({
  executionPackageStore: {
    verifyAdmission: async (request) => {
      if (!fixture.admitted.has(request.admissionId)) throw new Error(`unknown admission ${request.admissionId}`);
      if (request.missionId !== fixture.mission.id) throw new Error('admission request Mission does not match the active Mission');
      if (request.workspaceId !== fixture.binding.workspaceId) throw new Error('admission request workspace does not match the package binding');
      if (request.packageDigest !== fixture.binding.packageDigest) throw new Error('admission request package digest does not match the package binding');
      if (request.environmentDigest !== fixture.binding.environmentDigest) throw new Error('admission request environment digest does not match the package binding');
      if (request.acceptanceDigest !== fixture.binding.acceptanceDigest) throw new Error('admission request acceptance digest does not match the package binding');
      if (request.requestId !== fixture.runId) throw new Error('admission request run identity does not match the observation');
      if (!request.candidate || typeof request.candidate.id !== 'string' || !request.candidate.id
        || request.candidate.digest !== prefixed(fixture.patchDigest)) throw new Error('admission request is missing the candidate binding');
      if (!request.target || !request.build || !request.adapter) throw new Error('admission request is missing target/build/adapter');
      return { admission: { preparedArtifactDigest: fixture.admitted.get(request.admissionId) }, manifest: { requestId: request.requestId }, environment: {} };
    },
  },
  packageAdapter: { verifyPreparedArtifact: async () => ({ valid: artifactValid }) },
  ...(readTask ? { readTask: async (taskId) => (taskId === fixture.task.taskId ? fixture.task : null) } : {}),
  now: () => clock,
});

const baseFixture = buildFailedFixture();

// Each negative mutates exactly one boundary on a clone of the fixture that
// verifies unmutated. Duplicated copies (projected result, persisted benchmark
// state, queue receipt, observation evidence) stay in sync unless the boundary is
// explicitly one-sided, and the agreement is asserted before the acceptance call
// so an early "queue != projection" rejection cannot mask the intended branch.
const resultCopies = (f) => [f.result, f.state.benchmark.result, f.task.result];
const mutateResults = (f, mutate) => { for (const result of resultCopies(f)) mutate(result); };
const mutateEnvironment = (f, mutate) => { mutateResults(f, (result) => mutate(result.environment)); };
const mutateCorrectness = (f, mutate) => { mutateResults(f, (result) => mutate(result.correctness)); };
// The typed first failure lives in result.error / correctness.failure / the final
// case failure and must agree by full value; the string error.message copies stay
// in sync so a mutation is a semantic change, not an accidental disagreement.
const mutateTypedFailure = (f, mutate) => {
  for (const result of resultCopies(f)) {
    mutate(result.error);
    mutate(result.correctness.failure);
    mutate(result.correctness.caseResults.at(-1).failure);
    result.correctness.caseResults.at(-1).error = result.error.message;
    result.correctness.error = result.error.message;
  }
};

const assertQueueProjectionAgreement = (f, label) => {
  const projected = f.state.benchmark.result;
  assert.deepEqual(f.result, projected, `${label}: the projected result copies must agree before the acceptance call`);
  assert.deepEqual(f.task.result, projected, `${label}: the queue result copy must agree with the projection before the acceptance call`);
  assert.deepEqual(f.observation.evidence, projected.experienceEvidence, `${label}: the observation evidence must agree with the projected result before the acceptance call`);
};

const snapshotFixture = (f) => JSON.stringify([f.state.benchmark.result, f.observation.evidence, f.task.result]);

// Run one targeted negative. The proof must not be a verified receipt, the
// verifier must stay read-only, and at least one production-owned rejection code
// must be reported. When the control positive is red the case is reported blocked.
const checkNegative = async (name, mutate, control) => {
  const fixture = structuredClone(baseFixture);
  mutate(fixture);
  assertQueueProjectionAgreement(fixture, name);
  const before = snapshotFixture(fixture);
  const proof = await fixtureVerifier(fixture)({ state: fixture.state, mission: fixture.mission, observation: fixture.observation });
  assert.equal(snapshotFixture(fixture), before, `${name}: a rejected boundary must not rewrite the projected result, evidence or queue receipt`);
  if (proof.verified === true) throw new Error(`${name}: the mutated boundary was still accepted as a verified observation`);
  if (!control.verified) blocked(`control failed-candidate positive did not verify (${control.code}); the rejection of this boundary is not attributable to the mutation in the current snapshot`);
  assert.equal(typeof proof.code, 'string', `${name}: a rejection must carry a production-owned code`);
  return `rejected with ${proof.code}`;
};

const control = { verified: false, code: 'not-run' };

// ---------------------------------------------------------------------------
// Control positive: a fully bound failed candidate correctness observation.
// ---------------------------------------------------------------------------
await runCase('control-failed-candidate-positive', async () => {
  const proof = await fixtureVerifier(baseFixture)({ state: baseFixture.state, mission: baseFixture.mission, observation: baseFixture.observation });
  control.verified = proof.verified === true;
  control.code = proof.code ?? 'verified';
  assert.equal(proof.verified, true, 'a fully bound failed candidate observation must verify');
  assert.equal(proof.evidence.outcome, 'failed');
  assert.equal(proof.evidence.candidateId, baseFixture.candidateId);
  const summary = String(proof.summary);
  for (const token of [baseFixture.error.code, 'correctness', 'candidate', 'boundary', '4', '3', '2', baseFixture.error.message]) {
    assert.ok(summary.includes(token), `the failed summary must carry ${token}`);
  }
  return `verified; summary length ${summary.length}`;
});

// ---------------------------------------------------------------------------
// Compatibility guard: the successful legacy observation path stays intact.
// ---------------------------------------------------------------------------
await runCase('success-legacy-positive', async () => {
  const evidence = {
    missionId: 'MIS_OK', candidateId: 'candidate-ok', runId: 'run-ok',
    patchDigest: digest('ok-patch'), packageDigest: digest('ok-package'), environmentDigest: digest('ok-environment'), acceptanceDigest: digest('ok-acceptance'),
    hardware: 'nvidia-gpu', executionMode: 'gpu', outcome: 'passed', operation: 'test', liveHardware: true,
  };
  const binding = {
    packageDigest: evidence.packageDigest, admissionId: 'admission-ok', preparedArtifactDigest: digest('ok-artifact'),
    environmentDigest: evidence.environmentDigest, acceptanceDigest: evidence.acceptanceDigest, workspaceId: 'MIS_OK',
    target: { platform: 'nvidia-cuda', device: 'gpu' }, build: {}, adapter: { id: 'python-shared-gpu', version: '1', languages: ['python'] },
  };
  const state = { activeMissionId: 'MIS_OK', benchmark: { status: 'complete', purpose: 'candidate', testTaskId: 'queue-ok', candidate: { id: evidence.candidateId, digest: evidence.patchDigest }, executionPackage: binding, result: { experienceEvidence: evidence } } };
  const mission = { id: 'MIS_OK', workspaceId: 'MIS_OK' };
  const verifier = createSharedGpuExperienceVerifier({
    executionPackageStore: { verifyAdmission: async () => ({ manifest: {}, environment: {}, admission: { preparedArtifactDigest: binding.preparedArtifactDigest } }) },
    packageAdapter: { verifyPreparedArtifact: async () => ({ valid: true }) },
    readTask: async (taskId) => ({ taskId, status: 'completed', resourceRelease: { confirmed: true }, result: { experienceEvidence: evidence } }),
    now: () => clock,
  });
  const ok = await verifier({ state, mission, observation: { evidence } });
  assert.equal(ok.verified, true, 'the existing successful observation path must keep verifying');
  assert.equal(ok.evidence.outcome, 'passed');
  const wrong = await verifier({ state, mission, observation: { evidence: { ...evidence, candidateId: 'other' } } });
  assert.equal(wrong.verified, false, 'the success path still rejects a wrong candidate identity');
  return 'legacy success path verifies and still rejects a wrong candidate';
});

// ---------------------------------------------------------------------------
// Bounded failure detail: 5000-repeat case name, category and error message on
// the fully bound failed candidate, all three long fields triggered at once. The
// frozen contract caps the COMPLETE failure-detail suffix at 2000 characters,
// not each field separately and not the summary as a whole. Only the fixed
// trusted-admission base sentence plus its one ASCII joining space may sit outside
// the detail; when no base sentence is present the whole summary IS the failure
// detail. The unbounded tails must not survive, and
// the code/phase/role/counts and the real error prefix must remain inside the
// bounded detail. A <=4096 or <=7000 total-only bound, or a per-field-only
// bound, would each admit an over-long suffix and is explicitly not accepted.
// ---------------------------------------------------------------------------
const LONG = Object.freeze({
  errorPrefix: 'ERROR_PREFIX_', errorTail: '_ERROR_TAIL',
  casePrefix: 'CASE_PREFIX_', caseTail: '_CASE_TAIL',
  categoryPrefix: 'CATEGORY_PREFIX_', categoryTail: '_CATEGORY_TAIL',
});
// Exact end marker of the trusted admission base sentence emitted by production.
// The text up to and including it is the fixed revalidation sentence, not failure
// detail; everything after it is the failure-detail suffix under the 2000 cap.
// Production joins that fixed sentence to the detail with exactly one ASCII space
// ('...non-publishable. ' + detail): that single joining space belongs to the base
// sentence, so it is excluded here. Only that one separator is excluded — never
// arbitrary whitespace, and nothing at all when the base sentence is absent.
const TRUSTED_ADMISSION_END = 'development evidence remains non-publishable.';
const failureDetailSuffix = (summary) => {
  const text = String(summary);
  const marker = text.indexOf(TRUSTED_ADMISSION_END);
  if (marker === -1) return text;
  const suffix = text.slice(marker + TRUSTED_ADMISSION_END.length);
  return suffix.startsWith(' ') ? suffix.slice(1) : suffix;
};
const longestRun = (text, char) => Math.max(0, ...(String(text).match(new RegExp(`${char}+`, 'gu')) || []).map((run) => run.length));

await runCase('bounded-overall-summary', async () => {
  const fixture = buildFailedFixture({
    message: `${LONG.errorPrefix}${'Q'.repeat(5000)}${LONG.errorTail}`,
    failedCaseName: `${LONG.casePrefix}${'N'.repeat(5000)}${LONG.caseTail}`,
    failedCaseCategory: `${LONG.categoryPrefix}${'C'.repeat(5000)}${LONG.categoryTail}`,
  });
  const proof = await fixtureVerifier(fixture)({ state: fixture.state, mission: fixture.mission, observation: fixture.observation });
  if (!control.verified) blocked(`control failed-candidate positive did not verify (${control.code}); the summary bound is not observable in the current snapshot`);
  assert.equal(proof.verified, true, 'a fully bound failed candidate with long detail fields must still verify');
  const summary = String(proof.summary);
  const detail = failureDetailSuffix(summary);
  const base = summary.slice(0, summary.length - detail.length);
  for (const token of [FAILED_CANDIDATE_CODES[0], 'correctness', 'candidate', '4', '3', '2']) {
    assert.ok(detail.includes(token), `the bounded failure detail must still carry ${token}`);
  }
  assert.ok(detail.includes(LONG.errorPrefix), 'the real error prefix must still be visible inside the bounded failure detail');
  const runs = [
    ['Q', LONG.errorTail, LONG.errorPrefix, 'error message'],
    ['N', LONG.caseTail, LONG.casePrefix, 'failed case name'],
    ['C', LONG.categoryTail, LONG.categoryPrefix, 'failed case category'],
  ].map(([char, tail, prefix, label]) => {
    const longest = longestRun(detail, char);
    assert.ok(detail.includes(prefix), `${label}: the real prefix must reach the bounded failure detail`);
    assert.ok(longest >= 1, `${label}: a bounded real run must still reach the failure detail`);
    assert.equal(detail.includes(tail), false, `${label}: the unbounded tail must not survive into the failure detail`);
    return `${char}:${longest}`;
  });
  // The frozen cap applies to the complete suffix. Per-field bounds alone would
  // admit three ~2000-character fields at once, and a total-only bound of <=4096
  // (or <=7000) would still admit an over-long failure suffix.
  assert.ok(detail.length <= 2000, `the complete failure-detail suffix must not exceed 2000 characters (actual ${detail.length})`);
  assert.ok(summary.length <= base.length + 2000, `only the fixed trusted-admission base sentence may sit outside the 2000-character failure detail (summary ${summary.length}, base ${base.length})`);
  return `verified; summary length ${summary.length}; failure-detail length ${detail.length}; longest runs ${runs.join(' ')}`;
});

// ---------------------------------------------------------------------------
// Targeted boundaries Root reproduced (each is one mutation of the control).
// ---------------------------------------------------------------------------
await runCase('boundary-environment-source-mock', async () => checkNegative('boundary-environment-source-mock', (f) => {
  mutateEnvironment(f, (environment) => { environment.source = 'mock'; });
}, control));

await runCase('boundary-environment-hardware-cpu', async () => checkNegative('boundary-environment-hardware-cpu', (f) => {
  mutateEnvironment(f, (environment) => { environment.hardware = 'cpu'; });
}, control));

await runCase('boundary-environment-publishable-true', async () => checkNegative('boundary-environment-publishable-true', (f) => {
  mutateEnvironment(f, (environment) => { environment.publishable = true; });
}, control));

await runCase('boundary-environment-live-hardware-false', async () => checkNegative('boundary-environment-live-hardware-false', (f) => {
  // The projected/queue environment denies live hardware while the authorized
  // evidence still claims a live GPU run: the conflict must fail closed.
  mutateEnvironment(f, (environment) => { environment.liveHardware = false; });
}, control));

await runCase('boundary-payload-target-mismatch', async () => checkNegative('boundary-payload-target-mismatch', (f) => {
  f.task.payload.target = { platform: 'cpu', device: 'cpu', hardware: ['cpu'] };
}, control));

await runCase('boundary-payload-build-mismatch', async () => checkNegative('boundary-payload-build-mismatch', (f) => {
  f.task.payload.build = { kind: 'source-tree', format: 'directory' };
}, control));

await runCase('boundary-payload-adapter-mismatch', async () => checkNegative('boundary-payload-adapter-mismatch', (f) => {
  f.task.payload.adapter = { id: 'other-adapter', version: '9', languages: ['python'] };
}, control));

await runCase('boundary-payload-purpose-baseline', async () => checkNegative('boundary-payload-purpose-baseline', (f) => {
  f.task.payload.purpose = 'baseline';
}, control));

await runCase('boundary-typed-error-retryable-true', async () => checkNegative('boundary-typed-error-retryable-true', (f) => {
  mutateTypedFailure(f, (error) => { error.retryable = true; });
}, control));

await runCase('boundary-typed-error-empty-message', async () => checkNegative('boundary-typed-error-empty-message', (f) => {
  mutateTypedFailure(f, (error) => { error.message = ''; });
}, control));

await runCase('boundary-typed-error-missing-details', async () => checkNegative('boundary-typed-error-missing-details', (f) => {
  mutateTypedFailure(f, (error) => { delete error.details; });
}, control));

await runCase('boundary-preceding-case-missing-name', async () => checkNegative('boundary-preceding-case-missing-name', (f) => {
  mutateCorrectness(f, (correctness) => { delete correctness.caseResults[0].case; });
}, control));

// ---------------------------------------------------------------------------
// Real production archive/reset: benchmark status failed, result.error phase
// benchmark, benchmark=[] — but the provided top-level correctness passed with the
// four requested named cases. resetMissionRunState must archive that passed
// correctness (status/total/cases retained) while the failure fact stays the
// benchmark error. roundFacts is never hand-authored.
// ---------------------------------------------------------------------------
await runCase('passed-correctness-archive', async () => {
  const archiveRoot = path.join(tempRoot, 'archive-scenario');
  const archiveWorkspaces = path.join(tempRoot, 'archive-workspaces');
  const projectState = createMissionProjectState({
    rootDir: archiveRoot,
    workspaceDir: archiveWorkspaces,
    workspaceDirForMission: (missionId) => path.join(archiveWorkspaces, missionId),
    missionSourceDirFor: (missionId) => path.join(archiveRoot, 'sources', missionId),
  });
  const state = { missions: [], projects: [], activeMissionId: null, activeProjectId: null, runtimeEvents: [], auditEvents: [], iterationStats: {} };
  projectState.createMission(state, {
    title: 'Passed correctness after a benchmark failure',
    goal: 'Archive the passed correctness without inventing a failed case',
    metric: 'latency p50',
    hardware: ['local-shared-gpu'],
    operator: 'generic_affine',
    tags: ['affine'],
    repository: 'repo-passed-archive',
    testMatrix: { correctnessCases: 4 },
    objective: { targetRelativeImprovement: 0.999999 },
  });
  const mission = state.missions.find((item) => item.id === state.activeMissionId);
  const candidateId = 'candidate-passed-archive';
  const patchDigest = digest('passed-archive-patch');
  const binding = makeBinding('passed-archive', mission.id);
  const caseNames = ['minimal', 'representative', 'boundary', 'ragged'];
  const correctness = {
    status: 'passed', passed: true, total: 4, executedCases: 4, passedCases: 4,
    failedCase: null, failedCaseName: null, failedCaseCategory: null,
    caseResults: caseNames.map(passedCase),
    failure: null, error: null,
  };
  const environment = makeEnvironment();
  const result = {
    schemaVersion: 'operator-studio.shared-gpu-result/v1', status: 'failed', benchmark: [], publishable: false,
    correctness: structuredClone(correctness), error: structuredClone(BENCHMARK_ERROR), environment,
    executionPackage: structuredClone(binding), experienceEvidence: null,
  };
  state.agent = {
    status: 'failed', runId: 'agent_passed_archive', roundId: `${mission.id}:round:1`, missionId: mission.id,
    runtimeKind: 'claude-code', goal: mission.goal, threadId: 'thread-passed-archive',
    toolCalls: [], messages: [], resourceRelease: { confirmed: true, status: 'confirmed' },
  };
  state.stage = 'diagnosis';
  state.appliedCandidateId = candidateId;
  state.candidateEvaluations = [{
    id: candidateId, title: 'passed archive candidate', change: 'keep the passed correctness',
    files: ['run.py'], patchDigest, candidateGenerationPath: 'structured_edit', degraded: false,
  }];
  state.benchmark = {
    status: 'failed', purpose: 'candidate', testTaskId: 'task-passed-archive',
    runId: 'queue-passed-archive', requestId: 'queue-passed-archive',
    resourceRelease: { confirmed: true, status: 'confirmed' },
    candidate: { id: candidateId, digest: patchDigest },
    matrix: { correctnessCases: 4 },
    lastServiceError: structuredClone(BENCHMARK_ERROR),
    executionPackage: structuredClone(binding),
    result: structuredClone(result),
  };
  // The facts must come from production code below, never from the fixture.
  assert.equal(state.iterationStats.roundFacts, undefined, 'the archive case must not hand-author roundFacts');
  assert.equal(state.iterationContext, undefined, 'the archive case must not hand-author iterationContext');
  assert.equal(typeof projectState.resetMissionRunState, 'function', 'the real production archive entry must be callable');

  projectState.resetMissionRunState(state, 'Round 2 after the benchmark failure.');
  const facts = state.iterationStats.roundFacts;
  assert.equal(facts?.schemaVersion, 'operator-studio.round-facts/v1');
  assert.equal(facts.correctness.status, 'passed', 'the provided top-level passed correctness is the authority even when the benchmark state failed');
  assert.equal(facts.correctness.total, 4, 'the requested case count must be retained');
  assert.equal(facts.correctness.cases.length, 4, 'all four attempted passed cases must be archived');
  for (const name of caseNames) {
    assert.ok(facts.correctness.cases.some((item) => item.case === name && item.passed === true), `the passed case ${name} must be archived as passed`);
  }
  assert.equal(facts.correctness.failedCase, null, 'a passed correctness must not fabricate a failed case index');
  assert.equal(facts.correctness.error, null, 'a passed correctness must not fabricate an error');
  assert.ok(facts.failure, 'the benchmark failure fact must remain');
  assert.equal(facts.failure.code, BENCHMARK_ERROR.code, 'the archived failure stays the benchmark error code');
  assert.equal(facts.failure.message, BENCHMARK_ERROR.message, 'the archived failure stays the benchmark error message');
  return `archived correctness passed with ${facts.correctness.cases.length} cases; failure stayed ${facts.failure.code}`;
});

const counts = {
  total: outcomes.length,
  passed: outcomes.filter((item) => item.outcome === 'passed').length,
  failed: outcomes.filter((item) => item.outcome === 'failed').length,
  blocked: outcomes.filter((item) => item.outcome === 'blocked').length,
};
const ok = counts.failed === 0 && counts.blocked === 0;
console.log(JSON.stringify({
  ok,
  counts,
  cases: outcomes,
  note: 'blocked means the control failed-candidate positive did not verify, so a rejection cannot be attributed to the mutated boundary and is never reported green. A red case is always reported as failed, never silently accepted.',
}, null, 2));
process.exitCode = ok ? 0 : 1;

} finally {
  // Remove only this test's own isolated root, even when an assertion fails.
  await rm(tempRoot, { recursive: true, force: true });
}
