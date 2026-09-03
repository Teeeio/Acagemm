import assert from 'node:assert/strict';
import { createRuntimeAdvanceService } from '../client-runtime/application/runtime-advance-service.mjs';
const calls = [];
const service = createRuntimeAdvanceService({ autopilot: { advance: async (state) => { calls.push('autopilot'); return { state, action: 'none' }; } }, advanceIteration: async (state) => { calls.push('iteration'); return { state, action: 'round_counted' }; }, iteration: {}, reconcileWorkflowState: (state) => { calls.push('reconcile'); return { state, changed: false }; } });
const result = await service.advance({ state: {} });
assert.deepEqual(calls, ['autopilot', 'iteration', 'reconcile']);
assert.equal(result.changed, true);
console.log('[runtime-advance-service] ordered progression contract passed');
