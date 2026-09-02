import assert from 'node:assert/strict';
import { createAutopilotCandidateActionService } from '../client-runtime/application/autopilot-candidate-action-service.mjs';
const calls = [];
const service = createAutopilotCandidateActionService({ executeCommand: async (input) => { calls.push(input); return { state: { applied: true } }; }, journal: {}, saveState: () => {}, registry: {} });
assert.equal((await service.applyCandidate({ state: { stateVersion: 1 }, candidateId: 'c' })).applied, true);
assert.equal(calls[0].body.candidate, 'c');
assert.match((await service.resumeCandidate({ state: {}, mission: { goal: 'g' }, startMainRound: async ({ goal }) => ({ goal }) })).goal, /系统恢复/);
console.log('[autopilot-candidate-action-service] patch and recovery contracts passed');
