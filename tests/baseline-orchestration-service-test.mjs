import assert from 'node:assert/strict';
import { createBaselineOrchestrationService } from '../client-runtime/application/baseline-orchestration-service.mjs';
const calls = [];
const createService = ({ strict = false, policy = 'continue', activeResearch = false } = {}) => createBaselineOrchestrationService({
  inferMissionMatrix: () => ({ profile: 'fixed' }),
  isFixedOperatorMission: () => false,
  isStrictZeroSourceMission: () => strict,
  isResearchAgentActive: () => activeResearch,
  sourceService: { select: () => ({ source: { repository: 'r' }, semanticFallback: false }) },
  sourceInspection: { inspect: async () => ({ valid: true }) },
  materializerPolicy: { inspect: () => ({ action: policy }) },
  materializerRecovery: { recover: async ({ state }) => { calls.push('recover'); return { state: { ...state, recovered: true } }; } },
  materializerCommand: { start: async ({ state }) => { calls.push('materialize'); return { ...state, materializing: true }; } },
  benchmark: { start: async ({ state }) => { calls.push('benchmark'); return { ...state, benchmarkStarted: true }; } },
  appendRuntimeEvent: () => {},
});

assert.equal((await createService().start({ state: {}, mission: {}, reason: '' })).benchmarkStarted, true);
assert.deepEqual(calls.splice(0), ['benchmark']);
assert.equal((await createService({ strict: true, policy: 'materialize' }).start({ state: {}, mission: {}, reason: '' })).materializing, true);
assert.deepEqual(calls.splice(0), ['materialize']);
assert.equal((await createService({ strict: true, policy: 'recover' }).start({ state: {}, mission: {}, reason: '' })).recovered, true);
assert.deepEqual(calls.splice(0), ['recover']);
const waiting = { baseline: { materializer: { status: 'running' } } };
assert.equal(await createService({ strict: true, policy: 'wait' }).start({ state: waiting, mission: {}, reason: '' }), waiting);
assert.deepEqual(calls, []);
const researchState = {};
assert.equal(await createService({ activeResearch: true }).start({ state: researchState, mission: {}, reason: '' }), researchState);
console.log('[baseline-orchestration-service] branch progression contracts passed');
