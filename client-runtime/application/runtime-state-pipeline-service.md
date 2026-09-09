# Runtime State Pipeline Service Contract

`advance({ state, runtime })` runs runtime maintenance, compatibility migration,
Baseline failure projection, workflow/Agent projection, serialized test processing,
Benchmark projection, repository adoption, then automatic iteration advancement.
It returns `{ state, changed }` and is never called by snapshot queries or SSE.

The pipeline receives all effects through ports. The required
`runtimeAdvanceService.canStartNewWork(state)` port is checked before maintenance
and repository adoption. Pause, budget exhaustion or an outstanding
resource-release barrier suppresses new Agent/iteration work across the entire
pipeline, not only the final Autopilot step. A benchmark already committed in
`state.benchmark.testTaskId` remains dispatchable/pollable while paused so its
frozen queue task can reach a terminal outcome; this does not admit adoption or
the next round.
`processTests({ allowStart })` is bound to non-blocking Queue dispatch; with
`allowStart: false` it only observes/drains existing work. Backend waits do not
hold the State Repository lock. It may report
`OPERATOR_TEST_QUEUE_BUSY`; in that case it still projects the last atomic queue
snapshot. Other processing errors propagate. Benchmark projection receives a
read-only queue port and does not dispatch a second time in the same tick.

The service does not load, persist or lock state. Runtime Lifecycle coordinates
recovery and persistence; the composition root supplies the outer State Repository
exclusive scope. There is no nested lock and no second workflow for manual advance.
