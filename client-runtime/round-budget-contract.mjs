// Pure persisted round-clock contract. No provider, filesystem or timer effects.
export const ROUND_BUDGET_MS = 15 * 60 * 1000;
const fail = (code, message, details = {}) => Object.assign(new Error(message), { code, status: 409, retryable: false, details });
const clockValue = (nowMs) => {
  if (!Number.isFinite(nowMs) || !Number.isFinite(new Date(nowMs).getTime())) throw fail('ROUND_BUDGET_CLOCK_INVALID', 'Round budget requires a finite timestamp.');
  return nowMs;
};
const roundNumberFor = (state) => {
  const completed = Number(state.iterationStats?.round || 0);
  if (!Number.isSafeInteger(completed) || completed < 0) throw fail('ROUND_BUDGET_STATE_INVALID', 'Completed round count must be a non-negative integer.');
  return completed + 1;
};
const identity = (state, number) => String(state.activeMissionId || '') + ':round:' + number;

const inspectBudget = (state = {}, { nowMs = Date.now() } = {}, projectMissionCompletion = false) => {
  clockValue(nowMs);
  const budget = state.iterationStats?.roundBudget;
  if (budget == null) return { status: 'untracked', tracked: false, expired: false, elapsedMs: 0, remainingMs: null };
  const started = typeof budget.startedAt === 'string' && budget.startedAt ? Date.parse(budget.startedAt) : NaN;
  const deadline = started + ROUND_BUDGET_MS;
  if (!Number.isFinite(started) || !Number.isSafeInteger(budget.roundNumber) || budget.roundNumber < 1
    || budget.roundId !== identity(state, budget.roundNumber) || budget.budgetMs !== ROUND_BUDGET_MS
    || Date.parse(budget.deadlineAt) !== deadline || !['active', 'completed', 'expired'].includes(budget.status)) {
    return { ...budget, status: 'invalid', tracked: true, expired: false, code: 'ROUND_BUDGET_STATE_INVALID',
      reason: 'Round budget identity or timing metadata is invalid; its deadline must not be silently replaced.',
      nextAction: 'Inspect the recorded round metadata before starting more work.' };
  }
  const elapsedMs = Math.max(0, nowMs - started);
  const completed = budget.status === 'completed'
    || (projectMissionCompletion && state.stage === 'published' && state.knowledgeMaintenance?.status === 'completed');
  const expired = !completed && (budget.status === 'expired' || nowMs >= deadline);
  return { ...budget, status: completed ? 'completed' : expired ? 'expired' : 'active',
    tracked: true, expired, elapsedMs, remainingMs: Math.max(0, ROUND_BUDGET_MS - elapsedMs) };
};

export const inspectRoundBudget = (state = {}, options = {}) => inspectBudget(state, options, true);

export const ensureRoundBudgetStarted = (state = {}, { nowMs = Date.now(), allowSettledRestart = false, completedRoundId = null } = {}) => {
  clockValue(nowMs);
  if (!state.activeMissionId) throw fail('ROUND_BUDGET_MISSION_REQUIRED', 'A Mission identity is required before starting a round.');
  let number = roundNumberFor(state);
  // Start admission validates the frozen clock itself. The containing snapshot may
  // still describe the previously published round while a new intent is prepared.
  const previous = inspectBudget(state, { nowMs });
  if (previous.status === 'invalid') throw fail(previous.code, previous.reason, previous);
  if (previous.tracked) {
    if (previous.expired || state.iterationStats.roundBudget.status === 'expired') throw fail('ROUND_BUDGET_EXCEEDED', 'This round exhausted its 15-minute wall-clock budget; resuming or retrying cannot reset it.', previous);
    // Budget identity is independent of legacy evidence/performance counters.
    // Neither failed-attempt accounting nor an explicit run renews an active clock.
    if (previous.status === 'active') return { state, changed: false, roundBudget: state.iterationStats.roundBudget };
    const settledRestart = allowSettledRestart === true && previous.status === 'completed'
      && state.stage === 'published' && state.knowledgeMaintenance?.status === 'completed';
    const evidenceRestart = previous.status === 'completed' && completedRoundId === previous.roundId;
    if (!settledRestart && !evidenceRestart) throw fail('ROUND_BUDGET_ALREADY_COMPLETED', 'A settled round requires explicit completed-evidence admission or a new run after completed publication.', previous);
    number = Math.max(number, previous.roundNumber + 1);
  }
  if (!Number.isSafeInteger(number) || number < 1) throw fail('ROUND_BUDGET_STATE_INVALID', 'The next round identity is outside the supported integer range.');
  if (!Number.isFinite(new Date(nowMs + ROUND_BUDGET_MS).getTime())) throw fail('ROUND_BUDGET_CLOCK_INVALID', 'Round deadline is outside the supported clock range.');
  const roundBudget = { roundId: identity(state, number), roundNumber: number, startedAt: new Date(nowMs).toISOString(),
    deadlineAt: new Date(nowMs + ROUND_BUDGET_MS).toISOString(), budgetMs: ROUND_BUDGET_MS, status: 'active' };
  state.iterationStats = { ...(state.iterationStats || {}), roundBudget };
  return { state, changed: true, roundBudget };
};

export const completeRoundBudget = (state = {}, { nowMs = Date.now() } = {}) => {
  const budget = inspectRoundBudget(state, { nowMs });
  const previous = state.iterationStats?.roundBudget;
  if (!previous || previous.status !== 'active' || budget.status === 'invalid' || budget.expired) return { state, changed: false };
  state.iterationStats = { ...state.iterationStats, roundBudget: { ...previous, status: 'completed',
    completedAt: new Date(nowMs).toISOString(), elapsedMs: budget.elapsedMs } };
  return { state, changed: true, roundBudget: state.iterationStats.roundBudget };
};

export const expireRoundBudget = (state = {}, { nowMs = Date.now() } = {}) => {
  const budget = inspectRoundBudget(state, { nowMs });
  if (!budget.expired || state.iterationStats.roundBudget.status === 'expired') return { state, changed: false, roundBudget: state.iterationStats?.roundBudget || null };
  state.iterationStats = { ...state.iterationStats, roundBudget: { ...state.iterationStats.roundBudget,
    status: 'expired', expiredAt: budget.deadlineAt, observedAt: new Date(nowMs).toISOString(),
    elapsedMs: budget.elapsedMs, code: 'ROUND_BUDGET_EXCEEDED',
    reason: 'The complete round exhausted its 15-minute wall-clock budget, including tests and same-round retries.',
    nextAction: 'Inspect the failed round and resource-release status. Resume does not renew this deadline; start an explicitly new Mission or an admitted new round.' } };
  return { state, changed: true, roundBudget: state.iterationStats.roundBudget };
};
