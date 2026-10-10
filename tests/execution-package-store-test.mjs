import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile, mkdir, symlink, unlink, readdir } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createExecutionPackageStore, contentDigest } from '../client-runtime/execution-package-store.mjs';
import { createOperatorTestTool } from '../client-runtime/operator-test-tool.mjs';
import { createOperatorTestQueue } from '../client-runtime/operator-test-queue.mjs';
const root = await mkdtemp(path.join(os.tmpdir(), 'execution-package-'));
const h = contentDigest('test');
const target = { platform: 'test-x64', device: 'cpu' };
const adapterDescriptor = { id: 'test-language-cpu', version: '1' };
let environment = { digest: h, target, isolation: { kind: 'container', enforced: true } };
let prepareCount = 0;
let pendingRelease;
const adapter = {
  version: '1', languages: ['test-language'], verifyPreparedArtifact: async () => ({ valid: true }),
  prepare: async ({ packageDigest, environment: actual }) => { prepareCount += 1; return { status: 'ready', packageDigest, environmentDigest: actual.digest, preparedArtifactDigest: h, resourceRelease: { confirmed: true } }; },
};
const environmentPort = { resolve: async () => environment };
const makeStore = (dir = root, selected = adapter, options = {}) => createExecutionPackageStore({ rootDir: dir, environments: environmentPort, adapters: { [adapterDescriptor.id]: selected }, ...options });
const input = {
  language: 'test-language', adapter: adapterDescriptor,
  binding: { missionId: 'm1', workspaceId: 'w1', candidateId: 'c1', candidateDigest: h },
  environmentId: 'locked-test-runtime', candidateEntrypoint: 'src/operator.code',
  candidateFiles: { 'src/operator.code': 'candidate', 'src/data.bin': { encoding: 'base64', content: 'AAEC' } },
  dependencyFiles: { 'deps/library.code': 'offline-dependency' },
  acceptance: { entrypoint: 'suite/oracle.code', files: { 'suite/oracle.code': 'independent-oracle' }, testSpec: { cases: ['minimal', 'boundary'] }, semanticDigest: h },
};
let checks = 0;
const rejects = async (operation, code) => { await assert.rejects(operation, (error) => error.code === code); checks += 1; };
try {
  for (const admissionTtlMs of [0, -1, Infinity, NaN, 1.5, 86400001]) {
    assert.throws(() => createExecutionPackageStore({ rootDir: root, environments: environmentPort, adapters: {}, admissionTtlMs }), TypeError); checks += 1;
  }
  const store = makeStore();
  const pkg = await store.assemble(input);
  const repeated = await store.assemble({ ...input, candidateFiles: { 'src/data.bin': input.candidateFiles['src/data.bin'], 'src/operator.code': 'candidate' } });
  assert.equal(pkg.packageDigest, repeated.packageDigest); checks += 1;
  const admitted = await store.prepare(pkg.packageDigest);
  const request = {
    requestId: 'r1', purpose: 'candidate', missionId: 'm1', workspaceId: 'w1', candidate: { id: 'c1', digest: h },
    packageDigest: pkg.packageDigest, admissionId: admitted.admissionId,
    environmentDigest: h, acceptanceDigest: pkg.manifest.acceptance.digest, target,
    deadline: new Date(Date.now() + 60000).toISOString(), checks: ['correctness', 'benchmark'], limits: { timeoutSeconds: 10 },
  };
  assert.equal((await store.verifyAdmission(request)).manifest.language, 'test-language'); checks += 1;
  await rejects(() => store.verifyAdmission({ ...request, admissionId: contentDigest('forged') }), 'PACKAGE_NOT_ADMITTED');
  environment = { ...environment, digest: contentDigest('environment changed') };
  await rejects(() => store.verifyAdmission(request), 'PACKAGE_ENVIRONMENT_CHANGED');
  environment = { ...environment, digest: h, isolation: { kind: 'plain-python', enforced: false } };
  await rejects(() => store.prepare(pkg.packageDigest), 'EXECUTION_ISOLATION_UNAVAILABLE');
  environment = { ...environment, isolation: { kind: 'plain-python', enforced: true } };
  await rejects(() => store.verifyAdmission(request), 'EXECUTION_ISOLATION_UNAVAILABLE');
  environment = { ...environment, isolation: { kind: 'container', enforced: true } };
  const different = await store.assemble({ ...input, candidateFiles: { ...input.candidateFiles, 'src/operator.code': 'modified' } });
  await rejects(() => store.verifyAdmission({ ...request, packageDigest: different.packageDigest }), 'PACKAGE_ADMISSION_CONFLICT');

  // The MVP shared-GPU policy is a separate, explicit trusted environment. It
  // does not make the ordinary host-Python or CPU path admissible.
  const gpuTarget = { platform: 'test-x64', device: 'gpu' };
  const gpuEnvironment = {
    digest: contentDigest('shared gpu environment'), target: gpuTarget,
    isolation: { kind: 'shared-host-gpu', enforced: false },
    policy: { allowSharedHostGpu: true, packageBoundary: 'adapter-enforced' },
  };
  const gpuStore = createExecutionPackageStore({
    rootDir: path.join(root, 'shared-gpu'),
    environments: { resolve: async () => gpuEnvironment },
    adapters: { [adapterDescriptor.id]: adapter },
  });
  const gpuPackage = await gpuStore.assemble({ ...input, environmentId: 'shared-gpu', target: gpuTarget });
  const gpuAdmission = await gpuStore.prepare(gpuPackage.packageDigest);
  const gpuRequest = {
    ...request, requestId: 'gpu-r1', packageDigest: gpuPackage.packageDigest,
    admissionId: gpuAdmission.admissionId, environmentDigest: gpuEnvironment.digest,
    target: gpuTarget, deadline: new Date(Date.now() + 60000).toISOString(),
  };
  assert.equal((await gpuStore.verifyAdmission(gpuRequest)).environment.policy.allowSharedHostGpu, true); checks += 1;
  const gpuRejected = { ...gpuEnvironment, policy: { allowSharedHostGpu: false, packageBoundary: 'adapter-enforced' } };
  const rejectedGpuStore = createExecutionPackageStore({
    rootDir: path.join(root, 'shared-gpu-rejected'),
    environments: { resolve: async () => gpuRejected },
    adapters: { [adapterDescriptor.id]: adapter },
  });
  const rejectedGpuPackage = await rejectedGpuStore.assemble({ ...input, environmentId: 'shared-gpu-rejected', target: gpuTarget });
  await rejects(() => rejectedGpuStore.prepare(rejectedGpuPackage.packageDigest), 'EXECUTION_ISOLATION_UNAVAILABLE');
  const dep = pkg.manifest.layers.find((layer) => layer.role === 'dependency').files[0];
  const depPath = path.join(root, 'blobs', dep.digest.slice(7));
  const original = await readFile(depPath);
  await writeFile(depPath, 'corrupt');
  await rejects(() => store.verifyAdmission(request), 'PACKAGE_CONTENT_CHANGED');
  await writeFile(depPath, original);
  for (const backendId of ['local-test-queue', 'alternate-cloud-contract']) {
    const tasks = new Map(); let executions = 0;
    const backend = {
      capabilities: async () => ({ backendId, queryIsReadOnly: true, idempotentSubmission: true, targets: [target], adapters: [adapterDescriptor] }),
      submit: async (value) => { if (!tasks.has(value.requestId)) { executions += 1; tasks.set(value.requestId, { taskId: 't1', status: 'queued' }); } return tasks.get(value.requestId); },
      get: async () => ({ taskId: 't1', status: 'running' }),
      cancel: async () => ({ taskId: 't1', status: 'cancel_requested' }),
      findByRequestId: async (id) => tasks.get(id) || null,
    };
    const tool = createOperatorTestTool({ backend, packages: store });
    await tool.submit(request); await tool.submit(request);
    await tool.get('t1'); await tool.findByRequestId('r1', 'm1');
    assert.equal(executions, 1); checks += 1;
    assert.equal((await tool.cancel('t1')).status, 'cancel_requested'); checks += 1;
    await rejects(() => tool.submit({ ...request, validated: true, admissionId: contentDigest('untrusted') }), 'PACKAGE_NOT_ADMITTED');
  }
  // Compose the production queue and package port: a queue-only backend fixture
  // missed that the intermediate tool discarded the real timeout reason.
  for (const mode of ['user', 'deadline']) {
    let cancellation;
    const remoteId = 'cancel-' + mode;
    const backend = {
      capabilities: async () => ({ backendId: 'cancel-context', queryIsReadOnly: true, idempotentSubmission: true, targets: [target], adapters: [adapterDescriptor] }),
      submit: async () => ({ taskId: remoteId, status: 'queued' }),
      get: async () => ({ taskId: remoteId, status: 'running' }),
      cancel: async (taskId, options) => {
        cancellation = { taskId, ...options };
        return { taskId, status: 'cancelled', completedAt: new Date().toISOString(), resourceRelease: { confirmed: true } };
      },
      findByRequestId: async () => ({ taskId: remoteId, status: 'running' }),
    };
    const queue = createOperatorTestQueue({ filePath: path.join(root, 'cancel-' + mode + '.jsonl'), serviceClient: createOperatorTestTool({ backend, packages: store }) });
    try {
      const task = await queue.submit({ ...request, operator: 'cancel-context', matrix: { environments: ['test-cpu'] }, requestId: remoteId, limits: { timeoutSeconds: mode === 'deadline' ? 1 : 60 } });
      await queue.process();
      assert.equal((await queue.readTask(task.taskId)).remoteTaskId, remoteId);
      if (mode === 'user') await queue.cancel(task.taskId);
      const until = Date.now() + 5000;
      let result;
      do {
        result = await queue.readTask(task.taskId);
        if (['failed', 'cancelled'].includes(result.status)) break;
        await new Promise(resolve => setTimeout(resolve, 20));
      } while (Date.now() < until);
      assert.equal(result.status, mode === 'deadline' ? 'failed' : 'cancelled');
      assert.equal(cancellation.taskId, remoteId);
      assert.equal(cancellation.reason, result.cancelReason, 'backend receipt must retain the cancellation reason produced by the queue');
      assert.ok(Number.isFinite(Date.parse(cancellation.deadline)), 'the bounded cancel request deadline reaches the backend');
      assert.ok(cancellation.signal instanceof AbortSignal);
      assert.deepEqual(result.payload, task.payload);
      assert.equal(result.deadlineAt, task.deadlineAt);
      assert.equal(result.resourceRelease.confirmed, true);
      if (mode === 'deadline') assert.equal(result.error.category, 'timeout');
      const repeated = await queue.cancel(task.taskId);
      assert.equal(repeated.completedAt, result.completedAt);
      assert.equal(repeated.cancelReason, result.cancelReason);
      checks += 1;
    } finally { await queue.dispose(); }
  }
  // Freeze the injected store clock so validation I/O cannot consume this tiny
  // fixture budget before the hung adapter enters. The real timer must still
  // honor the original absolute deadline, rather than the 30-second default.
  const stalledClock = Date.now();
  const stalledDeadline = new Date(stalledClock + 15).toISOString();
  let observedStalledDeadline;
  let adapterStartedAt;
  let adapterAbortedAfter;
  const stalled = makeStore(path.join(root, 'stalled'), {
    version: '1', languages: ['test-language'], verifyPreparedArtifact: async () => ({ valid: true }),
    prepare: async ({ signal, deadline }) => {
      prepareCount += 1;
      observedStalledDeadline = deadline;
      adapterStartedAt = Date.now();
      return new Promise((resolve) => {
        pendingRelease = () => resolve({ resourceRelease: { confirmed: true } });
        signal.addEventListener('abort', () => { adapterAbortedAfter = Date.now() - adapterStartedAt; /* release remains uncertain */ });
      });
    },
  }, { now: () => new Date(stalledClock) });
  const stalledPackage = await stalled.assemble(input);
  await rejects(() => stalled.prepare(stalledPackage.packageDigest, { deadline: stalledDeadline }), 'PACKAGE_PREPARE_TIMEOUT');
  assert.equal(observedStalledDeadline, stalledDeadline);
  assert.ok(adapterAbortedAfter < 1000, 'the adapter aborts on the original 15ms deadline, not a renewed 30-second budget'); checks += 1;
  const atTimeout = prepareCount;
  await rejects(() => stalled.prepare(stalledPackage.packageDigest), 'PACKAGE_PREPARATION_UNCONFIRMED');
  await rejects(() => makeStore(path.join(root, 'stalled')).prepare(stalledPackage.packageDigest), 'PACKAGE_PREPARATION_UNCONFIRMED');
  assert.equal(prepareCount, atTimeout); checks += 1;
  pendingRelease();
  const releaseUntil = Date.now() + 5000;
  let releasedRecord;
  do {
    releasedRecord = JSON.parse(await readFile(path.join(root, 'stalled', 'preparations', stalledPackage.packageDigest.slice(7) + '.json'), 'utf8'));
    if (releasedRecord.resourceRelease?.confirmed === true) break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  } while (Date.now() < releaseUntil);
  assert.equal(releasedRecord.resourceRelease?.confirmed, true);
  const recovered = await makeStore(path.join(root, 'stalled')).prepare(stalledPackage.packageDigest);
  assert.equal(recovered.status, 'ready'); checks += 1;
  let aborted = false;
  const hung = createOperatorTestTool({ packages: store, requestTimeoutMs: 10, backend: {
    capabilities: async () => ({}), submit: async () => {}, cancel: async () => {}, findByRequestId: async () => null,
    get: async (_id, { signal }) => { signal.addEventListener('abort', () => { aborted = true; }); return new Promise(() => {}); },
  } });
  await rejects(() => hung.get('hung'), 'TEST_TOOL_REQUEST_TIMEOUT');
  assert.equal(aborted, true); checks += 1;

  const oldVerifier = adapter.verifyPreparedArtifact;
  adapter.verifyPreparedArtifact = async () => ({ valid: false });
  await rejects(() => store.verifyAdmission(request), 'PACKAGE_PREPARED_ARTIFACT_CHANGED');
  adapter.verifyPreparedArtifact = oldVerifier;
  adapter.version = '2';
  await rejects(() => store.verifyAdmission(request), 'PACKAGE_ADAPTER_UNSUPPORTED');
  adapter.version = '1';
  const wrongLanguage = await store.assemble({ ...input, language: 'rust' });
  await rejects(() => store.prepare(wrongLanguage.packageDigest), 'PACKAGE_ADAPTER_UNSUPPORTED');

  const preparationFile = path.join(root, 'preparations', pkg.packageDigest.slice(7) + '.json');
  const savedPreparation = await readFile(preparationFile);
  for (const corrupt of [{}, { packageDigest: pkg.packageDigest, preparationId: 'p', status: 'rejected', resourceRelease: { confirmed: false } }]) {
    await writeFile(preparationFile, JSON.stringify(corrupt));
    await rejects(() => store.prepare(pkg.packageDigest), 'PACKAGE_PREPARATION_UNCONFIRMED');
  }
  await writeFile(preparationFile, savedPreparation);
  for (const directory of ['blobs', 'manifests', 'admissions', 'preparations']) {
    const junctionRoot = path.join(root, 'junction-' + directory);
    const outside = path.join(root, 'outside-' + directory);
    await mkdir(junctionRoot); await mkdir(outside);
    const junctionStore = makeStore(junctionRoot);
    let junctionPackage;
    if (['admissions', 'preparations'].includes(directory)) junctionPackage = await junctionStore.assemble(input);
    const junction = path.join(junctionRoot, directory);
    await symlink(outside, junction, process.platform === 'win32' ? 'junction' : 'dir');
    try {
      await rejects(() => junctionPackage ? junctionStore.prepare(junctionPackage.packageDigest) : junctionStore.assemble(input), 'PACKAGE_STORAGE_UNSAFE');
      assert.deepEqual(await readdir(outside), []); checks += 1;
    } finally { await unlink(junction); }
  }
  let lookups = 0;
  let validationClock = Date.now();
  const slowRoot = path.join(root, 'late-validation');
  const slowStore = createExecutionPackageStore({
    rootDir: slowRoot, adapters: { [adapterDescriptor.id]: adapter },
    now: () => new Date(validationClock),
    environments: { resolve: async () => { lookups += 1; if (lookups >= 3) validationClock += 40; return environment; } },
  });
  const latePackage = await slowStore.assemble(input);
  await rejects(() => slowStore.prepare(latePackage.packageDigest, { timeoutMs: 25 }), 'PACKAGE_PREPARE_TIMEOUT');
  const lateRecord = JSON.parse(await readFile(path.join(slowRoot, 'preparations', latePackage.packageDigest.slice(7) + '.json')));
  assert.equal(lateRecord.status, 'rejected'); checks += 1;

  let lateRelease;
  const recoveryRoot = path.join(root, 'authoritative-recovery');
  const unknownAdapter = { ...adapter, prepare: () => new Promise((resolve) => { lateRelease = () => resolve({ resourceRelease: { confirmed: true } }); }) };
  const recoveryClock = Date.now();
  const unknownStore = makeStore(recoveryRoot, unknownAdapter, { now: () => new Date(recoveryClock) });
  const unknownPackage = await unknownStore.assemble(input);
  await rejects(() => unknownStore.prepare(unknownPackage.packageDigest, { timeoutMs: 15 }), 'PACKAGE_PREPARE_TIMEOUT');
  const authoritativeAdapter = { ...adapter, inspectPreparation: async ({ preparationId }) => ({ preparationId, status: 'cancelled', resourceRelease: { confirmed: true } }) };
  const restarted = makeStore(recoveryRoot, authoritativeAdapter);
  assert.equal((await restarted.reconcilePreparation(unknownPackage.packageDigest)).status, 'rejected'); checks += 1;
  const newAdmission = await restarted.prepare(unknownPackage.packageDigest);
  lateRelease();
  await new Promise((resolve) => setTimeout(resolve, 40));
  const currentRecord = JSON.parse(await readFile(path.join(recoveryRoot, 'preparations', unknownPackage.packageDigest.slice(7) + '.json')));
  assert.equal(currentRecord.admissionId, newAdmission.admissionId, 'late old preparation cannot overwrite new admission'); checks += 1;

  console.log('[execution-package-store] ' + checks + ' content/admission/backend/timeout checks passed (contract doubles; no OS isolation claim)');
} finally {
  pendingRelease?.();
  await rm(root, { recursive: true, force: true });
}
