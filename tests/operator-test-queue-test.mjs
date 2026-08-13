import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createOperatorTestQueue } from '../client-runtime/operator-test-queue.mjs';

const root = await mkdtemp(path.join(os.tmpdir(), 'operator-test-queue-'));
const queuePath = path.join(root, 'queue.jsonl');
let submitCount = 0;
let pollCount = 0;
const fakeService = {
  async submit(payload) {
    submitCount += 1;
    return { taskId: `remote-${submitCount}`, status: 'queued', submittedAt: new Date().toISOString(), payload };
  },
  async get(taskId) {
    pollCount += 1;
    if (pollCount % 2 === 1) return { taskId, status: 'running', progress: 50, logs: [{ sequence: 1, progress: 50, message: 'remote running' }] };
    return { taskId, status: 'completed', progress: 100, durationMs: 42, completedAt: new Date().toISOString(), logs: [{ sequence: 2, progress: 100, message: 'remote completed' }], result: { benchmark: [{ environment: 'C500', value: 41.8, unit: 'us' }] } };
  },
  async cancel() { return { status: 'cancelled' }; },
};

const queue = createOperatorTestQueue({ serviceClient: fakeService, filePath: queuePath });
const payload = { operator: 'paged_attention', candidate: { digest: 'sha256:test' }, matrix: { environments: ['C500'], stages: ['correctness'] } };

try {
  await assert.rejects(queue.submit({}), (error) => error.code === 'OPERATOR_TEST_TASK_INVALID');
  const first = await queue.submit(payload);
  const second = await queue.submit({ ...payload, candidate: { digest: 'sha256:test-2' } });
  assert.equal(first.status, 'waiting');
  assert.equal(second.status, 'waiting');

  const firstRunning = await queue.get(first.taskId);
  assert.equal(firstRunning.status, 'running');
  assert.equal(submitCount, 1);
  const secondStillWaiting = await queue.get(second.taskId);
  assert.equal(secondStillWaiting.status, 'waiting');
  assert.equal(submitCount, 1);

  const firstComplete = await queue.get(first.taskId);
  assert.equal(firstComplete.status, 'completed');
  assert.equal(firstComplete.result.benchmark[0].environment, 'C500');
  const secondRunning = await queue.get(second.taskId);
  assert.equal(secondRunning.status, 'running');
  assert.equal(submitCount, 2);

  const cancelled = await queue.cancel(second.taskId);
  assert.equal(cancelled.status, 'cancel_requested');
  const persisted = JSON.parse(`[${(await readFile(queuePath, 'utf8')).trim().split(/\r?\n/).join(',')}]`);
  assert.equal(persisted.length, 2);
  assert.equal(persisted.find((task) => task.taskId === second.taskId).cancelRequested, true);
  console.log('[operator-test-queue] submit, serial processing, persistence, and cancellation passed');
} finally {
  await rm(root, { recursive: true, force: true });
}
