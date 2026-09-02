import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { createSemanticService } from '../client-runtime/application/semantic-service.mjs';
import { createSemanticRoutes } from '../client-runtime/server/semantic-routes.mjs';
import { createJsonResponder, readJson } from '../client-runtime/server/http.mjs';

const state = { activeMissionId: 'MIS_1', missions: [{ id: 'MIS_1', title: 'Test operator', goal: 'optimize' }], runtimeEvents: [] };
let saved;
const service = createSemanticService({
  loadState: async () => structuredClone(state),
  persistState: async (next) => { saved = structuredClone(next); return next; },
  appendRuntimeEvent: (next, type, payload) => next.runtimeEvents.push({ type, ...payload }),
  addAuditEvent: (next, title) => { next.audit = title; },
});
const result = await service.freeze('MIS_1', { semanticDraft: { operator: 'test-op' } });
assert.equal(result.snapshot.status, 'frozen');
assert.equal(saved.missions[0].semanticSnapshot.status, 'frozen');
assert.equal(saved.runtimeEvents[0].type, 'semantic.snapshot_frozen');
assert.equal(saved.audit, '语义快照已冻结');
await assert.rejects(service.freeze('missing'), (error) => error.code === 'MISSION_NOT_FOUND');

const recorder = () => ({ status: null, headers: null, body: '', writeHead(status, headers) { this.status = status; this.headers = headers; }, end(chunk = '') { this.body += String(chunk); } });
const request = (body) => Object.assign(Readable.from([Buffer.from(body)]), { method: 'POST' });
const calls = [];
const routes = createSemanticRoutes({ json: createJsonResponder({ pid: 1, port: 2 }), readJson, semantic: { async freeze(id, input) { calls.push([id, input]); return { snapshot: { status: 'frozen' }, state: {} }; } } });
const response = recorder();
assert.equal(await routes({ request: request('{"semanticDraft":{"operator":"route-op"}}'), response, url: new URL('http://local/api/missions/MIS%201/semantic/freeze') }), true);
assert.equal(response.status, 200);
assert.deepEqual(calls, [['MIS 1', { semanticDraft: { operator: 'route-op' } }]]);
assert.equal(await routes({ request: request('{}'), response: recorder(), url: new URL('http://local/api/missions/MIS_1/semantic/other') }), false);
console.log('[semantic-service] semantic freeze projection, event/audit effects, errors, and route mapping passed');
