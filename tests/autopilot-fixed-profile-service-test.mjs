import assert from 'node:assert/strict';
import { createAutopilotFixedProfileService } from '../client-runtime/application/autopilot-fixed-profile-service.mjs';
const service = createAutopilotFixedProfileService({ isResearchAgentActive: () => false, startResearch: async ({ state }) => state, startMainRound: async ({ state }) => ({ ...state, started: true }), researchDirForMission: () => '/r', appendRuntimeEvent: () => {} });
const result = await service.advance({ state: { baseline: { status: 'complete' }, researchAgent: {}, agent: { status: 'idle' } }, mission: { goal: 'g' } });
assert.equal(result.action, 'candidate_agent_started');
assert.equal(result.state.started, true);
console.log('[autopilot-fixed-profile-service] fixed profile advance contract passed');
