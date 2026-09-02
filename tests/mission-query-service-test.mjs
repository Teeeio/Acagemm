import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { createMissionQueryService } from '../client-runtime/application/mission-query-service.mjs';
import { createMissionQueryRoutes } from '../client-runtime/server/mission-query-routes.mjs';
import { createJsonResponder } from '../client-runtime/server/http.mjs';

const initial = { activeMissionId: 'MIS_1', missions: [{ id: 'MIS_1' }, { id: 'MIS_2' }], researchNotes: [{ id: 'NOTE_1' }], researchAgent: null, runtimeEvents: [{ missionId: 'MIS_1', sequence: 1, type: 'started' }, { missionId: 'MIS_2', sequence: 2, type: 'other' }] };
let saved;
const query = createMissionQueryService({ loadState: async () => structuredClone(initial), persistState: async (state) => { saved = structuredClone(state); return state; }, missionState: { selectMission(state, id) { state.activeMissionId = id; return state; } } });
assert.deepEqual((await query.events('MIS_1', 0)).events.map((event) => event.type), ['started']);
assert.equal((await query.events('MIS_1', 1)).nextSequence, 1);
await assert.rejects(query.select('missing'), (error) => error.code === 'MISSION_NOT_FOUND' && error.status === 404);
assert.equal((await query.select('MIS_2')).state.activeMissionId, 'MIS_2');
assert.equal(saved.activeMissionId, 'MIS_2');
const notes = await query.researchNotes('MIS_1');
assert.deepEqual(notes.notes, [{ id: 'NOTE_1' }]);
assert.equal(notes.researchAgent.status, 'idle');
await assert.rejects(query.researchNotes('missing'), (error) => error.code === 'MISSION_NOT_FOUND');

const recorder = () => ({ status: null, headers: null, body: '', writeHead(status, headers) { this.status = status; this.headers = headers; }, end(chunk = '') { this.body += String(chunk); } });
const request = (method) => Object.assign(Readable.from([]), { method });
const calls = [];
const routes = createMissionQueryRoutes({ json: createJsonResponder({ pid: 1, port: 2 }), missionQuery: { async select(id) { calls.push(['select', id]); return { state: {} }; }, async events(id, after) { calls.push(['events', id, after]); return { missionId: id, events: [], nextSequence: after }; }, async researchNotes(id) { calls.push(['notes', id]); return { missionId: id, notes: [] }; } }, streamEvents: async (...args) => calls.push(['stream', args[2], args[3]]) });
assert.equal(await routes({ request: request('POST'), response: recorder(), url: new URL('http://local/api/missions/MIS%20A/select') }), true);
assert.equal(await routes({ request: request('GET'), response: recorder(), url: new URL('http://local/api/missions/MIS%20A/events?after=7') }), true);
assert.equal(await routes({ request: request('GET'), response: recorder(), url: new URL('http://local/api/missions/MIS%20A/events/stream?after=8') }), true);
assert.equal(await routes({ request: request('GET'), response: recorder(), url: new URL('http://local/api/missions/MIS%20A/research/notes') }), true);
assert.deepEqual(calls, [['select', 'MIS A'], ['events', 'MIS A', 7], ['stream', 'MIS A', 8], ['notes', 'MIS A']]);
console.log('[mission-query-service] Mission selection, event cursor queries, and SSE route delegation passed');
