import assert from 'node:assert/strict';
import { createCandidateValidationService } from '../client-runtime/application/candidate-validation-service.mjs';
import { createCandidateValidationRoutes } from '../client-runtime/server/candidate-validation-routes.mjs';

const matrix = { environments: ['C500'], stages: ['correctness'] };
let state = { stateVersion: 7, stage: 'candidate', patchApplied: false, appliedCandidateId: null, testMatrix: matrix, agent: { currentAction: { type: 'candidate.plan' } }, decisionReview: { status: 'idle' } };
const calls = [];
const workflow = createCandidateValidationService({
  loadState: async () => structuredClone(state),
  persistState: async (next) => next,
  executeCommand: async ({ type }) => { calls.push(type); return { status: 'applied', state: structuredClone(state), result: type === 'apply-patch' ? { workspace: { path: 'mission' }, policyChecks: [] } : type === 'start-benchmark' ? { runId: 'run-1', taskId: 'task-1' } : { recovery: { checkpointId: 'cp-1' } } }; },
  journal: {}, registry: {}, guardSupportedRuntimeAction: async () => {}, guardWorkflowTransition: () => {},
});

assert.equal((await workflow.applyPatch({ candidate: 'candidate-1' })).status, 'applied');
await assert.rejects(() => workflow.applyPatch({}), (error) => error.code === 'CANDIDATE_MISMATCH');
state = { ...state, stage: 'validation', patchApplied: true, appliedCandidateId: 'candidate-1', agent: { currentAction: { type: 'test.plan' } } };
assert.equal((await workflow.startBenchmark({})).result.status, 'applied');
assert.equal((await workflow.rollbackStage()).status, 'applied');
assert.deepEqual(calls, ['apply-patch', 'start-benchmark', 'rollback-stage']);

state = { ...state, patchApplied: false };
assert.equal((await workflow.startBenchmark({})).payload.code, 'PATCH_REQUIRED_BEFORE_CANDIDATE_BENCHMARK');
state = { ...state, patchApplied: true, testMatrix: { environments: [], stages: [] } };
assert.equal((await workflow.startBenchmark({})).payload.code, 'TEST_MATRIX_INVALID');
state = { ...state, testMatrix: matrix, appliedCandidateId: null };
assert.equal((await workflow.startBenchmark({})).payload.code, 'TEST_CANDIDATE_MISSING');
state = { ...state, decisionReview: { status: 'awaiting_review' } };
await assert.rejects(() => workflow.rollbackStage(), (error) => error.code === 'DECISION_REVIEW_PENDING');

const responses = [];
const routes = createCandidateValidationRoutes({
  json: (_response, status, body) => responses.push({ status, body }),
  readJson: async () => ({}),
  workflow: { startBenchmark: async () => ({ result: { status: 'applied', state: {}, result: { runId: 'run-2', taskId: 'task-2' } } }) },
});
assert.equal(await routes({ request: { method: 'POST' }, response: {}, url: { pathname: '/api/actions/start-benchmark' } }), true);
assert.deepEqual(responses[0], { status: 202, body: { state: {}, runId: 'run-2', taskId: 'task-2' } });
console.log('[candidate-validation-service] patch, benchmark, rollback, validation, and route contracts passed');
