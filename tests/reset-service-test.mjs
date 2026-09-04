import assert from 'node:assert/strict';
import { createResetService } from '../client-runtime/application/reset-service.mjs';
import { createResetRoutes } from '../client-runtime/server/reset-routes.mjs';

const calls = [];
const service = createResetService({
  guardSupportedRuntimeAction: async (action) => calls.push(['guard', action]),
  resetFixtureData: async () => { calls.push(['reset']); return { stage: 'intake' }; },
});
assert.deepEqual(await service.reset(), { state: { stage: 'intake' } });
assert.deepEqual(calls, [['guard', 'Test Fixture Reset'], ['reset']]);

let resetCalled = false;
const unavailable = createResetService({
  guardSupportedRuntimeAction: async () => { const error = new Error('unavailable'); error.status = 409; error.code = 'RUNTIME_ACTION_UNAVAILABLE'; throw error; },
  resetFixtureData: async () => { resetCalled = true; },
});
await assert.rejects(() => unavailable.reset(), (error) => error.code === 'RUNTIME_ACTION_UNAVAILABLE' && error.status === 409);
assert.equal(resetCalled, false);

const responses = [];
const routes = createResetRoutes({ json: (_response, status, body) => responses.push({ status, body }), reset: service });
assert.equal(await routes({ request: { method: 'POST' }, response: {}, url: new URL('http://local/api/reset') }), true);
assert.equal(await routes({ request: { method: 'GET' }, response: {}, url: new URL('http://local/api/reset') }), false);
assert.equal(responses[0].status, 200);
assert.equal(responses[0].body.state.stage, 'intake');

console.log('[reset-service] guard ordering, reset result, rejection, and route contracts passed');
