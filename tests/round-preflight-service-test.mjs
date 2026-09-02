import assert from 'node:assert/strict';
import { createRoundPreflightService } from '../client-runtime/application/round-preflight-service.mjs';

const calls = [];
const service = createRoundPreflightService({ settleGenerationAttemptBeforeStart: (...args) => { calls.push(args); return { blocked: false }; }, buildRuntimePreflight: async () => ({ ready: true, workspace: '/w' }) });
const state = { activeMissionId: 'm', missions: [{ id: 'm', goal: 'g' }] };
const result = await service.prepare({ state, goal: 'g', retryMode: 'correctness' });
assert.equal(result.blocked, false);
assert.equal(result.mission.id, 'm');
assert.equal(result.preflight.workspace, '/w');
assert.equal(calls[0][2].retryMode, 'correctness');
const blocked = createRoundPreflightService({ settleGenerationAttemptBeforeStart: () => ({ blocked: true }), buildRuntimePreflight: async () => { throw new Error('must not call'); } });
assert.equal((await blocked.prepare({ state, goal: 'g' })).blocked, true);
console.log('[round-preflight-service] settlement, preflight, and blocked contracts passed');
