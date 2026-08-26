import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'operator-studio-local-c500-'));
process.env.OPERATOR_RUNTIME_DIR = tempRoot;
process.env.OPERATOR_LOCAL_C500_DIR = path.join(tempRoot, 'tasks');
process.env.OPERATOR_LOCAL_C500_MOCK = '1';

const { createLocalC500ServiceClient } = await import('../client-runtime/local-c500-service-client.mjs');
const { createOperatorTestQueue } = await import('../client-runtime/operator-test-queue.mjs');

try {
  const client = createLocalC500ServiceClient();
  const queue = createOperatorTestQueue({ serviceClient: client, filePath: path.join(tempRoot, 'queue.jsonl') });
  const generatedRunPy = [
    'def get_inputs():',
    '    return {"generated": True}',
    '',
    'def run(inputs):',
    '    return inputs',
    '',
    'def reference(inputs):',
    '    return inputs',
    '',
  ].join('\n');

  const submitted = await queue.submit({
    schemaVersion: 1,
    requestId: 'production-local-c500-integration',
    missionId: 'mission-generated-artifact',
    purpose: 'candidate',
    operator: 'generated-op',
    candidate: { id: 'candidate-01', digest: 'sha256:generated-artifact' },
    hardware: ['C500'],
    metric: 'latency_p50',
    matrix: { environments: ['C500'], stages: ['Correctness'], warmup: 1, repeats: 2, correctnessCases: 1 },
    runPy: generatedRunPy,
    runPySource: 'production-mission-workspace/run.py',
  });
  await queue.get(submitted.taskId);
  const completed = await queue.get(submitted.taskId);
  assert.equal(completed.status, 'completed');
  assert.equal(completed.result.environment.liveHardware, false);
  assert.equal(completed.result.environment.source, 'simulation');
  assert.equal(completed.result.tracer.status, 'completed');
  assert.equal(completed.result.profiler.status, 'completed');
  assert.equal(await readFile(path.join(tempRoot, 'tasks', completed.remoteTaskId, 'run.py'), 'utf8'), generatedRunPy);
  assert.equal(completed.payload.candidate.digest, 'sha256:generated-artifact');
  console.log('local-c500 production backend test passed');
} finally {
  await rm(tempRoot, { recursive: true, force: true });
}
