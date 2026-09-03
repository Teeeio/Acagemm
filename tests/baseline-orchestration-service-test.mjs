import assert from 'node:assert/strict';
import { createBaselineOrchestrationService } from '../client-runtime/application/baseline-orchestration-service.mjs';
const service = createBaselineOrchestrationService({ inferMissionMatrix: () => ({}), isFixedOperatorMission: () => false, isStrictZeroSourceMission: () => false, isResearchAgentActive: () => false, sourceService: { select: () => ({ source: { repository: 'r' }, semanticFallback: false }) }, sourceInspection: {}, materializerPolicy: {}, materializerRecovery: {}, materializerCommand: {}, benchmark: { start: async () => ({ started: true }) }, appendRuntimeEvent: () => {} });
assert.equal((await service.start({ state: {}, mission: {}, reason: '' })).started, true);
console.log('[baseline-orchestration-service] benchmark progression contract passed');
