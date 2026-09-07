import assert from 'node:assert/strict';
import { createRuntimeLifecycleService } from '../client-runtime/application/runtime-lifecycle-service.mjs';
import { createRuntimeAdvanceRoutes } from '../client-runtime/server/runtime-advance-routes.mjs';
import { createStateRepository } from '../client-runtime/state-repository.mjs';

let stored = { stateVersion: 1, count: 0 };
const calls = [];
const repository = createStateRepository({
  load: async (options) => { calls.push(options.recover ? 'recover' : 'read'); return stored; },
  save: async (state) => { calls.push('persist'); stored = { ...state, stateVersion: stored.stateVersion + 1 }; return stored; },
});
let allowed = true;
const service = createRuntimeLifecycleService({
  readState: repository.read,
  persistState: repository.persist,
  describeRuntime: async () => ({ mode: 'fixture' }),
  canAdvance: () => allowed,
  pipeline: { advance: async ({ state }) => {
    calls.push('advance');
    await new Promise((resolve) => setTimeout(resolve, 5));
    state.count += 1;
    return { state, changed: true };
  } },
});
const read = () => repository.runExclusive(service.read);
const advance = () => repository.runExclusive(service.advance);
const first = await read();
first.count = 100;
assert.equal((await read()).count, 0, 'queries must be isolated snapshots');
assert.deepEqual(calls, ['read', 'read']);
assert.equal(stored.stateVersion, 1);
calls.length = 0;

const snapshots = await Promise.all([advance(), read(), advance(), advance(), read()]);
assert.deepEqual(snapshots.map((state) => state.count), [1, 1, 2, 3, 3]);
assert.equal(stored.stateVersion, 4);
assert.equal(calls.filter((call) => call === 'advance').length, 3);
assert.equal(calls.filter((call) => call === 'persist').length, 3);
assert.equal(repository.pending(), 0);

stored.workflowRecovery = { commandRecovery: { status: 'blocked' } };
calls.length = 0;
await advance();
assert.deepEqual(calls, ['recover'], 'blocked recovery must not process tests or advance workflow');
delete stored.workflowRecovery;
allowed = false;
await assert.rejects(advance(), { code: 'RUNTIME_OWNER_UNAVAILABLE' });
assert.equal((await read()).count, 3, 'owner loss does not prevent inspection');
allowed = true;

let response;
const route = createRuntimeAdvanceRoutes({ json: (_response, status, body) => { response = { status, body }; }, advanceRuntime: advance });
assert.equal(await route({ request: { method: 'GET' }, response: {}, url: new URL('http://local/api/runtime/advance') }), false);
assert.equal(await route({ request: { method: 'POST' }, response: {}, url: new URL('http://local/api/state') }), false);
assert.equal(await route({ request: { method: 'POST' }, response: {}, url: new URL('http://local/api/runtime/advance') }), true);
assert.equal(response.status, 200);
assert.equal(response.body.state.count, 4);

let persisted = false;
const idle = createRuntimeLifecycleService({
  readState: async () => ({ stateVersion: 9 }),
  describeRuntime: async () => ({ mode: 'fixture' }),
  persistState: async () => { persisted = true; },
  pipeline: { advance: async ({ state }) => ({ state, changed: false }) },
});
assert.equal((await idle.advance()).stateVersion, 9);
assert.equal(persisted, false, 'an unchanged tick must not bump the version');
console.log('[runtime-lifecycle] isolated reads, explicit advancement, serialization and owner guard passed');
