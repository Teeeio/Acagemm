import { createHash } from 'node:crypto';
import { normalizeWorkflowError } from './workflow-error.mjs';

export const WORKFLOW_OUTCOME = Object.freeze({
  COMPLETED: 'completed',
  IN_PROGRESS: 'in_progress',
  RETRYABLE_FAILURE: 'retryable_failure',
  TERMINAL_FAILURE: 'terminal_failure',
  CANCELLED: 'cancelled',
});

const ACTIVE_STATUSES = new Set(['waiting', 'queued', 'running', 'executing', 'cancel_requested']);
const COMPLETED_STATUSES = new Set(['complete', 'completed', 'succeeded', 'success']);
const CANCELLED_STATUSES = new Set(['cancelled', 'canceled']);
const FAILURE_STATUSES = new Set(['failed', 'error', 'timed_out', 'timeout']);
const errorView = (input = {}) => {
  return normalizeWorkflowError(input, { source: 'workflow-kernel', code: 'EXTERNAL_FAILURE' });
};

export function normalizeExternalOutcome(input = {}) {
  const status = String(input?.status || '').trim().toLowerCase();
  if (COMPLETED_STATUSES.has(status)) return { kind: WORKFLOW_OUTCOME.COMPLETED, terminal: true, retryable: false, error: null };
  if (ACTIVE_STATUSES.has(status)) return { kind: WORKFLOW_OUTCOME.IN_PROGRESS, terminal: false, retryable: false, error: null };
  if (CANCELLED_STATUSES.has(status)) return { kind: WORKFLOW_OUTCOME.CANCELLED, terminal: true, retryable: false, error: errorView(input) };

  const error = errorView(input);
  const retryableHttp = error.status === 408 || error.status === 425 || error.status === 429 || Number(error.status) >= 500;
  const retryable = error.retryable || retryableHttp;
  if (FAILURE_STATUSES.has(status) || input?.error || input instanceof Error) {
    return {
      kind: retryable ? WORKFLOW_OUTCOME.RETRYABLE_FAILURE : WORKFLOW_OUTCOME.TERMINAL_FAILURE,
      terminal: !retryable,
      retryable,
      error,
    };
  }
  return {
    kind: WORKFLOW_OUTCOME.TERMINAL_FAILURE,
    terminal: true,
    retryable: false,
    error: { ...error, code: error.code === 'EXTERNAL_FAILURE' ? 'EXTERNAL_OUTCOME_INVALID' : error.code },
  };
}

export function workflowEffectId({ missionId, type, round = 0, subject = '', revision = '' } = {}) {
  const identity = [missionId || 'mission', type || 'effect', Number(round) || 0, subject || '-', revision || '-'].join(':');
  return `effect_${createHash('sha256').update(identity).digest('hex').slice(0, 24)}`;
}

export function consumeWorkflowRecoveryBudget(state = {}, { component, limit = 1 } = {}) {
  if (!component) throw new Error('Workflow recovery budget requires a component.');
  const attempts = { ...(state.workflowKernel?.recoveryAttempts || {}) };
  const used = Number(attempts[component] || 0);
  const allowed = used < Math.max(0, Number(limit) || 0);
  if (allowed) attempts[component] = used + 1;
  state.workflowKernel = { ...(state.workflowKernel || {}), schemaVersion: 1, recoveryAttempts: attempts };
  return { allowed, attempt: allowed ? used + 1 : used, limit: Math.max(0, Number(limit) || 0), component };
}

export function deriveWorkflowEffect(state = {}) {
  const missionId = state.activeMissionId || null;
  const round = Number(state.iterationStats?.round || 0);
  if (!missionId || state.missionPaused || ['completed', 'needs_human', 'blocked'].includes(state.iterationStats?.loopStatus)) return null;
  const candidates = [
    ['operator-test', state.benchmark, state.benchmark?.testTaskId || state.benchmark?.runId],
    ['materializer', state.baseline?.materializer, state.baseline?.materializer?.runId],
    ['iteration-agent', state.agent, state.agent?.runId],
    ['research-agent', state.researchAgent, state.researchAgent?.runId],
  ];
  const active = candidates.find(([, value]) => ACTIVE_STATUSES.has(String(value?.status || '').toLowerCase()));
  if (!active) return null;
  return {
    id: workflowEffectId({ missionId, type: active[0], round, subject: active[2] || state.stage }),
    type: active[0],
    subject: active[2] || null,
    status: String(active[1]?.status || 'in_progress'),
  };
}

export function collectWorkflowInvariantViolations(state = {}) {
  const violations = [];
  const push = (code, detail) => violations.push({ code, detail });
  const benchmark = state.benchmark || {};
  const baseline = state.baseline || {};
  const gate = state.decisionReview?.gate || null;
  const gateLiveHardware = gate?.liveHardware === true || gate?.evidenceSource === 'live';
  const currentBestLiveHardware = state.currentBest?.liveHardware === true || state.currentBest?.evidenceSource === 'live';
  const terminal = state.stage === 'published' && state.knowledgeMaintenance?.status === 'completed';

  if (benchmark.status === 'running' && (!benchmark.runId || !benchmark.testTaskId)) {
    push('WORKFLOW_BENCHMARK_ORPHANED', 'Running benchmark requires both runId and testTaskId.');
  }
  if (benchmark.purpose === 'candidate' && ['running', 'complete', 'completed'].includes(benchmark.status) && baseline.status !== 'complete') {
    push('WORKFLOW_BASELINE_REQUIRED', 'Candidate evidence cannot exist before a complete baseline.');
  }
  if (state.patchApplied === true && !state.appliedCandidateId) {
    push('WORKFLOW_APPLIED_CANDIDATE_MISSING', 'patchApplied requires appliedCandidateId.');
  }
  if (benchmark.purpose === 'candidate' && benchmark.candidate?.id && state.appliedCandidateId && benchmark.candidate.id !== state.appliedCandidateId) {
    push('WORKFLOW_CANDIDATE_EVIDENCE_MISMATCH', 'Benchmark candidate must match the applied candidate.');
  }
  if ((gate?.publishable === true && !gateLiveHardware)
    || (state.currentBest?.verified === true && !currentBestLiveHardware)) {
    push('WORKFLOW_SIMULATION_PUBLISH_FORBIDDEN', 'Simulation evidence cannot be marked publishable or verified.');
  }
  if (terminal && deriveWorkflowEffect({ ...state, missionPaused: false, iterationStats: { ...(state.iterationStats || {}), loopStatus: 'running' } })) {
    push('WORKFLOW_TERMINAL_EFFECT_ACTIVE', 'A completed Mission cannot retain an active effect.');
  }
  return violations;
}

export function assertWorkflowInvariants(state = {}) {
  const violations = collectWorkflowInvariantViolations(state);
  if (!violations.length) return state;
  const error = new Error(`Workflow invariant violation: ${violations.map((item) => item.code).join(', ')}`);
  error.code = 'WORKFLOW_INVARIANT_VIOLATION';
  error.details = violations;
  throw error;
}

export function reconcileWorkflowState(state = {}, { now = new Date().toISOString() } = {}) {
  const next = state;
  const before = JSON.stringify({ workflowKernel: next.workflowKernel || null, iterationStats: next.iterationStats || null, missionPaused: next.missionPaused === true });
  const violations = collectWorkflowInvariantViolations(next);
  const recoveredInvariantBlock = violations.length === 0
    && next.iterationStats?.loopStatus === 'needs_human'
    && String(next.iterationStats?.loopStatusReason || '').startsWith('workflow_invariant:')
    && next.workflowKernel?.status === 'blocked';
  if (recoveredInvariantBlock) {
    next.missionPaused = false;
    next.iterationStats = { ...next.iterationStats, loopStatus: 'running', loopStatusReason: null };
  }
  const fingerprint = violations.length
    ? createHash('sha256').update(violations.map((item) => item.code).sort().join(':')).digest('hex').slice(0, 16)
    : null;
  const terminal = next.stage === 'published' && next.knowledgeMaintenance?.status === 'completed';

  if (terminal) {
    next.iterationStats = { ...(next.iterationStats || {}), loopStatus: 'completed', loopStatusReason: next.iterationStats?.loopStatusReason || 'mission_completed' };
  }
  if (violations.length) {
    next.missionPaused = true;
    next.iterationStats = { ...(next.iterationStats || {}), loopStatus: 'needs_human', loopStatusReason: `workflow_invariant:${violations.map((item) => item.code).join(',')}` };
  }

  const previous = next.workflowKernel || {};
  next.workflowKernel = {
    schemaVersion: 1,
    recoveryAttempts: { ...(previous.recoveryAttempts || {}) },
    status: violations.length ? 'blocked' : terminal ? 'completed' : deriveWorkflowEffect(next) ? 'active' : 'ready',
    effect: deriveWorkflowEffect(next),
    violationFingerprint: fingerprint,
    violations,
    reconciledAt: previous.violationFingerprint === fingerprint && previous.status === (violations.length ? 'blocked' : terminal ? 'completed' : deriveWorkflowEffect(next) ? 'active' : 'ready')
      ? previous.reconciledAt || now
      : now,
  };
  const after = JSON.stringify({ workflowKernel: next.workflowKernel || null, iterationStats: next.iterationStats || null, missionPaused: next.missionPaused === true });
  return { state: next, changed: before !== after, violations, effect: next.workflowKernel.effect };
}
