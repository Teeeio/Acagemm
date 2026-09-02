import assert from 'node:assert/strict';
import { createBaselineService } from '../client-runtime/application/baseline-service.mjs';
import { createBaselineRoutes } from '../client-runtime/server/baseline-routes.mjs';

const state = { stateVersion: 9, stage: 'diagnosis', baseline: { materializer: { status: 'idle' } } };
const calls = [];
const transitions = [];
const baseline = createBaselineService({
  loadState: async () => structuredClone(state),
  persistState: async (next) => next,
  executeCommand: async (input) => {
    calls.push(input);
    return { status: 'applied', state: { ...structuredClone(state), baseline: { materializer: { status: 'running', runId: 'materializer-1' } } }, result: { runId: 'materializer-1' } };
  },
  journal: {}, registry: {}, guardMutation: () => {}, guardWorkflowTransition: (_state, transition) => transitions.push(transition),
});

const result = await baseline.materialize({ baselineSource: { repository: 'upstream' } });
assert.equal(result.result.runId, 'materializer-1');
assert.equal(calls[0].type, 'materialize-baseline');
assert.equal(calls[0].expectedVersion, 9);
assert.deepEqual(transitions[0], { stages: ['diagnosis', 'candidate', 'validation'], label: 'Baseline 单文件展开' });

const responses = [];
const routes = createBaselineRoutes({
  json: (_response, status, body) => responses.push({ status, body }),
  readJson: async () => ({ source: { repository: 'upstream' } }),
  baseline: { materialize: async () => result },
});
assert.equal(await routes({ request: { method: 'POST' }, response: {}, url: { pathname: '/api/actions/materialize-baseline' } }), true);
assert.deepEqual(responses[0], { status: 202, body: { state: result.state, materializer: result.state.baseline.materializer, runId: 'materializer-1' } });

const conflicts = [];
const conflictRoutes = createBaselineRoutes({ json: (_response, status, body) => conflicts.push({ status, body }), readJson: async () => ({}), baseline: { materialize: async () => ({ status: 'conflict' }) } });
await conflictRoutes({ request: { method: 'POST' }, response: {}, url: { pathname: '/api/actions/materialize-baseline' } });
assert.deepEqual(conflicts[0], { status: 409, body: { error: '状态已变更，请刷新后重试。', code: 'STATE_VERSION_CONFLICT', retryable: true } });
console.log('[baseline-service] materialization orchestration, guards, command, and route contracts passed');
