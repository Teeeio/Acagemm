import assert from 'node:assert/strict';
import { createSharedGpuEnvironmentResolver } from '../client-runtime/local-shared-gpu-package-adapter.mjs';
import { probeSharedGpuRuntime, parseNvidiaSmi, parseNvcc, parsePythonRuntime, SHARED_GPU_ENVIRONMENT_ID } from '../client-runtime/shared-gpu-runtime.mjs';

assert.deepEqual(parseNvidiaSmi('NVIDIA GeForce RTX 3060 Laptop GPU, 551.78, 6144\n'), {
  name: 'NVIDIA GeForce RTX 3060 Laptop GPU', driver: '551.78', memoryMiB: 6144,
});
assert.equal(parseNvcc('Cuda compilation tools, release 12.4, V12.4.131'), '12.4');
assert.equal(parsePythonRuntime('{"framework":"torch","cudaAvailable":false}').cudaAvailable, false);
assert.throws(() => parseNvcc('unknown'), (error) => error.code === 'GPU_TOOLCHAIN_UNAVAILABLE');

const calls = [];
const run = async (command, args) => {
  calls.push([command, args]);
  if (command === 'nvidia-smi') return { stdout: 'RTX test, 1.2.3, 4096\n' };
  if (command === 'nvcc') return { stdout: 'Cuda compilation tools, release 12.4, V12.4.131' };
  return { stdout: JSON.stringify({ executable: 'python', framework: 'torch', frameworkVersion: 'cpu', cudaAvailable: false }) };
};
const result = await probeSharedGpuRuntime({ run, timeoutMs: 1000 });
assert.equal(result.environment.id, SHARED_GPU_ENVIRONMENT_ID);
assert.equal(result.environment.target.device, 'gpu');
assert.equal(result.environment.isolation.enforced, false);
assert.equal(result.environment.policy.allowSharedHostGpu, true);
assert.equal(result.capabilities.pythonRuntime.cudaAvailable, false);
assert.equal(calls.length, 3);

const pythonOnly = await probeSharedGpuRuntime({
  run: async (command) => {
    if (command === 'nvidia-smi') return { stdout: 'RTX test, 1.2.3, 4096\n' };
    if (command === 'nvcc') throw Object.assign(new Error('nvcc absent'), { code: 'ENOENT' });
    return { stdout: JSON.stringify({ executable: 'python', framework: 'torch', frameworkVersion: 'cuda', cudaAvailable: true, deviceName: 'RTX test' }) };
  }, requireCudaToolkit: false, timeoutMs: 1000,
});
assert.equal(pythonOnly.capabilities.cudaToolkit, null);
assert.equal(pythonOnly.capabilities.cudaCompiler.available, false);
assert.equal(pythonOnly.capabilities.pythonRuntime.cudaAvailable, true);

await assert.rejects(
  () => probeSharedGpuRuntime({ run: async () => { throw new Error('missing'); } }),
  (error) => error.code === 'GPU_DEVICE_UNAVAILABLE',
);
await assert.rejects(() => probeSharedGpuRuntime({ run, timeoutMs: 0 }), (error) => error.code === 'GPU_PROBE_TIMEOUT_INVALID');
// A still-valid cache must not bypass the preflight refresh. Concurrent
// admission reads join the refresh, including its failure, with no fallback.
let probeCalls = 0;
let query;
const resolver = createSharedGpuEnvironmentResolver({ probe: async () => {
  probeCalls++;
  if (probeCalls === 1) return result;
  return new Promise((resolve, reject) => { query = { resolve, reject }; });
} });
const environmentId = SHARED_GPU_ENVIRONMENT_ID;
await resolver.resolve(environmentId);
await resolver.resolve(environmentId);
assert.equal(probeCalls, 1, 'ordinary reads reuse the unexpired cache');
const refreshing = resolver.resolve(environmentId, { refresh: true });
const concurrent = resolver.resolve(environmentId);
await Promise.resolve();
assert.equal(probeCalls, 2, 'preflight refreshes even an unexpired cache');
query.resolve(pythonOnly);
const refreshed = await Promise.all([refreshing, concurrent]);
assert.deepEqual(refreshed, [pythonOnly.environment, pythonOnly.environment]);
refreshed[0].id = 'caller mutation';
assert.equal((await resolver.resolve(environmentId)).id, environmentId);
const failedRefresh = resolver.resolve(environmentId, { refresh: true });
const failedReader = resolver.resolve(environmentId);
const rejection = Promise.all([
  assert.rejects(failedRefresh, /probe unavailable/),
  assert.rejects(failedReader, /probe unavailable/),
]);
await Promise.resolve();
query.reject(Error('probe unavailable'));
await rejection;
const recovering = resolver.resolve(environmentId);
await Promise.resolve();
assert.equal(probeCalls, 4, 'failed refresh invalidates the older cached value');
query.resolve(result);
await recovering;
console.log('[shared-gpu-runtime] probe, policy, parser, refresh and failure-boundary checks passed');
