# Run Service Contract

Exception to fresh-draft clock absence: a bound, journal-committed pre-effect
experience-read failure allows explicit `startDraft` retry. Both active and saved
snapshots still pass all other draft checks; original Mission/round time remains
charged. The service reports the original read error only after its diagnostic
commits. Ordinary admission/unknown-effect failures retain the rules below.
See [generation-preparation](../generation-preparation.md).

## Generate-only admission

A Mission persisted with `executionMode: generate-only` may start only through
the existing `/runs {startDraft:true}` fresh paused-draft admission. The mode
comes from the Mission, never the run request. Repeated runs return
`GENERATION_ONLY_RUN_UNAVAILABLE` (409); a frozen pending candidate returns
`GENERATION_ONLY_PENDING_VALIDATION` (409). Original-owner resource release is
checked first. Oracle artifact, testSpec, strict-source authority, Agent/workspace
preflight and all fixed/round/Mission limits remain required.

On the admitted working clone, the canonical `freezeSemanticSnapshot` freezes
valid generation semantics (or `assertSemanticSnapshot` validates an already
frozen snapshot). Mission identity and testSpec must agree; conflicts, unknowns
or digest errors reject before effects without altering the saved draft. The
same frozen snapshot reaches the Prompt and run journal intent/payload.

Fixed Profiles in this mode use the normal journaled Agent command after fixed
budget admission instead of baseline-first arming. Baseline status/source are
unchanged: `user-provided` is not promoted to upstream authority or measured
evidence. There is no test-backend/Doctor prerequisite at this service. This
service owns generation and freezing. Reconnecting a frozen candidate uses
Candidate Validation's explicit submission entry; neither entry renews a spent
budget. Omitted mode remains legacy `iterate`.

Owns Mission run start across strict-zero-source research, Runtime preflight, fixed Operator arming, and normal Agent execution. It delegates durable command semantics to `executeCommand` and keeps HTTP response formatting in `run-routes.mjs`.

Input: Mission ID and run body (`goal`, `resume`, optional `startDraft`, and command fields). Output is a transport-neutral outcome containing a command result, a research response, or an armed fixed Operator state. Preflight failures use `RUNTIME_PREFLIGHT_FAILED` (503), or the existing specific preflight failure code; unknown Missions use `MISSION_NOT_FOUND` (404); command conflicts use `STATE_VERSION_CONFLICT`.

Constructor requires the injected `missionState.selectMission` transition and
`nowMs` millisecond clock; either missing port throws TypeError, with no state-store
or clock fallback. Production binds the canonical Mission/Project domain factory
and the process clock.

## Explicit saved draft start

`POST /api/missions/:id/runs` with `startDraft: true` starts an already active,
paused, genuinely fresh Mission in one admission. Immediate imports must also
create with `missionPaused: true`, then use this request. There is no separate
unpause request. Only boolean `true` opts in; other values retain the existing
run behavior, including rejection of paused Missions.

The original active owner's resource-release barrier is checked before selection
or new work, including when another Mission ID was requested. Admission uses a
`structuredClone` of the loaded state under the caller's existing API writer
lock. The target must already be active, with both active and saved pause flags
true, saved status `ready`, stage `diagnosis`, round zero and no started Mission
or round budget, Agent run, active research/materializer, candidate, test, run
history, spent attempt counter, or stopped/failed/completed loop. Both the active
projection and saved record are checked. Invalid freshness is rejected with
`MISSION_DRAFT_START_INVALID` (409); resource barriers retain
`MISSION_RESOURCE_RELEASE_PENDING` (409). No counters or spent budgets are reset.

Both snapshots must contain a materializer with `status: completed` and the same
nonempty string `result.runPy`; otherwise admission returns
`GENERIC_MISSION_BASELINE_NOT_READY` (409). This is a declared independent baseline
artifact, not measured baseline evidence. The stored v1 testSpec must have
explicit deterministic generation, correctness cases/categories/tolerances and
benchmark profiles/primary profile/warmup/repeats, and agree with the saved
Mission's spec. Failure returns `MISSION_DRAFT_TEST_SPEC_INVALID` (409). The
normalizer is deliberately not used to repair missing or invalid declarations.
Request-body baseline/test fields cannot replace saved declarations. Actual test
package admission and evidence validation remain authoritative.

For strict-source Missions, the existing research-source selector must resolve a
non-semantic source, matching any declared repository/commit/path. Otherwise
`BASELINE_SOURCE_UNRESOLVED` (409) is returned before effects, even if an artifact
was supplied. This path never silently launches research or grants semantic
fallback. Legacy non-draft research behavior is unchanged.

After admission only the working clone is unpaused. The normal mutation guard,
Mission budget, runtime preflight, intent guard and existing run command journal
are used; preflight elapsed time is rechecked against the same Mission clock.
Fixed Profiles retain their existing budget admission and arming branch, with the
same explicit artifact prerequisite. Success persists the unpaused state together
with the run/arming result. Admission and unclassified pre-effect failures leave
the original draft unchanged, even when the load port returns shared state. The
bound read-failure diagnostic described above is committed as a paused outcome.
Once command
effects start, the existing journal retains uncertain/prepared work for recovery;
the service neither rolls back nor repeats external work. A paused persisted
snapshot after an effect failure is not proof that no external work occurred.
No target-hardware Doctor or new hardware prerequisite is added here.

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

The same test also drives explicit draft requests through the actual route,
domain-created saved state, mutation policy, Agent command handler and command
journal with in-memory effect ports. It covers atomic success; missing CLI,
invalid/stale/started/stopped drafts, baseline/testSpec/strict-source rejection;
original-owner release barriers; fixed arming; legacy paused rejection; and
pre-effect, effect and persistence failures with conservative journal recovery.

The fixed-profile cases in tests/round-budget-test.mjs separately cover automatic
correctness-passed evidence settlement and research-injected continuation. They
are not proof that the fixed manual API passes through ordinary runs.plan.

The service does not parse URLs, emit HTTP, or duplicate workflow policy.

## Research material delivery

When a run is started without an explicit goal and pending research material exists, the material's
advisory envelope is passed to the Agent runtime and the goal only carries its verifiable identity
(`noteId` + `digest`). Raw research text is no longer concatenated into the goal. The material is
cleared only after the started run binds the same digest; otherwise it stays pending with an explicit
`uncertain` stage and reason, so a failed start never loses it. Legacy material without an advisory
envelope keeps the previous text path.

## Ordinary imported-source draft semantics

Explicit startDraft admission freezes complete imported-source Mission semantics before the ordinary Agent launch, using the same semantic/testSpec identity checks as generation-only admission. It preserves executionMode, declared baseline, original test matrix, journal and clocks. Frozen semantics are required by automatic candidate storage. tests/run-service-test.mjs verifies the real route/command with injected Provider effects; live shared-GPU evidence is recorded separately.
