import assert from 'node:assert/strict';
import { createAutopilotStrictSourceService } from '../client-runtime/application/autopilot-strict-source-service.mjs';
const service = createAutopilotStrictSourceService({ isStrictZeroSourceMission: () => true, isResearchAgentActive: () => false, selectResearchBaselineSource: () => null, buildSemanticBaselineSource: () => null, startResearch: async ({ state }) => ({ ...state, started: true }), startBaseline: async ({ state }) => ({ ...state, baseline: { status: 'running' } }), startMainRound: async ({ state }) => ({ ...state, agentStarted: true }), researchDirForMission: () => '/r' });
const result = await service.advance({ state: { activeMissionId: 'm', researchAgent: {} }, mission: { id: 'm', goal: 'g' }, candidate: null });
assert.equal(result.action, 'baseline_research_started');
console.log('[autopilot-strict-source-service] strict source research contract passed');
