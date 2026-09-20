# Iteration Loop Contract

## Purpose

Own the pure iteration guards and orchestrate one automatic iteration step.
Policies such as stagnation, research trigger/direction, tunnel vision, plateau and
the generation-attempt budget are pure exports; `advanceIteration` receives its
Agent Runtime and round-start effects through injected `deps` so the module has no
reverse dependency on adapters.

## Public API

Pure helpers include `isRoundAdopted`, `isResolvedEvidenceRound`,
`detectStagnation`, `decideResearchTrigger`, `selectResearchDirection`,
`buildResearchBriefing`, `evaluateResearchValue`, `detectTunnelVision`,
`settleGenerationAttemptBeforeStart`, `detectLoopGuard`,
`isExternalVerificationPending`, `isResearchExhausted` and `detectPlateau`.
`advanceIteration(state, deps)` performs one asynchronous step and returns
`{state, action, changed}`. Budgets/limits (`MAX_ROUNDS`, `TOTAL_BUDGET_MS`,
`RESEARCH_BUDGET_MS`, ...) are exported constants.

## Guards

`detectLoopGuard` returns the first hit reason code or `null`; a hit stops automatic
flow but never blocks manual operations. Order matters: an invalid/expired round
budget is reported first, then the external-verification wait, then phased/fixed
round policies, `needs_human` markers, total/round budgets and stagnation. A
`needs_human` marker does not interrupt a benchmark already `queued`/`running`.

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
`acquire`. When `sourcePolicy.researchEnabled === false` no entry starts a run; the loop emits
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
