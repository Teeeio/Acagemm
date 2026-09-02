import assert from 'node:assert/strict';
import { createOperatorTestService } from '../client-runtime/application/operator-test-service.mjs';
import { createOperatorTestRoutes } from '../client-runtime/server/operator-test-routes.mjs';

const calls = [];
const service = createOperatorTestService({ queue: {
  path: 'runtime/operator-test-queue.jsonl',
  list: async () => [{ taskId: 'task-1' }],
  get: async (taskId) => { calls.push(['get', taskId]); return { taskId }; },
  cancel: async (taskId) => { calls.push(['cancel', taskId]); return { taskId, status: 'cancel_requested' }; },
} });
assert.deepEqual(await service.list(), { tasks: [{ taskId: 'task-1' }], queueFile: 'runtime/operator-test-queue.jsonl' });
assert.deepEqual(await service.get('task/encoded'), { taskId: 'task/encoded' });
assert.deepEqual(await service.cancel('task-1'), { taskId: 'task-1', status: 'cancel_requested' });

const responses = [];
const routes = createOperatorTestRoutes({ json: (_response, status, body) => responses.push({ status, body }), operatorTests: service });
assert.equal(await routes({ request: { method: 'GET' }, response: {}, url: { pathname: '/api/operator-tests' } }), true);
assert.equal(await routes({ request: { method: 'GET' }, response: {}, url: { pathname: '/api/operator-tests/task%2Fencoded' } }), true);
assert.equal(await routes({ request: { method: 'POST' }, response: {}, url: { pathname: '/api/operator-tests/task-1/cancel' } }), true);
assert.equal(responses[0].body.queueFile, 'runtime/operator-test-queue.jsonl');
assert.equal(responses[1].body.task.taskId, 'task/encoded');
assert.equal(responses[2].body.task.status, 'cancel_requested');
assert.deepEqual(calls, [['get', 'task/encoded'], ['cancel', 'task-1'], ['get', 'task/encoded'], ['cancel', 'task-1']]);
console.log('[operator-test-service] queue projection and HTTP route contracts passed');
