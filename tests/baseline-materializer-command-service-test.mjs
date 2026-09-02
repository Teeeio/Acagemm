import assert from 'node:assert/strict';
import { createBaselineMaterializerCommandService } from '../client-runtime/application/baseline-materializer-command-service.mjs';
const calls = [];
const service = createBaselineMaterializerCommandService({ executeCommand: async (input) => { calls.push(input); return { state: { materializing: true } }; }, journal: {}, saveState: () => {}, registry: {} });
assert.equal((await service.start({ state: { stateVersion: 4 }, baselineSource: { repository: 'r' }, matrix: {} })).materializing, true);
assert.equal(calls[0].type, 'materialize-baseline');
console.log('[baseline-materializer-command-service] command contract passed');
