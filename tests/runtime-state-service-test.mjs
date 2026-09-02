import assert from 'node:assert/strict';
import { createRuntimeStateService } from '../client-runtime/application/runtime-state-service.mjs';
import { createRuntimeStateRoutes } from '../client-runtime/server/runtime-state-routes.mjs';

let state = { testMatrix: { environments: ['C500'], stages: ['Correctness'] }, missionPaused: true, missionBudgetMs: 1000, missionBudgetStartedAt: 'old', workspace: 'old', unreadCount: 2 };
const service = createRuntimeStateService({ loadState: async () => structuredClone(state), persistState: async (next) => { state = next; return next; }, resumeMissionState: (next) => { next.missionPaused = false; next.resumedBy = 'local-c500-tui'; }, normalizeMissionBudgetMs: (input) => { const value = Number(input.missionBudgetMs || input.timeBudgetMs || 0); return value > 0 ? value : null; } });
assert.equal((await service.patch({ testMatrix: { environments: [], stages: ['Correctness'] } })).statusCode, 400);
assert.equal((await service.patch({ missionBudgetMs: -1 })).payload.code, 'INVALID_MISSION_BUDGET');
const resumed = await service.patch({ missionPaused: false, missionBudgetMs: 0, unreadCount: 1 });
assert.equal(resumed.statusCode, 200);
assert.equal(resumed.payload.state.missionPaused, false);
assert.equal(resumed.payload.state.missionBudgetStartedAt, null);
assert.equal(resumed.payload.state.resumedBy, 'local-c500-tui');
const calls = [];
const routes = createRuntimeStateRoutes({ json: (_response, status, body) => calls.push({ status, body }), readJson: async () => ({ unreadCount: 0 }), runtimeState: { patch: async (body) => ({ statusCode: 200, payload: { body } }) } });
assert.equal(await routes({ request: { method: 'PATCH' }, response: {}, url: new URL('http://local/api/state') }), true);
assert.equal(calls[0].body.body.unreadCount, 0);
console.log('[runtime-state-service] matrix, budget, pause/resume, and route contracts passed');
