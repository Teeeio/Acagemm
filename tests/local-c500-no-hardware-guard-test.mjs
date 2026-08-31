import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'operator-studio-no-hardware-'));
process.env.OPERATOR_RUNTIME_DIR = tempRoot;
process.env.OPERATOR_LOCAL_C500_DIR = path.join(tempRoot, 'tasks');
process.env.OPERATOR_HARDWARE_DISABLED = '1';
delete process.env.OPERATOR_LOCAL_C500_COMMAND;
delete process.env.OPERATOR_LOCAL_C500_MOCK;

try {
  const { createLocalC500ServiceClient, localC500Config } = await import(`../client-runtime/local-c500-service-client.mjs?no-hardware=${process.pid}`);
  assert.equal(localC500Config.hardwareDisabled, true);
  assert.equal(localC500Config.mock, false);

  const client = createLocalC500ServiceClient();
  const submitted = await client.submit({
    missionId: 'MIS_NO_HARDWARE',
    purpose: 'candidate',
    operator: 'no-hardware-guard',
    candidate: { id: 'candidate-01', digest: `sha256:${'a'.repeat(64)}` },
    hardware: ['C550'],
    metric: 'latency_p50',
    matrix: { environments: ['C550'], correctnessCases: 1, warmup: 1, repeats: 1 },
    runPy: 'def get_inputs(): return {}\ndef run(inputs): return 1\ndef reference(inputs): return 1\n',
  });

  let task = await client.get(submitted.taskId);
  const deadline = Date.now() + 2_000;
  while (task.status === 'running' && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
    task = await client.get(submitted.taskId);
  }
  assert.equal(task.status, 'failed');
  assert.equal(task.error.code, 'LOCAL_C500_HARDWARE_DISABLED');
  assert.match(task.error.message, /Hardware execution is disabled/);
  console.log('[local-c500-no-hardware-guard] default hardware runner is unreachable during software-only verification');
} finally {
  await rm(tempRoot, { recursive: true, force: true });
}
