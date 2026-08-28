import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'operator-studio-local-c500-async-'));
const fixture = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'fake-local-c500-runner.mjs');
process.env.OPERATOR_RUNTIME_DIR = tempRoot;
process.env.OPERATOR_LOCAL_C500_DIR = path.join(tempRoot, 'tasks');
process.env.OPERATOR_LOCAL_C500_COMMAND = `"${process.execPath}" "${fixture}"`;
delete process.env.OPERATOR_LOCAL_C500_MOCK;

const { createLocalC500ServiceClient } = await import('../client-runtime/local-c500-service-client.mjs');

const client = createLocalC500ServiceClient();
let submitted = null;
try {
  submitted = await client.submit({
    missionId: 'MIS_ASYNC', purpose: 'candidate', operator: 'async-test',
    candidate: { id: 'candidate-01', digest: `sha256:${'a'.repeat(64)}` },
    hardware: ['C550'], metric: 'latency_p50',
    matrix: { environments: ['C550'], correctnessCases: 1, warmup: 1, repeats: 1 },
    limits: { timeoutSeconds: 10 },
    runPy: 'def get_inputs(): return {}\ndef run(inputs): return 1\ndef reference(inputs): return 1\n',
  });
  const startedAt = Date.now();
  const running = await client.get(submitted.taskId);
  assert.equal(running.status, 'running');
  assert.ok(Date.now() - startedAt < 200, 'starting a hardware task must not block the API until the runner exits');

  let benchmark = running;
  const progressDeadline = Date.now() + 2000;
  while (benchmark.status === 'running' && benchmark.progress < 60 && Date.now() < progressDeadline) {
    await new Promise((resolve) => setTimeout(resolve, 75));
    benchmark = await client.get(submitted.taskId);
  }
  assert.equal(benchmark.status, 'running');
  assert.equal(benchmark.progress, 60);
  assert.match(benchmark.logs.at(-1).message, /benchmark running/i);

  let completed = benchmark;
  const deadline = Date.now() + 3000;
  while (completed.status === 'running' && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    completed = await client.get(submitted.taskId);
  }
  assert.equal(completed.status, 'completed');
  assert.equal(completed.result.environment.liveHardware, true);
  console.log('[local-c500-service-async] non-blocking runner progress and completion passed');
} finally {
  if (submitted) await client.cancel(submitted.taskId).catch(() => {});
  await new Promise((resolve) => setTimeout(resolve, 100));
  await rm(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
