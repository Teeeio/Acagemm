import assert from 'node:assert/strict';
import { createReviewActionService } from '../client-runtime/application/review-action-service.mjs';
import { createReviewActionRoutes } from '../client-runtime/server/review-action-routes.mjs';

let state = { stateVersion: 1, stage: 'candidate', benchmark: { status: 'idle' }, decisionReview: { status: 'idle' } };
const calls = [];
const service = createReviewActionService({
  loadState: async () => structuredClone(state),
  persistState: async (next) => next,
  executeCommand: async ({ type }) => { calls.push(type); return { status: 'applied', state: { ...structuredClone(state), decisionReview: { status: type === 'request-review' ? 'awaiting_review' : 'idle' } } }; },
  journal: {}, registry: {}, guardSupportedRuntimeAction: async () => {}, guardWorkflowTransition: () => {},
});
assert.equal((await service.resume({})).status, 'applied');
assert.equal((await service.requestReview({ outcome: 'supplement' })).status, 'applied');
assert.equal((await service.cancelReview()).status, 'applied');
state = { ...state, decisionReview: { status: 'awaiting_review', request: { outcome: 'supplement' } } };
assert.equal((await service.resolveReview({ note: 'run more cases' })).outcome, 'supplement');
assert.deepEqual(calls, ['resume-mission', 'request-review', 'cancel-review', 'resolve-review']);

state = { ...state, decisionReview: { status: 'idle' } };
await assert.rejects(() => service.resolveReview({ outcome: 'supplement' }), (error) => error.code === 'DECISION_REVIEW_NOT_PENDING');
state = { ...state, decisionReview: { status: 'awaiting_review', request: { outcome: 'invalid' } } };
await assert.rejects(() => service.resolveReview({}), (error) => error.code === 'DECISION_REVIEW_OUTCOME_INVALID');
state = { ...state, decisionReview: { status: 'awaiting_review', request: { outcome: 'adopt' } } };
await assert.rejects(() => service.resolveReview({}), (error) => error.code === 'INTERVENTION_ADOPTION_UNAVAILABLE');

const responses = [];
const routes = createReviewActionRoutes({
  json: (_response, status, body) => responses.push({ status, body }),
  readJson: async () => ({ outcome: 'redirect', note: 'try another direction' }),
  actions: {
    resolveReview: async () => ({
      outcome: 'redirect',
      result: { status: 'applied', state: { decisionReview: { status: 'resolved' } }, result: { recovery: { checkpointId: 'cp-1' } } },
    }),
  },
});
assert.equal(await routes({ request: { method: 'POST' }, response: {}, url: { pathname: '/api/actions/resolve-review' } }), true);
assert.deepEqual(responses[0], { status: 200, body: { state: { decisionReview: { status: 'resolved' } }, review: { status: 'resolved' }, recovery: { checkpointId: 'cp-1' } } });
console.log('[review-action-service] resume and decision-review action contracts passed');
