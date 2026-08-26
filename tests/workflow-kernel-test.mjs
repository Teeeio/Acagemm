import assert from 'node:assert/strict';
import {
  WORKFLOW_OUTCOME,
  assertWorkflowInvariants,
  collectWorkflowInvariantViolations,
  consumeWorkflowRecoveryBudget,
  deriveWorkflowEffect,
  normalizeExternalOutcome,
  reconcileWorkflowState,
  workflowEffectId,
} from '../client-runtime/workflow-kernel.mjs';

const baseState = () => ({
  activeMissionId: 'MIS_KERNEL',
  stage: 'candidate',
  missionPaused: false,
  baseline: { status: 'complete' },
  benchmark: { status: 'idle' },
  agent: { status: 'awaiting_action', runId: null },
  researchAgent: { status: 'idle', runId: null },
  knowledgeMaintenance: { status: 'idle' },
  currentBest: { candidateId: null, verified: false },
  decisionReview: { gate: null },
  iterationStats: { round: 1, loopStatus: 'running', loopStatusReason: null },
});

assert.equal(normalizeExternalOutcome({ status: 'completed' }).kind, WORKFLOW_OUTCOME.COMPLETED);
assert.equal(normalizeExternalOutcome({ status: 'running' }).kind, WORKFLOW_OUTCOME.IN_PROGRESS);
assert.equal(normalizeExternalOutcome({ status: 'cancelled' }).kind, WORKFLOW_OUTCOME.CANCELLED);
assert.equal(normalizeExternalOutcome({ status: 'failed', error: { code: 'SERVICE_UNAVAILABLE', status: 503 } }).kind, WORKFLOW_OUTCOME.RETRYABLE_FAILURE);
assert.equal(normalizeExternalOutcome({ status: 'failed', error: { code: 'ARTIFACT_INVALID', status: 422 } }).kind, WORKFLOW_OUTCOME.TERMINAL_FAILURE);

const effectA = workflowEffectId({ missionId: 'MIS_KERNEL', type: 'operator-test', round: 2, subject: 'candidate-02' });
const effectB = workflowEffectId({ missionId: 'MIS_KERNEL', type: 'operator-test', round: 2, subject: 'candidate-02' });
const effectC = workflowEffectId({ missionId: 'MIS_KERNEL', type: 'operator-test', round: 3, subject: 'candidate-02' });
assert.equal(effectA, effectB);
assert.notEqual(effectA, effectC);

const recoveryState = {};
assert.deepEqual(consumeWorkflowRecoveryBudget(recoveryState, { component: 'materializer', limit: 1 }), { allowed: true, attempt: 1, limit: 1, component: 'materializer' });
assert.deepEqual(consumeWorkflowRecoveryBudget(recoveryState, { component: 'materializer', limit: 1 }), { allowed: false, attempt: 1, limit: 1, component: 'materializer' });

const active = baseState();
active.patchApplied = true;
active.appliedCandidateId = 'candidate-01';
active.benchmark = { status: 'running', purpose: 'candidate', runId: 'run_1', testTaskId: 'queue_1', candidate: { id: 'candidate-01' } };
assert.equal(collectWorkflowInvariantViolations(active).length, 0);
assert.equal(deriveWorkflowEffect(active).type, 'operator-test');
assert.doesNotThrow(() => assertWorkflowInvariants(active));

const invalid = structuredClone(active);
invalid.baseline.status = 'missing';
invalid.benchmark.testTaskId = null;
invalid.currentBest = { candidateId: 'candidate-01', verified: true };
invalid.benchmark.result = { environment: { liveHardware: false } };
const violationCodes = collectWorkflowInvariantViolations(invalid).map((item) => item.code).sort();
assert.deepEqual(violationCodes, [
  'WORKFLOW_BASELINE_REQUIRED',
  'WORKFLOW_BENCHMARK_ORPHANED',
  'WORKFLOW_SIMULATION_PUBLISH_FORBIDDEN',
]);
assert.throws(() => assertWorkflowInvariants(invalid), { code: 'WORKFLOW_INVARIANT_VIOLATION' });

const fixedNow = '2026-08-26T00:00:00.000Z';
const reconciled = reconcileWorkflowState(invalid, { now: fixedNow });
assert.equal(reconciled.state.missionPaused, true);
assert.equal(reconciled.state.iterationStats.loopStatus, 'needs_human');
assert.equal(reconciled.state.workflowKernel.status, 'blocked');
const reconciledAgain = reconcileWorkflowState(reconciled.state, { now: fixedNow });
assert.equal(reconciledAgain.changed, false, 'reconcile must be idempotent');

const terminal = baseState();
terminal.stage = 'published';
terminal.agent = { status: 'completed', runId: 'agent_done' };
terminal.knowledgeMaintenance = { status: 'completed' };
const terminalResult = reconcileWorkflowState(terminal, { now: fixedNow });
assert.equal(terminalResult.state.iterationStats.loopStatus, 'completed');
assert.equal(terminalResult.state.workflowKernel.status, 'completed');
assert.equal(terminalResult.effect, null);

// Property probe: arbitrary snapshots either stay valid or converge to one stable blocked state.
let seed = 0x5eed1234;
const random = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 0x1_0000_0000);
const choices = (items) => items[Math.floor(random() * items.length)];
for (let index = 0; index < 500; index += 1) {
  const state = baseState();
  state.baseline.status = choices(['missing', 'running', 'complete']);
  state.patchApplied = random() > 0.5;
  state.appliedCandidateId = random() > 0.5 ? 'candidate-01' : null;
  state.benchmark = {
    status: choices(['idle', 'running', 'complete', 'failed']),
    purpose: choices(['baseline', 'candidate']),
    runId: random() > 0.5 ? 'run_random' : null,
    testTaskId: random() > 0.5 ? 'task_random' : null,
    candidate: { id: random() > 0.5 ? 'candidate-01' : 'candidate-02' },
  };
  const first = reconcileWorkflowState(state, { now: fixedNow });
  const snapshot = JSON.stringify(first.state);
  const second = reconcileWorkflowState(first.state, { now: fixedNow });
  assert.equal(JSON.stringify(second.state), snapshot);
  assert.equal(second.changed, false);
  if (first.violations.length) assert.equal(first.state.iterationStats.loopStatus, 'needs_human');
}

console.log('[workflow-kernel] outcomes, invariants, effects, and idempotent reconciliation passed');
