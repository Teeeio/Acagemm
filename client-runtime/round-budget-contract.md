# Complete round wall-clock budget

The pure round-budget contract owns a persisted 15-minute clock for one complete
operator iteration. It imports no provider, queue, filesystem or timer adapters.
The existing iteration-loop ROUND_BUDGET_MS export remains compatible.

## State and identity

iterationStats.roundBudget defaults to null. An explicit admitted main-round
start creates roundId="<missionId>:round:<ordinal>", roundNumber, startedAt,
deadlineAt, budgetMs=900000 and status=active. The first ordinal uses the legacy
completed-round count plus one. Subsequent admitted settled evidence rounds and
explicit manual runs use max(completed-round count + 1, previous budget ordinal + 1): publication may
settle its budget before legacy evidence accounting increments its counter.
Budget identity is monotonic without rewriting evidence/performance/retry
counters or the total Mission budget.

Generation retries, Correctness repairs, queue waiting, test execution and
recovery inside that round retain the exact original clock. Neither replacing
an Agent runId nor changing Candidate contents creates another round. Evidence
accounting completes the old budget; only a subsequently admitted new round
receives a new identity and deadline. The legacy generic loop counts failed
diagnostic attempts in its existing round/MAX_ROUNDS counter; that counter is
not permission to replace an active budget. Such Correctness/no-Candidate retries,
including a completed transport result containing failed Correctness, retain the
first attempt's budget roundId even as the legacy counter advances. A counted
round closes its clock only with completed, correctness-passed test evidence.
No Profile, matrix, retry counter or individual Agent budget is changed.

Legacy snapshots without a round budget remain untracked until an explicit new
start. They never inherit a deadline from Agent/test/history timestamps. A
malformed explicit record is reported as invalid, not replaced with fresh time.

## Public API

- ensureRoundBudgetStarted(state, {nowMs, allowSettledRestart=false,
  completedRoundId=null}): update loaded state in memory; return
  {state, changed, roundBudget}. Same-round calls are idempotent even if the
  budget ordinal is ahead of legacy counters. Only explicit runs.plan admission
  or fixed RunService manual arming passes allowSettledRestart=true, and only
  persisted completed budget +
  published stage + completed knowledge maintenance grants that permission.
  The iteration loop separately supplies completedRoundId only after resolved,
  correctness-passed evidence is counted for the current Agent. This token must
  match the raw completed budget exactly; it is not forwarded as a body option
  or granted to AgentRound, prepare or replay. Default ensure on a completed
  budget always throws ROUND_BUDGET_ALREADY_COMPLETED, even if legacy counters
  advanced. An active or expired budget never gains a deadline from either
  permission; expiry throws ROUND_BUDGET_EXCEEDED (409). Startup validates the
  raw recorded clock, not a previous published-stage projection.
- inspectRoundBudget(state, {nowMs}): read-only tracked/status/expired/elapsedMs/
  remainingMs projection. Before-start clock values clamp elapsed to zero.
- completeRoundBudget(state, {nowMs}): complete the active, non-expired clock
  during genuine evidence settlement; repeated completion is a no-op.
- expireRoundBudget(state, {nowMs}): record the observed expired round with
  ROUND_BUDGET_EXCEEDED, reason, deadline and nextAction, without asserting any
  process or queue resource was released.

nowMs defaults to Date.now() and must be finite. detectLoopGuard(state,{nowMs})
uses the same clock; advanceIteration accepts deps.now returning a Date or epoch
milliseconds. Invalid explicit records yield round_budget_invalid and stable
ROUND_BUDGET_STATE_INVALID errors at startup.

## Pause, termination and recovery

This is wall-clock time: pause/stop does not suspend or renew the deadline.
An expired paused round can still trigger safety shutdown. Resume alone cannot
give that round another 15 minutes. A timed-out round remains needs_human;
operators inspect the failed round and resource ownership, then explicitly
choose a new admitted round or Mission. The policy never silently increments
fixed evidence/performance counters to bypass this stop.

Production runtime advancement recognizes round_budget before Autopilot/new
dispatch and reuses MissionControl.releaseResources. Pending or unknown releases
retain the existing resource barrier. Only subsequent confirmed release allows
iteration settlement to record loop.round_budget_exceeded (idempotent by roundId)
and the visible needs_human outcome. Current-best evidence is preserved.

AgentRound and journaled HTTP run handlers must persist/capture the new budget
before their Agent effects; journal prepare/replay restores the recorded budget
without new-round permission. A new active intent in an old published snapshot
is not already completed and must still pass its frozen deadline. A newly
admitted identity retrieves its own round experience, while same-round replay
retains its recorded context. Automatic iteration starts also call the same
idempotent helper before entering the main-round orchestration port. Only the
ordinary settled-evidence continuation and its research-injection path supply
the exact completedRoundId token. Failed correctness, no-Candidate retries and
Baseline recovery do not grant a new clock. Manual round 2 followed by real
unmet-Gate evidence therefore admits automatic round 3 even when the independent
evidence counter is still 1. Final published
Mission closure can return looped.changed=true solely to persist clock closure.

Verification: node tests/round-budget-test.mjs; node tests/loop-test.mjs.
These are memory/contract tests, not live-model or hardware acceptance.
