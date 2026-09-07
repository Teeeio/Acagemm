import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { createResearchService } from '../client-runtime/application/research-service.mjs';
import { createResearchRoutes } from '../client-runtime/server/research-routes.mjs';
import { createJsonResponder, readJson } from '../client-runtime/server/http.mjs';

const base = { activeMissionId: 'MIS_1', missions: [{ id: 'MIS_1' }, { id: 'MIS_2' }] };
let saved;
const selections = [];
const service = createResearchService({ missionState: { selectMission(state, id) { selections.push(id); state.activeMissionId = id; return state; } }, loadState: async () => structuredClone(base), persistState: async (state) => { saved = structuredClone(state); return state; }, executeCommand: async ({ state }) => ({ status: 'applied', state, result: { runId: 'RUN_1' } }), journal: {}, registry: {}, agentRuntime: { async cancelRun({ state }) { state.researchAgent = { status: 'cancel_requested' }; return { state, result: { runId: 'RUN_1' } }; } } });
const started = await service.start('MIS_1', { direction: 'investigate' });
assert.equal(started.status, 'applied');
assert.equal((await service.start('MIS_2', {})).state.activeMissionId, 'MIS_2');
assert.deepEqual(selections, ['MIS_2']);
await assert.rejects(service.start('missing', {}), (error) => error.code === 'MISSION_NOT_FOUND');
const cancelled = await service.cancel('MIS_1', 'RUN_1');
assert.equal(cancelled.result.runId, 'RUN_1');
await assert.rejects(service.cancel('MIS_2', 'RUN_1'), (error) => error.code === 'AGENT_MISSION_MISMATCH');

const recorder = () => ({ status: null, headers: null, body: '', writeHead(status, headers) { this.status = status; this.headers = headers; }, end(chunk = '') { this.body += String(chunk); } });
const request = (method, body = '') => Object.assign(Readable.from(body ? [Buffer.from(body)] : []), { method });
const calls = [];
const routes = createResearchRoutes({ json: createJsonResponder({ pid: 1, port: 2 }), readJson, research: { async start(id, body) { calls.push(['start', id, body]); return { status: 'applied', state: { researchAgent: {} } }; }, async cancel(id, runId) { calls.push(['cancel', id, runId]); return { state: {}, result: {} }; } } });
assert.equal(await routes({ request: request('POST', '{"direction":"x"}'), response: recorder(), url: new URL('http://local/api/missions/MIS%201/research') }), true);
assert.equal(await routes({ request: request('POST'), response: recorder(), url: new URL('http://local/api/missions/MIS%201/research/RUN%202/cancel') }), true);
assert.deepEqual(calls, [['start', 'MIS 1', { direction: 'x' }], ['cancel', 'MIS 1', 'RUN 2']]);
console.log('[research-service] research start/cancel commands, mismatch guards, and route mapping passed');
