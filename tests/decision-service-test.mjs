import assert from 'node:assert/strict';
import { createDecisionService } from '../client-runtime/application/decision-service.mjs';
import { createDecisionRoutes } from '../client-runtime/server/decision-routes.mjs';

let state = { stateVersion: 4, stage: 'evidence', benchmark: { status: 'complete' }, knowledgeMaintenance: { status: 'idle' }, publishedAssets: [], knowledgeDrafts: [{}], decisionReview: { status: 'idle' } };
const calls = [];
const decisions = createDecisionService({
  loadState: async () => structuredClone(state),
  persistState: async (next) => next,
  executeCommand: async ({ type }) => { calls.push(type); return { status: 'applied', state: structuredClone(state), result: type === 'revert-adoption' ? { recovery: { checkpointId: 'cp-1' }, repositoryRevert: { commit: 'abc' } } : null }; },
  journal: {}, registry: {}, guardSupportedRuntimeAction: async () => {}, guardWorkflowTransition: () => {},
});

assert.equal((await decisions.adopt({ note: 'verified' })).status, 'applied');
assert.equal((await decisions.reject()).status, 'applied');
state = { ...state, stage: 'published' };
assert.equal((await decisions.revertAdoption()).status, 'applied');
assert.deepEqual(calls, ['adopt', 'reject', 'revert-adoption']);

state = { ...state, stage: 'evidence', benchmark: { status: 'idle' } };
await assert.rejects(() => decisions.adopt(), (error) => error.status === 409 && error.message === 'Full Benchmark 尚未完成。');
state = { ...state, benchmark: { status: 'complete' }, decisionReview: { status: 'awaiting_review' } };
await assert.rejects(() => decisions.adopt(), (error) => error.code === 'DECISION_REVIEW_PENDING');
state = { ...state, decisionReview: { resolution: { outcome: 'reverted' } } };
assert.equal((await decisions.revertAdoption()).status, 'skipped_idempotent');

const responses = [];
const routes = createDecisionRoutes({
  json: (_response, status, body) => responses.push({ status, body }),
  readJson: async () => ({ note: 'verified' }),
  decisions: { revertAdoption: async () => ({ status: 'applied', state: {}, result: { recovery: { checkpointId: 'cp-2' }, repositoryRevert: { commit: 'def' } } }) },
});
assert.equal(await routes({ request: { method: 'POST' }, response: {}, url: { pathname: '/api/actions/revert-adoption' } }), true);
assert.deepEqual(responses[0], { status: 200, body: { state: {}, recovery: { checkpointId: 'cp-2' }, repositoryRevert: { commit: 'def' } } });
console.log('[decision-service] adoption, rejection, reversal, idempotency, and route contracts passed');
