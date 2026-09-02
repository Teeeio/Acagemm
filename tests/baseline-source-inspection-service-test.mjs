import assert from 'node:assert/strict';
import { createBaselineSourceInspectionService } from '../client-runtime/application/baseline-source-inspection-service.mjs';
const events = [];
const service = createBaselineSourceInspectionService({ inspectSources: async () => ({ ready: false, references: [], errors: ['missing'] }), appendRuntimeEvent: (...args) => events.push(args) });
const state = { activeMissionId: 'm' };
assert.equal((await service.inspect({ state, mission: { sourceRoot: '/s' }, baselineSource: {} })).valid, false);
assert.equal(state.iterationStats.loopStatusReason, 'baseline_source_unverified');
assert.equal(events.length, 1);
console.log('[baseline-source-inspection-service] invalid source contract passed');
