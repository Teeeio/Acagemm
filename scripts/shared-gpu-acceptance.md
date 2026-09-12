# Shared-GPU acceptance contracts (`shared-gpu-acceptance.mjs`)

Status: observation/statistics contract for the real shared-GPU Agent E2E. It is
pure and I/O-free: importing it never starts a Runtime, provider, GPU test or
scheduler. Authority: `docs/development/P2_EVIDENCE_ACCEPTANCE.md` "Deferred
evidence", `docs/development/TEAM_HANDOFF.md` §6/§10/§12 and
`docs/development/REAL_GPU_REGRESSION.md`.

Consumers:

The ledger requires complete, consistent per-family outcomes in both the attempt
and summary (`summary.summaries` is the driver's detailed family array). Empty
family arrays cannot prove full success. Conflicting duplicate records count once
as failure and retain a duplicate warning; neither an alternate attempt ID for
the same directory nor an alternate path for the same attempt increases N.
Budget release proof belongs to the current active Mission and Agent run; an
unbound historical budget event and `round_budget_invalid` cannot authorize a
safe stop. The current Agent must carry an explicit confirmed release; a Mission
projection may block it but cannot substitute for it. Console and summary status
distinguish `full_success`/`budget_terminal`/failure.

Code provenance hashes all tracked and nonignored source files under
`client-runtime`, `tools`, and `scripts`, plus package manifests/lockfiles. Missing
files or an unavailable Git inventory leave contentDigest unknown.

- `scripts/e2e-shared-gpu-agent-iteration.mjs` — live driver, read-only observer.
- `scripts/summarize-gpu-agent-runs.mjs` — read-only ledger over retained run dirs
  (re-exports `summarizeAcceptanceRuns`).

## `verifyContinuationAudit({ audit, sourceRound, experiences, missionId, projectId })`

Verifies the production prepared-before-send prompt audit that was written for the
round following the **verified candidate's own archived round**. Returns a
serializable summary (digest, bytes, bound experience, frozen facts, assertion
list) and throws on any mismatch. It never synthesizes facts or falls back to a
baseline/human record.

`sourceRound` must be the `runHistory` archive matched by the first verified
completed candidate task on **candidate digest AND the durable queue request id**
(`task.payload.requestId`), not by "the run the harness started first". The
archive's `runId` / `candidateSourceRunId` are the actual producing run, so a
same-round recovery attempt is attributed to the persisted
`candidate.sourceRunId`.

`audit` must be the retained artifact whose `roundId` equals
`sourceRound.roundFacts.target.roundId`. Using `state.agent.runId` (which may be a
third round or a later recovery attempt) is not allowed; the driver scans retained
`bridge/prompt-audits/*.json` and selects by the frozen target round id.

Retained P1 invariants:

1. `deliveryStage === 'prepared-before-send'`, mission/project match.
2. Audit round equals the frozen next round of `sourceRound` and is strictly later
   than the source round; audit run differs from the source run.
3. Prompt SHA-256 (UTF-8) and byte length recomputed independently.
4. `audit.roundFacts` deep-equals `sourceRound.roundFacts` (frozen archive), and
   `target.missionId/projectId/roundId` bind to mission/project/audit.
5. `previous.runId/roundId/candidateId/candidateDigest/queueRequestId` bind to the
   verified candidate; `candidateSourceRunId` is retained when present.
6. The source-round candidate execution experience is uniquely bound by
   missionId + candidateId + patchDigest + queueRequestId (`runId`) and is present
   in `selection.selected` with the same id/version.
7. The audited prompt contains that experience id/version exactly once with the
   complete unchanged content, the selection contextId matches, and the prompt's
   `MISSION ITERATION CONTEXT` section equals the audit sidecar.
8. `candidate` / `correctness` / `gate` / `rollback` / `currentBest` facts exist and
   `gate.result` equals the source round's resolved outcome (`reference`/`reject`).

This observes the pre-send artifact only. It does not claim what a live provider
process received or obeyed.

## Budget-safe terminal

`budgetTerminalEvidence(state, { missionId, runId })` returns `{ safe, terminal,
budgetReasonRecorded, resourceReleaseConfirmed, reason, budgetEvents,
resourceRelease, issues }`.

`safe` requires all of:

- the loop reached a terminal `needs_human` / `budget_exhausted`, and
- the **current** loop recorded a bounded-budget reason (`round_budget`,
  `total_budget`), or — only when no current reason exists
  — a current-bound `loop.round_budget_exceeded` / matching `loop.needs_human`
  runtime event, and
- an explicit confirmed execution resource release from
  `resourceReleaseEvidence`: `resourceRelease.confirmed === true` for the current
  mission, no pending/unconfirmed/quarantined/blocked projection and no
  unresolved current quarantine.

A terminal Agent status is **not** release proof: without an explicit
`confirmed: true` projection the stop is a failure. A current non-budget reason
(for example `generation_failure`) is authoritative — a historical
`loop.round_budget_exceeded` never upgrades it. Historical events bound to another
mission/run are ignored, and a current quarantine is resolved by the current
confirmed projection or a later matching `loop.resource_release_resolved` event,
so resolved history does not poison a new mission permanently. A bare
`needs_human` is a **failure**, never a terminal fallback.

## Family and attempt outcomes

`isRealGpuCompletedCandidate(task)` accepts only a `status: 'completed'` task
whose payload candidate digest is bound to a `source: 'local-shared-gpu'` result
with the same digest.

`evaluateFamilyOutcome(...)` returns `full_success` only for the complete
two-round path: at least two **distinct** real-GPU completed candidates (two tasks
with one digest never pass), a verified continuation audit and a clean automatic
rollback (`workspaceClean === true`).

Its `budgetTerminal` input must be the **evidence object** from
`budgetTerminalEvidence`; a bare truthy flag is never accepted (`safe` must be
literally `true`). A safe stop is `budget_terminal` with `fullSuccess: false`, and
only when no existing failure reason is present — pre-existing reasons are always
preserved instead of hidden, making a contradictory stop a `failure`.

`combineAttemptOutcome(...)` maps per-family outcomes plus a driver failure to
`full_success | budget_terminal | failure | timeout`. A failure is never hidden by
a successful family, and budget terminal is never promoted to full success.

## Config fingerprint and N-pooling

`buildConfigFingerprint(config, { code })` hashes a **normalized** configuration.
Per-run identifiers (`observedTargets`, `sourceRunId`, run/mission ids, paths,
timestamps) are stripped before hashing, so the same configuration observed in two
different runs hashes identically. The fingerprint includes code identity — the
git commit plus `code.contentDigest`, the actual content digest of the source tree
that participates in the run/runner/Gate/prompt — so a changed or dirty tree can
never be pooled with an unchanged one.

`unknownFields` comes from `REQUIRED_FINGERPRINT_PATHS` (provider runtime, CLI
version, model, backend kind, hardware, architecture, device, driver version,
families, candidate task count, matrix, experience selection policy, budgets, code
commit and content digest). Missing detection recurses into nested objects, so a
nested `null`/`unknown`/empty container is unknown, not known. Provenance is
enforced for `provider.cliVersion` and `provider.model`: only an observed value
(`runtime-descriptor`/`probe`/`observed`) counts — an `env`/`configured-default`
self-report is `declared` and keeps the group non-comparable, and a value that
cannot be observed stays `unknown` rather than guessed. Any unknown field makes
the group explicitly non-comparable.

`summarizeAcceptanceRuns(records)` (pure; records are `{ runDir, attempt, summary }`
with either JSON possibly `null`):

- counts `full_success`, `budget_terminal`, `failure`, `timeout` and
  `missing_summary` separately per run, plus supplementary `summariesMissing`,
  `attemptsMissing`, `attemptsNotTerminal`, `comparableRuns`;
- keeps every retained attempt in the stability denominator, including
  `missing_summary`, `timeout` and `failure`; nothing is silently excluded;
- de-duplicates identical identities (`attemptId`/`runRoot` or `runDir`) with a
  recorded warning, so the same attempt passed twice can never accumulate toward
  an N — while distinct attempts that merely share a directory are both kept;
- classifies explicitly and never upgrades: an explicit failure wins, a
  missing/running attempt or invalid schema is never `full_success`, and a
  summary/family contradiction is a failure with the contradiction listed in
  `issues`;
- groups by computed fingerprint; a group is comparable only when **every** entry
  is comparable, and it reports the union of unknown fields. A declared
  fingerprint that disagrees with the recomputed one, or an attempt/summary config
  or fingerprint mismatch, makes the run non-comparable; any group containing a
  run without a valid terminal attempt is never N=20 eligible;
- reports `n20.eligible` only for comparable groups with ≥20 retained unique
  attempts. It never asserts stability and never infers hardware samples.

## Hardware-free checks

All of the above can be exercised without a GPU or Agent by importing the module
and passing archived or synthetic objects, for example:

```bash
node --input-type=module -e "import('./scripts/shared-gpu-acceptance.mjs').then(m=>console.log(m.budgetTerminalEvidence({iterationStats:{loopStatus:'needs_human',loopStatusReason:'total_budget'},agent:{status:'completed',resourceRelease:{confirmed:true}}})))"
node --input-type=module -e "import('./scripts/summarize-gpu-agent-runs.mjs').then(m=>console.log(m.summarizeAcceptanceRuns([])))"
node scripts/summarize-gpu-agent-runs.mjs <retainedRunDir> [...]
```

The read-only CLI accepts explicit run directories only; it never launches a new
run.

## Boundaries

- No product, matrix, budget, provider or Gate behavior is defined here.
- Live hardware samples are never fabricated, back-filled or upgraded.
- The ledger keeps failures and missing summaries in their own groups; it does not
  certify stability, publishability or a real-instrument publication.
