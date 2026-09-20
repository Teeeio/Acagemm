import assert from 'node:assert/strict';
import { createAutopilotStrictSourceService } from '../client-runtime/application/autopilot-strict-source-service.mjs';
const service = createAutopilotStrictSourceService({ isStrictZeroSourceMission: () => true, isResearchAgentActive: () => false, selectResearchBaselineSource: () => null, buildSemanticBaselineSource: () => null, startResearch: async ({ state }) => ({ ...state, started: true }), startBaseline: async ({ state }) => ({ ...state, baseline: { status: 'running' } }), startMainRound: async ({ state }) => ({ ...state, agentStarted: true }), researchDirForMission: () => '/r' });
// 自动联网研究默认关闭，所以这个 fixture 必须显式开启，否则测的就不是"来源解析会启动研究"。
const enabled = { id: 'm', goal: 'g', sourcePolicy: { webResearchEnabled: true } };
const result = await service.advance({ state: { activeMissionId: 'm', researchAgent: {} }, mission: enabled, candidate: null });
assert.equal(result.action, 'baseline_research_started');
// 缺省（无 sourcePolicy）必须走显式状态而不是隐式开启研究——默认关闭是行为改变，不是文档措辞。
const disabled = await service.advance({ state: { activeMissionId: 'm', researchAgent: {} }, mission: { id: 'm', goal: 'g' }, candidate: null });
assert.equal(disabled.action, 'needs_human', 'a mission without the switch must not silently start web research');
assert.equal(disabled.state.iterationStats.loopStatusReason, 'research_disabled_source_unresolved');
assert.equal(disabled.state.started, undefined, 'the disabled path must not have invoked startResearch');
console.log('[autopilot-strict-source-service] strict source research contract passed');
