# Real shared-GPU Agent regression and sample ledger

Status: procedure/contract for the real shared-GPU regression only. It does not
contain hardware results, does not certify N=20 and does not claim publishability.
Current state (2026-09-12): no new GPU / real Agent run has been made for Phase 2,
the driver has **not observed a model value** (a `declared`/env label cannot make a
group comparable). Phase 2 hardware-free gates passed (release 136 / non-hardware 38,
exit 0); they do not add hardware samples — see
[`evidence/p2-evidence-20260912/README.md`](evidence/p2-evidence-20260912/README.md).
The ordered follow-up is: first observe the model, then a same-configuration real
two-round smoke, with family coverage and N=20 reported **separately**. Running the
driver 20 times is not by itself an N=20 qualification.

Every configured operator family must have consistent attempt/summary outcomes.
Missing summaries and failed attempts remain in the denominator. Duplicate
identities cannot increase N; contradictory duplicates remain visible as failure.
Only current Mission/Agent release confirmation can establish a budget-safe stop;
an invalid budget configuration is a failure. Full two-round success and a safe
budget terminal have separate console and summary statuses.
Authority: `P2_EVIDENCE_ACCEPTANCE.md` "Deferred evidence",
`TEAM_HANDOFF.md` §6/§10/§12. The observation/statistics contracts are documented
in `scripts/shared-gpu-acceptance.md`.

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
  and model with their provenance — `observed` only when the live Runtime/CLI
  reported them, otherwise `declared`/`unknown`, never guessed — observed device
  and driver version (empty/`unknown` if the real runner did not report them),
  backend, families, budgets, completed/unfinished families, failure and cleanup.

`summary.json` carries the same `schemaVersion` / `outcome` / `fullSuccess` /
config / evidence pointers plus per-family summaries. All run artifacts are
retained for audit; nothing is deleted to improve a ratio.

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
node scripts/summarize-gpu-agent-runs.mjs <retainedRunDir>
```

Running the real driver, the GPU, or a real Agent session is a separate,
independently scheduled activity; it is never part of a hardware-free check.

## Explicit non-claims

- No N=20 stability, no long-run stability and no real-instrument publication.
- No provider-equivalence claim: running one provider does not verify another.
- `prepared-before-send` audits prove what production prepared, not that a live
  provider received or obeyed it.
- A `budget_terminal` attempt and a covered multi-family smoke do not certify
  performance or correctness beyond the retained per-task evidence.
