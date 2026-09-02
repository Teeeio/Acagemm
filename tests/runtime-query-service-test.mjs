import assert from 'node:assert/strict';
import { createRuntimeQueryService } from '../client-runtime/application/runtime-query-service.mjs';
import { createRuntimeQueryRoutes } from '../client-runtime/server/runtime-query-routes.mjs';

const state = {
  activeMissionId: 'mission-1',
  missions: [{ id: 'mission-1', repository: 'kernels', sourceRoot: 'sources', projectRoot: 'project' }],
  patchApplied: true,
  candidateEvaluations: [{ files: 'kernel.py' }],
};
let sourceContent = false;
let simulation = false;
const workspaceInspection = { ready: true, baselineEmpty: true, code: 'WORKSPACE_READY' };
const service = createRuntimeQueryService({
  loadState: async () => structuredClone(state),
  ensureMissionWorkspace: async (missionId) => `C:/runtime/${missionId}`,
  inspectWorkspace: async () => workspaceInspection,
  inspectSources: async () => ({ ready: false, sources: [] }),
  preflightAgent: async () => ({ ready: true, code: 'AGENT_RUNTIME_READY' }),
  inspectSourceContent: async () => sourceContent,
  artifactDirForMission: (missionId) => `C:/artifacts/${missionId}`,
  isStrictZeroSourceMission: () => false,
  isSimulationRuntime: () => simulation,
  presentWorkspacePath: (workspace) => workspace.replace('C:/runtime/', 'runtime/'),
  workspaceFiles: ['kernel.py'],
  now: () => new Date('2026-09-02T00:00:00.000Z'),
});

const blocked = (await service.preflight()).payload.preflight;
assert.equal(blocked.ready, false);
assert.equal(blocked.workspaceCheck.code, 'WORKSPACE_BASELINE_EMPTY');
assert.equal(workspaceInspection.ready, true, 'cached workspace inspection must not be mutated');
sourceContent = true;
assert.equal((await service.buildPreflight(state.missions[0])).ready, true);
sourceContent = false;
simulation = true;
assert.equal((await service.buildPreflight(state.missions[0])).ready, true);
assert.deepEqual(await service.workspace(), { patchApplied: true, workspace: 'runtime/mission-1', files: ['kernel.py'] });
assert.equal((await service.preflight('missing')).statusCode, 404);
assert.deepEqual(await service.getState(), { state });

const calls = [];
const routes = createRuntimeQueryRoutes({
  json: (_response, status, body) => calls.push({ status, body }),
  runtimeQuery: {
    preflight: async (id) => ({ statusCode: 200, payload: { id } }),
    getState: async () => ({ state: {} }),
    workspace: async () => ({ workspace: 'runtime/mission-1' }),
  },
});
assert.equal(await routes({ request: { method: 'GET' }, response: {}, url: new URL('http://local/api/runtime/preflight?missionId=mission%201') }), true);
assert.equal(await routes({ request: { method: 'GET' }, response: {}, url: new URL('http://local/api/state') }), true);
assert.equal(await routes({ request: { method: 'GET' }, response: {}, url: new URL('http://local/api/workspace') }), true);
assert.equal(await routes({ request: { method: 'POST' }, response: {}, url: new URL('http://local/api/state') }), false);
assert.deepEqual(calls.map((call) => call.status), [200, 200, 200]);
assert.equal(calls[0].body.id, 'mission 1');

console.log('[runtime-query-service] preflight, state, workspace, simulation, and route contracts passed');
