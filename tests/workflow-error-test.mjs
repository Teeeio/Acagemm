import assert from 'node:assert/strict';
import {
  WORKFLOW_ERROR_CATEGORY,
  WORKFLOW_STOP_POLICY,
  assertWorkflowError,
  deriveRecoveryAction,
  deriveStopPolicy,
  normalizeWorkflowError,
  serializeWorkflowError,
} from '../client-runtime/workflow-error.mjs';

const cases = [
  [{ code: 'TOKEN_BUDGET_EXHAUSTED', message: 'tokens exhausted', phase: 'candidate' }, WORKFLOW_ERROR_CATEGORY.BUDGET, WORKFLOW_STOP_POLICY.BUDGET, false],
  [{ code: 'STOPPED_BY_USER', message: 'manual stop', phase: 'candidate' }, WORKFLOW_ERROR_CATEGORY.USER_CANCEL, WORKFLOW_STOP_POLICY.USER_CANCEL, false],
  [{ code: 'REMOTE_TEST_TIMEOUT', message: 'queue timed out', phase: 'operator-test.poll' }, WORKFLOW_ERROR_CATEGORY.TIMEOUT, WORKFLOW_STOP_POLICY.RETRY, true],
  [{ code: 'REMOTE_UNAVAILABLE', message: 'backend unavailable', statusCode: 503, phase: 'operator-test.submit' }, WORKFLOW_ERROR_CATEGORY.DEPENDENCY, WORKFLOW_STOP_POLICY.RETRY, true],
  [{ code: 'CORRECTNESS_BOUNDARY_MISMATCH', message: 'fixed case failed', phase: 'candidate.correctness' }, WORKFLOW_ERROR_CATEGORY.VALIDATION, WORKFLOW_STOP_POLICY.CONTINUE, false],
  [{ code: 'WORKFLOW_INVARIANT_VIOLATION', message: 'state mismatch', phase: 'workflow' }, WORKFLOW_ERROR_CATEGORY.INVARIANT, WORKFLOW_STOP_POLICY.NEEDS_HUMAN, false],
  [{ code: 'OPERATOR_PATH_REQUIRED', message: 'path missing', phase: 'initializing' }, WORKFLOW_ERROR_CATEGORY.CONFIGURATION, WORKFLOW_STOP_POLICY.NEEDS_HUMAN, false],
  [{ code: 'SOMETHING_UNEXPECTED', message: 'unknown internal error', phase: 'candidate' }, WORKFLOW_ERROR_CATEGORY.INTERNAL, WORKFLOW_STOP_POLICY.NEEDS_HUMAN, false],
];

for (const [input, category, stopPolicy, retryable] of cases) {
  const normalized = normalizeWorkflowError(input, { source: 'test' });
  assert.equal(normalized.category, category, input.code);
  assert.equal(normalized.stopPolicy, stopPolicy, input.code);
  assert.equal(normalized.retryable, retryable, input.code);
  assert.equal(normalized.terminal, stopPolicy !== WORKFLOW_STOP_POLICY.RETRY, input.code);
  assert.equal(normalized.source, 'test');
  assert.equal(normalized.phase, input.phase);
  assert.ok(normalized.action.length > 0);
  assert.deepEqual(serializeWorkflowError(normalized), normalized);
  assert.deepEqual(assertWorkflowError(normalized), normalized);
}

const statusError = normalizeWorkflowError({ status: 'failed', statusCode: 503, code: 'BACKEND_FAILED', message: 'server error' });
assert.equal(statusError.status, 503);
assert.equal(statusError.retryable, true);
assert.equal(statusError.stopPolicy, WORKFLOW_STOP_POLICY.RETRY);
const nested = normalizeWorkflowError({ error: { code: 'POLL_FAILED', message: 'poll failed', httpStatus: 504 }, phase: 'operator-test.poll' });
assert.equal(nested.status, 504);
assert.equal(nested.category, WORKFLOW_ERROR_CATEGORY.DEPENDENCY);
assert.equal(nested.retryable, true);
const explicit = normalizeWorkflowError({ code: 'CUSTOM', message: 'explicit category', category: WORKFLOW_ERROR_CATEGORY.VALIDATION, retryable: false }, { phase: 'candidate.correctness' });
assert.equal(explicit.category, WORKFLOW_ERROR_CATEGORY.VALIDATION);
assert.equal(explicit.stopPolicy, WORKFLOW_STOP_POLICY.CONTINUE);

assert.equal(deriveStopPolicy({ category: WORKFLOW_ERROR_CATEGORY.BUDGET, retryable: true }), WORKFLOW_STOP_POLICY.BUDGET);
assert.equal(deriveStopPolicy({ category: WORKFLOW_ERROR_CATEGORY.USER_CANCEL, retryable: true }), WORKFLOW_STOP_POLICY.USER_CANCEL);
assert.match(deriveRecoveryAction({ category: WORKFLOW_ERROR_CATEGORY.INVARIANT }), /workflow_state/);
assert.match(deriveRecoveryAction({ category: WORKFLOW_ERROR_CATEGORY.TIMEOUT }), /测试队列/);

for (const malformed of [null, {}, { code: '', message: '' }]) {
  const normalized = assertWorkflowError(malformed);
  assert.ok(normalized.code);
  assert.ok(normalized.message);
}

console.log('[workflow-error] unified classification, retry policy, status normalization, serialization and recovery actions passed');
