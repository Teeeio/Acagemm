import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createLocalC500Adapter } from '../tools/local-c500-tester/local-c500-adapter.mjs';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixturePath = path.join(rootDir, 'tools', 'local-c500-tester', 'fixtures', 'vector_add');

const pollUntilTerminal = async (adapter, taskId) => {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const task = await adapter.pollTest(taskId);
    if (['completed', 'failed', 'cancelled'].includes(task.status)) return task;
  }
  throw new Error(`task did not terminate: ${taskId}`);
};

const tempDir = await mkdtemp(path.join(os.tmpdir(), 'local-c500-adapter-'));

try {
  const mock = createLocalC500Adapter({ missionDir: tempDir, mock: true });
  const mockTask = await mock.submitTest({
    purpose: 'candidate',
    candidateArtifact: { digest: 'sha256:candidate-001', path: fixturePath },
    matrix: { shapeKey: 'small_decode_or_default', dtype: 'float16' },
    stages: ['correctness', 'benchmark', 'tracer', 'profiler'],
    round: 1,
  });
  assert.equal(mockTask.status, 'waiting');
  const mockResult = await pollUntilTerminal(mock, mockTask.taskId);
  assert.equal(mockResult.status, 'completed');
  assert.equal(mockResult.result.candidate.digest, 'sha256:candidate-001');
  assert.equal(mockResult.result.matrix.shapeKey, 'small_decode_or_default');
  assert.equal(mockResult.result.environment.liveHardware, false);
  assert.equal(mockResult.result.environment.source, 'simulation');
  assert.equal(mockResult.result.correctness, 'pass');
  assert.equal(mockResult.result.benchmark.status, 'completed');
  assert.equal(mockResult.result.tracer.status, 'generated');
  assert.equal(mockResult.result.profiler.status, 'generated');

  const real = createLocalC500Adapter({
    missionDir: path.join(tempDir, 'real'),
    mock: false,
    environment: { liveHardware: true, tools: { mctracer: { status: 'missing' }, mcProfiler: { status: 'missing' } } },
  });
  const realTask = await real.submitTest({
    purpose: 'baseline',
    candidateArtifact: { digest: 'sha256:baseline-001', path: fixturePath },
    matrix: { shapeKey: 'small_decode_or_default', dtype: 'float16' },
    stages: ['correctness', 'benchmark', 'tracer', 'profiler'],
  });
  const realResult = await pollUntilTerminal(real, realTask.taskId);
  assert.equal(realResult.status, 'completed');
  assert.equal(realResult.result.candidate.digest, 'sha256:baseline-001');
  assert.equal(realResult.result.environment.liveHardware, true);
  assert.equal(realResult.result.environment.source, 'local-c500');
  assert.equal(realResult.result.benchmark.status, 'completed');
  assert.equal(Number.isFinite(realResult.result.benchmark.latency_p50_us), true);
  assert.equal(realResult.result.tracer.status, 'missing');
  assert.equal(realResult.result.profiler.status, 'missing');

  const cancelled = await mock.submitTest({
    purpose: 'candidate',
    candidateArtifact: { digest: 'sha256:candidate-cancelled', path: fixturePath },
    matrix: { shapeKey: 'small_decode_or_default' },
    stages: ['benchmark'],
  });
  const cancelledResult = await mock.cancelTest(cancelled.taskId);
  assert.equal(cancelledResult.status, 'cancelled');
} finally {
  await rm(tempDir, { recursive: true, force: true });
}

process.stdout.write('[local-c500-adapter] contract and provenance passed\n');
