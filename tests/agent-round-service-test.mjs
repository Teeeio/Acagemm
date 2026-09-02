import assert from 'node:assert/strict';
import { createAgentRoundService } from '../client-runtime/application/agent-round-service.mjs';

const calls = [];
const service = createAgentRoundService({ resetMissionRunState: (...args) => calls.push(['reset', args]), resetMissionWorkspace: async (...args) => calls.push(['workspace', args]), createWorkspaceCheckpoint: async () => ({ id: 'cp' }), startAgentRun: (...args) => calls.push(['fallback', args]), appendRuntimeEvent: (...args) => calls.push(['event', args]), isManagedWorkspaceRuntimeMode: (mode) => mode === 'managed', agentRuntime: { startRun: async ({ state }) => ({ handled: true, state: { ...state, started: true } }) } });
const state = { activeMissionId: 'm', workflowRecovery: { checkpoints: [] } };
const result = await service.startRound({ state, mission: {}, goal: 'g', workspace: '/w', runtimeMode: 'managed' });
assert.equal(result.started, true);
assert.equal(state.workflowRecovery.checkpoints.length, 1);
console.log('[agent-round-service] managed Agent round start contract passed');
