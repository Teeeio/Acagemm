# Shared-GPU regression batch runner (`run-shared-gpu-regression-batch.mjs`)

Status: thin orchestration contract for the real shared-GPU Agent regression.
Authority: `docs/development/REAL_GPU_REGRESSION.md` Rules 0–5,
`docs/development/MODEL_OBSERVATION_ACCEPTANCE.md` (N20 strict release rule),
`docs/development/P2_EVIDENCE_ACCEPTANCE.md` and `scripts/shared-gpu-acceptance.md`.

## Scope

This tool is a **batch entry point only**. It does not define a second driver,
scheduler, provider, Gate or matrix:

- every invocation runs the unchanged existing driver
  `scripts/e2e-shared-gpu-agent-iteration.mjs` as a child process
  (`process.execPath`, absolute script path, `shell: false`);
- classification is the unchanged read-only ledger from
  `scripts/summarize-gpu-agent-runs.mjs` (`readRunRecord`,
  `classifyAcceptanceRecord`, `summarizeAcceptanceRuns`) over the artifacts that
  driver retained;
- the only driver change it relies on is the artifact-parent override
  `E2E_GPU_ARTIFACT_DIR` (see below). The frozen matrix, test spec, task
  timeout, candidate-task count and budgets are **not** touched.

Importing the module has no side effects: no spawn, no file write, no provider,
GPU or model call. Only the CLI executes a batch.

Hardware-free guarantees: a missing, unknown or invalid argument makes the CLI
exit non-zero **before any spawn**, and a batch is never executed on import.

## CLI

```bash
node scripts/run-shared-gpu-regression-batch.mjs \
  --mode smoke|n20 \
  --families affine|reduction,normalization \
  --artifact-dir <absolute> \
  --report-dir <absolute> \
  --gpu-python <absolute>
```

- `--mode smoke` runs exactly **1** two-round attempt.
- `--mode n20` runs exactly **20** independent attempts and only accepts
  `--families affine` (a coverage family set can never enter the affine N20
  denominator). `n20` additionally **rejects the controlled-study environment**
  (`E2E_EXPERIENCE_CONDITION` / `E2E_KERNEL_WIKI_SNAPSHOT`) with a non-zero exit
  **before any directory is created or any driver is spawned**, so a
  three-per-condition study result can never be silently labeled strict N20
  evidence. The study has its own smoke-only runner
  (`scripts/run-experience-condition-study.md`).
- `--artifact-dir` receives the large raw per-run directories and the raw
  merged driver logs (`<artifact-dir>/logs/run-NN.log`). It may be created.
- `--report-dir` receives only the small `batch.json` / `ledger.json` reports.
  It **must not exist yet**; an existing directory is never overwritten. Its
  missing parent directories are created first, so a fresh snapshot without
  `.operator-studio-local/` works; only `--report-dir` itself is refused.
- Both directories must be absolute and must not be the repository root or one
  of its ancestors; a repository subdirectory (for example an ignored report
  directory) is allowed. `--gpu-python` must be absolute.
- `--artifact-dir` and `--report-dir` must differ.

Fixed environment overrides (everything else is inherited, including the
provider CLI configuration and `PATH`):

| Variable | Value |
| --- | --- |
| `E2E_AGENT_RUNTIME` | `claude-code` |
| `E2E_GPU_CANDIDATE_TASKS` | `2` |
| `E2E_GPU_TIMEOUT_MS` | `720000` |
| `OPERATOR_MAIN_AGENT_BUDGET_MS` | `180000` |
| `OPERATOR_CODEX_LOGICAL_CLEANUP_MS` | `60000` |
| `OPERATOR_GPU_PYTHON` | `--gpu-python` value |
| `E2E_GPU_FAMILIES` | `--families` value |
| `E2E_GPU_ARTIFACT_DIR` | `--artifact-dir` value |

The driver without the override still uses its historical in-repo
`.tmp-real-agent` parent. With the override every run still gets its own
`mkdtemp` run root below the override; the driver mkdtemp isolation is unchanged.

## Original denominator, no substitution

`batch.json` (`operator-studio.shared-gpu-regression-batch/v1`) is written
**before the first spawn** and atomically replaced (`tmp` + `rename`) after every
state change:

```
{schemaVersion, mode, families, requestedRuns, startedAt, finishedAt, status,
 invocations: [{index, status, startedAt, finishedAt, exitCode, signal, runRoot,
                logPath, outcome, comparable, configFingerprint, issues}],
 stopReason, strictN20Passed}
```

- The invocation array always keeps the full original denominator (1 or 20).
  An invocation that is never spawned because the batch stopped stays present as
  `status: "stopped"` with `batch_stopped`; it is never removed and never
  replaced by a substitute run. There is no 21st sample and no re-run of a
  consumed index.
- A running index is appended before its spawn and updated atomically after its
  terminal state.
- Every started attempt — including failures, `unknown` response-model runs and
  attempts whose run root was not retained — is passed to the ledger.
  `ledger.json` is the raw `summarizeAcceptanceRuns(records)` output, so
  `full_success`, `budget_terminal`, `failure`, `timeout` and `missing_summary`
  all stay in their own group's stability denominator.
- A run root is taken only from the driver's single retained-artifacts line
  (or the injected invoker's return). A missing, duplicated or out-of-scope run
  root is recorded as an explicit issue (`run_root_missing`,
  `retained_artifacts_line_missing`, `retained_artifacts_line_duplicated`,
  `run_root_out_of_scope`) and never guessed. Every occurrence of the line is
  retained, so the same line naming the same path twice is still
  `retained_artifacts_line_duplicated`.
- Any invoker issue (missing/duplicate/out-of-scope run root, driver process
  error, log open/write failure, a read port that throws) becomes a batch
  `stopReason` and forces the final status to `failed`; it is never absorbed.
  A read failure still produces an explicit missing ledger record and a terminal
  batch write, so no invocation is left as `running`.
- Progress is emitted live as `DISPATCH_PROGRESS {json}` lines with
  `phase` / `completed` / `total` / `message`. Driver stdout/stderr are streamed
  chunk-by-chunk into the raw log and are never accumulated unbounded in memory.
  Raw chunks are written to the log undecoded (a multi-byte UTF-8 sequence split
  across chunks stays intact); only the stdout line parse uses a `StringDecoder`.
  The log file is opened before the driver is spawned, and a later log stream
  error is captured and fails the invocation instead of surfacing as an
  unhandled error with a still-running entry.

### Continuation safety (stop before the next spawn)

After each terminal invocation the batch decides whether another attempt may be
spawned:

- **both** the retained attempt and its summary must be present, schema-valid,
  terminal and outcome-compatible (`summary_missing`, `summary_not_terminal`,
  `attempt_summary_outcome_mismatch`, ... otherwise). A terminal attempt with a
  missing summary is not a safe terminal state;
- its stop receipts (or the teardown stop) must confirm resource release, and a
  spawned runtime must have exited (`runtime_exit_missing` otherwise). An absent
  cleanup block is never treated as confirmed. Release proof may only be skipped
  when the driver never spawned a runtime — `stopReason: unsafe_continuation:
  ...`. An existing `teardownStop` that is *not* confirmed is reported separately
  (`teardown_stop_unconfirmed`), so one confirmed proof never hides the other
  unconfirmed one and a missing field stays unknown (unsafe);
- the model-independent configuration (including the code commit and content
  digest) of every invocation must match the first one —
  `stopReason: config_or_source_drift`;
- two different **observed** response models stop the batch —
  `stopReason: observed_model_drift`. A genuinely `unknown` model does not stop
  the batch, but it keeps that run non-comparable and can never pass;
- an invoker issue stops the batch (`stopReason: invoker_issue: ...`);
- `smoke` stops unless the single attempt is a complete `full_success`.

A retained comparable failure (or an `unknown` model) with a terminal,
summary-backed and release-confirmed record does **not** stop an `n20` batch: it
is kept in the original denominator and the remaining original invocations
continue. Only the conditions above stop the batch early.

`continuationSafety(record)` is exported so the controlled experience-condition
study checks a retained slot with the **exact same** smoke release/observation
semantics (`{safe, issues}`) instead of a weaker copy of them; it is pure and
reads only the existing driver DTOs.

Before any directory is created or driver spawned, an `n20` batch **refuses** the
study environment (`E2E_EXPERIENCE_CONDITION` / `E2E_KERNEL_WIKI_SNAPSHOT` set):
a controlled study result is never strict N20 evidence. `smoke` is the only mode
that may run with a study condition, and it is the mode the study runner uses.

### `strictN20Passed`

Reported `true` only when **all** of the following hold:

- mode is `n20` and exactly 20 invocations were requested;
- every one of the 20 invocations is `full_success` with exit code `0`;
- the ledger contains one comparable group with 20 retained unique attempts
  (`n20.eligible`) whose `full_success` count is the full requested 20;
- **no** `stopReason` was recorded, i.e. every started attempt also reached a
  safe, summary-backed, release-confirmed terminal state with no invoker issue.

A `smoke` batch never declares `strictN20Passed` and passes only when its single
attempt is a comparable `full_success` with no `stopReason` (an `unknown`
response model keeps its workflow outcome but fails the batch). A `passed`
`n20` batch likewise requires `strictN20Passed`. `unknown`/non-comparable runs,
`budget_terminal`, failures, missing summaries and duplicate identities can never
satisfy it. This is the strict engineering batch rule, not a stability or
publication claim.

## Exit codes

| Situation | Exit code |
| --- | --- |
| `smoke` with the single attempt `full_success` | `0` |
| `n20` with `strictN20Passed === true` | `0` |
| argument/setup error (before any spawn) | non-zero |
| any failure, `budget_terminal`, `unknown`/non-comparable sample, missing summary, stopped batch | non-zero |
| any recorded `stopReason` (`unsafe_continuation`, `config_or_source_drift`, `observed_model_drift`, `invoker_issue`) or a `smoke` run that is not a comparable `full_success` | non-zero |

## External save and boundaries

Raw run directories, state snapshots and merged driver logs belong in the
private scratch/external `--artifact-dir` (`DISPATCH_SCRATCH_DIR` in a dispatch
run); only the small `batch.json` / `ledger.json` reports are written to
`--report-dir`. Nothing is deleted to improve a ratio, no hardware sample is
synthesized or back-filled, and no real GPU/model execution happens during
verification of this tooling.

## Hardware-free verification

```bash
node --check scripts/run-shared-gpu-regression-batch.mjs
node --check scripts/e2e-shared-gpu-agent-iteration.mjs
node tests/shared-gpu-acceptance-test.mjs
node tests/model-observation-acceptance-test.mjs
```

The batch logic is exercised without a GPU by importing the module and calling
`runRegressionBatch(options, { invokeDriver })` with an injected invocation port
that returns a retained fixture run root and an exit code; no child process is
spawned in that mode.
