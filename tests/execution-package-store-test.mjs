import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile, mkdir, symlink, unlink, readdir } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createExecutionPackageStore, contentDigest } from '../client-runtime/execution-package-store.mjs';
import { createOperatorTestTool } from '../client-runtime/operator-test-tool.mjs';
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
const makeStore = (dir = root, selected = adapter) => createExecutionPackageStore({ rootDir: dir, environments: environmentPort, adapters: { [adapterDescriptor.id]: selected } });
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
  const stalled = makeStore(path.join(root, 'stalled'), {
    version: '1', languages: ['test-language'], verifyPreparedArtifact: async () => ({ valid: true }),
    prepare: async ({ signal }) => {
      prepareCount += 1;
      return new Promise((resolve) => { pendingRelease = () => resolve({ resourceRelease: { confirmed: true } }); signal.addEventListener('abort', () => { /* claim deliberately remains uncertain */ }); });
    },
  });
  const stalledPackage = await stalled.assemble(input);
  await rejects(() => stalled.prepare(stalledPackage.packageDigest, { timeoutMs: 15 }), 'PACKAGE_PREPARE_TIMEOUT');
  const atTimeout = prepareCount;
  await rejects(() => stalled.prepare(stalledPackage.packageDigest, { timeoutMs: 15 }), 'PACKAGE_PREPARATION_UNCONFIRMED');
  await rejects(() => makeStore(path.join(root, 'stalled')).prepare(stalledPackage.packageDigest), 'PACKAGE_PREPARATION_UNCONFIRMED');
  assert.equal(prepareCount, atTimeout); checks += 1;
  pendingRelease();
  await new Promise((resolve) => setTimeout(resolve, 30));
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
  const slowRoot = path.join(root, 'late-validation');
  const slowStore = createExecutionPackageStore({
    rootDir: slowRoot, adapters: { [adapterDescriptor.id]: adapter },
    environments: { resolve: async () => { lookups += 1; if (lookups >= 3) await new Promise((resolve) => setTimeout(resolve, 40)); return environment; } },
  });
  const latePackage = await slowStore.assemble(input);
  await rejects(() => slowStore.prepare(latePackage.packageDigest, { timeoutMs: 25 }), 'PACKAGE_PREPARE_TIMEOUT');
  const lateRecord = JSON.parse(await readFile(path.join(slowRoot, 'preparations', latePackage.packageDigest.slice(7) + '.json')));
  assert.equal(lateRecord.status, 'rejected'); checks += 1;

  let lateRelease;
  const recoveryRoot = path.join(root, 'authoritative-recovery');
  const unknownAdapter = { ...adapter, prepare: () => new Promise((resolve) => { lateRelease = () => resolve({ resourceRelease: { confirmed: true } }); }) };
  const unknownStore = makeStore(recoveryRoot, unknownAdapter);
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
