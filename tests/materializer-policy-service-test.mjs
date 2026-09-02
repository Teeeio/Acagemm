import assert from 'node:assert/strict';
import { createMaterializerPolicyService } from '../client-runtime/application/materializer-policy-service.mjs';
const service = createMaterializerPolicyService({ consumeWorkflowRecoveryBudget: () => ({ allowed: true, attempt: 1, component: 'baseline-materializer', limit: 1 }) });
const state = {};
assert.equal(service.inspect({ state, materializer: { status: 'running' } }).action, 'wait');
assert.equal(service.inspect({ state, materializer: {} }).action, 'materialize');
assert.equal(service.inspect({ state, materializer: { status: 'failed' } }).action, 'redirect');
assert.equal(service.inspect({ state, materializer: { status: 'completed', result: { runPy: 'x' } } }).action, 'continue');
console.log('[materializer-policy-service] state policy contracts passed');
