import assert from 'node:assert/strict';
import { createBenchmarkProjectionService } from '../client-runtime/application/benchmark-projection-service.mjs';
const state = { benchmark: { status: 'running', testTaskId: 't' }, missions: [], activeMissionId: 'm' };
const service = createBenchmarkProjectionService({ operatorTestQueue: { get: async () => ({ taskId: 't', status: 'complete', completedAt: 'now' }) }, testServiceClient: {}, applyOperatorTestSnapshot: (s) => { s.benchmark.status = 'complete'; s.benchmark.result = {}; }, artifactDirForMission: () => '/tmp/a', mkdir: async () => {}, writeFile: async () => {}, path: { join: (...x) => x.join('/') } });
assert.equal((await service.project({ state })).changed, true);
assert.equal(state.benchmark.status, 'complete');
for (const status of ['complete', 'failed', 'cancelled']) {
  let collections = 0;
  const value = { benchmark: { status: 'running', testTaskId: 't' }, missions: [{ id: 'm', projectId: 'p' }], activeMissionId: 'm' };
  const projection = createBenchmarkProjectionService({
    operatorTestQueue: { get: async () => ({ taskId: 't', status }) }, testServiceClient: {},
    applyOperatorTestSnapshot: (next) => { next.benchmark.status = status; },
    collectExperience: async ({ state, mission }) => {
      collections++;
      assert.equal(mission.projectId, 'p');
      assert.equal(state.benchmark.status, status);
      throw Object.assign(new Error('Experience store unavailable'), { code: 'ROUND_EXPERIENCE_TIMEOUT', effectUnknown: true });
    },
  });
  assert.equal((await projection.project({ state: value })).changed, true);
  assert.equal(value.benchmark.status, status, 'experience failure cannot alter the test outcome');
  assert.equal(value.iterationStats.experienceCollection.error.code, 'ROUND_EXPERIENCE_TIMEOUT');
  assert.equal(value.iterationStats.experienceCollection.error.effectUnknown, true);
  assert.equal(collections, 1);
  await projection.project({ state: value });
  assert.equal(collections, 1, 'reading an already-terminal task does not blindly repeat an uncertain write');
}
console.log('[benchmark-projection-service] queue projection and visible terminal experience failures passed');
