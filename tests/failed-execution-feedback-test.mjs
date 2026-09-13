// Independent acceptance for docs/development/FAILED_EXECUTION_FEEDBACK_ACCEPTANCE.md (Node half).
//
// Two real production boundaries are driven here:
//   1. The trusted failed-observation verifier matrix (createSharedGpuExperienceVerifier).
//   2. The production failed-round pipeline: createBenchmarkProjectionService ->
//      applyOperatorTestSnapshot -> roundExperience.collect -> real filesystem Experience
//      repository -> resetMissionRunState archive -> agent-round-service + agentRuntime
//      next-round prompt/audit. The provider is an injected port double; no Claude/Codex
//      process, GPU, network or N=20 batch is started.
//
// What is REAL: the projection/verifier/round-experience/archive/prompt code paths and the
// repository storage. What is a PORT DOUBLE: the queue snapshot source, package admission,
// readTask, the prepared-artifact adapter and the Agent provider client. roundFacts /
// iterationContext / experiences are never hand-authored; they are read back after the
// production code produces them.
//
// Result envelope fidelity (frozen contract "Result contract and identity"): the typed
// error is the object carried by result.error / correctness.failure / the final case
// failure. correctness.error and each case.error keep the real string error.message the
// runner produced; they are not DTO-converted into objects here.
//
// Verifier matrix honesty: a rejected negative proves the verifier did not accept the
// observation and did not rewrite the projected result, the observation evidence or the
// queue receipt. The real Experience repository non-growth is asserted separately, in
// integration scenario E.
//
// On the pre-implementation tree the first failed positive cannot verify (the trusted
// verifier still requires benchmark.status=complete and a completed queue task, and the
// failed producer path does not exist yet), so this file is the intended red baseline. It
// must not be weakened to match the pre-integration tree.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

// Explicit scratch isolation must happen before any production module is imported.
const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'operator-failed-feedback-'));
process.env.OPERATOR_RUNTIME_DIR = path.join(tempRoot, 'runtime');
process.env.OPERATOR_DATA_DIR = path.join(tempRoot, 'data');
process.env.OPERATOR_BRIDGE_DIR = path.join(tempRoot, 'bridge');
delete process.env.OPERATOR_RUNTIME_MODE;

const { createSharedGpuExperienceVerifier } = await import('../client-runtime/application/shared-gpu-experience-verifier.mjs');

try {

const sha256Hex = (value) => createHash('sha256').update(value, 'utf8').digest('hex');
const digest = (label) => `sha256:${sha256Hex(label)}`;
const prefixed = (value) => `sha256:${String(value).replace(/^sha256:/iu, '').toLowerCase()}`;
const clock = Date.parse('2026-09-13T00:00:00.000Z');
const iso = (ms = clock) => new Date(ms).toISOString();
let idCounter = 0;

const FAILED_CANDIDATE_CODES = ['OPERATOR_CORRECTNESS_MISMATCH', 'OPERATOR_CANDIDATE_EXCEPTION'];
// One consistent numeric mismatch sample: the message and the archived case metrics state
// the same maxDiff/rmse/cosDiff, so a reader never has to reconcile a cosine threshold
// claim with an unrelated cosDiff. Uncomputed metrics (candidate throws) are exercised by
// the OPERATOR_CANDIDATE_EXCEPTION fixture below, where every metric is null.
const MISMATCH_METRICS = Object.freeze({ maxDiff: 3.2e-4, rmse: 2.4e-4, cosDiff: 0.9997 });
const MISMATCH_MESSAGE = 'maxDiff 3.2e-4 exceeds the frozen 1e-5 tolerance on case boundary (rmse 2.4e-4, cosDiff 0.9997)';
const EXCEPTION_MESSAGE = 'addcmul(): argument tensor2 (position 2) must be a tensor of type float, not float32';

const typedError = ({ code = 'OPERATOR_CORRECTNESS_MISMATCH', message = MISMATCH_MESSAGE, role = 'candidate', phase = 'correctness' } = {}) => ({
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

const makeCorrectness = ({ error, total = 4, metrics = MISMATCH_METRICS } = {}) => ({
  status: 'failed', passed: false, total, executedCases: 3, passedCases: 2,
  failedCase: 3, failedCaseName: 'boundary', failedCaseCategory: 'boundary',
  caseResults: [passedCase('minimal'), passedCase('representative'), failedCase('boundary', error, metrics)],
  failure: structuredClone(error), // typed first failure
  error: error.message, // real string error.message
});

const makeEnvironment = ({ architecture = 'sm86', liveHardware = true, executionMode = 'gpu', probe = true } = {}) => ({
  requested: ['local-shared-gpu'], runtime: 'local-shared-gpu-runner/v1', service: 'local-shared-gpu-adapter',
  source: 'local-shared-gpu', hardware: 'nvidia-gpu', executionMode, liveHardware, publishable: false,
  ...(architecture ? { architecture } : {}),
  ...(probe ? { device: 'NVIDIA GeForce RTX 3060 Laptop GPU', driverVersion: '551.78', targetProbe: { deviceName: 'NVIDIA GeForce RTX 3060 Laptop GPU', driverVersion: '551.78', architecture } } : {}),
});

// Complete, identical executionPackage binding: the payload, the projected result, the
// persisted state benchmark and the queue receipt all carry the same target/build/adapter
// the admission and prepared-artifact ports must actually validate.
const makeBinding = (label, workspaceId) => ({
  packageDigest: digest(`${label}-package`), admissionId: `admission-${label}`,
  preparedArtifactDigest: digest(`${label}-artifact`), environmentDigest: digest(`${label}-environment`),
  acceptanceDigest: digest(`${label}-acceptance`), workspaceId,
  target: { platform: 'nvidia-cuda', device: 'gpu', hardware: ['nvidia-gpu'], architecture: 'sm86' },
  build: { kind: 'prepared-artifact', format: 'source-tree' },
  adapter: { id: 'python-shared-gpu', version: '1', languages: ['python'] },
});

// ---------------------------------------------------------------------------
// Section 1. Trusted failed-observation verifier matrix.
// ---------------------------------------------------------------------------
const buildFailedFixture = ({ code = FAILED_CANDIDATE_CODES[0], message, role = 'candidate', phase = 'correctness', metrics = MISMATCH_METRICS } = {}) => {
  const candidateId = 'candidate-fb';
  const runId = 'run-fb';
  const mission = { id: 'MIS_FB', projectId: 'PROJ_FB', hardware: ['nvidia-gpu'], architecture: ['sm86'], operator: 'generic_affine', tags: ['affine'] };
  const binding = makeBinding('fb', mission.id);
  const error = typedError({ code, role, phase, ...(message ? { message } : {}) });
  const correctness = makeCorrectness({ error, metrics });
  const environment = makeEnvironment();
  const patchDigest = digest('fb-patch');
  const evidence = {
    missionId: mission.id, candidateId, runId, patchDigest,
    packageDigest: binding.packageDigest, environmentDigest: binding.environmentDigest, acceptanceDigest: binding.acceptanceDigest,
    hardware: 'nvidia-gpu', executionMode: 'gpu', outcome: 'failed', operation: 'test', liveHardware: true, architecture: 'sm86',
  };
  const result = {
    schemaVersion: 'operator-studio.shared-gpu-result/v1', status: 'failed', benchmark: [], publishable: false,
    correctness: structuredClone(correctness), error: structuredClone(error), environment: structuredClone(environment),
    executionPackage: structuredClone(binding), experienceEvidence: structuredClone(evidence),
  };
  const task = {
    taskId: 'queue-fb', status: 'failed',
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
  return { binding, mission, candidateId, runId, patchDigest, error, correctness, environment, result, evidence, task, state, observation, admitted };
};

// The admission port validates the actual request the verifier assembled (identity,
// binding digests, run identity, candidate binding and target/build/adapter presence); it
// never approves unconditionally. The prepared-artifact port reports the injected verdict
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

// Every negative is expressed on a clone of the fixture that verifies unmutated, so a
// rejection is attributable to the mutated target rather than to a missing unrelated
// field. Result/evidence/queue copies are mutated together unless the negative is
// specifically a one-sided queue-vs-projection disagreement; the copies are asserted equal
// before the acceptance call so an early "queue != projection" rejection cannot mask the
// intended branch.
const resultCopies = (f) => [f.result, f.state.benchmark.result, f.task.result];
const evidenceCopies = (f) => [...resultCopies(f).map((entry) => entry.experienceEvidence), f.observation.evidence];
const packageCopies = (f) => [
  f.result.executionPackage, f.state.benchmark.result.executionPackage, f.task.result.executionPackage,
  f.state.benchmark.executionPackage, f.task.executionPackage,
];
const mutateResults = (f, mutate) => { for (const result of resultCopies(f)) mutate(result); };
const mutateEnvironment = (f, mutate) => { mutateResults(f, (result) => mutate(result.environment)); mutate(f.environment); };
const mutateEvidence = (f, mutate) => { for (const target of evidenceCopies(f)) mutate(target); };
const mutateCorrectness = (f, mutate) => { mutateResults(f, (result) => mutate(result.correctness)); mutate(f.correctness); };
const mutatePackage = (f, mutate) => { for (const binding of packageCopies(f)) mutate(binding); };
// The typed first failure lives in result.error / correctness.failure / the final case
// failure and must agree by full value; the string error.message copies stay in sync.
const mutateTypedFailure = (f, mutate) => {
  for (const result of resultCopies(f)) {
    mutate(result.error);
    mutate(result.correctness.failure);
    mutate(result.correctness.caseResults.at(-1).failure);
    result.correctness.caseResults.at(-1).error = result.error.message;
    result.correctness.error = result.error.message;
  }
  mutate(f.error);
  mutate(f.correctness.failure);
  f.correctness.error = f.error.message;
};

const assertQueueResultConsistency = (f, label) => {
  const projected = f.state.benchmark.result;
  const queued = f.task.result;
  assert.deepEqual(queued.correctness, projected.correctness, `${label}: the queue correctness copy must agree with the projection before the acceptance call`);
  assert.deepEqual(queued.error, projected.error, `${label}: the queue typed error copy must agree with the projection before the acceptance call`);
  assert.deepEqual(queued.experienceEvidence, projected.experienceEvidence, `${label}: the queue experienceEvidence copy must agree with the projection before the acceptance call`);
  assert.deepEqual(queued.executionPackage, projected.executionPackage, `${label}: the queue executionPackage copy must agree with the projection before the acceptance call`);
};

const expectRejected = async (name, mutate, { verifier = {}, queueAgrees = true } = {}) => {
  const fixture = structuredClone(baseFixture);
  mutate(fixture);
  if (queueAgrees) assertQueueResultConsistency(fixture, name);
  const projectedBefore = JSON.stringify(fixture.state.benchmark.result);
  const observedBefore = JSON.stringify(fixture.observation.evidence);
  const queueBefore = JSON.stringify(fixture.task.result);
  const proof = await fixtureVerifier(fixture, verifier)({ state: fixture.state, mission: fixture.mission, observation: fixture.observation });
  assert.notEqual(proof.verified, true, `${name}: the mutated target field must be rejected`);
  assert.equal(typeof proof.code, 'string', `${name}: a rejection must carry a production-owned code`);
  // The verifier is a read-only authority: rejection must not rewrite the projected
  // result, the observation evidence or the queue receipt.
  assert.equal(JSON.stringify(fixture.state.benchmark.result), projectedBefore, `${name}: a rejected observation must not rewrite the projected result`);
  assert.equal(JSON.stringify(fixture.observation.evidence), observedBefore, `${name}: a rejected observation must not rewrite the observation evidence`);
  assert.equal(JSON.stringify(fixture.task.result), queueBefore, `${name}: a rejected observation must not rewrite the queue receipt`);
  return proof;
};

{
  // Positive: a fully bound failed candidate correctness observation verifies and its
  // deterministic proof.summary carries the typed identity the next round must see.
  const proof = await fixtureVerifier(baseFixture)({ state: baseFixture.state, mission: baseFixture.mission, observation: baseFixture.observation });
  assert.equal(proof.verified, true, 'a fully bound failed candidate observation must verify');
  assert.equal(proof.evidence.outcome, 'failed');
  assert.equal(proof.evidence.candidateId, baseFixture.candidateId);
  const summary = String(proof.summary);
  assert.ok(summary.includes(baseFixture.error.code), 'summary must carry the typed error code');
  assert.ok(summary.includes('correctness') && summary.includes('candidate'), 'summary must carry phase/role');
  assert.ok(summary.includes('boundary'), 'summary must carry the failed case name/category');
  assert.ok(summary.includes('4') && summary.includes('3') && summary.includes('2'), 'summary must carry total/executed/passed counts');
  assert.ok(summary.includes(baseFixture.error.message), 'summary must carry the real error');

  // The candidate-exception code is the other eligible typed failure. Its metrics were
  // never computed (the candidate threw), so they stay null, never a fabricated 0.
  const exceptionFixture = buildFailedFixture({ code: 'OPERATOR_CANDIDATE_EXCEPTION', message: EXCEPTION_MESSAGE, metrics: null });
  const exceptionCase = exceptionFixture.correctness.caseResults.at(-1);
  assert.equal(exceptionCase.maxDiff, null, 'an uncomputed metric must stay null in the fixture');
  assert.equal(exceptionCase.rmse, null);
  assert.equal(exceptionCase.cosDiff, null);
  assert.equal(exceptionCase.error, EXCEPTION_MESSAGE, 'the case error keeps the real string error.message');
  const exceptionProof = await fixtureVerifier(exceptionFixture)({ state: exceptionFixture.state, mission: exceptionFixture.mission, observation: exceptionFixture.observation });
  assert.equal(exceptionProof.verified, true, 'a bound candidate exception must verify as an operator failure');
  assert.ok(String(exceptionProof.summary).includes('OPERATOR_CANDIDATE_EXCEPTION'));
  assert.ok(String(exceptionProof.summary).includes(EXCEPTION_MESSAGE), 'the candidate exception summary must carry the real error');

  // A long failure detail is bounded by the contract to a 2000-character failure-detail
  // suffix. A total-length bound alone would accept a 3000-char suffix, so count the
  // longest surviving run of the repeated character and require the tail marker to be gone.
  const repeated = 'Z'.repeat(5000);
  const longFixture = buildFailedFixture({ message: `${repeated}TAIL_MARKER` });
  const longProof = await fixtureVerifier(longFixture)({ state: longFixture.state, mission: longFixture.mission, observation: longFixture.observation });
  assert.equal(longProof.verified, true, 'a long failure message must still verify');
  const longSummary = String(longProof.summary);
  const longestRun = Math.max(0, ...(longSummary.match(/Z+/gu) || []).map((run) => run.length));
  assert.ok(longestRun >= 1, 'the real error prefix must still reach the summary');
  assert.ok(longestRun <= 2000, `the bounded failure-detail suffix must not exceed 2000 characters (surviving run: ${longestRun})`);
  assert.equal(longSummary.includes('TAIL_MARKER'), false, 'the unbounded failure tail must not survive into the summary');
}

{
  // A fully bound failed candidate observation verifies through the queue receipt too:
  // the persisted queue task must agree with the projection on every checked identity.
  // (Explicit positive guard for the readTask-required failed branch.)
  const fixture = structuredClone(baseFixture);
  assertQueueResultConsistency(fixture, 'failed positive');
}

{
  await expectRejected('outcome contradiction (passed claim)', (f) => { mutateEvidence(f, (evidence) => { evidence.outcome = 'passed'; }); });
  await expectRejected('outcome contradiction (benchmark complete)', (f) => { f.state.benchmark.status = 'complete'; });
  await expectRejected('wrong Mission', (f) => {
    mutateEvidence(f, (evidence) => { evidence.missionId = 'MIS_OTHER'; });
  });
  await expectRejected('wrong candidate', (f) => { f.state.benchmark.candidate.id = 'candidate-other'; });
  await expectRejected('wrong applied candidate', (f) => { f.state.appliedCandidateId = 'candidate-other'; });
  await expectRejected('wrong run/request identity', (f) => { f.state.benchmark.runId = 'run-other'; f.state.benchmark.requestId = 'run-other'; });
  await expectRejected('wrong queue taskId', (f) => { f.task.taskId = 'queue-other'; });
  await expectRejected('queue still running', (f) => { f.task.status = 'running'; });
  await expectRejected('queue cancelled/quarantined', (f) => { f.task.status = 'cancelled'; });
  await expectRejected('queue release missing', (f) => { delete f.task.resourceRelease; });
  await expectRejected('queue release not confirmed', (f) => { f.task.resourceRelease = { confirmed: false, status: 'pending' }; });
  await expectRejected('benchmark release not confirmed', (f) => { f.state.benchmark.resourceRelease = { confirmed: false, status: 'pending' }; });
  // Binding digests change on the executionPackage only; the recorded evidence keeps the
  // admitted digests, so the binding-vs-evidence constraint is the one under test.
  await expectRejected('wrong package binding digest', (f) => { mutatePackage(f, (binding) => { binding.packageDigest = digest('other-package'); }); });
  await expectRejected('wrong environment binding digest', (f) => { mutatePackage(f, (binding) => { binding.environmentDigest = digest('other-environment'); }); });
  await expectRejected('wrong acceptance binding digest', (f) => { mutatePackage(f, (binding) => { binding.acceptanceDigest = digest('other-acceptance'); }); });
  // Workspace identity lives on the executionPackage binding; the Mission keeps its own id.
  await expectRejected('wrong workspace identity', (f) => { mutatePackage(f, (binding) => { binding.workspaceId = 'MIS_OTHER'; }); });
  await expectRejected('wrong admission id', (f) => { mutatePackage(f, (binding) => { binding.admissionId = 'admission-other'; }); });
  await expectRejected('wrong prepared artifact digest', (f) => { mutatePackage(f, (binding) => { binding.preparedArtifactDigest = digest('other-artifact'); }); });
  // The prepared-artifact port alone reports invalid; the digest binding stays intact.
  await expectRejected('prepared artifact port invalid', () => {}, { verifier: { artifactValid: false } });
  await expectRejected('queue result error mismatch', (f) => { f.task.result.error.code = 'OPERATOR_CANDIDATE_EXCEPTION'; }, { queueAgrees: false });
  await expectRejected('queue result correctness mismatch', (f) => { f.task.result.correctness.passed = true; }, { queueAgrees: false });
  await expectRejected('queue result evidence mismatch', (f) => { f.task.result.experienceEvidence.runId = 'run-other'; }, { queueAgrees: false });
  await expectRejected('queue executionPackage mismatch', (f) => {
    f.task.result.executionPackage.packageDigest = digest('other-package'); f.task.executionPackage.packageDigest = digest('other-package');
  }, { queueAgrees: false });
  await expectRejected('projected result has no experienceEvidence', (f) => { mutateResults(f, (result) => { delete result.experienceEvidence; }); });
  await expectRejected('readTask port missing', () => {}, { verifier: { readTask: false } });

  // Wrong phase/role must never be learned as an operator failure. The typed triple
  // (result.error / correctness.failure / final failure) changes together.
  for (const [name, mutateError] of [
    ['role=oracle', (error) => { error.role = 'oracle'; }],
    ['phase=preflight', (error) => { error.phase = 'preflight'; }],
    ['phase=benchmark', (error) => { error.phase = 'benchmark'; }],
  ]) {
    await expectRejected(name, (f) => mutateTypedFailure(f, mutateError));
  }

  // Oracle exception is a distinct typed code and must never become operator experience.
  const oracleFixture = buildFailedFixture({ code: 'OPERATOR_ORACLE_EXCEPTION', role: 'oracle' });
  const oracleProof = await fixtureVerifier(oracleFixture)({ state: oracleFixture.state, mission: oracleFixture.mission, observation: oracleFixture.observation });
  assert.notEqual(oracleProof.verified, true, 'role=oracle must never authorize operator experience');

  // A backend code that is not one of the two frozen candidate codes must be rejected.
  await expectRejected('unfrozen backend error code', (f) => mutateTypedFailure(f, (error) => { error.code = 'SHARED_GPU_BACKEND_ERROR'; }));

  // not_run: a failed execution that attempted no case must not fabricate a failed case.
  await expectRejected('not_run correctness', (f) => {
    const notRun = { status: 'not_run', passed: null, total: 4, executedCases: 0, passedCases: 0, failedCase: null, failedCaseName: null, failedCaseCategory: null, caseResults: [], failure: null, error: null };
    for (const result of resultCopies(f)) result.correctness = structuredClone(notRun);
  });

  // Fabricated counts, prefix and case identity.
  await expectRejected('fabricated passedCases=executedCases', (f) => mutateCorrectness(f, (correctness) => { correctness.passedCases = 3; }));
  await expectRejected('fabricated passedCases prefix', (f) => mutateCorrectness(f, (correctness) => { correctness.passedCases = 1; }));
  await expectRejected('fabricated failedCase index', (f) => mutateCorrectness(f, (correctness) => { correctness.failedCase = 2; }));
  await expectRejected('fabricated case prefix length', (f) => mutateCorrectness(f, (correctness) => { correctness.caseResults = correctness.caseResults.slice(0, 2); }));
  await expectRejected('preceding case marked failed', (f) => mutateCorrectness(f, (correctness) => { correctness.caseResults[0].passed = false; }));
  await expectRejected('failed case name mismatch', (f) => mutateCorrectness(f, (correctness) => { correctness.caseResults[2].case = 'other'; }));
  await expectRejected('fabricated zero total', (f) => mutateCorrectness(f, (correctness) => { correctness.total = 0; }));

  // Missing real probe and mock/simulation must fail closed. The environment copy in the
  // queue receipt is synced with the projection.
  await expectRejected('missing real probe metadata', (f) => {
    mutateEnvironment(f, (environment) => { delete environment.targetProbe; delete environment.device; delete environment.driverVersion; });
  });
  await expectRejected('probe without driver version', (f) => {
    mutateEnvironment(f, (environment) => { delete environment.driverVersion; environment.targetProbe = { deviceName: 'NVIDIA GeForce RTX 3060 Laptop GPU' }; });
  });
  await expectRejected('simulation execution mode', (f) => {
    mutateEvidence(f, (evidence) => { evidence.executionMode = 'simulation'; evidence.liveHardware = false; });
    mutateEnvironment(f, (environment) => { environment.executionMode = 'simulation'; environment.liveHardware = false; });
  });
  await expectRejected('conflicting liveHardware=false', (f) => {
    mutateEvidence(f, (evidence) => { evidence.liveHardware = false; });
  });
}

{
  // The successful legacy observation path and its compatibility behaviour stay intact.
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
  assert.equal((await verifier({ state, mission, observation: { evidence: { ...evidence, candidateId: 'other' } } })).verified, false, 'the success path still rejects a wrong candidate');
}

console.log('[failed-execution-feedback] verifier failed-candidate matrix passed (positive, bounded summary, negatives fail closed)');

// ---------------------------------------------------------------------------
// Section 2. Production failed-round pipeline.
// ---------------------------------------------------------------------------
const { createMissionProjectState, selectRoundFactsForPrompt } = await import('../client-runtime/mission-project-state.mjs');
const { applyOperatorTestSnapshot } = await import('../client-runtime/operator-test-evidence.mjs');
const { createExperienceRepository } = await import('../client-runtime/experience-repository.mjs');
const { createExperienceService } = await import('../client-runtime/application/experience-service.mjs');
const { createRoundExperienceService } = await import('../client-runtime/application/round-experience-service.mjs');
const { createBenchmarkProjectionService } = await import('../client-runtime/application/benchmark-projection-service.mjs');
const { createAgentRoundService } = await import('../client-runtime/application/agent-round-service.mjs');
const { createMainRoundOrchestrationService } = await import('../client-runtime/application/main-round-orchestration-service.mjs');
const { createAgentRuntime } = await import('../client-runtime/agent-runtime.mjs');
const { ensureRoundBudgetStarted, completeRoundBudget } = await import('../client-runtime/round-budget-contract.mjs');
const { isManagedWorkspaceRuntimeMode } = await import('../client-runtime/agent-runtime/capabilities.mjs');
const { appendRuntimeEvent, addAuditEvent } = await import('../client-runtime/runtime-events.mjs');

const timers = { setTimeout: (cb, ms) => setTimeout(cb, ms), clearTimeout: (handle) => clearTimeout(handle) };

const createScenario = async ({ name }) => {
  const rootDir = path.join(tempRoot, 'scenarios', name);
  const missionWorkspaceRoot = path.join(tempRoot, 'mission-workspaces', name);
  const projectState = createMissionProjectState({
    rootDir,
    workspaceDir: missionWorkspaceRoot,
    workspaceDirForMission: (missionId) => path.join(missionWorkspaceRoot, missionId),
    missionSourceDirFor: (missionId) => path.join(rootDir, 'sources', missionId),
  });
  const state = { missions: [], projects: [], activeMissionId: null, activeProjectId: null, runtimeEvents: [], auditEvents: [], iterationStats: {} };
  projectState.createMission(state, {
    title: `Failed feedback ${name}`, goal: `Optimize the affine kernel for ${name}`, metric: 'latency p50',
    hardware: ['local-shared-gpu'], operator: 'generic_affine', tags: ['affine'], repository: `repo-${name}`,
    testMatrix: { correctnessCases: 4 }, objective: { targetRelativeImprovement: 0.999999 },
  });
  const mission = state.missions.find((item) => item.id === state.activeMissionId);
  const repository = createExperienceRepository({ rootDir: path.join(tempRoot, 'stores', name) });
  const experienceService = createExperienceService({ repository, now: () => iso(), createId: () => `exp_${name}_${++idCounter}` });
  const tasks = new Map();
  const admitted = new Map();
  const verifier = createSharedGpuExperienceVerifier({
    executionPackageStore: {
      // The admission port validates the actual request; it never approves unconditionally.
      verifyAdmission: async (request) => {
        if (!admitted.has(request.admissionId)) throw new Error(`unknown admission ${request.admissionId}`);
        if (request.missionId !== mission.id) throw new Error(`admission request Mission mismatch: ${request.missionId}`);
        if (request.workspaceId !== mission.id) throw new Error(`admission request workspace mismatch: ${request.workspaceId}`);
        if (!request.candidate?.id || !request.candidate?.digest) throw new Error('admission request lacks a candidate binding');
        return { admission: { preparedArtifactDigest: admitted.get(request.admissionId) }, manifest: { requestId: request.requestId }, environment: {} };
      },
    },
    packageAdapter: { verifyPreparedArtifact: async () => ({ valid: true }) },
    readTask: async (taskId) => tasks.get(taskId) || null,
    now: () => clock,
  });
  const roundExperience = createRoundExperienceService({
    experienceService,
    resolveAccess: ({ mission: bound }) => ({ projectId: bound.projectId, allowedProjectIds: [bound.projectId] }),
    verifyObservationEvidence: verifier, timers,
  });
  const projection = createBenchmarkProjectionService({
    operatorTestQueue: { get: async (taskId) => tasks.get(taskId) },
    testServiceClient: { get: async () => { const error = new Error('not found'); error.code = 'OPERATOR_TEST_QUEUE_NOT_FOUND'; throw error; } },
    applyOperatorTestSnapshot, artifactDirForMission: () => path.join(rootDir, 'artifacts'), mkdir, writeFile, path,
    collectExperience: roundExperience.collect,
  });
  return {
    name, rootDir, projectState, state, mission, repository, experienceService, roundExperience, projection, tasks, admitted,
    bridgeDir: path.join(tempRoot, 'bridges', name), workspaceRoot: missionWorkspaceRoot,
    workspaceForMission: (missionId = mission.id) => path.join(missionWorkspaceRoot, missionId),
  };
};

const seedRound = ({ scenario, candidateId, agentRunId }) => {
  ensureRoundBudgetStarted(scenario.state, { nowMs: clock });
  const roundId = scenario.state.iterationStats.roundBudget.roundId;
  const patchDigestRaw = sha256Hex(`${scenario.name}:${candidateId}`);
  const patchDigest = `sha256:${patchDigestRaw}`;
  const binding = makeBinding(scenario.name, scenario.mission.id);
  scenario.admitted.set(binding.admissionId, binding.preparedArtifactDigest);
  scenario.state.iterationStats = { ...scenario.state.iterationStats, round: 0 };
  scenario.state.agent = {
    status: 'running', runId: agentRunId, roundId, missionId: scenario.mission.id, runtimeKind: 'claude-code',
    goal: scenario.mission.goal, threadId: `thread-${scenario.name}`, toolCalls: [], messages: [],
  };
  scenario.state.appliedCandidateId = candidateId;
  scenario.state.candidateEvaluations = [{
    id: candidateId, title: `${candidateId} vectorized load`, change: 'merge boundary copies into one vectorized load',
    files: ['run.py'], patchDigest, candidateGenerationPath: 'structured_edit', degraded: false,
  }];
  scenario.state.currentBest = { candidateId: 'candidate-prior', version: 'cnd.00', value: 9.5, improvement: '-20.0%', status: 'active', measurements: [{ profile: 'primary', value: 9.5 }] };
  return { roundId, patchDigest, patchDigestRaw, binding, agentRunId };
};

const buildFailedSnapshot = ({ scenario, seed, taskId, queueRunId, candidateId, correctness, error, benchmark = [] }) => {
  const missionId = scenario.mission.id;
  const environment = makeEnvironment();
  const evidence = {
    missionId, candidateId, runId: queueRunId, patchDigest: seed.patchDigest,
    packageDigest: seed.binding.packageDigest, environmentDigest: seed.binding.environmentDigest, acceptanceDigest: seed.binding.acceptanceDigest,
    hardware: 'nvidia-gpu', executionMode: 'gpu', outcome: 'failed', operation: 'test', liveHardware: true, architecture: 'sm86',
  };
  const result = {
    schemaVersion: 'operator-studio.shared-gpu-result/v1', status: 'failed', benchmark: structuredClone(benchmark), publishable: false,
    correctness: structuredClone(correctness), error: error ? structuredClone(error) : null, environment,
    executionPackage: structuredClone(seed.binding), experienceEvidence: evidence,
  };
  return {
    taskId, status: 'failed', progress: 40, completedAt: iso(), durationMs: 2000,
    resourceRelease: { confirmed: true, status: 'confirmed', resources: [] },
    ...(error ? { error: structuredClone(error) } : {}),
    payload: {
      missionId, requestId: queueRunId, purpose: 'candidate', candidate: { id: candidateId, digest: seed.patchDigest },
      packageDigest: seed.binding.packageDigest, admissionId: seed.binding.admissionId, preparedArtifactDigest: seed.binding.preparedArtifactDigest,
      environmentDigest: seed.binding.environmentDigest, acceptanceDigest: seed.binding.acceptanceDigest,
      workspaceId: missionId, target: structuredClone(seed.binding.target), build: structuredClone(seed.binding.build), adapter: structuredClone(seed.binding.adapter),
    },
    executionPackage: structuredClone(seed.binding),
    result,
  };
};

const projectSnapshot = async (scenario, snapshot) => {
  scenario.tasks.set(snapshot.taskId, snapshot);
  scenario.state.benchmark = {
    ...scenario.state.benchmark, status: 'running', progress: 10, testTaskId: snapshot.taskId,
    runId: snapshot.payload.requestId, purpose: 'candidate',
    candidate: { id: snapshot.payload.candidate.id, digest: snapshot.payload.candidate.digest },
    matrix: structuredClone(scenario.mission.testMatrix), logs: [], result: null, lastServiceError: null,
  };
  return scenario.projection.project({ state: scenario.state });
};

const readStore = async (scenario) => (await scenario.repository.read()).records;

const advanceRound = async (scenario, { goal }) => {
  const { state, mission } = scenario;
  const sourceRoundId = state.agent.roundId;
  completeRoundBudget(state, { nowMs: clock });
  state.iterationStats = { ...state.iterationStats, round: 1 };
  ensureRoundBudgetStarted(state, { nowMs: clock, completedRoundId: sourceRoundId });
  const roundTwoId = state.iterationStats.roundBudget.roundId;
  assert.equal(roundTwoId, `${mission.id}:round:2`);
  const workspace = scenario.workspaceForMission();
  await mkdir(workspace, { recursive: true });
  const providerStarts = [];
  const client = {
    describe: async () => ({ installed: true, loggedIn: true, version: 'deterministic-provider-double' }),
    start: async (input) => { providerStarts.push(input.goal); return { runId: input.runId, threadId: 'thread-next', startedAt: iso(), workspace: input.workspace }; },
    readRun: async () => ({ status: 'running' }), readEvents: async () => [], cancel: async () => ({}), eventText: () => '',
  };
  const agentRuntime = createAgentRuntime({ mode: 'claude-code', bridgeDir: scenario.bridgeDir, codexWorkspace: scenario.workspaceRoot, claudeClient: client });
  const agentRound = createAgentRoundService({
    resetMissionRunState: scenario.projectState.resetMissionRunState,
    resetMissionWorkspace: async () => {},
    createWorkspaceCheckpoint: async (missionId, label) => ({ id: `cp-${label}`, missionId, label, stableDigest: digest(`${scenario.name}:next-checkpoint`), createdAt: iso() }),
    startAgentRun: (target, nextGoal, options) => scenario.projectState.startAgentRun(target, nextGoal, options),
    appendRuntimeEvent, isManagedWorkspaceRuntimeMode, agentRuntime,
    roundExperience: scenario.roundExperience, nowMs: () => clock,
  });
  const orchestration = createMainRoundOrchestrationService({
    agentRuntime,
    preflight: { prepare: async () => ({ mission, preflight: { workspace } }) },
    recovery: { restoreRejectedRound: async () => ({ candidateId: state.appliedCandidateId, candidateDigest: state.benchmark?.candidate?.digest || null, checkpointId: 'cp-failed', stableDigest: digest(`${scenario.name}:checkpoint`), workspaceClean: true, restoredAt: iso() }) },
    artifactGuard: { assertReady: () => {} },
    agentRound, appendRuntimeEvent, addAuditEvent,
  });
  await orchestration.start({ state, goal });
  assert.equal(providerStarts.length, 1, 'exactly one provider start for the next round');
  const prompt = providerStarts[0];
  const auditPath = path.join(scenario.bridgeDir, 'prompt-audits', `${state.agent.runId}.json`);
  const audit = JSON.parse(await readFile(auditPath, 'utf8'));
  assert.equal(audit.deliveryStage, 'prepared-before-send');
  assert.equal(audit.prompt, prompt, 'audited pre-send prompt must equal provider start.goal');
  assert.equal(audit.promptDigest, `sha256:${sha256Hex(prompt)}`);
  const factsRaw = prompt.split('----- BEGIN MISSION ITERATION CONTEXT -----\n')[1]?.split('\n----- END MISSION ITERATION CONTEXT -----')[0];
  assert.ok(factsRaw, 'the next-round prompt must embed the archived round facts');
  const facts = JSON.parse(factsRaw);
  assert.deepEqual(audit.roundFacts, facts, 'audit roundFacts must be the same projection sent to the provider');
  return { prompt, audit, facts, roundTwoId, auditPath };
};

const parseExperienceContext = (prompt) => {
  const raw = prompt.split('----- BEGIN UNTRUSTED EXPERIENCE DATA -----\n')[1]?.split('\n----- END UNTRUSTED EXPERIENCE DATA -----')[0];
  assert.ok(raw, 'the next-round prompt must embed the frozen experience context');
  return JSON.parse(raw);
};

// ===========================================================================
// A. Failed candidate correctness -> benchmark=[] -> archived facts -> next prompt.
// ===========================================================================
{
  const scenario = await createScenario({ name: 'failed-correctness' });
  const candidateId = 'candidate-failed-1';
  const seed = seedRound({ scenario, candidateId, agentRunId: 'agent_failed_round_1' });
  const error = typedError();
  const correctness = makeCorrectness({ error });
  const snapshot = buildFailedSnapshot({ scenario, seed, taskId: 'task_failed_1', queueRunId: 'queue-failed-1', candidateId, correctness, error, benchmark: [] });

  const projected = await projectSnapshot(scenario, snapshot);
  assert.equal(projected.changed, true);
  assert.equal(scenario.state.benchmark.status, 'failed', 'the failed terminal state must be projected');
  assert.deepEqual(scenario.state.benchmark.result.benchmark, [], 'a failed correctness result must not serialize a benchmark row');
  assert.equal(scenario.state.benchmark.result.publishable, false);
  assert.equal(scenario.state.benchmark.result.correctness.status, 'failed');
  assert.equal(scenario.state.benchmark.result.correctness.caseResults.length, 3);
  assert.equal(scenario.state.benchmark.result.correctness.error, error.message, 'the projected correctness keeps the real string error.message');
  assert.deepEqual(scenario.state.benchmark.result.correctness.failure, error, 'the projected correctness keeps the typed first failure');

  // The failed observation is collected through the real verifier + real repository.
  const collection = scenario.state.iterationStats.experienceCollection;
  assert.equal(collection.recorded, 1, 'the verified failed observation must be recorded exactly once');
  const records = await readStore(scenario);
  assert.equal(records.length, 1);
  const record = records[0];
  assert.equal(record.source, 'execution');
  assert.equal(record.kind, 'observation');
  assert.equal(record.version, 1);
  assert.equal(record.verification.publishable, false, 'a failed development observation is never publishable');
  assert.equal(record.verification.status, 'observed');
  assert.equal(record.evidence.outcome, 'failed');
  assert.equal(record.evidence.operation, 'test');
  assert.equal(record.evidence.candidateId, candidateId);
  assert.equal(record.evidence.runId, 'queue-failed-1');
  assert.equal(record.scope.hardware[0], 'nvidia-gpu');
  assert.equal(record.scope.architecture[0], 'sm86');
  assert.ok(record.evidenceKey, 'a failed observation keeps its evidence identity key');
  const content = record.content;
  for (const expected of ['OPERATOR_CORRECTNESS_MISMATCH', 'correctness', 'candidate', 'boundary', '4', '3', '2', error.message]) {
    assert.ok(content.includes(expected), `failed experience content must carry ${expected}`);
  }

  // Replaying the identical observation is idempotent: one id/version/evidenceKey.
  const replay = await scenario.roundExperience.collect({ state: scenario.state, mission: scenario.mission });
  assert.equal(replay.records[0].status, 'existing', 'replaying the identical failed observation must be a no-op');
  assert.equal(replay.records[0].experience.id, record.id);
  assert.equal(replay.records[0].experience.version, 1);
  assert.equal(replay.records[0].experience.evidenceKey, record.evidenceKey);
  assert.equal((await readStore(scenario)).length, 1, 'replay must not append a second experience');

  // Production archive/reset freezes the failed correctness from the top-level result.
  const next = await advanceRound(scenario, { goal: 'Round 2: fix the failed correctness case.' });
  const facts = next.facts;
  assert.equal(facts.schemaVersion, 'operator-studio.round-facts/v1');
  assert.equal(facts.correctness.status, 'failed');
  assert.equal(facts.correctness.total, 4, 'total is the frozen requested case count');
  assert.equal(facts.correctness.failedCase, 3);
  assert.equal(facts.correctness.failedCaseName, 'boundary');
  assert.equal(facts.correctness.failedCaseCategory, 'boundary');
  assert.equal(facts.correctness.error, error.message, 'the archived correctness error is the real string error.message');
  assert.equal(facts.correctness.environments[0].environment, 'local-shared-gpu', 'the facts environment comes from the result source');
  assert.equal(facts.correctness.environments[0].stage, 'Correctness');
  assert.equal(facts.correctness.environments[0].profile, null);
  const failedFactCase = facts.correctness.cases.find((item) => item.case === 'boundary');
  assert.ok(failedFactCase, 'the attempted failed case must be archived');
  assert.equal(failedFactCase.passed, false);
  assert.equal(failedFactCase.maxDiff, 3.2e-4, 'the real computed metric is archived, never fabricated as 0');
  assert.equal(failedFactCase.cosDiff, 0.9997);
  assert.equal(facts.failure.code, 'OPERATOR_CORRECTNESS_MISMATCH');
  assert.equal(facts.failure.classification, 'operator');
  assert.equal(facts.previous.candidateId, candidateId, 'the archived previous candidate is the failed candidate');
  assert.equal(facts.previous.candidateDigest, seed.patchDigest);
  assert.equal(facts.candidate.id, candidateId);
  assert.equal(facts.rollback.candidateId, candidateId, 'rollback must keep the failed candidate identity');

  // The failed identity reaches the next-round prompt and audit, including exact experience.
  assert.ok(next.prompt.includes('OPERATOR_CORRECTNESS_MISMATCH'), 'the prompt must carry the failed code');
  assert.ok(next.prompt.includes('boundary'), 'the prompt must carry the failed case');
  assert.equal(next.prompt.includes('"status": "failed"'), true, 'the prompt must carry the failed correctness status');
  const context = parseExperienceContext(next.prompt);
  const item = context.items.find((entry) => entry.id === record.id);
  assert.ok(item, 'the failed experience must be injected into the next-round prompt');
  assert.equal(item.version, 1);
  assert.equal(item.content, record.content, 'the injected experience content must be the exact recorded content');
  assert.equal(item.source, 'execution');
  assert.ok(next.prompt.includes(record.id));
  for (const line of record.content.split('\n').filter((entry) => entry.trim() && !entry.includes('"') && !entry.includes('\\'))) {
    assert.ok(next.prompt.includes(line), `the provider prompt must carry the full failed experience line: ${line}`);
  }
  const selected = next.audit.selection.selected.map((entry) => [entry.id, entry.version, entry.source]);
  assert.ok(selected.some(([id, version, source]) => id === record.id && version === 1 && source === 'execution'), 'the audit must select the failed experience with its exact identity');

  // Applying the next candidate must not rewrite the archived failed identity.
  const factsBefore = structuredClone(scenario.state.iterationStats.roundFacts);
  const archivedBefore = structuredClone(scenario.state.runHistory[0].roundFacts);
  scenario.state.appliedCandidateId = 'candidate-next';
  scenario.state.candidateEvaluations.push({ id: 'candidate-next', title: 'next candidate', change: 'different direction', files: ['run.py'], patchDigest: digest('next-patch') });
  assert.deepEqual(scenario.state.iterationStats.roundFacts, factsBefore, 'the next candidate must not rewrite the archived failed facts');
  assert.equal(scenario.state.runHistory[0].roundFacts.previous.candidateId, candidateId, 'the archived run keeps the failed candidate identity');
  assert.deepEqual(scenario.state.runHistory[0].roundFacts, archivedBefore);
  const recordsAfterNextCandidate = await readStore(scenario);
  assert.equal(recordsAfterNextCandidate.length, 1);
  assert.equal(recordsAfterNextCandidate[0].evidence.candidateId, candidateId, 'the failed experience keeps its own candidate identity');

  console.log('[failed-execution-feedback] production failed-correctness pipeline passed (archive -> prompt -> audit -> idempotent experience)');
}

// ===========================================================================
// B. Stale successful benchmark rows must not override the top-level failed correctness.
// ===========================================================================
{
  const scenario = await createScenario({ name: 'stale-success' });
  const candidateId = 'candidate-stale';
  const seed = seedRound({ scenario, candidateId, agentRunId: 'agent_stale_round_1' });
  const error = typedError();
  const correctness = makeCorrectness({ error });
  const staleRow = {
    environment: 'local-shared-gpu', metric: 'latency p50', profile: 'primary', value: 11.264, unit: 'us', samples: 10, warmup: 3,
    correctness: { passed: true, total: 4, passedCases: 4, failedCase: null, failedCaseName: null, failedCaseCategory: null, error: null, caseResults: [passedCase('minimal'), passedCase('representative'), passedCase('boundary'), passedCase('ragged')] },
  };
  const snapshot = buildFailedSnapshot({ scenario, seed, taskId: 'task_stale_1', queueRunId: 'queue-stale-1', candidateId, correctness, error, benchmark: [staleRow] });

  await projectSnapshot(scenario, snapshot);
  assert.equal(scenario.state.benchmark.result.benchmark.length, 1, 'the stale success row is the fixture, not a new measurement');
  assert.equal(scenario.state.benchmark.result.correctness.status, 'failed');
  assert.equal((await readStore(scenario)).length, 1, 'the failed observation is recorded from the top-level correctness');

  const next = await advanceRound(scenario, { goal: 'Round 2 after the stale success rows.' });
  assert.equal(next.facts.correctness.status, 'failed', 'a stale successful row must not turn the round into passed');
  assert.equal(next.facts.correctness.failedCase, 3);
  assert.equal(next.facts.correctness.failedCaseName, 'boundary');
  assert.equal(next.facts.correctness.error, error.message);
  assert.ok(next.prompt.includes('OPERATOR_CORRECTNESS_MISMATCH'));
  console.log('[failed-execution-feedback] stale success rows cannot override the top-level failed correctness');
}

// ===========================================================================
// C. not_run must stay not_observed and must not fabricate a failed case.
// ===========================================================================
{
  const scenario = await createScenario({ name: 'not-run' });
  const candidateId = 'candidate-not-run';
  const seed = seedRound({ scenario, candidateId, agentRunId: 'agent_notrun_round_1' });
  const correctness = { status: 'not_run', passed: null, total: 4, executedCases: 0, passedCases: 0, failedCase: null, failedCaseName: null, failedCaseCategory: null, caseResults: [], failure: null, error: null };
  const snapshot = buildFailedSnapshot({ scenario, seed, taskId: 'task_notrun_1', queueRunId: 'queue-notrun-1', candidateId, correctness, error: null, benchmark: [] });

  await projectSnapshot(scenario, snapshot);
  assert.equal(scenario.state.iterationStats.experienceCollection.recorded, 0, 'not_run must never create a failed operator experience');
  assert.equal((await readStore(scenario)).length, 0, 'not_run must not grow the experience repository');

  const next = await advanceRound(scenario, { goal: 'Round 2 after a not_run candidate.' });
  assert.equal(next.facts.correctness.status, 'not_observed');
  assert.equal(next.facts.correctness.failedCase, null, 'not_run must not fabricate a failed case index');
  assert.equal(next.facts.correctness.failedCaseName, null);
  assert.equal(next.facts.correctness.error, null);
  assert.deepEqual(next.facts.correctness.cases, [], 'not_run has no attempted case');
  assert.equal(next.facts.correctness.total, 4, 'parsed matrix metadata keeps the requested total');
  console.log('[failed-execution-feedback] not_run stays not_observed without a fabricated failed case');
}

// ===========================================================================
// D. Archive replay is idempotent for the failed round identity.
// ===========================================================================
{
  const scenario = await createScenario({ name: 'replay' });
  const candidateId = 'candidate-replay';
  const seed = seedRound({ scenario, candidateId, agentRunId: 'agent_replay_round_1' });
  const error = typedError();
  await projectSnapshot(scenario, buildFailedSnapshot({ scenario, seed, taskId: 'task_replay_1', queueRunId: 'queue-replay-1', candidateId, correctness: makeCorrectness({ error }), error, benchmark: [] }));

  scenario.projectState.resetMissionRunState(scenario.state, 'first replay goal');
  const firstFacts = structuredClone(scenario.state.iterationStats.roundFacts);
  assert.equal(firstFacts.previous.candidateId, candidateId);
  assert.equal(firstFacts.correctness.status, 'failed');
  scenario.state.agent.goal = 'rewritten goal';
  scenario.projectState.resetMissionRunState(scenario.state, 'second replay goal');
  assert.equal(scenario.state.runHistory.length, 1, 'one runId keeps exactly one archive entry');
  assert.deepEqual(scenario.state.iterationStats.roundFacts, firstFacts, 'replay must reuse the first frozen failed facts');
  assert.equal(scenario.state.iterationStats.roundFacts.previous.goal, scenario.mission.goal);
  assert.equal(scenario.state.iterationStats.roundFacts.previous.candidateId, candidateId);
  assert.equal(scenario.state.iterationStats.roundFacts.correctness.failedCaseName, 'boundary');
  assert.equal((await readStore(scenario)).length, 1, 'replay does not duplicate the failed experience');
  console.log('[failed-execution-feedback] failed-round archive replay is idempotent');
}

// ===========================================================================
// E. A rejected failed observation must not grow the real experience repository.
// ===========================================================================
{
  const scenario = await createScenario({ name: 'rejected-no-write' });
  const candidateId = 'candidate-rejected';
  const seed = seedRound({ scenario, candidateId, agentRunId: 'agent_rejected_round_1' });
  const error = typedError();
  const snapshot = buildFailedSnapshot({ scenario, seed, taskId: 'task_rejected_1', queueRunId: 'queue-rejected-1', candidateId, correctness: makeCorrectness({ error }), error, benchmark: [] });
  // The queue receipt disagrees with the projected observation: the verifier must fail closed.
  snapshot.result.experienceEvidence.candidateId = 'candidate-other';

  await projectSnapshot(scenario, snapshot);
  assert.equal(scenario.state.benchmark.status, 'failed', 'the failed terminal state still projects');
  assert.equal(scenario.state.iterationStats.experienceCollection.recorded, 0, 'a rejected failed observation is never recorded');
  assert.equal(scenario.state.iterationStats.experienceCollection.skipped, 1);
  assert.equal((await readStore(scenario)).length, 0, 'a rejected failed observation must not grow the repository');
  console.log('[failed-execution-feedback] a rejected failed observation does not grow the repository');
}

console.log(JSON.stringify({
  ok: true,
  cases: ['verifier-failed-matrix', 'failed-correctness-pipeline', 'stale-success-rows', 'not-run', 'archive-replay', 'rejected-no-write'],
}));

} finally {
  // Remove only this test's own isolated root, even when an assertion fails.
  await rm(tempRoot, { recursive: true, force: true });
}
