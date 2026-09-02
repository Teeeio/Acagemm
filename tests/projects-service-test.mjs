import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import path from 'node:path';
import { createProjectsService } from '../client-runtime/application/projects-service.mjs';
import { createJsonResponder, readJson } from '../client-runtime/server/http.mjs';
import { createProjectRoutes } from '../client-runtime/server/project-routes.mjs';

const root = path.resolve('runtime', 'projects-service-contract');
const baseState = {
  activeProjectId: 'PRJ_1',
  activeMissionId: 'MIS_1',
  projects: [{
    id: 'PRJ_1',
    name: 'Kernel',
    root,
    repository: path.join(root, 'repository'),
    sourceRoot: path.join(root, 'sources'),
    runtimeRoot: path.join(root, '.operator-studio'),
    layout: 'three-layer',
    status: 'active',
  }],
  missions: [
    { id: 'MIS_1', projectId: 'PRJ_1', repository: path.join(root, 'repository'), projectRoot: root, status: 'running' },
    { id: 'MIS_2', projectId: 'PRJ_1', repository: path.join(root, 'repository'), projectRoot: root, status: 'ready' },
  ],
};

let persisted = null;
const layoutCalls = [];
const gitCalls = [];
const workspace = {
  async inspect(repository) { return { ready: true, gitRoot: repository, baselineEmpty: false }; },
  async inspectSources(sourceRoot) { return { ready: true, sources: [{ path: sourceRoot }] }; },
  async git(args, cwd) { gitCalls.push({ args, cwd }); },
  async bootstrapRepository() { throw new Error('not expected'); },
};
const filesystem = {
  async directoryExists() { return true; },
  async mkdir() {},
  async readFile() { return JSON.stringify({ schemaVersion: 1, sources: [{ id: 'SRC_1' }] }); },
};
const projectState = {
  createProject(state, input) {
    const project = { id: 'PRJ_2', name: input.name, ...input };
    state.projects.push(project);
    return project;
  },
  selectProject(state, projectId) {
    state.activeProjectId = projectId;
    return { project: state.projects.find((item) => item.id === projectId), selectedMission: state.missions[0] };
  },
  updateProject(state, projectId, input) {
    return Object.assign(state.projects.find((item) => item.id === projectId), input);
  },
  deleteProject(state, projectId) {
    const project = state.projects.find((item) => item.id === projectId);
    state.projects = state.projects.filter((item) => item.id !== projectId);
    return project;
  },
};
const projects = createProjectsService({
  loadState: async () => structuredClone(baseState),
  persistState: async (state) => { persisted = structuredClone(state); return state; },
  ensureProjectLayout: async (input) => {
    layoutCalls.push(input);
    return { runtimeRoot: path.join(input.root, '.operator-studio') };
  },
  workspace,
  filesystem,
  projectState,
});

const listed = await projects.list();
assert.equal(listed.activeProjectId, 'PRJ_1');
assert.equal(listed.projects[0].missionCount, 2);
assert.equal(listed.projects[0].runningMissionCount, 1);

await assert.rejects(
  projects.create({ root: 'relative/project' }),
  (error) => error.status === 400 && error.code === 'PROJECT_ROOT_NOT_ABSOLUTE',
);
const created = await projects.create({ root, name: 'New Project' });
assert.equal(created.project.id, 'PRJ_2');
assert.equal(created.project.layout, 'three-layer');
assert.equal(layoutCalls.length, 2);
assert.equal(gitCalls.length, 0);
assert.equal(persisted.projects.some((project) => project.id === 'PRJ_2'), true);

const sourceView = await projects.sources('PRJ_1');
assert.equal(sourceView.layout, 'three-layer');
assert.deepEqual(sourceView.registry.sources, [{ id: 'SRC_1' }]);
assert.match(sourceView.layers.activeSnapshot, /MIS_1/);
await assert.rejects(projects.sources('missing'), (error) => error.code === 'PROJECT_NOT_FOUND');

assert.equal((await projects.select('PRJ_1')).selectedMissionId, 'MIS_1');
assert.equal((await projects.update('PRJ_1', { name: 'Updated' })).project.name, 'Updated');
assert.equal((await projects.remove('PRJ_1')).project.id, 'PRJ_1');

const responseRecorder = () => ({
  headers: null,
  status: null,
  body: '',
  writeHead(status, headers) { this.status = status; this.headers = headers; },
  end(chunk = '') { this.body += String(chunk); this.writableEnded = true; },
});
const request = (method, body = '') => Object.assign(Readable.from(body ? [Buffer.from(body)] : []), { method });
const json = createJsonResponder({ pid: 1, port: 2 });
const routeCalls = [];
const routes = createProjectRoutes({
  json,
  readJson,
  projects: {
    async list() { routeCalls.push(['list']); return { projects: [], activeProjectId: null }; },
    async create(input) { routeCalls.push(['create', input]); return { state: {}, project: input }; },
    async sources(id) { routeCalls.push(['sources', id]); return { projectId: id }; },
    async select(id) { routeCalls.push(['select', id]); return { project: { id } }; },
    async update(id, input) { routeCalls.push(['update', id, input]); return { project: { id, ...input } }; },
    async remove(id) { routeCalls.push(['remove', id]); return { project: { id } }; },
    async bootstrap(id, input) { routeCalls.push(['bootstrap', id, input]); return { project: { id }, bootstrap: input }; },
    async reinitialize(id) { routeCalls.push(['reinitialize', id]); return { project: { id } }; },
  },
});

const createResponse = responseRecorder();
assert.equal(await routes({
  request: request('POST', '{"name":"Route Project"}'),
  response: createResponse,
  url: new URL('http://local/api/projects'),
}), true);
assert.equal(createResponse.status, 201);
assert.deepEqual(routeCalls.at(-1), ['create', { name: 'Route Project' }]);

const selectResponse = responseRecorder();
await routes({
  request: request('POST', '{}'),
  response: selectResponse,
  url: new URL('http://local/api/projects/PRJ%20A/select'),
});
assert.deepEqual(routeCalls.at(-1), ['select', 'PRJ A']);
assert.equal(await routes({
  request: request('POST', '{}'),
  response: responseRecorder(),
  url: new URL('http://local/api/projects/PRJ_1/bootstrap'),
}), true);
assert.deepEqual(routeCalls.at(-1), ['bootstrap', 'PRJ_1', {}]);
assert.equal(await routes({
  request: request('POST', '{}'),
  response: responseRecorder(),
  url: new URL('http://local/api/projects/PRJ_1/reinitialize'),
}), true);
assert.deepEqual(routeCalls.at(-1), ['reinitialize', 'PRJ_1']);

console.log('[projects-service] Project use cases, migration commands, injected ports, and route mapping passed');
