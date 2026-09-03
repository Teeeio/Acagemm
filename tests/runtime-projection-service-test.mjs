import assert from 'node:assert/strict';
import { createRuntimeProjectionService } from '../client-runtime/application/runtime-projection-service.mjs';
const calls = [];
const service = createRuntimeProjectionService({ reconcileWorkflowState: (state) => { calls.push('reconcile'); return { state: { ...state, reconciled: true }, changed: true }; }, projectState: async (state) => { calls.push('project'); return { state: { ...state, projected: true }, changed: false }; } });
const result = await service.project({ state: {}, runtime: { mode: 'managed' } });
assert.deepEqual(calls, ['reconcile', 'project']);
assert.equal(result.state.projected, true);
assert.equal(result.changed, true);
console.log('[runtime-projection-service] ordering and projection contract passed');
