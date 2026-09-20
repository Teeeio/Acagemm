import assert from 'node:assert/strict';
import { createAutopilotCandidateBaselineService } from '../client-runtime/application/autopilot-candidate-baseline-service.mjs';
const service = createAutopilotCandidateBaselineService({ isManagedWorkspaceRuntimeMode: () => true, startBaseline: async ({ state }) => state, startResearch: async ({ state }) => ({ ...state, researched: true }), researchDirForMission: () => '/r', agentRuntime: { describe: async () => ({ mode: 'managed' }) }, appendRuntimeEvent: () => {}, addAuditEvent: () => {} });
const result = await service.advance({ state: { stage: 'candidate', agent: { status: 'awaiting_action' }, researchAgent: {}, activeMissionId: 'm' }, mission: { id: 'm', goal: 'g', sourcePolicy: { webResearchEnabled: true } } });
assert.equal(result.action, 'baseline_research_started');
assert.equal(result.state.researched, true);
// 缺省即关闭：没有开关时必须给显式状态，不能悄悄启动联网研究。
const disabled = await service.advance({ state: { stage: 'candidate', agent: { status: 'awaiting_action' }, researchAgent: {}, activeMissionId: 'm' }, mission: { id: 'm', goal: 'g' } });
assert.equal(disabled.action, 'needs_human');
assert.equal(disabled.state.iterationStats.loopStatusReason, 'research_disabled_source_unresolved');
assert.equal(disabled.state.researched, undefined);
console.log('[autopilot-candidate-baseline-service] baseline research contract passed');
