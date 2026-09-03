import assert from 'node:assert/strict';
import { createBaselineMaterializerRecoveryService } from '../client-runtime/application/baseline-materializer-recovery-service.mjs';
const service = createBaselineMaterializerRecoveryService({ consumeWorkflowRecoveryBudget: () => ({ allowed: true, attempt: 1, component: 'baseline-materializer', limit: 1 }), startResearch: async ({ state }) => ({ ...state, redirected: true }), researchDirForMission: () => '/r', appendRuntimeEvent: () => {} });
const result = await service.recover({ state: { activeMissionId: 'm' }, mission: { title: 'op' }, baselineSource: { repository: 'r', commit: 'c', path: 'p' }, materializer: { status: 'failed' } });
assert.equal(result.action, 'research_redirected');
assert.equal(result.state.redirected, true);
console.log('[baseline-materializer-recovery-service] redirect and recovery contract passed');
