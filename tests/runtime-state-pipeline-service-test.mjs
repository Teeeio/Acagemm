import assert from 'node:assert/strict';
import { createRuntimeStatePipelineService } from '../client-runtime/application/runtime-state-pipeline-service.mjs';

const calls = [];
let processError = null;
let allowWork = true;
const service = createRuntimeStatePipelineService({
  maintenance: { advance: ({ state }) => { calls.push('maintenance'); return { state, changed: false }; } },
  processTests: async ({ allowStart = true } = {}) => { calls.push(allowStart ? 'process-tests' : 'poll-only'); if (processError) throw processError; },
  migrateState: (state) => { calls.push('migration'); state.step = 1; return { changed: true, recovery: {} }; },
  recordMigration: () => calls.push('record'),
  projectBaselineFailure: () => { calls.push('baseline'); return false; },
  runtimeProjection: { project: async ({ state }) => { calls.push('runtime'); state.step = 2; return { state, changed: false }; } },
  benchmarkProjection: { project: async ({ state }) => { calls.push('benchmark'); state.step = 3; return { state, changed: false }; } },
  repositoryAdoption: { adopt: async ({ state }) => { calls.push('adoption'); state.step = 4; return { state, changed: false }; } },
  runtimeAdvance: { canStartNewWork: () => allowWork, advance: async ({ state }) => { calls.push('advance'); state.step = 5; return { state, changed: false }; } },
});

const result = await service.advance({ state: {}, runtime: { mode: 'mock' } });
assert.deepEqual(calls, ['maintenance', 'migration', 'record', 'baseline', 'runtime', 'process-tests', 'benchmark', 'adoption', 'advance']);
assert.equal(result.state.step, 5);
assert.equal(result.changed, true);
processError = Object.assign(new Error('busy'), { code: 'OPERATOR_TEST_QUEUE_BUSY' });
await service.advance({ state: {}, runtime: { mode: 'mock' } });
assert.equal(calls.at(-1), 'advance', 'queue contention still allows persisted snapshot projection');
processError = new Error('storage unavailable');
await assert.rejects(service.advance({ state: {}, runtime: { mode: 'mock' } }), /storage unavailable/);
processError = null;
calls.length = 0;
allowWork = false;
await service.advance({ state: {}, runtime: { mode: 'mock' } });
assert.deepEqual(calls, ['migration', 'record', 'baseline', 'runtime', 'poll-only', 'benchmark', 'advance'], 'barrier must prevent maintenance adoption, new test dispatch and repository writes while still observing existing work');
calls.length = 0;
await service.advance({ state: { missionPaused: true, benchmark: { status: 'running', testTaskId: 'queue_existing' } }, runtime: { mode: 'mock' } });
assert.equal(calls.includes('process-tests'), true, 'a committed benchmark remains dispatchable while Mission workflow is paused');
assert.equal(calls.includes('adoption'), false, 'paused committed benchmark must not trigger adoption');
console.log('[runtime-state-pipeline-service] ordered advancement and queue contention contract passed');
