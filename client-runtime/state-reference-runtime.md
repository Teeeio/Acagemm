# State Reference Runtime Contract

## Purpose

Project existing reference-fixture Agent and Benchmark progress in memory.

## Responsibilities

Compute elapsed-time progress, fixture metadata, review readiness and display logs.

## Non-Responsibilities

No Agent/hardware execution, queue, Gate, adoption, Workspace or snapshot effects.
Display artifacts are records, not generated files or proof of execution.

## Public API

| Export | Input | Output |
|---|---|---|
| `refreshReferenceBenchmark(state)` | Running fixture Benchmark state | Same state object |
| `refreshReferenceAgent(state)` | Running fixture Agent state | `{ state, changed }` |
| `buildBenchmarkLogsForMatrix(progress, matrix = {})` | Progress and optional environments | New log array |
| `buildBenchmarkLogs(progress)` | Progress | New legacy log array |

## Inputs

Callers establish a valid reference-fixture context; this module does not check
runtime mode. Progress needs running status, `startedAt`, parseable timestamps
and positive `durationMs` (milliseconds); no validator is added. Matrix logs default
to C550/CUDA and reuse the first environment when only one exists.

## Outputs

Benchmark refresh mutates progress/logs and, at completion, stage, review and Agent
state. Pending human review stays on the approval path; otherwise review becomes
`auto_ready`, without adopting a Candidate. Its completion event uses the existing
`completedAt` guard.

Agent refresh returns a shallow new state with a replacement Agent, while also
mutating the input stage/events/audit when completion requires it. Callers must use
the returned state. `changed` compares old/new Agent JSON, not every state field.
Inactive refreshes return the original state; Agent additionally returns `false`.
Agent completion events retain their per-run guard.

## Invariants

Fixture `Level 3`, correctness and latency text is not live-hardware evidence and
must never satisfy the production Gate. The application maintenance service owns
mode gating and advancement order; snapshot queries do not invoke these refreshes.

## Dependencies

Only `state-reference-data`, `runtime-events` and `evidence-state`. No state-store,
filesystem, HTTP, Provider, queue-execution or hardware implementation imports.

## Side Effects

In-memory changes above; refreshers read `Date.now()`/`Date` directly. Progress is
clamped to 0-100 in ten-point buckets. Log builders only filter threshold records
and do not read a clock. Runtime/audit records use canonical bounded appenders.
No I/O, timers, processes or real test results are produced.

## Error Contract

No error codes, retries or recovery. Malformed states retain JavaScript/time
arithmetic behavior; existing non-running records are unchanged.

## Example

```js
const logs = buildBenchmarkLogsForMatrix(40, { environments: ['C550'] });
```

## Verification

```bash
npm run test:mission-project-state
npm run test:state-domain-boundary
npm run test:runtime-maintenance-service
npm run test:state-store-projection
npm run test:smoke
```

## Change Checklist

Preserve facade exports, mutations, thresholds, review branches and fixture tests.

## Known Limitations

Logs retain example counts and measurements, without validation or conversion
to real evidence. Clock injection and stricter validation are not added.
