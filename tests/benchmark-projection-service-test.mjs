import assert from 'node:assert/strict';
import { createBenchmarkProjectionService } from '../client-runtime/application/benchmark-projection-service.mjs';
const state = { benchmark: { status: 'running', testTaskId: 't' }, missions: [], activeMissionId: 'm' };
const service = createBenchmarkProjectionService({ operatorTestQueue: { get: async () => ({ taskId: 't', status: 'complete', completedAt: 'now' }) }, testServiceClient: {}, applyOperatorTestSnapshot: (s) => { s.benchmark.status = 'complete'; s.benchmark.result = {}; }, artifactDirForMission: () => '/tmp/a', mkdir: async () => {}, writeFile: async () => {}, path: { join: (...x) => x.join('/') } });
assert.equal((await service.project({ state })).changed, true);
assert.equal(state.benchmark.status, 'complete');
console.log('[benchmark-projection-service] queue projection contract passed');
