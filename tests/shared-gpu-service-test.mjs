import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const python = process.env.OPERATOR_GPU_PYTHON || path.join(root, '.gpu-venv', 'Scripts', 'python.exe');
const required = process.env.OPERATOR_SHARED_GPU_REQUIRED === '1';
const { access } = await import('node:fs/promises');
try { await access(python); } catch {
  if (required) throw new Error(`GPU Python runtime is unavailable: ${python}`);
  console.log('[shared-gpu-service] skipped: GPU Python runtime is unavailable');
  process.exit(0);
}

const runtime = await mkdtemp(path.join(os.tmpdir(), 'shared-gpu-service-'));
process.env.OPERATOR_TEST_BACKEND = 'local-shared-gpu';
process.env.OPERATOR_GPU_PYTHON = python;
process.env.OPERATOR_RUNTIME_DIR = runtime;
process.env.OPERATOR_LOCAL_C500_DIR = path.join(runtime, 'tasks');
const { createLocalC500ServiceClient, localC500Config } = await import(`../client-runtime/local-c500-service-client.mjs?shared-gpu=${process.pid}`);
const { createOperatorTestTool } = await import('../client-runtime/operator-test-tool.mjs');
const { createExecutionPackageStore, contentDigest } = await import('../client-runtime/execution-package-store.mjs');
const { createSharedGpuEnvironmentResolver, createSharedGpuPackageAdapter, SHARED_GPU_PACKAGE_ADAPTER } = await import('../client-runtime/local-shared-gpu-package-adapter.mjs');
const packageRoot = path.join(runtime, 'execution-packages');
const environmentResolver = createSharedGpuEnvironmentResolver();
const packageAdapter = createSharedGpuPackageAdapter({ rootDir: path.join(packageRoot, 'adapter') });
const packageStore = createExecutionPackageStore({ rootDir: path.join(packageRoot, 'store'), environments: environmentResolver, adapters: { [SHARED_GPU_PACKAGE_ADAPTER.id]: packageAdapter } });
const resolvePreparedPackage = async (payload) => {
  const verified = await packageStore.verifyAdmission(payload);
  const artifact = await packageAdapter.verifyPreparedArtifact({ manifest: verified.manifest, environment: verified.environment, preparedArtifactDigest: verified.admission.preparedArtifactDigest });
  const files = {};
  for (const layer of verified.manifest.layers) for (const descriptor of layer.files) files[descriptor.path] = await (await import('node:fs/promises')).readFile(path.join(artifact.root, ...descriptor.path.split('/')), 'utf8');
  return { runPy: files[verified.manifest.entrypoints.candidate], oracleRunPy: files[verified.manifest.entrypoints.acceptance], implementationFiles: {}, packageDigest: payload.packageDigest, admissionId: payload.admissionId };
};
const client = createOperatorTestTool({ backend: createLocalC500ServiceClient({ packageResolver: resolvePreparedPackage }), packages: packageStore });
const source = `import torch\n\ndef get_inputs():\n    return {'x': torch.ones((8,), device='cuda', dtype=torch.float32)}\n\ndef run(inputs):\n    return inputs['x'] + 1\n\ndef reference(inputs):\n    return inputs['x'] + 1\n\ndef get_test_cases():\n    return [{'name': 'small', 'category': 'representative', 'inputs': get_inputs()}, {'name': 'repeat', 'category': 'representative', 'inputs': get_inputs()}]\n\ndef get_benchmark_inputs():\n    return [{'name': 'primary', 'inputs': get_inputs()}]\n`;
const testSpec = { correctness: { requestedCases: 2, requiredCategories: ['representative'], atol: 0, rtol: 0, requireNamedCases: true }, benchmark: { requiredProfiles: ['primary'], primaryProfile: 'primary', warmup: 1, repeats: 3 } };
const sourcePayload = {
  requestId: 'shared-gpu-service-test', missionId: 'MIS_SHARED_GPU', operator: 'generic_gpu_operator',
  purpose: 'candidate', candidate: { id: 'candidate-01', digest: 'sha256:' + '2'.repeat(64) },
  hardware: ['local-shared-gpu'], matrix: { environments: ['local-shared-gpu'], correctnessCases: 2, warmup: 1, repeats: 3, testSpec },
  metric: 'latency_p50', limits: { timeoutSeconds: 120 }, runPySource: 'shared-gpu-test',
};
const assembled = await packageStore.assemble({
  language: 'python', adapter: SHARED_GPU_PACKAGE_ADAPTER, environmentId: 'local-shared-gpu',
  binding: { missionId: sourcePayload.missionId, workspaceId: sourcePayload.missionId, candidateId: sourcePayload.candidate.id, candidateDigest: sourcePayload.candidate.digest },
  candidateEntrypoint: 'run.py', candidateFiles: { 'run.py': source }, dependencyFiles: {},
  acceptance: { entrypoint: 'oracle.py', files: { 'oracle.py': source }, semanticDigest: contentDigest(Buffer.from(JSON.stringify(testSpec), 'utf8')), testSpec }, build: {},
});
const admission = await packageStore.prepare(assembled.packageDigest);
const payload = { ...sourcePayload, workspaceId: sourcePayload.missionId, packageDigest: assembled.packageDigest, admissionId: admission.admissionId, environmentDigest: admission.environmentDigest, acceptanceDigest: admission.acceptanceDigest, target: admission.target, build: admission.build, adapter: admission.adapter, checks: ['correctness', 'benchmark'], deadline: new Date(Date.now() + 120_000).toISOString() };
try {
  assert.equal(localC500Config.kind, 'local-shared-gpu');
  assert.equal(localC500Config.executionMode, 'shared-host-gpu');
  assert.equal(localC500Config.publishable, false);
  let task = await client.submit(payload);
  assert.equal(task.status, 'queued');
  assert.equal((await client.findByRequestId(payload.requestId, payload.missionId, payload)).taskId, task.taskId);
  assert.equal((await client.submit(payload)).taskId, task.taskId, 'same admitted request must not create another task');
  await client.advance(task.taskId);
  for (let attempt = 0; attempt < 120; attempt += 1) {
    task = await client.get(task.taskId);
    if (['completed', 'failed', 'cancelled', 'quarantined'].includes(task.status)) break;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  assert.equal(task.status, 'completed', JSON.stringify(task.error));
  assert.equal(task.result.environment.source, 'local-shared-gpu');
  assert.equal(task.result.environment.publishable, false);
  assert.equal(task.result.benchmark[0].correctness.passed, true);
  assert.equal(task.resourceRelease.confirmed, true);
  console.log('[shared-gpu-service] production local queue, supervisor, CUDA correctness and benchmark passed');
} finally {
  await rm(runtime, { recursive: true, force: true });
}
