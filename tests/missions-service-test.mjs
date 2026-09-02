import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { createMissionsService } from '../client-runtime/application/missions-service.mjs';
import { createMissionRoutes } from '../client-runtime/server/mission-routes.mjs';
import { createJsonResponder, readJson } from '../client-runtime/server/http.mjs';

const state = {
  activeMissionId: 'MIS_1',
  missions: [{ id: 'MIS_1', goal: 'existing' }],
};
let persisted = null;
let workspaceCall = null;
const missions = createMissionsService({
  loadState: async () => structuredClone(state),
  persistState: async (next) => { persisted = structuredClone(next); return next; },
  ensureMissionWorkspace: async (...args) => { workspaceCall = args; },
  validateMissionBudgetInput: (input) => ({ ok: input.missionBudgetMs == null || input.missionBudgetMs === 0 || input.missionBudgetMs > 0 }),
  missionState: {
    createMission(current, input) {
      const mission = { id: 'MIS_2', ...input };
      current.missions.unshift(mission);
      current.activeMissionId = mission.id;
      return current;
    },
  },
});

assert.deepEqual(await missions.list(), { missions: state.missions, activeMissionId: 'MIS_1' });
await assert.rejects(missions.create({ title: 'Missing goal' }), (error) => error.code === 'MISSION_GOAL_REQUIRED' && error.status === 400);
await assert.rejects(missions.create({ goal: 'bad budget', missionBudgetMs: -1 }), (error) => error.code === 'INVALID_MISSION_BUDGET');
const created = await missions.create({ goal: 'optimize kernel', repository: 'repo', missionBudgetMs: 1000 });
assert.equal(created.state.activeMissionId, 'MIS_2');
assert.equal(persisted.activeMissionId, 'MIS_2');
assert.deepEqual(workspaceCall, ['MIS_2', 'repo', { projectRoot: undefined, sourceRoot: undefined }]);

const responseRecorder = () => ({
  status: null, headers: null, body: '',
  writeHead(status, headers) { this.status = status; this.headers = headers; },
  end(chunk = '') { this.body += String(chunk); this.writableEnded = true; },
});
const request = (method, body = '') => Object.assign(Readable.from(body ? [Buffer.from(body)] : []), { method });
const calls = [];
const routes = createMissionRoutes({
  json: createJsonResponder({ pid: 1, port: 2 }),
  readJson,
  missions: {
    async list() { calls.push(['list']); return { missions: [] }; },
    async create(input) { calls.push(['create', input]); return { state: {} }; },
  },
});
assert.equal(await routes({ request: request('GET'), response: responseRecorder(), url: new URL('http://local/api/missions') }), true);
const createResponse = responseRecorder();
assert.equal(await routes({ request: request('POST', '{"goal":"route goal"}'), response: createResponse, url: new URL('http://local/api/missions') }), true);
assert.equal(createResponse.status, 201);
assert.deepEqual(calls, [['list'], ['create', { goal: 'route goal' }]]);
assert.equal(await routes({ request: request('GET'), response: responseRecorder(), url: new URL('http://local/api/missions/MIS_1') }), false);

console.log('[missions-service] Mission list/create contracts, validation, workspace initialization, and route mapping passed');
