// F7 (P4-1/P4-2): the preparation layer must not own the language/backend
// combination. This suite proves the combination travels with the adapter by
// driving the real preparer and the real package store with TWO different
// adapters — the frozen shared-GPU one and a synthetic non-Python one — and by
// pinning the two structural properties that make the split real:
//   - the port mapping is required (no silent Python/NVIDIA fallback), and
//   - the port mapping never enters the adapter identity, so wiring cannot
//     shift the digest of a package a restart still references.
// Hardware-free: the environment probe and the adapter implementation are
// declared doubles. No GPU, driver, provider, network call or Python runner.
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

import { createExecutionPackageStore, contentDigest } from '../client-runtime/execution-package-store.mjs';
import { createBenchmarkPackagePreparer } from '../client-runtime/application/benchmark-package-preparation-service.mjs';
import { canonicalJson } from '../client-runtime/execution-package-contract.mjs';
import { SHARED_GPU_PACKAGE_ADAPTER, SHARED_GPU_PACKAGE_PORT } from '../client-runtime/local-shared-gpu-package-adapter.mjs';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'package-port-'));
let checks = 0;
const ok = (condition, message) => { assert.ok(condition, message); checks += 1; };
// 同步版，只适用于**同步抛出**的操作（组合期校验那一类）。
const rejects = (operation, code) => {
  assert.throws(operation, (error) => error.code === code, `expected ${code}`);
  checks += 1;
};
// 异步版：准备函数是 async 的，同步版对它只会看到「没有同步抛异常」，而那条没人接的
// promise 会变成未处理拒绝把进程打崩——输出的还是原始业务错误，看起来像断言以外的问题。
const rejectsAsync = async (operation, code) => {
  await assert.rejects(operation, (error) => error.code === code, `expected ${code}`);
  checks += 1;
};

const TEST_SPEC = { id: 'port-spec', correctness: { cases: ['case-a'] } };
const ORACLE_SOURCE = 'def get_test_cases():\n    return []\n';
const CANDIDATE_SOURCE = 'def run(inputs):\n    return inputs\n';

const environmentFor = (id, target) => ({
  id, digest: contentDigest(`environment:${id}:${canonicalJson(target)}`), target,
  isolation: { kind: 'container', enforced: true },
});

// Identity and implementation are deliberately separate objects, exactly as the
// composition root separates them: the identity is plain JSON and is what enters
// the manifest, the implementation is never serialized.
const adapterIdentity = (id, version, languages) => Object.freeze({ id, version, languages: Object.freeze([...languages]) });
const adapterDouble = (identity) => ({
  ...identity,
  calls: [],
  async prepare({ packageDigest, environment }) {
    this.calls.push({ packageDigest, environmentId: environment.id });
    return { status: 'ready', packageDigest, environmentDigest: environment.digest, preparedArtifactDigest: contentDigest(`prepared:${packageDigest}`), resourceRelease: { confirmed: true } };
  },
  async verifyPreparedArtifact({ preparedArtifactDigest }) { return { valid: true, preparedArtifactDigest, root: path.join(tempRoot, 'artifact-double') }; },
});

// One store per adapter: the registry is keyed by adapter id, exactly as the
// composition root keys it.
const storeFor = (dir, adapter, environment) => createExecutionPackageStore({
  rootDir: path.join(tempRoot, dir),
  environments: { resolve: async (environmentId) => { if (environmentId !== environment.id) { const error = new Error('unknown environment'); error.code = 'PACKAGE_ENVIRONMENT_UNKNOWN'; throw error; } return environment; } },
  adapters: { [adapter.id]: adapter },
});

const runPreparer = async ({ identity, implementation, port, environment, dir, missionImplementation }) => {
  const store = storeFor(dir, implementation, environment);
  const preparer = createBenchmarkPackagePreparer({ executionPackageStore: store, packageAdapter: identity, packagePort: port });
  const request = await preparer({
    request: { missionId: 'mission-port', candidate: { id: 'candidate-1', digest: contentDigest(CANDIDATE_SOURCE) }, oracleRunPy: ORACLE_SOURCE, semanticBinding: {}, limits: { timeoutSeconds: 30 } },
    mission: { id: 'mission-port', workspaceId: 'workspace-port', ...(missionImplementation ? { implementation: missionImplementation } : {}) },
    matrix: { testSpec: TEST_SPEC },
    missionRunPy: { content: CANDIDATE_SOURCE, implementationFiles: { 'helper.py': '# helper\n' } },
  });
  return { request, manifest: (await store.validate(request.packageDigest)).manifest };
};

try {
  // --- 1. The identity constant stays clean. ------------------------------
  // A wiring field added to the identity would silently re-digest every package
  // manifest, including prepared artifacts a restart still points at.
  assert.deepEqual(Object.keys(SHARED_GPU_PACKAGE_ADAPTER).sort(), ['id', 'languages', 'version']);
  checks += 1;
  ok(SHARED_GPU_PACKAGE_PORT.adapterId === SHARED_GPU_PACKAGE_ADAPTER.id, 'the port mapping must name the adapter that owns it');
  ok(Object.isFrozen(SHARED_GPU_PACKAGE_PORT) && Object.isFrozen(SHARED_GPU_PACKAGE_PORT.checks), 'the port mapping must be frozen');

  // --- 2. A missing or foreign mapping is refused, never defaulted. -------
  const legacyEnvironment = environmentFor('local-shared-gpu', { platform: 'windows-x64', device: 'gpu' });
  rejects(() => createBenchmarkPackagePreparer({ executionPackageStore: {}, packageAdapter: SHARED_GPU_PACKAGE_ADAPTER }), 'PACKAGE_PORT_MISSING');
  rejects(() => createBenchmarkPackagePreparer({ executionPackageStore: {}, packageAdapter: SHARED_GPU_PACKAGE_ADAPTER, packagePort: null }), 'PACKAGE_PORT_MISSING');
  rejects(() => createBenchmarkPackagePreparer({ executionPackageStore: {}, packageAdapter: null, packagePort: SHARED_GPU_PACKAGE_PORT }), 'PACKAGE_PORT_MISSING');
  rejects(() => createBenchmarkPackagePreparer({ executionPackageStore: {}, packageAdapter: { id: 'other-adapter', version: '1', languages: ['python'] }, packagePort: SHARED_GPU_PACKAGE_PORT }), 'PACKAGE_PORT_MISMATCH');
  for (const broken of [
    { ...SHARED_GPU_PACKAGE_PORT, language: '' },
    { ...SHARED_GPU_PACKAGE_PORT, environmentId: '   ' },
    { ...SHARED_GPU_PACKAGE_PORT, candidateEntrypoint: null },
    { ...SHARED_GPU_PACKAGE_PORT, acceptanceEntrypoint: undefined },
    { ...SHARED_GPU_PACKAGE_PORT, checks: [] },
    { ...SHARED_GPU_PACKAGE_PORT, checks: ['correctness', ''] },
  ]) rejects(() => createBenchmarkPackagePreparer({ executionPackageStore: {}, packageAdapter: SHARED_GPU_PACKAGE_ADAPTER, packagePort: broken }), 'PACKAGE_PORT_INVALID');

  // --- 3. The NVIDIA production path is unchanged. ------------------------
  const legacy = await runPreparer({
    identity: SHARED_GPU_PACKAGE_ADAPTER, implementation: adapterDouble(SHARED_GPU_PACKAGE_ADAPTER),
    port: SHARED_GPU_PACKAGE_PORT, environment: legacyEnvironment, dir: 'legacy',
  });
  assert.equal(legacy.manifest.language, 'python');
  assert.deepEqual(legacy.manifest.entrypoints, { candidate: 'run.py', acceptance: 'oracle.py' });
  assert.equal(legacy.manifest.environment.id, 'local-shared-gpu');
  assert.deepEqual(legacy.request.checks, ['correctness', 'benchmark']);
  assert.deepEqual(legacy.request.target, legacyEnvironment.target, 'the trusted environment target must be recorded on the request');
  assert.deepEqual(legacy.request.adapter, SHARED_GPU_PACKAGE_ADAPTER, 'the admitted adapter identity must be the injected one');
  checks += 1;

  // --- 4. A completely different adapter needs no service change. ---------
  // Same frozen factory, same real store, non-Python language, different
  // environment, different entrypoint file names. Nothing in the service, the
  // command or the loop knows about any of these values.
  const metalIdentity = adapterIdentity('metal-msl-npu', '1', ['metal-msl']);
  const metalAdapter = adapterDouble(metalIdentity);
  const metalEnvironment = environmentFor('locked-metal-npu', { platform: 'linux-aarch64', device: 'npu' });
  const metalPort = Object.freeze({
    adapterId: 'metal-msl-npu', language: 'metal-msl', environmentId: 'locked-metal-npu',
    candidateEntrypoint: 'kernel.metal', acceptanceEntrypoint: 'check.metal', checks: Object.freeze(['correctness']),
  });
  const metal = await runPreparer({ identity: metalIdentity, implementation: metalAdapter, port: metalPort, environment: metalEnvironment, dir: 'metal' });
  assert.equal(metal.manifest.language, 'metal-msl');
  assert.deepEqual(metal.manifest.entrypoints, { candidate: 'kernel.metal', acceptance: 'check.metal' });
  assert.equal(metal.manifest.environment.id, 'locked-metal-npu');
  assert.equal(metal.manifest.environment.digest, metalEnvironment.digest);
  assert.equal(metal.manifest.adapter.id, 'metal-msl-npu');
  assert.deepEqual(metal.request.checks, ['correctness']);
  assert.deepEqual(metal.request.target, metalEnvironment.target);
  assert.equal(metal.manifest.layers.find((layer) => layer.role === 'candidate').files[0].path, 'kernel.metal');
  assert.equal(metal.manifest.layers.find((layer) => layer.role === 'acceptance').files[0].path, 'check.metal');
  assert.equal(metalAdapter.calls.length, 1, 'the non-Python adapter implementation must actually be the one driven');
  checks += 1;

  // --- 5. Wiring cannot move a digest. ------------------------------------
  // Two preparers built from the same adapter and the same port over the same
  // inputs must agree, and the manifest's adapter payload must be exactly the
  // injected identity — no port fields riding along into the digest.
  const repeat = await runPreparer({ identity: metalIdentity, implementation: adapterDouble(metalIdentity), port: metalPort, environment: metalEnvironment, dir: 'metal-repeat' });
  assert.equal(repeat.request.packageDigest, metal.request.packageDigest);
  assert.equal(canonicalJson(metal.manifest.adapter), canonicalJson(metalIdentity));
  checks += 1;

  // --- 6. The read-only sample package is a real, valid package. ----------
  // docs/development/adapter-onboarding/sample-package is the reference other
  // backends copy. If it stopped assembling, the reference would rot silently.
  const sampleRoot = path.join(rootDir, 'docs', 'development', 'adapter-onboarding', 'sample-package');
  const sampleSpec = JSON.parse(await readFile(path.join(sampleRoot, 'test-spec.json'), 'utf8'));
  const sampleCandidate = await readFile(path.join(sampleRoot, 'candidate', 'run.py'), 'utf8');
  const sampleOracle = await readFile(path.join(sampleRoot, 'acceptance', 'oracle.py'), 'utf8');
  const declaredCases = [...sampleOracle.matchAll(/_case\("([^"]+)",\s*"([^"]+)"/g)].map((match) => ({ name: match[1], category: match[2] }));
  ok(declaredCases.length >= sampleSpec.correctness.requestedCases,
    'the sample oracle must declare at least the requested number of correctness cases');
  for (const category of sampleSpec.correctness.requiredCategories) {
    ok(declaredCases.some((item) => item.category === category), `the sample oracle must cover the required category ${category}`);
  }
  const sampleEnvironment = environmentFor('sample-environment', { platform: 'sample-host', device: 'cpu' });
  const sampleIdentity = adapterIdentity('sample-language-host', '1', ['sample-language']);
  const samplePort = Object.freeze({
    adapterId: 'sample-language-host', language: 'sample-language', environmentId: 'sample-environment',
    candidateEntrypoint: 'run.py', acceptanceEntrypoint: 'oracle.py', checks: Object.freeze(['correctness', 'benchmark']),
  });
  const sampleStore = storeFor('sample', adapterDouble(sampleIdentity), sampleEnvironment);
  const sampleRequest = await createBenchmarkPackagePreparer({ executionPackageStore: sampleStore, packageAdapter: sampleIdentity, packagePort: samplePort })({
    request: { missionId: 'sample-mission', candidate: { id: 'sample-candidate' }, oracleRunPy: sampleOracle, limits: { timeoutSeconds: 30 } },
    mission: { id: 'sample-mission', workspaceId: 'sample-workspace' },
    matrix: { testSpec: sampleSpec },
    missionRunPy: { content: sampleCandidate, implementationFiles: {} },
  });
  const sampleManifest = (await sampleStore.validate(sampleRequest.packageDigest)).manifest;
  assert.deepEqual(sampleManifest.entrypoints, { candidate: 'run.py', acceptance: 'oracle.py' });
  assert.deepEqual(sampleManifest.acceptance.testSpecDigest, contentDigest(Buffer.from(canonicalJson(sampleSpec), 'utf8')));
  assert.equal(sampleManifest.layers.find((layer) => layer.role === 'candidate').files.length, 1);
  checks += 1;

  // --- 7. Implementation-language coverage is enforced where it is knowable.
  // 语言覆盖是**后端承诺**，所以要在「语言」与「环境」同时在场的地方强制。判据取登记表
  // 而不是适配器物化清单：cuda-cpp-extension 仍然是一个 python 包，只是多带一个 operator.cu。
  // 在接上这条之前，capabilitySupportsLanguage 没有任何生产调用点——登记表声明了 languages，
  // 却没人据此拒绝，于是「本机后端支持哪些实现语言」只是一句无人执行的描述。
  const native = await runPreparer({
    identity: SHARED_GPU_PACKAGE_ADAPTER, implementation: adapterDouble(SHARED_GPU_PACKAGE_ADAPTER),
    port: SHARED_GPU_PACKAGE_PORT, environment: legacyEnvironment, dir: 'language-native',
    missionImplementation: { id: 'cuda-cpp-extension' },
  });
  assert.equal(native.manifest.language, 'python', 'the package bridge language stays python; only the implementation language is native');
  assert.equal(native.manifest.entrypoints.candidate, 'run.py');
  checks += 1;

  // 本机后端确实跑不了 Triton（`.gpu-venv` 里没有 triton，共享 GPU 运行器也没有 Triton 代码路径）。
  // 拒绝要发生在**接受 Mission 之前**，而不是让它死在 `import triton` 上——那种报错长得像工具链坏了，
  // 而不是「这个后端不支持这种语言」。
  await rejectsAsync(() => runPreparer({
    identity: SHARED_GPU_PACKAGE_ADAPTER, implementation: adapterDouble(SHARED_GPU_PACKAGE_ADAPTER),
    port: SHARED_GPU_PACKAGE_PORT, environment: legacyEnvironment, dir: 'language-refused',
    missionImplementation: { id: 'triton' },
  }), 'PACKAGE_LANGUAGE_UNSUPPORTED');

  // 但准备层仍然与后端无关：登记表没意见的环境不在这里判。metal 与 sample 两条走的正是这里，
  // 上面能通过就是这条层次分工的证据——拒绝由环境解析器负责，不由准备层越权。
  const unregistered = await runPreparer({
    identity: metalIdentity, implementation: adapterDouble(metalIdentity), port: metalPort,
    environment: metalEnvironment, dir: 'language-unregistered', missionImplementation: { id: 'cuda-cpp-extension' },
  });
  assert.equal(unregistered.manifest.environment.id, 'locked-metal-npu');
  checks += 1;

  // --- 8. The service source owns no vendor literal. ----------------------
  const source = (await readFile(path.join(rootDir, 'client-runtime', 'application', 'benchmark-package-preparation-service.mjs'), 'utf8'))
    .split(/\r?\n/).map((line) => line.replace(/\/\/.*$/, '')).join('\n');
  for (const literal of ["'python'", '"python"', "'local-shared-gpu'", "'run.py'", "'oracle.py'", "'correctness'"]) {
    ok(!source.includes(literal), `the preparation service must not hardcode ${literal}`);
  }
} finally {
  await rm(tempRoot, { recursive: true, force: true }).catch(() => {});
}

console.log(`[package-port] ${checks} adapter-owned port mapping checks passed (contract doubles; no GPU, driver or run started)`);
