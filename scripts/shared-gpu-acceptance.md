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
  Its artifact parent may be redirected with `E2E_GPU_ARTIFACT_DIR` (absolute
  path) so raw run directories/logs stay outside the repository snapshot; each
  run still gets its own `mkdtemp` run root and nothing else changes.
- `scripts/summarize-gpu-agent-runs.mjs` — read-only ledger over retained run dirs
  (re-exports `summarizeAcceptanceRuns`).
- `scripts/run-shared-gpu-regression-batch.mjs` — thin batch entry point that
  spawns the unchanged driver and feeds its retained artifacts to this ledger.
  See `scripts/run-shared-gpu-regression-batch.md`; it defines no second driver,
  scheduler or acceptance threshold.

## `verifyRoundFactsAudit({ audit, sourceRound, missionId, projectId })`

The condition-independent half of the continuation contract, extracted so the
controlled experience-condition study can run the **same** strict facts checks in
every mode. It is not a weaker verifier: `verifyContinuationAudit` is now exactly
this function plus the strict experience binding below.

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

It returns `{runId, roundId, promptDigest, promptBytes, sourceRound, facts,
assertions}` and throws on any mismatch; nothing is synthesized. Verified here:

1. `deliveryStage === 'prepared-before-send'`, mission/project match.
2. Audit round equals the frozen next round of `sourceRound` and is strictly later
   than the source round; audit run differs from the source run.
3. Prompt SHA-256 (UTF-8) and byte length recomputed independently.
4. `audit.roundFacts` deep-equals `sourceRound.roundFacts` (frozen archive), and
   `target.missionId/projectId/roundId` bind to mission/project/audit.
5. `previous.runId/roundId/candidateId/candidateDigest/queueRequestId` bind to the
   verified candidate; `candidateSourceRunId` is retained when present.
6. The prompt's own `MISSION ITERATION CONTEXT` section deep-equals the audit
   sidecar (the actual prompt is the authority, never the sidecar).
7. `candidate` / `correctness` / `gate` / `rollback` / `currentBest` facts exist and
   `gate.result` equals the source round's resolved outcome (`reference`/`reject`).

Two lower-level helpers are exported for the same reason:
`promptSection(prompt, label)` parses one `----- BEGIN <label> -----` JSON block
out of an audited prompt (a missing/unterminated/non-JSON block throws), and
`bindSourceRoundExecutionExperience({experiences, sourceRound, missionId})`
returns the execution records bound to the source round by mission + candidate id +
patch digest + queue request id (callers decide whether they require exactly one).

## `verifyContinuationAudit({ audit, sourceRound, experiences, missionId, projectId })`

Verifies the production prepared-before-send prompt audit that was written for the
round following the **verified candidate's own archived round**. Returns a
serializable summary (digest, bytes, bound experience, frozen facts, assertion
list) and throws on any mismatch. It never synthesizes facts or falls back to a
baseline/human record.

It runs `verifyRoundFactsAudit` first (all seven checks above) and then adds the
two strict experience invariants. These stay mandatory in the default mode:

8. The source-round candidate execution experience is **uniquely** bound by
   missionId + candidateId + patchDigest + queueRequestId (`runId`) — exactly one
   match — and is present in `selection.selected` with the same id/version and
   `source: 'execution'`.
9. The audited prompt contains that experience id/version exactly once with the
   complete unchanged content, the selection contextId matches, and the prompt's
   version map carries the bound version.

A zero-experience (`facts-only`) prompt can therefore never satisfy this verifier,
whatever its condition audit says. This observes the pre-send artifact only. It
does not claim what a live provider process received or obeyed.

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
enforced for `provider.cliVersion` and `provider.model`: an `env`/`configured-default`
self-report is `declared` and keeps the group non-comparable, and a value that
cannot be observed stays `unknown` rather than guessed. `provider.cliVersion`
keeps the existing real-probe rules (`runtime-descriptor`/`probe`/`observed`),
while `provider.model` additionally requires a **provider-reported response
observation**: `modelSource === 'observed'`, `modelObservationStatus ===
'observed'` and `modelObservationVersion ===
operator-studio.model-observation/v1`. A bare `observed` label without that
retained status/schema proof, or a `probe`/`init`/`env`/`declared` model source,
is non-comparable. Per-run/session identifiers (`sessionId`, `threadId`, run and
mission ids, paths, timestamps) are stripped before hashing. Any unknown field
makes the group explicitly non-comparable.

## Response-model proof and ledger recomputation

The driver retains the frozen per-run DTOs and required-run identities at
**top level**, outside the config hash:
`modelObservations` (array of `operator-studio.model-observation/v1` DTOs),
`modelObservationRequiredRuns` (provider/runId/missionId/sessionId bindings, one
per started run including failed/recovery/zero-candidate runs, with the
`<unresolved-mission>` / `<unresolved-session>` placeholders standing in when the
real identity was never observed),
`modelObservationSummary` (the pure summary) and `modelObservationUnboundRuns`
(runs whose real session was never learned). `provider.model` /
`modelSource` / `modelObservationStatus` / `modelObservationVersion` in the final
config are derived from that summary; `declaredModel` / `declaredModelSource`
remain separate requested-configuration fields and never upgrade the proof.

`summarizeAcceptanceRuns` does **not** trust the retained summary. For each run it
recomputes `summarizeModelObservations(modelObservations,
{ requiredRuns: modelObservationRequiredRuns })` and makes the run non-comparable
when:

- attempt or summary model evidence is absent/incomplete (legacy runs stay
  counted but non-comparable — no back-fill from another directory or the host);
- attempt and summary disagree on required-run bindings, retained DTOs, the
  recomputed summary, or the recomputed model;
- the retained `modelObservationSummary` is malformed: a missing required field
  (including `reasons`), a non-array/blank-element reasons list, or an `observed`
  verdict that still carries a reason;
- the retained summary disagrees with the recomputation;
- the config claims `observed` while the recomputed evidence is unknown/conflict,
  or mismatches the recomputed model/source/status/schema version.

Duplicate aliases are compared by outcome, config **and per-run model proof**: the
same alias/config/outcome with contradictory `modelObservations` /
`modelObservationRequiredRuns` / `modelObservationSummary` on either file is a
duplicate conflict (counted once as failure, non-comparable), not a harmless alias
of the first good record.

Missing, malformed, foreign or contradictory per-run evidence can never establish
comparability or N=20. Model comparability never changes a run's classified
outcome: a real `full_success` stays `full_success` even when its model is
unknown, and a failure is never hidden. `counts` / stability denominator
semantics (`full_success`, `budget_terminal`, `failure`, `timeout`,
`missing_summary`, duplicate handling) are unchanged.

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
  fingerprint that disagrees with the recomputed one, an attempt/summary config
  or fingerprint mismatch, or a per-run model-proof failure (missing/foreign/
  malformed/contradictory DTOs, attempt-summary disagreement or a config claim the
  recomputation contradicts) makes the run non-comparable; any group containing a
  run without a valid terminal attempt is never N=20 eligible;
- reports `n20.eligible` only for comparable groups with ≥20 retained unique
  attempts. It never asserts stability and never infers hardware samples.

## Frozen consumer helpers (driver observation)

The live driver does not keep a private reader or a DTO ranking. It calls the two
I/O-free helpers in this module; the frozen independent test
`tests/shared-gpu-model-collector-test.mjs` exercises the same functions.

### `collectModelObservationEvidence({ provider, missionIds, knownRuns, records })`

Returns `{ observations, requiredRuns, summary, unboundRuns }`.

- `knownRuns` are independently observed start identities
  `{provider, runId, missionId?, sessionId?}`. They dedupe by provider/run (not by
  success); every distinct started run stays required, including failed, recovery
  and zero-candidate runs. A blank Mission/session is only *pending* and may be
  completed from the current-attempt final record. Two **concrete** but
  contradictory Missions (or sessions) for one started run identity never resolve
  first-wins: the run is retained exactly once and marked invalid, so it can never
  produce an observation.
- `records` are the FINAL filesystem read results `{fileName, record, error}`.
  Only safe single-basename `.json` files (alphanumeric first character, no
  separator) are read; the read filename, `record.runId`, expected provider,
  expected Mission and the independent `record.sessionId`/`threadId` must agree
  (if both nonblank they must match). A DTO's own fields never supply an expected
  identity, and a concrete identity conflict is never overwritten.
- Final records are the authority, and a filename resolves to exactly one
  semantics: all reads of the same filename must be semantically identical (JSON
  key order is irrelevant, so an identical re-read dedupes). Conflicting content
  for one filename fails closed **in either order** — there is no last-write-wins
  map — and an earlier observed snapshot is never preferred over a later
  unknown/conflict/missing state.
- A safe file whose content is unreadable/invalid, or a started run with no final
  record, remains an unbound required identity and fails the summary closed —
  it is never silently skipped, and it is never dropped by an early `continue`.
  The same holds for a **new** safe file that no known start references but that
  carries no usable identity (`{}`, `[]`, a missing Mission, a foreign provider,
  a mismatched `runId`, no session): it joins the denominator as required/unbound
  rather than vanishing. Only a file with a **concrete** Mission outside the
  expected set that no known start references is ignored as foreign.
- An unresolved Mission/session is retained through the explicit non-bindable
  placeholders `UNRESOLVED_RUN_MISSION` / `UNRESOLVED_RUN_SESSION`
  (`<unresolved-mission>` / `<unresolved-session>`). They keep the started run in
  the frozen `requiredRuns` denominator without inventing an identity the attempt
  never observed, and since `bindModelObservation` requires an exact identity
  match no placeholder can ever yield an observation.
- `observations` are `bindModelObservation`-validated DTOs; `summary` is
  `summarizeModelObservations(observations, { requiredRuns })`; `unboundRuns`
  retain the run identity plus a nonblank reason.

### `evaluateMissionStopReceipt({ missionId, receipt })`

Evaluates the real Mission-stop HTTP body `{state}` (or a later bounded read-only
`{state}` observation) and returns `{confirmed, reasons}`. It is pure: it never
cancels, mutates or advances anything.

`confirmed` requires **all** of: exact `state.activeMissionId`, `missionPaused ===
true`, a loop intent that is exactly `stopped` (`paused`/`idle` alone are not a
stopped intent), `state.workflowRecovery.resourceRelease` with `confirmed: true` /
`status: 'confirmed'` and a `resources` array where every resource explicitly
confirms release with no pending/unconfirmed/quarantined/blocked flag, and — when
a current Agent run exists — a same-Mission Agent with explicit confirmed release
(reusing `resourceReleaseEvidence`). The mission-level aggregate is not enough on
its own: the existing provider-neutral `resourceReleaseBarrier(state)` from
`client-runtime/cancellation-contract.mjs` must also report no pending execution
resource, so a research Agent, baseline materializer, GPU test or benchmark still
sitting in a cancellation/quarantine barrier keeps the stop unconfirmed. An empty
`resources` array is admissible because the aggregate release itself is already
explicitly confirmed (nothing was pending): the list describes the resources this
stop needs to stop, so a current Agent that is already terminal may be absent
from it. When the Mission is explicitly confirmed with `resources: []` and the
same-Mission current Agent separately proves an explicit confirmed release
(reusing `resourceReleaseEvidence`) with no remaining barrier, the stop is still
confirmed. An idle placeholder Agent without a run identity needs no fabricated
release, while a **nonblank** run without the exact same-Mission explicit release
is rejected. An
absent/malformed/foreign/pending release is `false` even when HTTP was 2xx or the
Agent status is terminal. A 202 only becomes confirmed from a later proving
read-only state, never from elapsed time or a terminal status.

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
