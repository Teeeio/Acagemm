import assert from 'node:assert/strict';
import { createBaselineMaterializerRecoveryService } from '../client-runtime/application/baseline-materializer-recovery-service.mjs';
const service = createBaselineMaterializerRecoveryService({ consumeWorkflowRecoveryBudget: () => ({ allowed: true, attempt: 1, component: 'baseline-materializer', limit: 1 }), startResearch: async ({ state }) => ({ ...state, redirected: true }), researchDirForMission: () => '/r', appendRuntimeEvent: () => {} });
const result = await service.recover({ state: { activeMissionId: 'm' }, mission: { title: 'op', sourcePolicy: { webResearchEnabled: true } }, baselineSource: { repository: 'r', commit: 'c', path: 'p' }, materializer: { status: 'failed' } });
assert.equal(result.action, 'research_redirected');
assert.equal(result.state.redirected, true);
// 缺省即关闭：没有开关时改选也必须停成显式状态，不能悄悄启动联网研究。
const disabled = await service.recover({ state: { activeMissionId: 'm' }, mission: { title: 'op' }, baselineSource: { repository: 'r', commit: 'c', path: 'p' }, materializer: { status: 'failed' } });
assert.equal(disabled.action, 'needs_human');
assert.equal(disabled.state.iterationStats.loopStatusReason, 'research_disabled_source_unresolved');
assert.equal(disabled.state.redirected, undefined);
console.log('[baseline-materializer-recovery-service] redirect and recovery contract passed');
