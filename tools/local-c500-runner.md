# local-c500-runner diagnostics contract

Runner progress records remain temporary-file + atomic replacement writes.
On Windows, `_write_runner_status` retries replacement denied with WinError
5/32/33 for at most one monotonic second, sleeping up to 25 ms between attempts.
The old complete JSON stays visible until the replacement succeeds. Persistent
denials and all other errors still propagate; there is no direct-write fallback,
success fabrication or budget renewal. The wait consumes the existing task and
Mission deadlines. Shared-GPU execution inherits this same progress writer.
`tests/local-c500-runner-contract-test.py` covers real Windows handles with and
without timely release, and unclassified errors on every platform.

`local-c500-runner.py` owns the fixed Correctness/Benchmark matrix and the
optional mcTracer/mcProfiler diagnostic collection. `local-shared-gpu-runner.py`
reuses the same `_run` path and only replaces the hardware probe and the
benchmark timer, so this diagnostic contract applies to both backends. The
existing real tool invocation entry points
(`OPERATOR_LOCAL_C500_MCTRACER_COMMAND` / `OPERATOR_LOCAL_C500_MCPROFILER_COMMAND`
and the `mctracer` / `mcProfiler` binaries on `PATH`) are preserved unchanged.

## `OPERATOR_DIAGNOSTICS_MODE`

Accepted values: `unavailable` (default) and `mock`. Any other non-empty value
raises an explicit error before correctness or benchmark work starts; an unset
or empty value is the default `unavailable`. The value is recorded as
`environment.diagnosticsMode`.

Exact priority when collecting one diagnostic:

1. `mock`: produce a simulated record only. No process is spawned, even when a
   command is configured or the tool is on `PATH`.
2. a command is configured via `OPERATOR_LOCAL_C500_MCTRACER_COMMAND` /
   `OPERATOR_LOCAL_C500_MCPROFILER_COMMAND`, or the tool is on `PATH`: keep the
   real invocation.
3. neither exists: return `unavailable` without inventing content.

`mock` is therefore never a downgrade of a real run, and `unavailable` never
suppresses a real tool that is actually present.

## Collection record (`_analysis_tool`)

| status | source | meaning |
|---|---|---|
| `completed` | `tool` | a real process ran and exited 0 |
| `failed` | `tool` | a real process ran and exited non-zero, or invocation failed |
| `unavailable` | `unavailable` | no command configured and no tool on `PATH` |
| `mocked` | `mock` | simulation only; `simulated=true`, `real=false`, no process |

Raw `stdout.txt` / `stderr.txt` and the artifact directory are always written
under `analysis/<tool>/` and their paths stay in the record for a future real
parser. The record also carries `tool`, `attempted`, `command`, `exitCode`,
`durationMs` and byte counts.

`_analysis_tool(..., mode=...)` validates an explicit optional `mode` against
the same `unavailable|mock` allow-list as the environment variable; an illegal
mode raises instead of silently falling through to a real invocation.

## Result projection (`_diagnostic_result(kind, collection, binding)`)

Pure, testable projection. `kind` is `tracer` or `profiler`; `collection` is an
`_analysis_tool` record; `binding` is
`{candidateDigest, runId, taskId, sourceRunId, semanticDigest}`.

- `format`: `operator-trace/v1` for tracer, `operator-profile/v1` for profiler.
- `status` / `source` / `simulated`: copied from the collection, with two
  conservative rules. (1) Mock provenance wins over a contradictory status: an
  explicit `source=mock` or `simulated=true` is always normalized to
  `status=mocked` / `source=mock` / `simulated=true`, whatever the incoming
  status was. (2) A `completed`/`failed` record without a `source` cannot prove
  a real collection, so it is reported as `source=unknown` rather than promoted
  to `tool`; only a real record that explicitly declares `source=tool` is a real
  tool execution. `mocked` is never rewritten to `completed`.
- `binding`: projected verbatim from the task's real fields
  (`task.candidate.digest`, `task.payload.requestId`, `task.taskId`,
  `task.candidate.sourceRunId`, `task.semanticSnapshot.digest` or
  `payload.semanticBinding.semanticDigest`). `runId` is the benchmark-command
  `requestId` (the queue run identity); the backend `taskId` is a different
  identity and is never substituted for it. A missing field stays `null`;
  nothing is filled from the current time, a benchmark number or a guessed
  default.
- `events` (tracer) / `metrics` (profiler): always `[]` / `{}` until a real
  parser consumes the retained raw output. A successful tool exit only proves
  the collection command ran. Tool-process events and benchmark `p50`/`p95` are
  never written as diagnostic content; benchmark timings stay in `benchmark[]`.
- `diagnostics`: the collection error plus an explicit note for
  `mocked` / `unavailable` / `unknown` / `completed` / `failed` explaining what
  the status does and does not prove.
- `artifacts`: the raw collection record (tool, command, artifactDir, raw
  stdout/stderr paths, exit code, duration); its `simulated` flag is kept
  consistent with the normalized verdict.

## Terminal correctness and result persistence

`_run` persists a structured terminal state for every outcome instead of leaving
only stderr. `correctness.json` and `result.json` are each written with a
temporary file plus `os.replace` in the destination directory; a direct write of
either final path (including an atomic replace followed by a plain overwrite) is
not allowed. A failed execution carries `status=failed`, `benchmark=[]`,
`publishable=false`, the retained `environment` and, when the task provides it,
the admitted `executionPackage` binding.

`_run_correctness` returns the typed correctness contract
(`docs/development/FAILED_EXECUTION_FEEDBACK_ACCEPTANCE.md`):

- `status=passed|failed`, `passed=true|false`; `total` stays the requested case
  count and is never lowered to the attempted prefix.
- `executedCases`/`passedCases` count real attempted/passed cases;
  `caseResults` is the actual early-stop prefix, `failedCase` is one-based and
  `failedCaseName`/`failedCaseCategory` identify the real case.
- Each failed case carries `error` (the real message string) and `failure` (the
  typed first failure); `correctness.failure` and `result.error` are that same
  typed value, and preceding successful cases stay in `caseResults`.

Frozen neutral codes for this base path: `OPERATOR_CORRECTNESS_MISMATCH`
(phase `correctness`, role `candidate`) for an oracle comparison mismatch
including an output shape/type/numeric/cosine failure, `OPERATOR_CANDIDATE_EXCEPTION`
(phase `correctness`, role `candidate`) when `candidate.run` throws (the case was
attempted, never `not_run`), and `OPERATOR_ORACLE_EXCEPTION` (phase
`correctness`, role `oracle`) when oracle input generation (including a throwing
`make_inputs`) or `reference` throws. A reference-cache failure is backend
infrastructure, not an operator failure: it keeps the passed prefix with
`OPERATOR_REFERENCE_CACHE_FAILURE` at role `backend`.

Each stage of a selected named case preserves that case's index and the
already-observed prefix. Input generation and dtype resolution run under the
oracle role; output diagnostics and the comparison run under the candidate role,
so a shape/type error in the numeric difference is a candidate correctness
mismatch and never a generic outer `OPERATOR_ORACLE_EXCEPTION` or `not_run`.
Numeric diagnostics that were not really computed stay `null`, never a
fabricated `0`; only a known empty tensor pair keeps its actual zero difference.

A benchmark-stage exception after correctness passed preserves the passed
correctness (`correctness.failure`/`correctness.error` stay `null`) and records a
`phase=benchmark`, `role=backend` error; it is never relabeled as a correctness
mismatch. The passed `correctness.json` is written atomically as soon as
correctness completes, before any benchmark work starts, so the observed facts
survive a later benchmark failure. Preflight, task/matrix (including a malformed
`testSpec`/tolerance), module-load and hardware-probe failures persist a
structured failed record with an accurate phase/role and a `not_run` correctness
(requested total when matrix metadata was parsed); a missing probe is never
replaced by current-host/default metadata.

## Evidence rule

`format` validity does not imply `available`, and `available` does not imply
`evidenceEligible`. A rule that requires real diagnostic evidence must check
that the status is a real completion, the source is not `mock`, the binding
matches the current candidate and run, and the actual content satisfies that
diagnostic rule. Values that arrive with `simulated=true` / `source=mock`
never qualify, regardless of their content.
