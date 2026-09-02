import assert from 'node:assert/strict';
import { createBaselineBenchmarkService } from '../client-runtime/application/baseline-benchmark-service.mjs';
const calls = [];
const service = createBaselineBenchmarkService({ executeCommand: async (input) => { calls.push(input); return { state: { started: true } }; }, journal: {}, saveState: () => {}, registry: {} });
const state = { stateVersion: 2, baseline: { materializer: { result: { runPy: 'x' } } } };
assert.equal((await service.start({ state, mission: { operator: 'op' }, baselineSource: { repository: 'r' }, matrix: { warmup: 1, repeats: 2, correctnessCases: 3 }, strictZeroSource: true, fixedOperator: false })).started, true);
assert.equal(calls[0].body.purpose, 'baseline');
console.log('[baseline-benchmark-service] command contract passed');
