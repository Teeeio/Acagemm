import assert from 'node:assert/strict';
import { createRuntimeAdvanceService } from '../client-runtime/application/runtime-advance-service.mjs';
const calls = [];
const service = createRuntimeAdvanceService({ autopilot: { advance: async (state) => { calls.push('autopilot'); return { state, action: 'none' }; } }, advanceIteration: async (state) => { calls.push('iteration'); return { state, action: 'round_counted' }; }, iteration: {}, reconcileWorkflowState: (state) => { calls.push('reconcile'); return { state, changed: false }; } });
const result = await service.advance({ state: {} });
assert.deepEqual(calls, ['autopilot', 'iteration', 'reconcile']);
assert.equal(result.changed, true);

const quarantinedCalls = [];
const quarantinedService = createRuntimeAdvanceService({
  autopilot: { advance: async () => { quarantinedCalls.push('autopilot'); throw new Error('must not start new work'); } },
  advanceIteration: async (state) => { quarantinedCalls.push('iteration'); state.markedNeedsHuman = true; return { state, action: 'needs_human', changed: true }; },
  iteration: {},
  reconcileWorkflowState: (state) => { quarantinedCalls.push('reconcile'); return { state, changed: false }; },
});
const quarantined = await quarantinedService.advance({ state: {
  agent: { runId: 'codex_ORPHAN', status: 'cancel_requested', resourceRelease: { confirmed: false, status: 'unconfirmed', quarantined: true } },
} });
assert.deepEqual(quarantinedCalls, ['iteration', 'reconcile']);
assert.equal(quarantined.actions.iteration, 'needs_human');
assert.equal(quarantined.state.markedNeedsHuman, true);
console.log('[runtime-advance-service] ordered progression contract passed');
