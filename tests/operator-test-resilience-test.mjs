// Robustness contracts: retry only proven non-acceptance; unknown workers retain their slot.
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createOperatorTestQueue } from '../client-runtime/operator-test-queue.mjs';

const root = await mkdtemp(path.join(os.tmpdir(), 'operator-test-resilience-'));
const noWorker = { confirmed: true, status: 'confirmed', reason: 'This fake has no active worker.', deadline: null, nextAction: null };
const notStarted = (error, input) => Object.assign(error, {
  submission: { status: 'not_started', confirmed: true, requestId: input.requestId }, resourceRelease: noWorker,
});
const payload = {
  requestId: 'request-stable-1',
  missionId: 'MIS_RESILIENCE',
  operator: 'mla_paged_attention',
  candidate: { id: 'candidate-01', digest: 'sha256:candidate-01' },
  matrix: { environments: ['C500'] },
};

try {
  let submitCalls = 0;
  let pollCalls = 0;
  const serviceClient = {
    submit: async (input) => {
      submitCalls += 1;
      if (submitCalls === 1) {
        const error = new Error('temporary submit outage');
        error.code = 'SERVICE_UNAVAILABLE';
        error.status = 503;
        throw notStarted(error, input);
      }
      return { taskId: 'remote-1', status: 'queued' };
    },
    get: async () => {
      pollCalls += 1;
      if (pollCalls === 1) {
        const error = new Error('temporary poll disconnect');
        error.code = 'ECONNRESET';
        throw error;
      }
      return { taskId: 'remote-1', status: 'completed', resourceRelease: noWorker, progress: 100, result: { benchmark: [] } };
    },
  };
  const queueFile = path.join(root, 'recoverable.jsonl');
  const queue = createOperatorTestQueue({ serviceClient, filePath: queueFile, maxAttempts: 3 });
  const submitted = await queue.submit(payload);
  const duplicate = await queue.submit(payload);
  assert.equal(duplicate.taskId, submitted.taskId, 'requestId must make queue submission idempotent');
  assert.equal((await readFile(queueFile, 'utf8')).trim().split(/\r?\n/).length, 1);

  let task = await queue.get(submitted.taskId);
  assert.equal(task.status, 'waiting');
  assert.equal(task.attempts.submit, 1);
  task = await queue.get(submitted.taskId);
  assert.equal(task.status, 'running');
  task = await queue.get(submitted.taskId);
  assert.equal(task.status, 'quarantined', 'disconnect does not prove worker release');
  assert.equal(task.resourceRelease.confirmed, false);
  assert.equal(task.attempts.poll, 1);
  task = await queue.get(submitted.taskId);
  assert.equal(task.status, 'completed');
  assert.equal(submitCalls, 2);
  assert.equal(pollCalls, 2);

  const terminalQueue = createOperatorTestQueue({
    filePath: path.join(root, 'terminal.jsonl'),
    serviceClient: {
      submit: async (input) => {
        const error = new Error('invalid task');
        error.code = 'OPERATOR_TEST_TASK_INVALID';
        error.status = 422;
        throw notStarted(error, input);
      },
    },
  });
  const terminalSubmission = await terminalQueue.submit({ ...payload, requestId: 'request-terminal' });
  const terminal = await terminalQueue.get(terminalSubmission.taskId);
  assert.equal(terminal.status, 'failed');
  assert.equal(terminal.attempts.submit, 1);

  let unavailableCalls = 0;
  const boundedQueue = createOperatorTestQueue({
    filePath: path.join(root, 'bounded.jsonl'),
    maxAttempts: 2,
    serviceClient: {
      submit: async (input) => {
        unavailableCalls += 1;
        const error = new Error('still unavailable');
        error.code = 'SERVICE_UNAVAILABLE';
        error.status = 503;
        throw notStarted(error, input);
      },
    },
  });
  const boundedSubmission = await boundedQueue.submit({ ...payload, requestId: 'request-bounded' });
  assert.equal((await boundedQueue.get(boundedSubmission.taskId)).status, 'waiting');
  const exhausted = await boundedQueue.get(boundedSubmission.taskId);
  assert.equal(exhausted.status, 'failed');
  assert.equal(exhausted.attempts.submit, 2);
  assert.equal(unavailableCalls, 2);

  let snapshotCalls = 0;
  const snapshotQueue = createOperatorTestQueue({
    filePath: path.join(root, 'snapshot-outcomes.jsonl'),
    serviceClient: {
      submit: async () => ({ taskId: 'remote-snapshot' }),
      get: async () => {
        snapshotCalls += 1;
        return snapshotCalls === 1
          ? { status: 'failed', error: { code: 'SERVICE_UNAVAILABLE', retryable: true, message: 'temporary remote failure' } }
          : { status: 'completed', resourceRelease: noWorker, progress: 100, result: { benchmark: [] } };
      },
    },
  });
  const snapshotSubmission = await snapshotQueue.submit({ ...payload, requestId: 'request-snapshot' });
  await snapshotQueue.get(snapshotSubmission.taskId);
  const unconfirmed = await snapshotQueue.get(snapshotSubmission.taskId);
  assert.equal(unconfirmed.status, 'quarantined');
  assert.equal(unconfirmed.resourceRelease.confirmed, false);
  assert.equal((await snapshotQueue.get(snapshotSubmission.taskId)).status, 'completed');

  const malformedQueue = createOperatorTestQueue({
    filePath: path.join(root, 'malformed.jsonl'),
    serviceClient: {
      submit: async () => ({ taskId: 'remote-malformed' }),
      get: async () => ({ status: 'unexpected-state' }),
    },
  });
  const malformedSubmission = await malformedQueue.submit({ ...payload, requestId: 'request-malformed' });
  await malformedQueue.get(malformedSubmission.taskId);
  const malformed = await malformedQueue.get(malformedSubmission.taskId);
  assert.equal(malformed.status, 'quarantined');
  assert.equal(malformed.resourceRelease.confirmed, false);
  assert.equal(malformed.error.code, 'EXTERNAL_OUTCOME_INVALID');

  console.log('[operator-test-resilience] idempotency and bounded outcome-class retries passed');
} finally {
  await rm(root, { recursive: true, force: true });
}
