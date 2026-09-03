import assert from 'node:assert/strict';
import { createRuntimeStatePipelineService } from '../client-runtime/application/runtime-state-pipeline-service.mjs';

const calls = [];
const service = createRuntimeStatePipelineService({
  migrateState: (state) => { calls.push('migration'); state.step = 1; return { changed: true, recovery: {} }; },
  recordMigration: () => calls.push('record'),
  projectBaselineFailure: () => { calls.push('baseline'); return false; },
  runtimeProjection: { project: async ({ state }) => { calls.push('runtime'); state.step = 2; return { state, changed: false }; } },
  benchmarkProjection: { project: async ({ state }) => { calls.push('benchmark'); state.step = 3; return { state, changed: false }; } },
  repositoryAdoption: { adopt: async ({ state }) => { calls.push('adoption'); state.step = 4; return { state, changed: false }; } },
  runtimeAdvance: { advance: async ({ state }) => { calls.push('advance'); state.step = 5; return { state, changed: false }; } },
});

const result = await service.project({ state: {}, runtime: { mode: 'mock' } });
assert.deepEqual(calls, ['migration', 'record', 'baseline', 'runtime', 'benchmark', 'adoption', 'advance']);
assert.equal(result.state.step, 5);
assert.equal(result.changed, true);
console.log('[runtime-state-pipeline-service] ordered projection contract passed');
