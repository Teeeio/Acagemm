import assert from 'node:assert/strict';
import { createMainRoundOrchestrationService } from '../client-runtime/application/main-round-orchestration-service.mjs';

const calls = [];
const service = createMainRoundOrchestrationService({
  agentRuntime: { describe: async () => { calls.push('runtime'); return { mode: 'managed' }; } },
  preflight: { prepare: async ({ state }) => { calls.push('preflight'); return { state, mission: { id: 'm1' }, preflight: { workspace: { root: 'w' } } }; } },
  recovery: { restoreRejectedRound: async () => { calls.push('recovery'); return { candidateId: 'c1', checkpointId: 'cp1' }; } },
  artifactGuard: { assertReady: () => calls.push('guard') },
  agentRound: { startRound: async ({ state }) => { calls.push('launch'); return { ...state, launched: true }; } },
  appendRuntimeEvent: () => calls.push('event'),
  addAuditEvent: () => calls.push('audit'),
});

const result = await service.start({ state: {}, goal: 'optimize' });
assert.equal(result.launched, true);
assert.deepEqual(calls, ['runtime', 'preflight', 'recovery', 'guard', 'event', 'audit', 'launch']);
assert.equal(result.workflowRecovery.lastRecovery.type, 'round_rollback');

const blockedCalls = [];
const blockedState = {};
const blocked = createMainRoundOrchestrationService({
  agentRuntime: { describe: async () => ({ mode: 'managed' }) },
  preflight: { prepare: async () => ({ blocked: true }) },
  recovery: { restoreRejectedRound: async () => blockedCalls.push('recovery') },
  artifactGuard: { assertReady: () => blockedCalls.push('guard') },
  agentRound: { startRound: async () => blockedCalls.push('launch') },
  appendRuntimeEvent: () => {},
  addAuditEvent: () => {},
});
assert.equal(await blocked.start({ state: blockedState, goal: 'optimize' }), blockedState);
assert.deepEqual(blockedCalls, []);
console.log('[main-round-orchestration-service] launch and blocked contracts passed');
