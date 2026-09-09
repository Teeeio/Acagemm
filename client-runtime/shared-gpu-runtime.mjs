import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { canonicalJson } from './execution-package-contract.mjs';
import { resolvePythonExecutable } from './platform-runtime.mjs';

const execFileAsync = promisify(execFile);
const SHARED_GPU_ENVIRONMENT_ID = 'local-shared-gpu';
const SHARED_GPU_TARGET = Object.freeze({ platform: 'nvidia-cuda', device: 'gpu' });

const digest = (value) => 'sha256:' + createHash('sha256')
  .update(canonicalJson(value))
  .digest('hex');

const positiveTimeout = (value) => {
  const timeoutMs = Number(value ?? 5000);
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 30000) {
    throw Object.assign(new Error('GPU probe timeout must be between 1 and 30000 ms.'), { code: 'GPU_PROBE_TIMEOUT_INVALID', status: 422 });
  }
  return timeoutMs;
};

const parseNvidiaSmi = (stdout) => {
  const [first] = String(stdout || '').trim().split(/\r?\n/).filter(Boolean);
  if (!first) throw Object.assign(new Error('nvidia-smi returned no GPU.'), { code: 'GPU_DEVICE_UNAVAILABLE', status: 503 });
  const [name, driver, memoryMiB] = first.split(',').map((value) => value.trim());
  if (!name || !driver) throw Object.assign(new Error('nvidia-smi returned an invalid GPU record.'), { code: 'GPU_PROBE_INVALID', status: 502 });
  return { name, driver, memoryMiB: Number.isFinite(Number(memoryMiB)) ? Number(memoryMiB) : null };
};

const parseNvcc = (stdout) => {
  const match = String(stdout || '').match(/release\s+([0-9.]+)/i);
  if (!match) throw Object.assign(new Error('nvcc version could not be detected.'), { code: 'GPU_TOOLCHAIN_UNAVAILABLE', status: 503 });
  return match[1];
};

const parsePythonRuntime = (stdout) => {
  try {
    const value = JSON.parse(String(stdout || '').trim());
    return {
      executable: value.executable || null,
      framework: value.framework || null,
      frameworkVersion: value.frameworkVersion || null,
      cudaAvailable: value.cudaAvailable === true,
      deviceName: value.deviceName || null,
    };
  } catch {
    return { executable: null, framework: null, frameworkVersion: null, cudaAvailable: false, deviceName: null };
  }
};

const defaultRun = async (command, args, options) => execFileAsync(command, args, {
  windowsHide: true, maxBuffer: 1024 * 1024, ...options,
});

// Read-only capability probe. It never labels an arbitrary Python process as a
// GPU adapter and never changes the host runtime or installs dependencies.
export const probeSharedGpuRuntime = async ({
  run = defaultRun,
  nvidiaSmi = process.env.OPERATOR_GPU_NVIDIA_SMI || 'nvidia-smi',
  nvcc = process.env.OPERATOR_GPU_NVCC || 'nvcc',
  python = resolvePythonExecutable(),
  timeoutMs = 5000,
} = {}) => {
  const timeout = positiveTimeout(timeoutMs);
  const common = { timeout, encoding: 'utf8' };
  let gpu;
  let cudaToolkit;
  try {
    const result = await run(nvidiaSmi, ['--query-gpu=name,driver_version,memory.total', '--format=csv,noheader,nounits'], common);
    gpu = parseNvidiaSmi(result.stdout);
  } catch (error) {
    if (error?.code === 'GPU_DEVICE_UNAVAILABLE' || error?.code === 'GPU_PROBE_INVALID') throw error;
    throw Object.assign(new Error('No usable NVIDIA GPU was detected.'), { code: 'GPU_DEVICE_UNAVAILABLE', status: 503, cause: error });
  }
  try {
    const result = await run(nvcc, ['--version'], common);
    cudaToolkit = parseNvcc(result.stdout);
  } catch (error) {
    throw Object.assign(new Error('CUDA toolkit is unavailable for the shared GPU adapter.'), { code: 'GPU_TOOLCHAIN_UNAVAILABLE', status: 503, cause: error });
  }
  let pythonRuntime = parsePythonRuntime('{}');
  try {
    const result = await run(python, ['-c', "import json,sys\ntry:\n import torch\n print(json.dumps({'executable':sys.executable,'framework':'torch','frameworkVersion':torch.__version__,'cudaAvailable':bool(torch.cuda.is_available()),'deviceName':torch.cuda.get_device_name(0) if torch.cuda.is_available() else None}))\nexcept Exception:\n print(json.dumps({'executable':sys.executable,'cudaAvailable':False}))"], common);
    pythonRuntime = parsePythonRuntime(result.stdout);
  } catch {
    // A CUDA toolkit can still support non-Python adapters; Python capability
    // is reported as unavailable instead of making the whole probe hang/fail.
  }
  const capabilities = {
    gpu, cudaToolkit, pythonRuntime,
    target: SHARED_GPU_TARGET,
    executionMode: 'shared-host-gpu',
    isolation: { kind: 'shared-host-gpu', enforced: false },
    policy: { allowSharedHostGpu: true, packageBoundary: 'adapter-enforced' },
  };
  return {
    environment: {
      id: SHARED_GPU_ENVIRONMENT_ID,
      digest: digest(capabilities),
      target: SHARED_GPU_TARGET,
      isolation: capabilities.isolation,
      policy: capabilities.policy,
    },
    capabilities,
  };
};

export { SHARED_GPU_ENVIRONMENT_ID, SHARED_GPU_TARGET, parseNvidiaSmi, parseNvcc, parsePythonRuntime };
