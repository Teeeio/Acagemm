# local-c500-runner diagnostics contract

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

## Evidence rule

`format` validity does not imply `available`, and `available` does not imply
`evidenceEligible`. A rule that requires real diagnostic evidence must check
that the status is a real completion, the source is not `mock`, the binding
matches the current candidate and run, and the actual content satisfies that
diagnostic rule. Values that arrive with `simulated=true` / `source=mock`
never qualify, regardless of their content.
