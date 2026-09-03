import assert from 'node:assert/strict';
import { createAutopilotService } from '../client-runtime/application/autopilot-service.mjs';
const service = createAutopilotService({ contextService: { prepare: () => ({ enabled: false }) }, fixedProfileService: {}, strictSourceService: {}, candidateBaselineService: {}, candidateActionService: {}, validationService: {}, iteration: {}, isFixedOperatorMission: () => false, isStrictZeroSourceMission: () => false, runtimeMode: () => 'reference-fixture' });
assert.deepEqual(await service.advance({ id: 'state' }), { state: { id: 'state' }, action: 'none' });
console.log('[autopilot-service] application boundary contract passed');
