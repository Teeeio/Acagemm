import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createOperatorTestQueue } from '../client-runtime/operator-test-queue.mjs';

const root = await mkdtemp(path.join(os.tmpdir(), 'operator-queue-stop-race-'));
const payload = {
  requestId: 'queue-stop-race',
  missionId: 'MIS_QUEUE_RACE',
  operator: 'mla_paged_attention',
  candidate: { digest: 'sha256:queue-stop-race' },
  matrix: { environments: ['C500'], stages: ['Correctness'] },
};

try {
  let pollCalls = 0;
  const timeoutQueue = createOperatorTestQueue({
    filePath: path.join(root, 'timeout.jsonl'),
    maxAttempts: 2,
    serviceClient: {
      submit: async () => ({ taskId: 'remote-timeout', status: 'queued' }),
      get: async () => {
        pollCalls += 1;
        const error = new Error('remote runner exceeded timeout');
        error.code = 'REMOTE_TEST_TIMEOUT';
        error.status = 504;
        throw error;
      },
    },
  });
  const timeoutTask = await timeoutQueue.submit(payload);
  assert.equal((await timeoutQueue.get(timeoutTask.taskId)).status, 'running');
  const unknown = await timeoutQueue.get(timeoutTask.taskId);
  assert.equal(unknown.status, 'quarantined');
  assert.equal(unknown.resourceRelease.confirmed, false);
  const exhausted = await timeoutQueue.get(timeoutTask.taskId);
  assert.equal(exhausted.status, 'quarantined', 'poll failure does not prove the worker stopped');
  assert.equal(exhausted.attempts.poll, 2);
  assert.equal(exhausted.error.code, 'REMOTE_TEST_TIMEOUT');
  assert.equal(exhausted.error.category, 'timeout');
  assert.equal(exhausted.error.retryable, false);
  assert.equal(exhausted.error.terminal, false);
  assert.equal(exhausted.resourceRelease.confirmed, false);
  assert.equal(exhausted.error.stopPolicy, 'needs_human');
  assert.equal(pollCalls, 2);

  let releaseSubmit;
  const submitStarted = new Promise((resolve) => { releaseSubmit = resolve; });
  const raceQueue = createOperatorTestQueue({
    filePath: path.join(root, 'race.jsonl'),
    serviceClient: {
      submit: async () => {
        await submitStarted;
        return { taskId: 'remote-race', status: 'queued' };
      },
      get: async () => ({ taskId: 'remote-race', status: 'cancelled', resourceRelease: { confirmed: true }, progress: 100 }),
      cancel: async () => ({ status: 'cancel_requested' }),
    },
  });
  const raceTask = await raceQueue.submit({ ...payload, requestId: 'queue-race' });
  const runningRead = raceQueue.get(raceTask.taskId);
  const cancelRead = raceQueue.cancel(raceTask.taskId);
  releaseSubmit();
  const [running, cancelled] = await Promise.all([runningRead, cancelRead]);
  assert.ok(['running', 'cancel_requested'].includes(running.status));
  assert.equal(cancelled.status, 'cancel_requested');
  const final = await raceQueue.get(raceTask.taskId);
  assert.equal(final.status, 'cancelled');
  assert.equal(final.cancelRequested, true);
  const persisted = (await readFile(path.join(root, 'race.jsonl'), 'utf8')).trim().split(/\r?\n/).map(JSON.parse);
  assert.equal(persisted.length, 1);
  assert.equal(persisted[0].status, 'cancelled');
} finally {
  await rm(root, { recursive: true, force: true });
}

console.log('[queue-stop-race] unknown timeout retains its slot; confirmed cancellation has one terminal outcome');
