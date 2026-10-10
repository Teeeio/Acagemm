# Iteration Loop Contract

`settleIterationEvidenceRound(state,{nowMs})` exposes the existing pure accounting
step to both ordinary iteration and explicit frozen feedback. It starts no work,
preserves fixed correctness/generation attempt limits and completes a round clock
only after correctness-passed evidence. `advanceIteration` uses the same function.

Generate-only lifecycle: `advanceIteration` cannot dispatch baseline, research,
tests, automatic retries or another Agent for `mission.executionMode=generate-only`.
Existing resource-release and stop guards run first. A released terminal
`failed`/`cancelled` Agent settles once by run ID through
`settleGenerationAttemptBeforeStart`, using the existing generation-attempt
counters and failure event without requiring a measured baseline. Explicit
`resourceRelease.confirmed === true` is required. It immediately pauses the Mission
as `needs_human`, retaining the terminal Agent status, `candidateValidation` and
`primaryFailure`; the returned and persisted reason includes their actual cause.
Repeated ticks/reloads do not recount the attempt or replace that cause with a
later budget timeout. No clock is started/reset, no evidence round is counted and
no retry is admitted. Other generate-only states retain the existing budget guards.
A frozen
`iterationStats.pendingValidation` is held paused with `blocked/awaiting_backend`;
the DTO, candidate, baseline and original budget identities are retained.
`detectLoopGuard` still recognizes expired round/Mission clocks for a pending
candidate. Expiry transitions to `needs_human` with the original budget reason,
without resetting counters, extending the clock, discarding the artifact or
calling maximize completion/publication. Repeated waiting/expired ticks are
idempotent. The Agent's completed status describes generation only; testing,
adoption and publication remain unproven. Reconnecting tests, including tests
after budget expiry, requires a future explicit authorization contract.

## Purpose

Own the pure iteration guards and orchestrate one automatic iteration step.
Policies such as stagnation, research trigger/direction, tunnel vision, plateau and
the generation-attempt budget are pure exports; `advanceIteration` receives its
Agent Runtime and round-start effects through injected `deps` so the module has no
reverse dependency on adapters.

## Public API

Pure helpers include `isRoundAdopted`, `isRoundProgress`, `isResolvedEvidenceRound`,
`detectStagnation`, `decideResearchTrigger`, `selectResearchDirection`,
`buildResearchBriefing`, `evaluateResearchValue`, `detectTunnelVision`,
`settleGenerationAttemptBeforeStart`, `detectLoopGuard`,
`isExternalVerificationPending`, `isResearchExhausted` and `detectPlateau`.
`advanceIteration(state, deps)` performs one asynchronous step and returns
`{state, action, changed}`. Budgets/limits (`MAX_ROUNDS`, `TOTAL_BUDGET_MS`,
`RESEARCH_BUDGET_MS`, ...) are exported constants.

## Guards

### Progress and adoption

`isRoundAdopted` retains its target-adoption meaning. `isRoundProgress` also
recognizes resolved `retain` outcomes with complete, correctness-passed
measurements and the Gate decision's `improved_current_best / retainable` claim.
It does not grant adoption or publication, or infer progress from latency text,
pending review or Agent claims.

`iterationStats.consecutiveNoProgress` is created at round settlement and used
by stagnation/research and maximize plateau. The separate `consecutiveNoAdopt`
counter keeps its meaning: retention increments that counter while resetting
no-progress and recording `lastRoundOutcome=improved_current_best`. Existing
research-window resets clear both counters.

Fresh/legacy snapshots may omit the new counter. Read-only projections use
counted live/archived evidence to shorten the legacy streak at actual progress;
absent evidence conservatively preserves the legacy counter. No migration
rewrites adoption history. Consecutive-history and duplicate checks cannot skip
an intervening improvement or bridge an unknown candidate identity.

New terminal rounds settle before plateau evaluation, so an old streak cannot
finish a Mission that has just retained an improvement. Repeated ticks and
reloads still settle each run only once. Budgets, fixed Profiles and release
barriers are unchanged. `tests/loop-test.mjs` covers these transitions and
`tests/knowledge-state-test.mjs` checks real Gate/governance output against the
progress predicate; neither test invokes a model or GPU.

An explicit `agent.primaryFailure.code === 'CLAUDE_TOOL_PERMISSION_DENIED'`
bound to an Agent run blocks automatic work in both execution modes, including
fixed Profiles with unused retry attempts. `detectLoopGuard` exposes this cause
before autopilot dispatch (invalid/expired round-clock diagnostics still take
precedence there). `advanceIteration` checks release barriers and durable stop
first, then requires explicit `resourceRelease.confirmed === true` before pausing
the Mission as `needs_human`. A missing release proof remains pending.
The terminal Agent status, failure details, candidate pool, existing evidence and
all original clocks are retained. Ordinary iterate does not consume/reset retry
counters; generate-only reuses its existing once-per-run generation settlement.
Repeated ticks/restarts and subsequent budget expiry neither repeat settlement
nor replace the denial cause. Model prose, candidate-validation text and other
error codes do not activate this guard. Other failure retries and permission
settings are unchanged; no approval or failure-clearing recovery API is added.
The existing fixed-Profile `/runs` admission also consumes `detectLoopGuard`, so
it reports `FIXED_OPERATOR_RUN_BLOCKED` while the original run still carries this
denial. This policy does not grant permission to repeat a denied operation.

`detectLoopGuard` returns the first hit reason code or `null`; a hit stops automatic
flow but never blocks manual operations. Order matters: an invalid/expired round
budget is reported first, then an explicit tool permission denial, then the external-verification wait, then phased/fixed
round policies, `needs_human` markers, total/round budgets and stagnation. A
`needs_human` marker does not interrupt a benchmark already `queued`/`running`.

An explicit `iterationStats.loopStatus === 'stopped'` is durable control intent.
After checking resource-release barriers, `advanceIteration` returns
`action: 'stopped', changed: false` before applying any budget or round policy.
Expired/invalid budgets never rewrite the stop reason, stopped timestamp, Mission
status or frozen clock. Pending/quarantined release still blocks work and remains
unconfirmed; confirming release later does not reopen the loop. Ordinary pause
continues to obey budget termination. `detectLoopGuard` remains a budget/limit
diagnostic; a stopped intent is checked separately before consuming its verdict.
Regression: `tests/loop-test.mjs` crosses total/round/invalid clocks with pending,
confirmed and quarantined release on both sides of the deadline.

## External-verification wait

`isExternalVerificationPending` is true only when a unified decision bound to the
current candidate/run says so. The decision-binding identity (`binding.candidateId`
and `binding.runId`) must match `appliedCandidateId`/`benchmark.candidate.id` and
`benchmark.runId`; `currentBest.evidenceDecision` and other runs' decisions are
never read. It is never inferred from a live boolean or `publishable`.

A retest already `queued`/`running`, or a resume-acknowledged wait for the same
candidate/run (`iterationStats.externalVerificationAcknowledged`), returns false so
the old wait cannot block or re-trigger on the new attempt. `decisionReview.status
=== 'waiting_external_verification'` counts only for the matching current candidate
and, when present, a matching Gate decision.

When `detectLoopGuard` hits `external_verification`, `advanceIteration`:

- keeps the candidate, workspace and current Agent identity — no new candidate and
  no code edit;
- sets `missionPaused = true`, `iterationStats.loopStatus = 'blocked'` /
  `loopStatusReason = 'external_verification'`, Agent `awaiting_action` with a
  `test.plan` "resume and retry the same candidate" action, and Mission `blocked`;
- emits `loop.external_verification_pending` and the audit entry once per
  mission/candidate/run identity (payload carries `candidateId` and `runId`), then
  returns `{state, action: 'external_verification', changed: true}`.

Re-entering an already-waiting (or resume-acknowledged) state returns
`changed: false` with no new event or timestamp. A blocked external-verification
marker is ignored while a same-candidate retest is queued/running, so the retry is
not stalled by the old decision.

This reuses the existing `missionPaused` / blocked-loop mechanism, so
`workflow-kernel` already treats the state as having no active effect. Recovery is
the existing resume + retest of the same candidate; budget and resource-release
rules are unchanged. Locally optional diagnostics never trigger this wait — only a
required, blocking decision does.

## Research strategy and delivery

`advanceIteration` never decides research policy by itself. Every automatic research entry calls
`resolveAutomaticResearch` (`research-policy.mjs`) and passes the resulting phase and budget
explicitly. Stagnation and tunnel-vision escalation therefore start an `advisory` phase run — a
suggestion-only phase that must not acquire or clone a baseline source — instead of falling back to
`acquire`. Unless `sourcePolicy.webResearchEnabled === true` (default off) no entry starts a run; the loop emits
`research.skipped_disabled` and returns without weakening any source gate. Pure runtime faults
(`classifyResearchFaults`) emit `research.skipped_runtime_fault` instead of triggering full domain
research.

Research material moves through explicit delivery stages (`available` → `selected` → `submitted`),
persisted on `iterationStats.pendingInjection`. Passing the value gate does not set
`researchAgent.injected`: only an executor run bound to the material `digest` counts as submitted
(`resolveInjectionDelivery`). A blocked preflight or a throwing round start leaves the material in
`uncertain` state with its failure reason — it is never consumed early, re-submitted into a round
that already started, or silently dropped. Bounded re-submission is capped by
`MAX_INJECTION_ATTEMPTS`. Material is bound to Mission, Round, `researchRunId`/`noteId` and digest;
another Mission's note never becomes this Mission's material (`noteBelongsToMission`).

Building the advisory envelope is optional context, not a gate: a rejected envelope degrades to
`research_noted` ("no material this round") and the note is still bookkept, so one rejection can never
stop the loop. Prose length does not reject at all — the contract bounds it in two tiers, passing values
untouched up to the hard limit and truncating only beyond it. What still rejects is an identity-bearing
field, which is never truncated. Those two rules compose: the fields that can reject are exactly the ones
where a shortened value would be a false identity, and rejection is survivable.

Repeated rejection is different from a single one. `iterationStats.consecutiveAdvisoryRejected` counts
only rounds that actually attempted a build and were refused — a round that needed no material neither
increments nor resets it, while a successful build resets it to zero. At `MAX_ADVISORY_REJECTIONS` the
loop stops reporting "no material" and returns `action: 'needs_human'` with
`loopStatusReason = 'advisory_contract_mismatch'`: consecutive rejection means the contract and its
producer disagree, and a mismatch that keeps degrading silently would be audited as "research produced
nothing", which is the wrong cause.

`evaluateResearchValue` decides in a fixed order: is there material at all, is its declared scope
compatible with the frozen task contract, and only then is it compared against existing knowledge.
Only verified `publishedAssets` can suppress new material, and only when the new material adds no
new constraint, evidence or experiment path. Unverified drafts and unrelated referenced assets never
block it. Transport/auth-only output is reported as `transport_failure_only`, not as a finding.

Source acquisition runs on `deps.acquireSources` (the iteration-advance path), never inside state
projection. Per-run source accounting uses `deps.countRunSources`, so Source Registry history is not
reported as this run's harvest.

## Verification

`npm run test:loop`, `npm run test:workflow-kernel`,
`npm run test:operator-test-resilience`, `npm run test:state-domain-boundary`.

## Shared remaining Mission clock

`remainingMissionBudgetMs(state,{nowMs})` is the pure remaining-time projection
used by detectLoopGuard and bounded startup preflight. It keeps the existing
state-level budget, then active Mission budget, then TOTAL_BUDGET_MS precedence,
using missionBudgetStartedAt or loopStartedAt. It neither allocates nor renews
any clock. Startup consumers reject nonfinite or exhausted remaining time.

### Missing acquisition port is reported, never silently "no material"

The acquire path settles its harvest through `deps.acquireSources`. A composition root that has not wired
that port yet must not be silently indistinguishable from "this run genuinely found nothing", so the loop
emits `research.acquisition_port_missing` with the fallback it chose, and — when only the legacy
`deps.registerSources` port exists — records `researchAgent.acquisitionStatus = 'legacy'` with
`reasonCode = RESEARCH_ACQUISITION_PORT_MISSING` before continuing with the legacy registry count.
With neither port the loop still reports `fallback: 'none'` before ending as `research_no_material`.
Regression: `tests/loop-test.mjs` asserts all three shapes.

### Modified source root stops auto-advance

Third-party sources are fixed references. Once the source root has been modified — uncommitted changes, or a
HEAD tree that no longer matches the registered `operatorStudio.sourceTree` pin — the material basis for the
round is no longer the pinned one, so the automatic flow must stop rather than continue on swapped material.

The acquire region calls the optional `deps.inspectSourceIntegrity` port immediately after settlement, before
promoting to the synthesize stage, and asks it about `researchAgent.sourceRoot` (the root acquisition actually
used), not about whatever root the Mission also carries. A non-`valid` result returns `action: 'needs_human'`
with `loopStatusReason` = `source_root_modified` or `source_root_unverifiable`, plus a durable
`source_registry.integrity_failed` event; `detectLoopGuard` then returns that reason on the next tick, which is
what actually halts auto-advance. Manual operations are not blocked.

The port is optional on purpose: with no port there is no evidence about the source root, and the loop does not
invent a conclusion from its absence. Regression: `tests/loop-test.mjs` (blocked, unverifiable, clean, and the
port-absent path), `tests/source-registry-integrity-test.mjs`.

## Accurate automatic continuation feedback (2026-10-08)

Normal no-candidate retries include the retained candidateValidation code and detail, or the actual primaryFailure, in the next generation goal. Undeclared temporary probe files require removal before final declaration or complete declaration of real dependencies; the admission allowlist remains strict. Continuation after an adopted Gate states that adoption and retained best instead of claiming it failed acceptance. These messages do not change retry admission, round/Mission clocks, correctness coverage or Gate policy. tests/loop-test.mjs exercises both messages through advanceIteration with injected effects; no live provider or GPU is called.
