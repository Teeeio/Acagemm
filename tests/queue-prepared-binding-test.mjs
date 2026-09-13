// Independent hardware-free acceptance for the prepared-artifact identity that must
// travel from the production package preparer through the production Benchmark command
// into the real persisted operator-test queue and the unchanged strict failed-experience
// verifier. Frozen authority: docs/development/QUEUE_PREPARED_BINDING_ACCEPTANCE.md
// (sha256 60234ed781554fe6421bf9d527f8fce2482669628481f12a505ce86b5db58c26).
//
// What is REAL in this file:
//   - the exported production preparer factory createBenchmarkPackagePreparer, driven
//     through its frozen port signature ({request,mission,matrix,missionRunPy}) => request;
//   - the production createBenchmarkCommands 'start-benchmark' prepare/apply path;
//   - the real createOperatorTestQueue file-backed persistence (the final queue payload is
//     produced by preparer -> command -> queue.submit, never hand-authored);
//   - the unchanged strict createSharedGpuExperienceVerifier for the failed-candidate path.
// What is a declared PORT DOUBLE (hardware/GPU-free by construction):
//   - executionPackageStore.assemble/prepare/verifyAdmission (deterministic digests);
//   - the prepared-artifact adapter (reports the injected verdict only);
//   - the backend serviceClient of the queue (returns one deterministic terminal failed
//     snapshot so the real queue performs its real settle/terminal/release bookkeeping).
// No GPU, driver, torch/CUDA probe, model, provider, network call or Python runner is
// started. Projected environment fields are labelled as doubles so a green run is
// contract/integration evidence only and never a hardware sample or publishability claim.
// Every case runs; a red control positive marks the dependent negatives BLOCKED instead of
// green. Temporary files live under the OS temp root and are removed in finally.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// Explicit scratch isolation must happen before any production module is imported:
// operator-test-queue.mjs resolves its default paths at module scope.
const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'operator-queue-prepared-binding-'));
process.env.OPERATOR_RUNTIME_DIR = path.join(tempRoot, 'runtime');
process.env.OPERATOR_DATA_DIR = path.join(tempRoot, 'data');
process.env.OPERATOR_BRIDGE_DIR = path.join(tempRoot, 'bridge');
delete process.env.OPERATOR_RUNTIME_MODE;

const { createBenchmarkPackagePreparer } = await import('../client-runtime/application/benchmark-package-preparation-service.mjs');
const { createBenchmarkCommands } = await import('../client-runtime/application/benchmark-command.mjs');
const { createOperatorTestQueue } = await import('../client-runtime/operator-test-queue.mjs');
const { createSharedGpuExperienceVerifier } = await import('../client-runtime/application/shared-gpu-experience-verifier.mjs');
const { SHARED_GPU_PACKAGE_ADAPTER } = await import('../client-runtime/local-shared-gpu-package-adapter.mjs');

const queues = [];

// ---------------------------------------------------------------------------
// Per-case harness: a red case never aborts the matrix, and a negative whose
// control positive is red is reported blocked rather than green.
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

try {
// ---------------------------------------------------------------------------
// Deterministic identities. The trusted admission digest is deliberately distinct
// from every other identity so "appears identically" cannot be satisfied by
// recomputing it from the candidate/result/package content.
// ---------------------------------------------------------------------------
const sha256 = (label) => `sha256:${createHash('sha256').update(label, 'utf8').digest('hex')}`;
const PACKAGE_DIGEST = sha256('queue-prepared-binding-package');
const ENVIRONMENT_DIGEST = sha256('queue-prepared-binding-environment');
const ACCEPTANCE_DIGEST = sha256('queue-prepared-binding-acceptance');
const TRUSTED_PREPARED_ARTIFACT_DIGEST = sha256('queue-prepared-binding-prepared-artifact');
const CONFLICTING_CALLER_DIGEST = sha256('queue-prepared-binding-caller-conflict');
const REPLACEMENT_DIGEST = sha256('queue-prepared-binding-replacement');
const CANDIDATE_DIGEST = sha256('queue-prepared-binding-candidate');
const ADMISSION_ID = `admission-${sha256('queue-prepared-binding-admission').slice(7, 23)}`;
const TARGET = Object.freeze({ platform: 'nvidia-cuda', device: 'gpu', hardware: ['nvidia-gpu'], architecture: 'sm86' });
const BUILD = Object.freeze({ kind: 'prepared-artifact', format: 'source-tree' });
const CLOCK = Date.parse('2026-09-14T00:00:00.000Z');
const ISO = new Date(CLOCK).toISOString();
const RUN_ID = 'run_queue_prepared_binding';
const MISSION_ID = 'MIS_QUEUE_PREPARED_BINDING';
const CANDIDATE_ID = 'candidate-queue-prepared-binding';
const CANDIDATE_SOURCE = 'def run(case):\n    return "candidate source"\n';
const ORACLE_SOURCE = 'def run(case):\n    return "independent oracle"\n';
const IMPLEMENTATION_FILES = Object.freeze({ 'impl_a.py': 'A = 1\n', 'impl_b.py': 'B = 2\n' });
const TEST_SPEC = Object.freeze({ cases: Object.freeze(['minimal', 'representative', 'queue-binding']), correctness: Object.freeze({ requestedCases: 3, tolerance: 1e-5 }) });
const MATRIX = Object.freeze({
  environments: Object.freeze(['local-shared-gpu']),
  stages: Object.freeze(['Correctness', 'Full Benchmark']),
  warmup: 50, repeats: 200, correctnessCases: 3, testSpec: TEST_SPEC,
});

const createAdmission = () => ({
  format: 'operator-studio.execution-admission/v1', validatorVersion: 1, status: 'ready',
  // The trusted admission must carry its own non-empty identity: the store port's
  // prepare() result is the only source of admissionId, and a JSON-persisted queue
  // receipt silently drops an undefined field, which would break the identity chain
  // for a fixture reason rather than a product one.
  admissionId: ADMISSION_ID,
  packageDigest: PACKAGE_DIGEST, environmentDigest: ENVIRONMENT_DIGEST, acceptanceDigest: ACCEPTANCE_DIGEST,
  adapter: { ...SHARED_GPU_PACKAGE_ADAPTER }, target: structuredClone(TARGET), build: structuredClone(BUILD),
  preparationId: 'prepare_queue_prepared_binding',
  preparedArtifactDigest: TRUSTED_PREPARED_ARTIFACT_DIGEST,
  issuedAt: ISO, expiresAt: new Date(CLOCK + 3_600_000).toISOString(),
});

// ---------------------------------------------------------------------------
// Failed-candidate projection builders (same public DTO shape as the frozen
// failed-execution acceptance). The projection is derived from the payload the
// production command actually persisted; it is never hand-authored per case.
// ---------------------------------------------------------------------------
const MISMATCH_MESSAGE = 'maxDiff 3.2e-4 exceeds the frozen 1e-5 tolerance on case queue-binding (rmse 2.4e-4, cosDiff 0.9997)';
const typedError = () => ({
  code: 'OPERATOR_CORRECTNESS_MISMATCH', message: MISMATCH_MESSAGE, phase: 'correctness', role: 'candidate',
  retryable: false, details: { runStage: 'correctness' },
});
const passedCase = (name) => ({ case: name, dtype: 'float32', maxDiff: 1e-6, rmse: 1e-7, cosDiff: 1e-8, passed: true });
const failedCase = (name, error) => ({
  case: name, dtype: 'float32', maxDiff: 3.2e-4, rmse: 2.4e-4, cosDiff: 0.9997, passed: false,
  error: error.message, failure: structuredClone(error),
});
const makeCorrectness = (error) => ({
  status: 'failed', passed: false, total: 3, executedCases: 3, passedCases: 2,
  failedCase: 3, failedCaseName: 'queue-binding', failedCaseCategory: 'boundary',
  caseResults: [passedCase('minimal'), passedCase('representative'), failedCase('queue-binding', error)],
  failure: structuredClone(error), error: error.message,
});
// Hardware-free by construction: every GPU-looking field is an explicit port-double label,
// never a probed device. The strict verifier still requires the real shared-GPU identity.
const makeEnvironment = () => ({
  requested: ['local-shared-gpu'], runtime: 'local-shared-gpu-runner/v1', service: 'local-shared-gpu-adapter',
  source: 'local-shared-gpu', hardware: 'nvidia-gpu', executionMode: 'gpu', liveHardware: true, publishable: false,
  architecture: 'sm86', device: 'double:no-gpu-probed', driverVersion: '0.0.0-double',
  targetProbe: { deviceName: 'double:no-gpu-probed', driverVersion: '0.0.0-double', architecture: 'sm86' },
});
const bindingFromPayload = (payload) => ({
  packageDigest: payload.packageDigest, admissionId: payload.admissionId,
  preparedArtifactDigest: payload.preparedArtifactDigest,
  environmentDigest: payload.environmentDigest, acceptanceDigest: payload.acceptanceDigest,
  workspaceId: payload.workspaceId,
  target: structuredClone(payload.target), build: structuredClone(payload.build), adapter: structuredClone(payload.adapter),
});
const projectFailedCandidate = (payload) => {
  const binding = bindingFromPayload(payload);
  const error = typedError();
  const evidence = {
    missionId: payload.missionId, candidateId: payload.candidate.id, runId: payload.requestId,
    patchDigest: payload.candidate.digest,
    packageDigest: binding.packageDigest, environmentDigest: binding.environmentDigest, acceptanceDigest: binding.acceptanceDigest,
    hardware: 'nvidia-gpu', executionMode: 'gpu', outcome: 'failed', operation: 'test', liveHardware: true, architecture: 'sm86',
  };
  return {
    schemaVersion: 'operator-studio.shared-gpu-result/v1', status: 'failed', benchmark: [], publishable: false,
    correctness: makeCorrectness(error), error, environment: makeEnvironment(),
    executionPackage: binding, experienceEvidence: evidence,
  };
};

// ---------------------------------------------------------------------------
// Declared port doubles. The admission port validates the request the verifier
// assembled against the production payload instead of approving unconditionally.
// ---------------------------------------------------------------------------
const createStoreDouble = (admission) => {
  assert.equal(typeof admission.admissionId, 'string', 'the trusted admission fixture must carry a real admissionId');
  assert.ok(admission.admissionId.length > 0, 'the trusted admission fixture admissionId must be non-empty');
  const calls = { assemble: [], prepare: [], verifyAdmission: [] };
  return {
    calls,
    async assemble(input) {
      calls.assemble.push({
        language: input.language, environmentId: input.environmentId, adapter: input.adapter,
        binding: structuredClone(input.binding), candidateEntrypoint: input.candidateEntrypoint,
        candidateFiles: structuredClone(input.candidateFiles), dependencyFiles: structuredClone(input.dependencyFiles),
        acceptance: structuredClone(input.acceptance), build: structuredClone(input.build),
      });
      return { packageDigest: admission.packageDigest, manifest: { packageDigest: admission.packageDigest } };
    },
    async prepare(packageDigest) {
      calls.prepare.push(packageDigest);
      // The trusted admission identity wins over any fixture field that tries to
      // shadow it, mirroring the production store contract.
      return { ...structuredClone(admission), admissionId: admission.admissionId };
    },
    async verifyAdmission(request) {
      calls.verifyAdmission.push(structuredClone(request));
      const problems = [];
      if (request.admissionId !== admission.admissionId) problems.push('admissionId');
      if (request.packageDigest !== admission.packageDigest) problems.push('packageDigest');
      if (request.environmentDigest !== admission.environmentDigest) problems.push('environmentDigest');
      if (request.acceptanceDigest !== admission.acceptanceDigest) problems.push('acceptanceDigest');
      if (!request.candidate?.id || !request.candidate?.digest) problems.push('candidate');
      if (!request.target || !request.build || !request.adapter) problems.push('target/build/adapter');
      if (problems.length) throw new Error(`trusted admission port double rejected the assembled request: ${problems.join(', ')}`);
      return {
        manifest: { packageDigest: admission.packageDigest }, environment: { id: 'local-shared-gpu' },
        testSpec: structuredClone(TEST_SPEC), admission: structuredClone(admission),
      };
    },
  };
};
// Reports the injected verdict only, so an artifact verdict can never be confused
// with a binding-digest rejection.
const artifactAdapterDouble = (valid = true) => ({
  calls: [],
  async verifyPreparedArtifact(input) { this.calls.push(structuredClone({ preparedArtifactDigest: input.preparedArtifactDigest })); return { valid, preparedArtifactDigest: input.preparedArtifactDigest, root: path.join(tempRoot, 'artifact-double') }; },
});

// ---------------------------------------------------------------------------
// Production chain: real preparer port -> real Benchmark command -> real queue.
// ---------------------------------------------------------------------------
const readMissionRunPy = async () => ({ content: CANDIDATE_SOURCE, source: 'workspace', implementationFiles: structuredClone(IMPLEMENTATION_FILES) });

let chainSeq = 0;
const createChain = ({ name, admission = createAdmission(), withOracle = true, backendTaskId = 'backend-double-task' }) => {
  // Every chain owns a fresh isolated directory: a re-used queue file would resolve
  // the same requestId to the already terminal receipt instead of a new submission.
  const chainName = `${name}-${chainSeq += 1}`;
  const queuePath = path.join(tempRoot, chainName, 'operator-test-queue.jsonl');
  const store = createStoreDouble(admission);
  const artifactAdapter = artifactAdapterDouble(true);
  const preparer = createBenchmarkPackagePreparer({ executionPackageStore: store, packageAdapter: SHARED_GPU_PACKAGE_ADAPTER });
  const preparerInputs = [];
  // The command receives the exported production port; the wrapper only records the
  // exact input the composition would have passed, so case 2 can replay a real request.
  const prepareExecutionPackage = async (input) => { preparerInputs.push(structuredClone(input)); return preparer(input); };
  const backend = {
    calls: [],
    async submit(payload) {
      backend.calls.push(structuredClone(payload));
      return {
        taskId: backendTaskId, status: 'failed', startedAt: ISO, completedAt: ISO, durationMs: 1_234, progress: 100,
        resourceRelease: { confirmed: true, status: 'confirmed', reason: 'Backend port double released the simulation slot.' },
        result: projectFailedCandidate(payload),
      };
    },
  };
  const queue = createOperatorTestQueue({ filePath: queuePath, serviceClient: backend, taskTimeoutMs: 120_000 });
  queues.push(queue);
  const mission = {
    id: MISSION_ID, projectId: 'PROJ_QUEUE_PREPARED_BINDING', title: 'Queue prepared binding',
    goal: 'Prove the trusted prepared-artifact identity reaches the persisted queue request.',
    operator: 'generic_affine', hardware: ['local-shared-gpu'], metric: 'latency_p50',
    repository: 'repo-queue-prepared-binding', projectRoot: path.join(tempRoot, chainName, 'project'), implementation: {},
  };
  const state = {
    activeMissionId: MISSION_ID, appliedCandidateId: CANDIDATE_ID,
    candidateEvaluations: [{ id: CANDIDATE_ID, title: 'binding candidate', files: ['run.py'], patchDigest: CANDIDATE_DIGEST }],
    missions: [mission], testMatrix: structuredClone(MATRIX), agent: { messages: [] },
    ...(withOracle ? { baseline: { oracleRunPy: ORACLE_SOURCE, status: 'complete' } } : {}),
  };
  const intents = [];
  const commands = createBenchmarkCommands({
    addAuditEvent: () => {}, appendRuntimeEvent: () => {}, baselineMatchesMatrix: () => true,
    createSemanticTaskBinding: () => { throw new Error('a frozen semantic snapshot is not part of this matrix'); },
    hashKey: (value) => sha256(`hash:${value}`),
    isFixedOperatorMission: () => false,
    localC500Config: { enabled: true, kind: 'local-shared-gpu', mock: false, liveHardware: true, executionMode: 'gpu' },
    missionShapeKeyFor: () => 'shape', normalizeBaselineKind: (value) => value,
    operatorTestQueue: queue, prepareExecutionPackage, timeoutSeconds: 600,
    readMissionRunPy, resolveBaselineRunPlan: () => { throw new Error('candidate purpose never resolves a baseline plan'); },
  });
  const verifier = createSharedGpuExperienceVerifier({
    executionPackageStore: store, packageAdapter: artifactAdapter, readTask: (taskId) => queue.readTask(taskId), now: () => CLOCK,
  });
  const prepareCandidate = (body = {}) => commands['start-benchmark'].prepare({
    state, body: { matrix: structuredClone(MATRIX), purpose: 'candidate', ...body },
    intent: { runId: RUN_ID },
    recordIntent: async (intent) => { intents.push(structuredClone(intent)); },
    runEffect: (effect) => effect(),
  });
  return {
    name, queue, queuePath, store, artifactAdapter, preparer, prepareExecutionPackage, preparerInputs,
    backend, mission, state, intents, commands, verifier, prepareCandidate,
  };
};

const readQueueFile = (queuePath) => readFile(queuePath, 'utf8');
const parseQueueFile = (text) => text.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
// Mutates the PERSISTED request only; the queue file is rewritten on disk so the real
// readTask observes the damaged receipt rather than an in-memory copy.
const mutatePersistedPayload = async (queuePath, mutate) => {
  const tasks = parseQueueFile(await readQueueFile(queuePath));
  assert.equal(tasks.length, 1, 'exactly one persisted task is expected before mutating the request');
  for (const task of tasks) mutate(task.payload);
  await writeFile(queuePath, tasks.map((task) => JSON.stringify(task)).join('\n') + '\n', 'utf8');
};

const control = { verified: false, code: 'not-run' };

// Comments are removed before the wiring assertions so a commented-out call or a
// documentation line can neither satisfy nor break them. String literals survive.
const stripComments = (source) => {
  let output = '';
  let quote = null;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (quote) {
      output += char;
      if (char === '\\') { output += source[index + 1] ?? ''; index += 1; continue; }
      if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'" || char === '`') { quote = char; output += char; continue; }
    if (char === '/' && source[index + 1] === '/') { const end = source.indexOf('\n', index); index = (end < 0 ? source.length : end) - 1; output += ' '; continue; }
    if (char === '/' && source[index + 1] === '*') { const end = source.indexOf('*/', index + 2); index = end < 0 ? source.length : end + 1; output += ' '; continue; }
    output += char;
  }
  return output;
};

// Extracts the literal argument text of the first `callee(` call, balancing
// brackets while ignoring string literals and comments. The wiring assertion must
// read the call's ACTUAL arguments, not merely find the property word somewhere in
// the file: a wrongly supplied adapter instance still contains "packageAdapter".
const balancedCallArguments = (source, callee) => {
  const callAt = source.indexOf(`${callee}(`);
  assert.ok(callAt >= 0, `the composition root must call ${callee}`);
  const start = source.indexOf('(', callAt);
  let depth = 0;
  let quote = null;
  for (let index = start; index < source.length; index += 1) {
    const char = source[index];
    if (quote) {
      if (char === '\\') index += 1;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'" || char === '`') { quote = char; continue; }
    if (char === '/' && source[index + 1] === '/') { const end = source.indexOf('\n', index); index = end < 0 ? source.length : end; continue; }
    if (char === '/' && source[index + 1] === '*') { const end = source.indexOf('*/', index + 2); index = end < 0 ? source.length : end + 1; continue; }
    if (char === '(') depth += 1;
    else if (char === ')') { depth -= 1; if (depth === 0) return source.slice(start + 1, index); }
  }
  throw new Error(`unbalanced call arguments for ${callee}`);
};

// ---------------------------------------------------------------------------
// 1. Trusted admission digest propagation: returned request, recorded command
// intent, persisted queue payload and benchmark execution-package binding.
// ---------------------------------------------------------------------------
await runCase('trusted-admission-digest-propagation', async () => {
  const chain = createChain({ name: 'propagation' });
  const prepared = await chain.prepareCandidate();

  // The production command called the exported port with the frozen input shape.
  assert.equal(chain.preparerInputs.length, 1, 'the production command must call the injected preparer exactly once');
  const portInput = chain.preparerInputs[0];
  for (const key of ['request', 'mission', 'matrix', 'missionRunPy']) assert.ok(Object.hasOwn(portInput, key), `the preparer port input must carry ${key}`);
  assert.equal(portInput.mission.id, MISSION_ID);
  assert.equal(portInput.missionRunPy.content, CANDIDATE_SOURCE);

  // The store double observed the real package assembly followed by prepare(packageDigest).
  assert.equal(chain.store.calls.assemble.length, 1, 'the preparer must assemble exactly one package');
  const assemble = chain.store.calls.assemble[0];
  assert.equal(assemble.language, 'python');
  assert.equal(assemble.environmentId, 'local-shared-gpu');
  assert.equal(assemble.candidateEntrypoint, 'run.py');
  assert.equal(assemble.acceptance.entrypoint, 'oracle.py');
  assert.equal(assemble.acceptance.files['oracle.py'], ORACLE_SOURCE, 'the request oracle must remain the acceptance file');
  assert.equal(assemble.candidateFiles['run.py'], CANDIDATE_SOURCE, 'the request candidate must remain the candidate entrypoint');
  assert.deepEqual(assemble.dependencyFiles, IMPLEMENTATION_FILES, 'dependent implementation files must reach the package unchanged');
  assert.equal(assemble.adapter, SHARED_GPU_PACKAGE_ADAPTER, 'the frozen shared-GPU adapter identity must be the assemble adapter');
  assert.deepEqual(assemble.acceptance.testSpec, TEST_SPEC, 'the frozen testSpec must reach the acceptance layer unchanged');
  assert.deepEqual(chain.store.calls.prepare, [PACKAGE_DIGEST], 'prepare must be called with the assembled package digest');

  // (a) recorded command intent.
  assert.equal(chain.intents.length, 1, 'the command must record exactly one submission intent');
  const intent = chain.intents[0];
  assert.equal(intent.request.preparedArtifactDigest, TRUSTED_PREPARED_ARTIFACT_DIGEST);
  assert.equal(intent.payload.executionPackage.preparedArtifactDigest, TRUSTED_PREPARED_ARTIFACT_DIGEST);
  assert.equal(intent.request.requestId, RUN_ID);

  // (b) persisted queue payload, read back from the real file-backed queue.
  const persisted = await chain.queue.findByRequestId(RUN_ID, MISSION_ID, intent.request);
  assert.ok(persisted, 'the real queue must persist the production request');
  assert.equal(persisted.payload.preparedArtifactDigest, TRUSTED_PREPARED_ARTIFACT_DIGEST);
  assert.deepEqual(persisted.payload, intent.request, 'the persisted payload must be the recorded command request, not a hand-authored object');
  assert.equal(persisted.status, 'waiting', 'the queue must not have been dispatched by preparation itself');
  const onDisk = parseQueueFile(await readQueueFile(chain.queuePath));
  assert.equal(onDisk.length, 1);
  assert.equal(onDisk[0].payload.preparedArtifactDigest, TRUSTED_PREPARED_ARTIFACT_DIGEST, 'the identity must survive the durable JSONL write');

  // (c) benchmark execution-package binding after the production apply.
  chain.commands['start-benchmark'].apply(chain.state, prepared.payload);
  assert.equal(chain.state.benchmark.executionPackage.preparedArtifactDigest, TRUSTED_PREPARED_ARTIFACT_DIGEST);
  assert.equal(chain.state.benchmark.executionPackage.admissionId, ADMISSION_ID);

  // The trusted identity is the admission's, not a recomputation of any other identity.
  for (const [label, value] of [['package', PACKAGE_DIGEST], ['environment', ENVIRONMENT_DIGEST], ['acceptance', ACCEPTANCE_DIGEST], ['candidate', CANDIDATE_DIGEST]]) {
    assert.notEqual(TRUSTED_PREPARED_ARTIFACT_DIGEST, value, `the trusted prepared-artifact digest must be distinct from the ${label} identity`);
  }
  return `identical trusted digest in port request, recorded intent, persisted payload and applied binding`;
});

// ---------------------------------------------------------------------------
// 2. A conflicting caller digest is overwritten by the trusted admission digest;
// unrelated fields and dependent implementation files survive unchanged.
// ---------------------------------------------------------------------------
await runCase('caller-digest-conflict-overwritten', async () => {
  const chain = createChain({ name: 'caller-conflict' });
  await chain.prepareCandidate();
  const productionRequest = structuredClone(chain.preparerInputs[0].request);
  assert.equal(productionRequest.preparedArtifactDigest, undefined, 'the command-side request must not carry a digest before preparation');
  const callerRequest = {
    ...productionRequest,
    preparedArtifactDigest: CONFLICTING_CALLER_DIGEST,
    callerNote: 'unrelated caller field that must survive',
  };
  const returned = await chain.preparer({ request: callerRequest, mission: chain.mission, matrix: structuredClone(MATRIX), missionRunPy: await readMissionRunPy() });
  assert.equal(returned.preparedArtifactDigest, TRUSTED_PREPARED_ARTIFACT_DIGEST, 'a caller-supplied digest must never win over the trusted admission');
  assert.notEqual(returned.preparedArtifactDigest, CONFLICTING_CALLER_DIGEST);
  assert.equal(returned.callerNote, callerRequest.callerNote, 'an unrelated caller field must survive preparation');
  assert.deepEqual(returned.candidate, callerRequest.candidate, 'the caller candidate binding must survive preparation');
  assert.deepEqual(returned.implementationFiles, IMPLEMENTATION_FILES, 'dependent implementation files must survive unchanged');
  assert.equal(returned.runPy, productionRequest.runPy, 'the candidate entrypoint content must survive unchanged');
  assert.equal(returned.oracleRunPy, ORACLE_SOURCE, 'the acceptance entrypoint must survive unchanged');
  assert.equal(returned.missionId, MISSION_ID);
  assert.deepEqual(returned.limits, { timeoutSeconds: 600 }, 'the caller deadline limits must survive unchanged');
  assert.deepEqual(returned.matrix, callerRequest.matrix, 'the requested matrix must survive preparation');
  return 'caller conflict overwritten by the admission digest; unrelated fields preserved';
});

// ---------------------------------------------------------------------------
// 3. The frozen preparation errors survive and no submission happens on them.
// ---------------------------------------------------------------------------
await runCase('preparation-failure-no-submission', async () => {
  const missingSpec = createChain({ name: 'missing-test-spec' });
  await assert.rejects(
    () => missingSpec.prepareCandidate({ matrix: { ...structuredClone(MATRIX), testSpec: undefined } }),
    (error) => error?.code === 'PACKAGE_TEST_SPEC_REQUIRED',
    'a matrix without a frozen testSpec must keep PACKAGE_TEST_SPEC_REQUIRED',
  );
  assert.equal(missingSpec.intents.length, 0, 'a rejected preparation must not record a submission intent');
  assert.deepEqual(await missingSpec.queue.readTasks(), [], 'a rejected preparation must not submit to the queue');

  const missingOracle = createChain({ name: 'missing-oracle', withOracle: false });
  await assert.rejects(
    () => missingOracle.prepareCandidate(),
    (error) => error?.code === 'PACKAGE_ORACLE_INVALID',
    'a request without an independent acceptance entrypoint must keep PACKAGE_ORACLE_INVALID',
  );
  assert.equal(missingOracle.intents.length, 0, 'a rejected preparation must not record a submission intent');
  assert.deepEqual(await missingOracle.queue.readTasks(), [], 'a rejected preparation must not submit to the queue');
  return 'PACKAGE_TEST_SPEC_REQUIRED and PACKAGE_ORACLE_INVALID preserved with zero queue submissions';
});

// ---------------------------------------------------------------------------
// 4/5. Positive strict failed-candidate acceptance on the production-created queue
// request, then the persisted-digest negatives on the same real receipt.
// ---------------------------------------------------------------------------
const buildAcceptedChain = async () => {
  const chain = createChain({ name: 'strict-failed-verifier' });
  const prepared = await chain.prepareCandidate();
  chain.commands['start-benchmark'].apply(chain.state, prepared.payload);
  // The real queue performs its real submit/settle/release bookkeeping; only the
  // backend serviceClient is a double.
  const processed = await chain.queue.process();
  assert.equal(processed.taskId, prepared.result.taskId);
  assert.equal(processed.status, 'failed', 'the queue double must settle the task as a released failure');
  assert.equal(processed.resourceRelease.confirmed, true);
  const task = await chain.queue.readTask(prepared.result.taskId);
  assert.equal(chain.backend.calls.length, 1, 'the queue must submit the production request exactly once');
  assert.equal(chain.backend.calls[0].preparedArtifactDigest, TRUSTED_PREPARED_ARTIFACT_DIGEST, 'the backend must receive the production request with the trusted digest');
  assert.deepEqual(chain.backend.calls[0], task.payload, 'the backend payload must be the persisted production request');
  chain.state.benchmark.status = 'failed';
  chain.state.benchmark.result = structuredClone(task.result);
  chain.state.benchmark.resourceRelease = { confirmed: true, status: 'confirmed' };
  chain.observation = { evidence: structuredClone(task.result.experienceEvidence), evidenceRefs: ['result.json'] };
  chain.task = task;
  return chain;
};

// Re-verification helper shared by the positive and the negatives. It never
// rewrites the request or the result, which the caller asserts separately.
const verifyFailed = (chain) => chain.verifier({ state: chain.state, mission: chain.mission, observation: chain.observation });

await runCase('strict-failed-verifier-positive', async () => {
  const chain = await buildAcceptedChain();
  const proof = await verifyFailed(chain);
  control.verified = proof.verified === true;
  control.code = proof.code ?? 'verified';
  assert.equal(proof.verified, true, 'a completely bound failed observation on the production queue request must verify');
  assert.equal(proof.evidence.outcome, 'failed');
  assert.equal(proof.evidence.runId, RUN_ID);
  assert.equal(proof.evidence.packageDigest, PACKAGE_DIGEST);
  assert.equal(chain.store.calls.verifyAdmission.length, 1, 'the strict verifier must revalidate the assembled request against the trusted admission');
  assert.equal(chain.artifactAdapter.calls.length, 1, 'the strict verifier must revalidate the prepared artifact');
  assert.equal(chain.artifactAdapter.calls[0].preparedArtifactDigest, TRUSTED_PREPARED_ARTIFACT_DIGEST);
  assert.equal(chain.queue.path, chain.queuePath);
  return 'strict failed-candidate verifier accepted the production-created queue request';
});

// The negative is only attributable to the mutation when the control positive is green.
const checkPersistedDigestNegative = async (name, mutate) => {
  if (!control.verified) blocked(`control failed-candidate positive did not verify (${control.code}); the persisted-digest rejection is not attributable to the mutation`);
  const chain = await buildAcceptedChain();
  const resultBefore = JSON.stringify(chain.state.benchmark.result);
  const evidenceBefore = JSON.stringify(chain.observation.evidence);
  await mutatePersistedPayload(chain.queuePath, mutate);
  const damagedBytes = await readQueueFile(chain.queuePath);
  const damagedPayload = parseQueueFile(damagedBytes)[0].payload;
  assert.equal(damagedPayload.missionId, MISSION_ID, 'the mutation must target the production-created persisted request');
  const proof = await verifyFailed(chain);
  if (proof.verified === true) throw new Error(`${name}: the damaged persisted request was still accepted`);
  assert.equal(proof.code, 'EXECUTION_PACKAGE_QUEUE_RESULT_MISMATCH', `${name}: the rejection must be attributable to the queue/result identity, got ${proof.code}`);
  assert.equal(await readQueueFile(chain.queuePath), damagedBytes, `${name}: the strict verifier must not rewrite the persisted request`);
  assert.equal(JSON.stringify(chain.state.benchmark.result), resultBefore, `${name}: the strict verifier must not rewrite the projected result`);
  assert.equal(JSON.stringify(chain.observation.evidence), evidenceBefore, `${name}: the strict verifier must not rewrite the observation evidence`);
  return `rejected with ${proof.code}; request/result/evidence unchanged`;
};

await runCase('persisted-digest-deleted-rejected', () => checkPersistedDigestNegative('persisted-digest-deleted-rejected', (payload) => {
  delete payload.preparedArtifactDigest;
  assert.equal(Object.hasOwn(payload, 'preparedArtifactDigest'), false);
}));

await runCase('persisted-digest-changed-rejected', () => checkPersistedDigestNegative('persisted-digest-changed-rejected', (payload) => {
  payload.preparedArtifactDigest = REPLACEMENT_DIGEST;
}));

// ---------------------------------------------------------------------------
// Composition-root wiring: the production server must consume the exported
// service through the existing documented command injection. This is a
// supplementary read-only assertion, not a substitute for the behavior above.
// ---------------------------------------------------------------------------
await runCase('composition-root-wiring', async () => {
  const source = stripComments(await readFile(path.join(rootDir, 'client-runtime', 'local-server.mjs'), 'utf8'));
  assert.match(source, /import\s*\{[^}]*\bcreateBenchmarkPackagePreparer\b[^}]*\}\s*from\s*'\.\/application\/benchmark-package-preparation-service\.mjs'/u,
    'the composition root must import the exported preparer factory from the documented application service');
  assert.match(source, /import\s*\{[^}]*\bSHARED_GPU_PACKAGE_ADAPTER\b[^}]*\}\s*from\s*'\.\/local-shared-gpu-package-adapter\.mjs'/u,
    'the composition root must import the frozen shared-GPU adapter identity constant');

  // Read the real construction arguments. The frozen interface binds the identity
  // CONSTANT (id/version/languages); the adapter implementation instance spreads the
  // same keys and must never be substituted for it.
  const preparerArgs = balancedCallArguments(source, 'createBenchmarkPackagePreparer');
  assert.match(preparerArgs, /(?:^|[,{\s])executionPackageStore\s*(?=[,}]|$)|executionPackageStore\s*:\s*executionPackageStore\b/u,
    'the port must receive the composition-root execution package store');
  assert.match(preparerArgs, /(?:^|[,{\s])packageAdapter\s*:\s*SHARED_GPU_PACKAGE_ADAPTER\s*(?=[,}]|$)/u,
    'the port must receive the frozen SHARED_GPU_PACKAGE_ADAPTER identity constant as packageAdapter');
  assert.doesNotMatch(preparerArgs, /(?:^|[,{\s])packageAdapter\s*:\s*(?:sharedGpuPackageAdapter|executionPackageStore|localBackend|operatorTestQueue)\b/u,
    'the port must not receive an adapter instance or another composition-root object in place of the identity constant');

  const commandArgs = balancedCallArguments(source, 'createBenchmarkCommands');
  assert.match(commandArgs, /(?:^|[,{\s])prepareExecutionPackage\b/u, 'the constructed port must be injected into the Benchmark command');
  assert.equal(source.includes('executionPackageStore.assemble'), false, 'the package assembly callback must live in the application service, not inline in the composition root');
  return 'composition root constructs the exported preparer with the frozen identity constant and injects it into the Benchmark command';
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
  note: 'Hardware-free contract/integration evidence only: package storage/admission/artifact and the queue backend are declared port doubles; no GPU, driver, model, provider, network call or Python runner is started. blocked means the control failed-candidate positive did not verify, so a persisted-digest rejection is not attributable to the mutation and is never reported green. A red case is always reported as failed.',
}, null, 2));
process.exitCode = ok ? 0 : 1;
} finally {
  // Stop process-local scheduling first, then remove only this test's own isolated root.
  await Promise.allSettled(queues.map((queue) => queue.dispose()));
  await rm(tempRoot, { recursive: true, force: true });
}
