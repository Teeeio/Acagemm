import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const python = process.env.OPERATOR_GPU_PYTHON || path.join(root, '.gpu-venv', 'Scripts', 'python.exe');
const runner = path.join(root, 'tools', 'local-shared-gpu-runner.py');
const required = process.env.OPERATOR_SHARED_GPU_REQUIRED === '1';

const exists = async (file) => { try { await readFile(file); return true; } catch { return false; } };
if (!await exists(python)) {
  if (required) throw new Error(`GPU Python runtime is unavailable: ${python}`);
  console.log('[shared-gpu-runner] skipped: set OPERATOR_GPU_PYTHON or create .gpu-venv to run the real GPU adapter');
} else {
  const work = await mkdtemp(path.join(os.tmpdir(), 'shared-gpu-runner-'));
  const candidate = path.join(work, 'run.py');
  const oracle = path.join(work, 'oracle.py');
  const result = path.join(work, 'result.json');
  const task = path.join(work, 'task.json');
  const source = `import torch\n\ndef get_inputs():\n    return {'x': torch.ones((8,), device='cuda', dtype=torch.float32)}\n\ndef run(inputs):\n    return inputs['x'] + 1\n\ndef reference(inputs):\n    return inputs['x'] + 1\n\ndef get_test_cases():\n    return [{'name': 'small', 'category': 'representative', 'inputs': get_inputs()}, {'name': 'repeat', 'category': 'representative', 'inputs': get_inputs()}]\n\ndef get_benchmark_inputs():\n    return [{'name': 'primary', 'inputs': get_inputs()}]\n`;
  const testSpec = {
    correctness: { requestedCases: 2, requiredCategories: ['representative'], atol: 0, rtol: 0, requireNamedCases: true },
    benchmark: { requiredProfiles: ['primary'], primaryProfile: 'primary', warmup: 1, repeats: 3 },
  };
  await writeFile(candidate, source, 'utf8');
  await writeFile(oracle, source, 'utf8');
  await writeFile(task, JSON.stringify({
    operator: 'shared_gpu_vector_add', candidate: { digest: 'sha256:' + '1'.repeat(64) },
    hardware: ['local-shared-gpu'], metric: 'latency_p50', runPySource: 'test-fixture',
    matrix: { environments: ['local-shared-gpu'], correctnessCases: 2, warmup: 1, repeats: 3, testSpec },
  }));
  const child = spawn(python, [runner, '--run-py', candidate, '--result-json', result], {
    cwd: work, windowsHide: true,
    env: {
      ...process.env, OPERATOR_LOCAL_C500_TASK_DIR: work,
      OPERATOR_LOCAL_C500_RUN_PY: candidate, OPERATOR_LOCAL_C500_ORACLE_RUN_PY: oracle,
      OPERATOR_LOCAL_C500_RESULT_JSON: result, OPERATOR_LOCAL_C500_REFERENCE_CACHE_DIR: path.join(work, 'cache'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '', stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const exitCode = await new Promise((resolve) => child.once('close', resolve));
  try {
    assert.equal(exitCode, 0, `${stdout}\n${stderr}`);
    const payload = JSON.parse(await readFile(result, 'utf8'));
    assert.equal(payload.environment.runtime, 'local-shared-gpu-runner/v1');
    assert.equal(payload.environment.executionMode, 'gpu');
    assert.equal(payload.environment.publishable, false);
    assert.equal(payload.environment.liveHardware, true);
    assert.equal(payload.benchmark[0].correctness.passed, true);
    console.log('[shared-gpu-runner] real CUDA correctness and benchmark passed; evidence remains non-publishable');
  } finally {
    await rm(work, { recursive: true, force: true });
  }

  // Regression: a preflight failure must still leave a structured terminal
  // result for the queue (never an opaque process exit with no JSON).
  const failedWork = await mkdtemp(path.join(os.tmpdir(), 'shared-gpu-runner-failure-'));
  const failedCandidate = path.join(failedWork, 'run.py');
  const failedResult = path.join(failedWork, 'result.json');
  await writeFile(failedCandidate, 'def run(inputs): return inputs\n', 'utf8');
  await writeFile(path.join(failedWork, 'task.json'), JSON.stringify({ hardware: ['local-shared-gpu'] }), 'utf8');
  const failedChild = spawn(python, [runner, '--run-py', failedCandidate, '--result-json', failedResult], {
    cwd: failedWork, windowsHide: true,
    env: { ...process.env, OPERATOR_LOCAL_C500_TASK_DIR: failedWork,
      OPERATOR_LOCAL_C500_RUN_PY: failedCandidate, OPERATOR_LOCAL_C500_RESULT_JSON: failedResult,
      OPERATOR_LOCAL_C500_ORACLE_RUN_PY: '' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const failedExit = await new Promise((resolve) => failedChild.once('close', resolve));
  const failedPayload = JSON.parse(await readFile(failedResult, 'utf8'));
  assert.equal(failedExit, 1);
  assert.equal(failedPayload.status, 'failed');
  assert.equal(failedPayload.error.code, 'SHARED_GPU_ORACLE_REQUIRED');
  assert.equal(failedPayload.environment.publishable, false);
  await rm(failedWork, { recursive: true, force: true });
  console.log('[shared-gpu-runner] structured preflight failure terminal record passed');
}
