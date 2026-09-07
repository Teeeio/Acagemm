# Run Service Contract

Owns Mission run start across strict-zero-source research, Runtime preflight, fixed Operator arming, and normal Agent execution. It delegates durable command semantics to `executeCommand` and keeps HTTP response formatting in `run-routes.mjs`.

Input: Mission ID and run body (`goal`, `resume`, and command fields). Output is a transport-neutral outcome containing a command result, a research response, or an armed fixed Operator state. Preflight failures use `RUNTIME_PREFLIGHT_FAILED` (503); unknown Missions use `MISSION_NOT_FOUND` (404); command conflicts use `STATE_VERSION_CONFLICT`.

Constructor requires the injected `missionState.selectMission` transition and
`nowMs` millisecond clock; either missing port throws TypeError, with no state-store
or clock fallback. Production binds the canonical Mission/Project domain factory
and the process clock.

## Fixed Profile manual admission

The actual fixed POST branch returns armed; it does not execute the ordinary
journaled runs.plan handler. Therefore this service performs its own explicit
manual admission using the canonical detectLoopGuard and round-budget contract,
not a second copy of Profile semantics.

Before arming, current fixed performance/generation/Correctness limits, global
limits and deadlines must allow work. A failure throws FIXED_OPERATOR_RUN_BLOCKED
(409, retryable=false) with details.reason and details.nextAction, without a 202
response, persisted arming or Agent effect. Normal guardMutation still owns pause,
resource-release and explicit Mission-budget admission. Clearing an old loop-status
marker does not clear any evidence counter, retry counter or total Mission clock.

Within the remaining limits, only a persisted completed budget plus published
stage plus completed knowledge maintenance grants a new manual budget identity.
An already active round keeps its exact identity/deadline; an expired round cannot
be renewed. A completed but unpublished round is synchronously rejected with
ROUND_BUDGET_ALREADY_COMPLETED and nextAction, leaving automatic evidence
settlement/continuation to the iteration loop. Body fields cannot grant a
completedRoundId token or replace the recorded budget.

The admitted budget is frozen before Runtime preflight and rechecked immediately
before persisting armed state. An old published snapshot cannot hide expiry of a
new active intent. A successful 202 means an active budget is persisted for later
Baseline/Autopilot/AgentRound work, not that a Provider has already started.
Autopilot receives no permission to renew completed budgets. Fixed attempts,
Profile/test matrices, legacy evidence counters and total Mission budget are
unchanged.

## Verification

node tests/run-service-test.mjs exercises the production run route and Run Service,
then the actual Fixed Autopilot and AgentRound services. Effects use injected
Provider/workspace/experience doubles; it is route/service integration, not real
network, model, GPU or end-to-end acceptance. It covers first/manual-settled
arming, retry clock/context retention, fixed/global limits, rejected completed
states and preflight crossing the frozen deadline.

The fixed-profile cases in tests/round-budget-test.mjs separately cover automatic
correctness-passed evidence settlement and research-injected continuation. They
are not proof that the fixed manual API passes through ordinary runs.plan.

The service does not parse URLs, emit HTTP, or duplicate workflow policy.
