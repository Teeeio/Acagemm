import { normalizeWorkflowError, serializeWorkflowError } from '../workflow-error.mjs';

// Pure projection of an unresolved Baseline source research into an actionable
// workflow error. The helper never resolves a source, never mutates its inputs
// and never changes the workflow decision: the calling service keeps returning
// its existing `needs_human` action. It only preserves the exact failed research
// identity, the original error and the frozen source constraints so a human can
// act on the failure instead of re-discovering it.
const TERMINAL_STATUSES = Object.freeze(['completed', 'failed', 'cancelled', 'timed_out']);

// Only the STATUS overrides the category. A `failed` research keeps its original
// classification (or the existing normalization inference), never a blanket one.
const categoryForStatus = (status) => {
  if (status === 'cancelled') return 'user_cancel';
  if (status === 'timed_out') return 'timeout';
  if (status === 'completed') return 'configuration';
  return null;
};

const text = (value) => (value == null || value === '' ? null : value);

export const buildBaselineSourceFailure = ({ state = {}, mission = null, now = () => new Date().toISOString() } = {}) => {
  const active = mission || {};
  const research = state.researchAgent || {};
  const status = research.status;
  const originalError = research.error ?? null;
  const error = originalError?.error && typeof originalError.error === 'object' ? originalError.error : originalError;
  const runId = text(research.runId);
  const missionId = text(research.missionId) || text(state.activeMissionId) || text(active.id) || null;
  const previous = state.workflowFailure;
  const sameIdentity = Boolean(runId)
    && previous?.phase === 'baseline.source'
    && previous.details?.missionId === missionId
    && previous.details?.runId === runId
    && previous.details?.startedAt === (text(research.startedAt))
    && previous.details?.researchStatus === status
    && previous.details?.runPhase === (text(research.runPhase));
  const statusCategory = categoryForStatus(status);
  // A completed research that produced no source is a configuration outcome;
  // cancelled/timed_out keep their own classification even when the original
  // error claims something else. `failed` always keeps the real original fields.
  const code = error?.code || originalError?.code || 'BASELINE_SOURCE_UNRESOLVED';
  const NO_SOURCE_MESSAGE = 'No verifiable baseline source was resolved by research; an explicit human decision is required.';
  const message = error?.message || originalError?.message || NO_SOURCE_MESSAGE;
  // Spelling out every normalized field keeps a nested `retryable: true` on the
  // original error from overriding the frozen non-retrying classification.
  const normalizedInput = {
    code,
    message,
    category: statusCategory || error?.category || originalError?.category || undefined,
    statusCode: error?.statusCode ?? originalError?.statusCode,
    httpStatus: error?.httpStatus ?? originalError?.httpStatus,
    status: error?.status ?? originalError?.status,
    retryable: false,
    occurredAt: research.completedAt || (sameIdentity ? previous.occurredAt : null) || now(),
    source: 'baseline-source',
    details: {
      missionId,
      runId,
      threadId: text(research.threadId),
      startedAt: text(research.startedAt),
      researchStatus: status ?? null,
      runPhase: text(research.runPhase),
      researchDir: text(research.researchDir),
      researchTerminal: TERMINAL_STATUSES.includes(status),
      // The FULL original error object is preserved verbatim, including a nested
      // `error` object some runtimes attach.
      originalError: structuredClone(originalError),
      sourceConstraints: structuredClone({
        sourcePolicy: active.sourcePolicy || null,
        baselineSource: active.baseline?.source || null,
        upstreamBaselineSource: active.upstream?.baselineSource || null,
        upstreamReference: active.upstream?.reference || null,
        rejectedSources: state.baseline?.rejectedSources || [],
      }),
    },
  };
  return serializeWorkflowError(normalizeWorkflowError(normalizedInput, {
    phase: 'baseline.source',
    source: 'baseline-source',
    occurredAt: normalizedInput.occurredAt,
    details: normalizedInput.details,
  }));
};

export const BASELINE_SOURCE_FAILURE_UNRESOLVED_MESSAGE = 'No verifiable baseline source was resolved by research; an explicit human decision is required.';
