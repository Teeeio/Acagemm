import assert from 'node:assert/strict';
import { projectBaselineFailure } from '../client-runtime/application/baseline-failure-projection.mjs';
const events = [];
const state = { benchmark: { purpose: 'baseline', status: 'failed', lastServiceError: { code: 'E' } }, runtimeEvents: [] };
assert.equal(projectBaselineFailure({ state, appendRuntimeEvent: (...args) => events.push(args) }), true);
assert.equal(state.baseline.status, 'failed');
assert.equal(projectBaselineFailure({ state, appendRuntimeEvent: (...args) => events.push(args) }), false);
assert.equal(events.length, 1);
console.log('[baseline-failure-projection] idempotent projection contract passed');
