import assert from 'node:assert/strict';
import { createAutopilotValidationService } from '../client-runtime/application/autopilot-validation-service.mjs';
const calls = [];
const service = createAutopilotValidationService({ inferMissionMatrix: () => ({ environments: ['C500'] }), executeCommand: async (input) => { calls.push(input); return { state: { tested: true } }; }, journal: {}, saveState: () => {}, registry: {} });
const state = { appliedCandidateId: 'c', stateVersion: 3, testMatrix: {} };
assert.equal((await service.startCandidateTest({ state, mission: {} })).tested, true);
assert.equal(calls[0].body.candidate, 'c');
console.log('[autopilot-validation-service] candidate benchmark contract passed');
