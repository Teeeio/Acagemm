import assert from 'node:assert/strict';
import { createExperienceApiService } from '../client-runtime/application/experience-api-service.mjs';
import { createExperienceService } from '../client-runtime/application/experience-service.mjs';
import { emptyExperienceStore } from '../client-runtime/experience-contract.mjs';
import { createExperienceRoutes } from '../client-runtime/server/experience-routes.mjs';

const state = { projects: [{ id: 'project-a' }, { id: 'project-b' }] };
let store = emptyExperienceStore();
let writes = 0;
let ids = 0;
const experiences = createExperienceService({
  repository: {
    read: async () => structuredClone(store),
    transact: async (mutate) => {
      const draft = structuredClone(store);
      const outcome = mutate(draft);
      if (outcome.changed) { store = draft; writes++; }
      return outcome.result;
    },
  },
  now: () => '2026-09-07T00:00:00.000Z',
  createId: () => 'experience-' + (++ids),
});
const api = createExperienceApiService({ loadState: async () => structuredClone(state), experiences });
assert.throws(() => createExperienceApiService({}), TypeError);
assert.deepEqual((await api.list('project-a')).payload.experiences, []);
assert.equal(writes, 0);
await assert.rejects(api.list('foreign-project'), { code: 'EXPERIENCE_PROJECT_NOT_FOUND', status: 404 });
const guidance = { title: 'Tail handling', content: 'Check the final partial block.', author: 'engineer', scope: { operator: 'vector_add' } };
for (const key of ['projectId', 'allowedProjectIds', 'evidence', 'verification', 'source', 'kind']) {
  await assert.rejects(api.create('project-a', { ...guidance, [key]: 'forged' }), { code: 'EXPERIENCE_INVALID' });
}
const created = await api.create('project-a', guidance);
assert.equal(created.statusCode, 201);
const id = created.payload.experience.id;
assert.equal(created.payload.experience.verification.publishable, false);
assert.equal(created.payload.experience.source, 'human');
assert.equal((await api.list('project-b')).payload.experiences.length, 0);
await assert.rejects(api.get('project-b', id), { code: 'EXPERIENCE_NOT_FOUND' });
await assert.rejects(api.update('project-a', id, { content: 'No version' }), { code: 'EXPERIENCE_INVALID' });
const updated = await api.update('project-a', id, { content: 'Keep the remainder path.', expectedVersion: 1 });
assert.equal(updated.payload.experience.version, 2);
assert.equal((await api.get('project-a', id, { version: 1 })).payload.experience.content, guidance.content);
await assert.rejects(api.update('project-a', id, { content: 'stale', expectedVersion: 1 }), (error) => error.status === 409);
const responses = [];
let body = guidance;
const routes = createExperienceRoutes({ json: (_response, status, payload) => responses.push({ status, payload }), readJson: async () => body, experiences: api });
const route = (method, pathname) => routes({ request: { method }, response: {}, url: new URL(pathname, 'http://localhost') });
assert.equal(await route('GET', '/api/projects/project-a/experiences'), true);
assert.equal(responses.at(-1).payload.experiences.length, 1);
await route('GET', '/api/projects/project-a/experiences/' + id + '?version=1');
assert.equal(responses.at(-1).payload.experience.version, 1);
await route('POST', '/api/projects/project-b/experiences');
assert.equal(responses.at(-1).status, 201);
body = { expectedVersion: 2, status: 'archived' };
await route('PATCH', '/api/projects/project-a/experiences/' + id);
assert.equal(responses.at(-1).payload.experience.status, 'archived');
assert.equal(await route('DELETE', '/api/projects/project-a/experiences/' + id), false);
assert.equal(await route('POST', '/api/experiences/observations'), false);
assert.equal(await route('GET', '/api/other'), false);
assert.deepEqual(state, { projects: [{ id: 'project-a' }, { id: 'project-b' }] });
console.log('[experience-api-service] local project scope, human-only writes, history, conflicts and route mapping passed');
