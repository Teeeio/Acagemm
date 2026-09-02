import assert from 'node:assert/strict';
import { createBaselineSourceService } from '../client-runtime/application/baseline-source-service.mjs';
const service = createBaselineSourceService({ isFixedOperatorMission: () => false, isStrictZeroSourceMission: () => false, selectResearchBaselineSource: () => null, buildSemanticBaselineSource: () => ({ kind: 'semantic' }), inferAuthoritativeBaselineSource: () => ({ kind: 'authoritative' }), isSemanticBaselineSource: (s) => s.kind === 'semantic' });
assert.equal(service.select({ state: {}, mission: {} }).source.kind, 'authoritative');
console.log('[baseline-source-service] source selection contract passed');
