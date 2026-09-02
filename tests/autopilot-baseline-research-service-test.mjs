import assert from 'node:assert/strict';
import { createAutopilotBaselineResearchService } from '../client-runtime/application/autopilot-baseline-research-service.mjs';
const calls = [];
const service = createAutopilotBaselineResearchService({ isManagedWorkspaceRuntimeMode: () => true, isResearchAgentActive: () => false, startResearch: async ({ state }) => ({ ...state, started: true }), researchDirForMission: () => '/r', appendRuntimeEvent: (...x) => calls.push(x), addAuditEvent: (...x) => calls.push(x), agentRuntime: { describe: async () => ({ mode: 'managed' }) } });
const result = await service.advance({ state: { activeMissionId: 'm', researchAgent: {} }, mission: { id: 'm', goal: 'g' } });
assert.equal(result.action, 'baseline_research_started');
assert.equal(result.state.started, true);
console.log('[autopilot-baseline-research-service] research start contract passed');
