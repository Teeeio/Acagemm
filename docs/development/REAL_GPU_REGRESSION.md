# Real shared-GPU Agent regression and sample ledger

Status: procedure/contract for the real shared-GPU regression only. It does not
contain hardware results, does not certify N=20 and does not claim publishability.
Current state (2026-09-13): the response-model observation implementation is
complete and the upgraded hardware-free gates pass — **release 139 / non-hardware
41, exit 0** (UTC 19:18:55–19:29:01, log SHA256
`c4205aa44917708dff15aaa3d2d2996d95b9f9e5fd4a6aa83a12d7ba7a0b3c46`), with the
producer `assistant.message.model` observation chain, the consumer final-record /
all-requiredRuns / ledger / stop semantics, `collector 65/65` and the five
fixture-only driver scenarios all verified. Archived originals, the machine
manifest and the precise proof boundaries are in
[`evidence/model-observation-20260913/README.md`](evidence/model-observation-20260913/README.md).
The earlier Phase 2 gates (release 136 / non-hardware 38, exit 0) are **historical
and retained** at
[`evidence/p2-evidence-20260912/README.md`](evidence/p2-evidence-20260912/README.md);
they are not the current numbers and add no hardware samples. **No new GPU / real
Agent run has been made** for this batch: the live request was refused by the
`exec_command` automatic approval review **before process creation**
(`approval-required`, `processCreated: false`, payload/destination authorization
pending), so the newest real affine two-round smoke is still pending execution
(`待运行`); reduction/normalization coverage and N=20 are likewise pending.
Nothing in this document or in the hardware-free tests is evidence that the live
observation path works, and the rejected live execution must not be replaced by a
local dispatch run. The driver has **not observed a model value** on real hardware
yet (a `declared`/env label cannot make a group comparable).
The ordered follow-up is unchanged: first observe the model, then a
same-configuration real two-round smoke, with family coverage and N=20 reported
**separately**. Running the driver 20 times is not by itself an N=20 qualification,
and the strict statistics threshold below is not relaxed.

Every configured operator family must have consistent attempt/summary outcomes.
Missing summaries and failed attempts remain in the denominator. Duplicate
identities cannot increase N; contradictory duplicates remain visible as failure.
Only current Mission/Agent release confirmation can establish a budget-safe stop;
an invalid budget configuration is a failure. Full two-round success and a safe
budget terminal have separate console and summary statuses.
Authority: `P2_EVIDENCE_ACCEPTANCE.md` "Deferred evidence",
`MODEL_OBSERVATION_ACCEPTANCE.md`, `TEAM_HANDOFF.md` §6/§10/§12. The
observation/statistics contracts are documented in
`scripts/shared-gpu-acceptance.md`.

## Rule 0 — one comparable configuration, one N

A stability statement may only pool attempts that share **one complete
configuration fingerprint**: provider runtime, observable CLI version, model,
backend, hardware, architecture, device, driver version, code revision (git commit
plus the actual content digest of the participating source tree, so a dirty tree
counts), operator families, candidate-task count, test matrix, prompt/selection
policy and budgets. Per-run identifiers — `observedTargets`, `sourceRunId`,
run/mission ids, paths and timestamps — are stripped before hashing: the same
configuration measured twice must hash identically, and a changed commit, dirty
source, model or budget must hash differently.

`summarizeAcceptanceRuns` groups by that fingerprint; a group is comparable only
when **every** entry is comparable, and a group with any `unknown` field (for
example an unobservable model or device, or a CLI/model value the driver only read
from an env/configured label — `declared` is not `observed`) is explicitly
non-comparable and can never claim N=20. Old or provider-mixed runs are never
re-pooled into the current denominator.

The model field is stricter than the CLI-version field: `provider.model` is only
comparable when the provider-reported `assistant.message.model` response was
actually observed under the frozen status/schema
(`modelSource === 'observed'`, `modelObservationStatus === 'observed'`,
`modelObservationVersion === operator-studio.model-observation/v1`). `probe`,
`system.init.model`, `result.modelUsage` keys and env/`declared` labels are
retained only as diagnostics and never make a group comparable. `provider.model`,
`modelSource`, `modelObservationStatus` and `modelObservationVersion` in the final
config are derived from the retained per-run summary; `declaredModel` /
`declaredModelSource` stay separate requested-configuration fields.

## Rule 0b — response-model label priority and evidence boundary

Only `assistant.message.model` (provider-reported) identifies the responding
model. Priority: response metadata > retained diagnostics (`system.init.model`,
`result.modelUsage`, CLI probe) > env/`declared`; a lower tier never upgrades a
higher one. An unknown/conflict model does **not** turn a real completed E2E into
a failure — it only keeps the run out of any N=20 comparison and the N=20 rule
stays a separate engineering batch rule, not a stability guarantee inferred from
the current `n20.eligible` sample threshold.

Per-run evidence is read **only** from the current attempt's own `runRoot`
(`bridge/<provider>-runs/*.json` with safe filenames, plus the live
`state.agent`/`state.runHistory` projection), with every run matched to the
expected Mission set fixed at Mission creation. Every started Agent run —
including failed, recovery, zero-candidate and teardown runs begun between two
polls — is retained as a required run in the attempt/summary top-level
`modelObservationRequiredRuns`; a run whose real session was never learned keeps
an explicit non-bindable `<unresolved-mission>` / `<unresolved-session>`
placeholder (fail-closed unknown, never a guessed identity). Host or historical
directories are never searched and old runs are never back-filled.

The driver itself keeps no private reader or DTO ranking: it calls the frozen
pure helpers `collectModelObservationEvidence` and `evaluateMissionStopReceipt`
in `scripts/shared-gpu-acceptance.mjs`. `runHistory` rounds carry no Mission field
of their own, so their Mission is completed from the current-attempt final record
— never relabeled with the current `activeMissionId`. The final physical record
is the observation authority: all reads of one filename must agree semantically
(a duplicate re-read dedupes, key order irrelevant), any conflicting content
fails closed in **either** order, a later unreadable/invalid/unknown/conflicting
record can never be masked by an earlier observed snapshot, and an unreadable or
identity-less new safe file stays in the denominator as an unbound required run.
Only a concrete foreign-Mission file that no known start references is ignored.

Each sweep of the current attempt's `runRoot` **rebuilds** the record set from the
latest physical reads instead of reusing a previous snapshot: a file that
disappeared, a read/parse failure, or a directory-enumeration failure becomes an
explicit error entry, so a run started between two polls cannot be silently
dropped and a lost final state can never masquerade as observed. The sweep result
(`enumerationError`, `discoveredFiles`) is retained as
`modelObservationSweep` in both the terminal attempt and the summary for audit
only; it is outside the config hash and never supplies a run identity. This is
provider-reported metadata, not independent attestation of the remote service.

Teardown is observed too. After each family (and, on error/timeout, in `finally`
before the Runtime is killed), the driver stops the still-owned Mission through
the real production API and retains the **original** HTTP status + `{state}` body
in `initialReceipt` — never overwritten by a later poll — together with every
later bounded read-only observation and the final state, plus the frozen
`evaluateMissionStopReceipt` verdict in `stopReceipts`/`teardownStop`. The stop
methods are declared outside the `try` so the error/timeout `finally` can reach
them: an errored run really calls the production stop before killing the Runtime,
and a stop failure is recorded as cleanup evidence without replacing the original
failure. An unconfirmed release can never be a `full_success` and forbids
starting the next Mission; a 202 is only confirmed by a bounded read-only
observation proving release (loop intent exactly `stopped`, explicit current
Mission release, a same-Mission Agent release for any nonblank current run, and no
pending `resourceReleaseBarrier` for any research/materializer/benchmark/GPU
resource). Every stop and read-only final state is also scanned for Agent start
identities, so a run begun between two polls still enters the required set.
Teardown stops are recorded in `teardownWrites`, separate from
`workflowWritesAfterStart`; they never advance the loop or inject a candidate.

## Rule 1 — complete the real smoke before any N=20 batch

Run the real two-round production path first and confirm it actually completed:

```powershell
# Default provider is claude-code, matching the main acceptance wording.
$env:E2E_AGENT_RUNTIME = 'claude-code'
$env:E2E_GPU_FAMILIES = 'affine'
npm.cmd run e2e:shared-gpu-agent-iteration

# Codex is an explicit override only.
$env:E2E_AGENT_RUNTIME = 'codex-cli'
npm.cmd run e2e:shared-gpu-agent-iteration
```

The driver is a read-only observer: it drives only baseline/setup commands and
never injects candidates, overrides the Gate or advances the loop itself
(`workflowWritesAfterStart` must be 0).

A family is `full_success` only when all of the following are real:

- two **distinct** completed candidates on the real GPU queue (4/4 correctness,
  `primary`/`small` profiles, `source=local-shared-gpu`, `publishable=false`);
- the first candidate round was archived as `reference`/`reject`;
- the production loop automatically rolled back the workspace
  (`workflow.round_rolled_back`, `workspaceClean: true`) and started the next
  Agent round;
- the continuation prompt audit for the round frozen in
  `sourceRound.roundFacts.target.roundId` passes `verifyContinuationAudit`
  (digest/bytes recomputed, experience id/version/full content, frozen facts,
  candidate/queue-bound selection).

Only then may the same fingerprint be repeated toward N=20. The smoke itself is
one sample, not evidence of stability.

## Rule 2 — a safe budget stop is not a full success

If the bounded budget stops the loop before a second candidate, the attempt may be
recorded as `budget_terminal` (`fullSuccess: false`) **only** with:

- the **current** loop recording a bounded-budget reason (`round_budget` /
  `total_budget`, or — only when no current reason exists
  — a current-bound budget runtime event), and
- an explicit confirmed execution resource release (`resourceRelease.confirmed ===
  true`), with no pending/unconfirmed/quarantined/blocked projection and no
  unresolved current quarantine.

A terminal Agent status is not release proof. A current non-budget reason (for
example a candidate-generation failure) is authoritative: a historical
`loop.round_budget_exceeded` event never upgrades it. A bare `needs_human` is a
failure: invariant guards, candidate-generation failures, unresolved baselines
and unconfirmed release are never accepted as a safe terminal fallback. A
`budget_terminal` result stays in the ledger denominator; it is never counted as
a completed two-round run, and a bare boolean budget flag (without the evidence
object) can never produce it.

## Rule 3 — keep every attempt, including failures and missing summaries

Each driver invocation writes `attempt.json` next to its retained artifacts:

- `phase: running` **before** the Runtime starts, so an interrupted attempt stays
  visible;
- `phase: terminal` in `finally`, with `outcome`, `fullSuccess`, normalized
  config fingerprint (including git commit, dirty flag and the content digest of
  the participating source tree), relevant source digests, provider/CLI version
  and the summary-derived model/status/source/version, observed device and driver
  version (empty/`unknown` if the real runner did not report them), backend,
  families, budgets, completed/unfinished families, failure and cleanup.

The terminal attempt and summary both carry the response-model proof at top
level — `modelObservations`, `modelObservationRequiredRuns`,
`modelObservationSummary`, `modelObservationUnboundRuns` — in every branch
(`full_success`, `budget_terminal`, failure, timeout), plus the final physical
sweep result `modelObservationSweep`. They also retain the
teardown evidence (`stopReceipts`, `teardownStop`, `teardownWrites`). These stay
outside the config hash; run/session ids never split a same-configuration group.
`declaredModel`/`declaredModelSource` remain separate requested-configuration
fields and never upgrade the observed proof. Legacy records are counted but stay
non-comparable and are never back-filled.

`summary.json` carries the same `schemaVersion` / `outcome` / `fullSuccess` /
config / evidence pointers plus per-family summaries and the same top-level model
evidence. All run artifacts are retained for audit; nothing is deleted to improve
a ratio.

Ledger (explicit run directories only, never launches a run):

```bash
node scripts/summarize-gpu-agent-runs.mjs <runDir> [runDir...]
node scripts/summarize-gpu-agent-runs.mjs --json <runDir> [runDir...]
```

It counts `full_success`, `budget_terminal`, `failure`, `timeout` and
`missing_summary` separately per run and groups by fingerprint. Missing summaries
and timeouts are never silently dropped and stay in the stability denominator of
their group. Identities are aliases of **one run**: `attemptId`, `runRoot` and the
resolved `runDir`, so any record matching an existing alias — including two records
that share a `runDir` — is the same run and counts exactly once with a warning.
Aliases can never accumulate toward an N. If aliased records disagree on outcome,
the kept entry is classified as a `failure` (`duplicate_record_conflict`), never
upgraded. A contradiction — an explicit failure, a missing/running attempt, an
invalid schema, a summary-versus-family disagreement, or an attempt/summary config
or fingerprint mismatch — is likewise classified as a failure and can never be
upgraded to `full_success`; a group containing any such run or any run without a
valid terminal attempt is not N=20 eligible.

The ledger independently recomputes the model summary from the retained
`modelObservationRequiredRuns` + `modelObservations` (it never trusts the
persisted `modelObservationSummary`) and compares it with both files' proof and
the config claims. Missing/foreign/malformed/conflicting evidence, attempt-summary
model disagreement, or a forged/contradicted config label makes only the
comparability non-comparable — the classified outcome
(`full_success`/`budget_terminal`/failure/timeout/missing) and the stability
denominator are unchanged. Legacy records without model proof stay counted and
non-comparable; nothing is back-filled from the host or another directory.

## Rule 4 — operator-family coverage and stability are separate claims

`E2E_GPU_FAMILIES` defaults to `affine,reduction,normalization`. A run that covers
all three families in one attempt is coverage evidence only. Stability requires a
same-fingerprint N=20 batch, and the fingerprint includes the family set: a
three-family batch and a single-family batch are different configurations and are
never pooled. Report coverage and stability as two separate results.

## Rule 5 — never fake a hardware sample

Do not synthesize `attempt.json` / `summary.json`, do not back-fill an `unknown`
architecture/model from the current host, and do not copy a sample from another
provider or version. The observed target is whatever the real runner reported
(`iterationStats.resolvedTarget`); if it is absent the run is non-comparable.
`source=local-shared-gpu` observations remain `hardware-observation` and
`publishable: false` — a passing regression is not a publication claim.

## Verification of the acceptance tooling itself (hardware-free)

The observation and ledger code is pure and testable without a GPU or Agent:

```bash
node --check scripts/e2e-shared-gpu-agent-iteration.mjs
node --check scripts/shared-gpu-acceptance.mjs
node --check scripts/summarize-gpu-agent-runs.mjs
node tests/model-observation-test.mjs
node tests/model-observation-acceptance-test.mjs
node tests/shared-gpu-acceptance-test.mjs
node tests/shared-gpu-model-collector-test.mjs
node scripts/summarize-gpu-agent-runs.mjs <retainedRunDir>
```

These prove observer/ledger classification only. Running the real driver, the
GPU, or a real Agent session is a separate, independently scheduled activity; it
is never part of a hardware-free check. The newest real affine two-round smoke and
any model observation on real hardware are **pending**, not passed.

## Explicit non-claims

- No N=20 stability, no long-run stability and no real-instrument publication.
- `n20.eligible` is a comparability/denominator eligibility flag, not a stability
  conclusion; the strict N=20 release rule is a separate frozen engineering gate.
- No provider-equivalence claim: running one provider does not verify another.
- The model observation is provider-reported metadata, not independent
  attestation of the remote service; the live path has not been re-run for this
  batch.
- `prepared-before-send` audits prove what production prepared, not that a live
  provider received or obeyed it.
- A `budget_terminal` attempt and a covered multi-family smoke do not certify
  performance or correctness beyond the retained per-task evidence.
