// Robustness contracts: hung/ambiguous backend I/O must not hold queue locks.
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createOperatorTestQueue } from '../client-runtime/operator-test-queue.mjs';

const payload = (id) => ({
  requestId: id, missionId: 'MIS_LIVENESS', operator: 'identity',
  candidate: { digest: 'sha256:' + 'a'.repeat(64) }, matrix: { environments: ['CPU'] },
});
const ended = (status = 'completed') => ({
  taskId: 'remote-one', status, resourceRelease: { confirmed: true, status: 'confirmed', reason: 'Fake owns no worker.', deadline: null, nextAction: null },
});
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const never = () => new Promise(() => {});
const poll = async (read, predicate, timeout = 1000) => {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const value = await read(); if (predicate(value)) return value; await wait(10); }
  throw new Error('bounded observation deadline expired');
};

test('queue liveness and resource ownership', { timeout: 15_000 }, async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'operator-queue-liveness-'));
  const queues = [];
  const create = (name, serviceClient, options = {}) => {
    const queue = createOperatorTestQueue({ filePath: path.join(root, name + '.jsonl'), serviceClient, ioTimeoutMs: 60, taskTimeoutMs: 5_000, ...options });
    queues.push(queue);
    return queue;
  };
  try {
    await t.test('waiting tasks also have a total deadline without any worker start', async () => {
      let submits = 0;
      const queue = create('waiting-deadline', { submit: () => { submits += 1; return never(); } }, { taskTimeoutMs: 60 });
      const task = await queue.submit(payload('waiting-deadline'));
      const expired = await poll(() => queue.readTask(task.taskId), (value) => value.status === 'failed');
      assert.equal(expired.error.code, 'OPERATOR_TEST_TASK_DEADLINE');
      assert.equal(expired.resourceRelease.confirmed, true);
      assert.equal(submits, 0);
    });

    await t.test('partial or foreign not-started proofs never authorize a retry', async () => {
      for (const [name, submission, resourceRelease] of [
        ['foreign', { status: 'not_started', confirmed: true, requestId: 'another-request' }, { confirmed: true }],
        ['unconfirmed', { status: 'not_started', confirmed: true, requestId: 'proof-unconfirmed' }, { confirmed: false }],
        ['missing', null, { confirmed: true }],
      ]) {
        let calls = 0;
        const queue = create('proof-' + name, { submit: async () => {
          calls += 1;
          throw Object.assign(new Error('unproven rejection'), { code: 'SERVICE_UNAVAILABLE', submission, resourceRelease });
        } });
        const task = await queue.submit(payload('proof-' + name));
        assert.equal((await queue.process()).status, 'quarantined');
        await queue.process();
        assert.equal(calls, 1);
        assert.equal((await queue.readTask(task.taskId)).resourceRelease.confirmed, false);
      }
    });

    await t.test('allowStart=false neither claims waiting work nor invokes a worker-starting advance', async () => {
      let submits = 0, advances = 0, reads = 0;
      const queue = create('start-barrier', {
        submit: async () => { submits += 1; return { taskId: 'remote-one', status: 'queued' }; },
        advance: async () => { advances += 1; return { taskId: 'remote-one', status: 'running' }; },
        get: async () => { reads += 1; return { taskId: 'remote-one', status: 'waiting' }; },
      });
      const task = await queue.submit(payload('barrier'));
      const before = await readFile(queue.path, 'utf8');
      assert.equal(await queue.dispatch({ allowStart: false }), null);
      assert.equal(await readFile(queue.path, 'utf8'), before);
      assert.equal(submits, 0);
      await queue.process();
      await queue.dispatch({ allowStart: false });
      await poll(() => queue.readTask(task.taskId), (value) => value.dispatchClaim === null);
      assert.equal(reads, 1);
      assert.equal(advances, 0);
      assert.equal(submits, 1);
    });

    await t.test('dispatch freezes content before await and does not hold locks while submit hangs', async () => {
      let calls = 0;
      let observed;
      const queue = create('hung-submit', {
        submit: (input) => { calls += 1; observed = input; return never(); },
      });
      const input = payload('hung-submit');
      const submitting = queue.submit(input);
      input.candidate.digest = 'mutated-after-call';
      const first = await submitting;
      const second = await queue.submit(payload('second'));
      const started = performance.now();
      assert.equal((await queue.dispatch()).status, 'submitting');
      assert.ok(performance.now() - started < 250);
      await poll(() => Promise.resolve(calls), (count) => count === 1);
      assert.equal(observed.candidate.digest, first.payload.candidate.digest);
      const before = await readFile(queue.path, 'utf8');
      const readStarted = performance.now();
      await Promise.all([queue.readTask(first.taskId), queue.readTasks(), queue.findByRequestId('hung-submit', 'MIS_LIVENESS')]);
      assert.ok(performance.now() - readStarted < 100);
      assert.equal(await readFile(queue.path, 'utf8'), before);
      const cancelStarted = performance.now();
      await queue.cancel(first.taskId);
      assert.ok(performance.now() - cancelStarted < 250, 'cancel must persist without waiting for submit');
      await poll(() => queue.readTask(first.taskId), (task) => task.status === 'quarantined');
      await queue.process();
      assert.equal(calls, 1, 'unknown submit must never be repeated');
      assert.equal((await queue.readTask(first.taskId)).resourceRelease.confirmed, false);
      assert.equal((await queue.readTask(second.taskId)).status, 'waiting');
    });

    await t.test('hung get cannot prevent confirmed cancellation or admit the next task early', async () => {
      let submits = 0;
      const queue = create('hung-get', {
        submit: async () => { submits += 1; return { taskId: 'remote-one', status: 'queued' }; },
        get: never,
        cancel: async () => ended('cancelled'),
      });
      const first = await queue.submit(payload('hung-get'));
      const second = await queue.submit(payload('after-hung-get'));
      await queue.process();
      await queue.dispatch();
      const started = performance.now();
      await queue.cancel(first.taskId);
      const cancelled = await poll(() => queue.readTask(first.taskId), (task) => task.status === 'cancelled');
      assert.ok(performance.now() - started < 300);
      assert.equal(cancelled.resourceRelease.confirmed, true);
      assert.equal((await queue.readTask(second.taskId)).status, 'waiting');
      await queue.process();
      assert.equal(submits, 2, 'only release confirmation admits the next submission');
      await wait(80); // stale hung-poll deadline must not overwrite cancellation.
      assert.equal((await queue.readTask(first.taskId)).status, 'cancelled');
    });

    await t.test('terminal status without explicit release is quarantined', async () => {
      let polls = 0;
      const queue = create('unconfirmed-terminal', {
        submit: async () => ({ taskId: 'remote-one', status: 'queued' }),
        get: async () => { polls += 1; return { taskId: 'remote-one', status: 'completed', result: {} }; },
      });
      const first = await queue.submit(payload('unconfirmed'));
      const second = await queue.submit(payload('blocked'));
      await queue.process();
      const unknown = await queue.process();
      assert.equal(unknown.status, 'quarantined');
      assert.equal(unknown.error.code, 'OPERATOR_TEST_RELEASE_UNCONFIRMED');
      assert.equal(unknown.resourceRelease.confirmed, false);
      assert.equal((await queue.readTask(second.taskId)).status, 'waiting');
      assert.equal(polls, 1);
      assert.equal((await queue.readTask(first.taskId)).completedAt, undefined);
    });

    await t.test('lost submit response reconciles frozen request identity without another submit', async () => {
      let submits = 0;
      let received;
      let lookups = 0;
      const queue = create('lost-response', {
        submit: async (input) => {
          submits += 1; received = input;
          throw Object.assign(new Error('response was lost after acceptance'), { code: 'ECONNRESET' });
        },
        findByRequestId: async (id, missionId, expected) => {
          lookups += 1;
          assert.equal(id, received.requestId);
          assert.equal(missionId, received.missionId);
          assert.deepEqual(expected, received);
          return { taskId: 'remote-one', status: 'running' };
        },
        get: async () => ended(),
      });
      const task = await queue.submit(payload('lost-response'));
      assert.equal((await queue.process()).status, 'quarantined');
      assert.equal((await queue.process()).status, 'running');
      assert.equal((await queue.process()).status, 'completed');
      assert.equal(submits, 1);
      assert.equal(lookups, 1);
      assert.equal((await queue.readTask(task.taskId)).resourceRelease.confirmed, true);
    });

    await t.test('a late accepted response is retained and cancelled once', async () => {
      let resolveSubmit;
      let submits = 0, cancels = 0;
      const queue = create('late-response', {
        submit: () => { submits += 1; return new Promise((resolve) => { resolveSubmit = resolve; }); },
        findByRequestId: async () => null,
        cancel: async () => { cancels += 1; return ended('cancelled'); },
      });
      const task = await queue.submit(payload('late'));
      await queue.dispatch();
      await poll(() => Promise.resolve(resolveSubmit), Boolean);
      await queue.cancel(task.taskId);
      await wait(80);
      resolveSubmit({ taskId: 'remote-one', status: 'queued' });
      await poll(() => queue.readTask(task.taskId), (value) => value.remoteTaskId === 'remote-one');
      await queue.process();
      const final = await poll(() => queue.readTask(task.taskId), (value) => value.status === 'cancelled');
      assert.equal(final.resourceRelease.confirmed, true);
      assert.equal(submits, 1);
      assert.equal(cancels, 1);
    });

    await t.test('task deadline cancels independently of a stalled get', async () => {
      let cancelled = 0;
      const queue = create('total-deadline', {
        submit: async () => ({ taskId: 'remote-one', status: 'queued' }),
        get: never,
        cancel: async (_id, options) => { cancelled += 1; assert.equal(options.reason, 'task_deadline'); return ended('cancelled'); },
      }, { taskTimeoutMs: 100, ioTimeoutMs: 500 });
      const task = await queue.submit(payload('total-deadline'));
      await queue.process();
      await queue.dispatch();
      const result = await poll(() => queue.readTask(task.taskId), (value) => value.status === 'failed');
      assert.equal(result.cancelReason, 'task_deadline');
      assert.equal(result.error.code, 'OPERATOR_TEST_TASK_DEADLINE');
      assert.equal(cancelled, 1);
      assert.equal(result.resourceRelease.confirmed, true);
    });

    await t.test('two queue instances share one durable submission claim', async () => {
      let calls = 0, resolveSubmit;
      const service = { submit: () => { calls += 1; return new Promise((resolve) => { resolveSubmit = resolve; }); } };
      const first = create('shared', service, { ioTimeoutMs: 500 });
      const second = create('shared', service, { ioTimeoutMs: 500 });
      const task = await first.submit(payload('shared'));
      await Promise.all([first.dispatch(), second.dispatch()]);
      await poll(() => Promise.resolve(calls), (value) => value === 1);
      assert.equal((await second.readTask(task.taskId)).status, 'submitting');
      resolveSubmit({ taskId: 'remote-one', status: 'queued' });
      await poll(() => first.readTask(task.taskId), (value) => value.status === 'running');
      assert.equal(calls, 1);
    });
  } finally {
    await Promise.all(queues.map((queue) => queue.dispose()));
    await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
});
