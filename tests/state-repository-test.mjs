import assert from 'node:assert/strict';
import { createStateRepository } from '../client-runtime/state-repository.mjs';

let persisted = { stateVersion: 0, counter: 0, order: [] };
const repository = createStateRepository({
  load: async () => structuredClone(persisted),
  save: async (state) => {
    persisted = { ...structuredClone(state), stateVersion: Number(state.stateVersion || 0) + 1 };
    return persisted;
  },
});

const release = [];
await Promise.all(Array.from({ length: 20 }, (_, index) => repository.update(async (state) => {
  await new Promise((resolve) => setTimeout(resolve, index % 3));
  state.counter += 1;
  state.order.push(index);
  release.push(index);
})));

assert.equal(persisted.counter, 20);
assert.equal(persisted.stateVersion, 20);
assert.deepEqual(persisted.order, Array.from({ length: 20 }, (_, index) => index));
assert.deepEqual(release, persisted.order);
assert.equal(repository.pending(), 0);

await assert.rejects(
  repository.update(() => {}, { expectedVersion: 19 }),
  (error) => error.code === 'STATE_VERSION_CONFLICT'
    && error.status === 409
    && error.retryable === true
    && error.expectedVersion === 19
    && error.actualVersion === 20,
);

await assert.rejects(repository.runExclusive(() => { throw new Error('expected failure'); }), /expected failure/);
await repository.update((state) => { state.counter += 1; });
assert.equal(persisted.counter, 21, 'a failed operation must not poison the repository queue');

const snapshot = await repository.read();
snapshot.counter = -1;
assert.equal(persisted.counter, 21, 'read returns an isolated snapshot');

console.log('[state-repository] serialization, version conflicts, recovery, and snapshot isolation passed');
