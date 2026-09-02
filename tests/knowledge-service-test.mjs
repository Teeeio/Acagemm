import assert from 'node:assert/strict';
import { createKnowledgeService } from '../client-runtime/application/knowledge-service.mjs';
import { createKnowledgeRoutes } from '../client-runtime/server/knowledge-routes.mjs';

let state = { activeMissionId: 'mission-1', knowledgeDrafts: [{ id: 'draft-1', title: 'Old' }], publishedAssets: [], knowledgeMaintenance: { changes: [] }, knowledgeReferences: [] };
const events = [];
const service = createKnowledgeService({ loadState: async () => structuredClone(state), persistState: async (next) => next, appendRuntimeEvent: (_state, type) => events.push(type), addAuditEvent: () => {}, now: () => new Date('2026-09-02T00:00:00.000Z') });
assert.equal((await service.patchDraft('missing', {})).statusCode, 404);
assert.equal((await service.patchDraft('draft-1', { title: 'New' })).state.knowledgeDrafts[0].title, 'New');
await assert.rejects(() => service.patchDraft('draft-1', { id: 'changed' }), (error) => error.code === 'KNOWLEDGE_PATCH_REJECTED');
state = { ...state, publishedAssets: [{ id: 'draft-1' }] };
await assert.rejects(() => service.patchDraft('draft-1', { title: 'New' }), (error) => error.code === 'KNOWLEDGE_IMMUTABLE');
state = { ...state, publishedAssets: [] };
assert.equal((await service.addReference({})).statusCode, 400);
const referenced = await service.addReference({ assetId: 'asset-1', title: 'Guide', version: 'v1' });
assert.equal(referenced.reference.missionId, 'mission-1');
assert.deepEqual(events, ['knowledge.referenced']);
assert.deepEqual(service.retiredPublish(true), {
  statusCode: 410,
  payload: {
    error: '批量手工发布接口已退役；知识由效果决策触发并按治理策略自动维护。',
    code: 'KNOWLEDGE_PUBLISH_RETIRED',
  },
});

const responses = [];
const routes = createKnowledgeRoutes({ json: (_response, status, body) => responses.push({ status, body }), readJson: async () => ({}), knowledge: service });
await routes({ request: { method: 'POST' }, response: {}, url: { pathname: '/api/knowledge/publish' } });
assert.equal(responses[0].status, 410);
console.log('[knowledge-service] draft, immutability, reference, retirement, and route contracts passed');
