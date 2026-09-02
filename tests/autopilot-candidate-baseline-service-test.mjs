import assert from 'node:assert/strict';
import { createAutopilotCandidateBaselineService } from '../client-runtime/application/autopilot-candidate-baseline-service.mjs';
const service = createAutopilotCandidateBaselineService({ isManagedWorkspaceRuntimeMode: () => true, startBaseline: async ({ state }) => state, startResearch: async ({ state }) => ({ ...state, researched: true }), researchDirForMission: () => '/r', agentRuntime: { describe: async () => ({ mode: 'managed' }) }, appendRuntimeEvent: () => {}, addAuditEvent: () => {} });
const result = await service.advance({ state: { stage: 'candidate', agent: { status: 'awaiting_action' }, researchAgent: {}, activeMissionId: 'm' }, mission: { id: 'm', goal: 'g' } });
assert.equal(result.action, 'baseline_research_started');
assert.equal(result.state.researched, true);
console.log('[autopilot-candidate-baseline-service] baseline research contract passed');
