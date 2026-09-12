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

## Verification

`npm run test:loop`, `npm run test:workflow-kernel`,
`npm run test:operator-test-resilience`, `npm run test:state-domain-boundary`.
