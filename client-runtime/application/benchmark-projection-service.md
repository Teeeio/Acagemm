# Benchmark Projection Service Contract

Projects a running Operator Test task into Mission benchmark state, using queue-first and test-service fallback reads. Completed results are persisted to mission artifacts; transient service errors become stable `lastServiceError` metadata. Input/output are `{ state }` plus `{ changed, state }`.

This is an advancement-only service: artifact writes and evidence projection are
not query behavior. Production injects collectExperience to record terminal
candidate observations through the trusted round-experience service. Missing
package bindings are explicitly skipped; observation failures remain visible in
iterationStats.experienceCollection without rewriting test/Gate evidence. Final
rounds are collected here even when no subsequent Agent round is started. Its queue `get` port is bound to read-only `readTask`; the
surrounding pipeline calls `processTests()` once before projecting the snapshot.

## Terminal observation preflight

`createBenchmarkProjectionService` accepts one optional port,
`preflightExperience({ state, mission })`. Production binds it in the existing
composition call to `roundExperienceService.preflightCollection`, alongside the
unchanged `collectExperience: roundExperienceService.collect`.

Inside the existing terminal branch (the `collectExperience` port is a function
and `benchmark.status` is `complete`/`failed`/`cancelled`) the service awaits
`preflightExperience({ state, mission })` first, only when it is a function, and
then awaits `collectExperience({ state, mission })` exactly once. Both hooks
receive the same `state` object and the same Mission resolved from
`activeMissionId`. A `ready` or `skipped` preflight return is not a new gate: it
still collects. Omitting the port preserves prior behavior, and when no
`collectExperience` port is present the preflight does not run either (no collect
means no preflight).

A thrown preflight error is handled by the existing experience failure
projection, so it blocks `collectExperience` and is reported through the existing
DTO `iterationStats.experienceCollection = { status: 'failed', error: { code,
message, effectUnknown } }` with `code` defaulting to `ROUND_EXPERIENCE_FAILED`
and `effectUnknown` to `false`. It does not change the benchmark status, the
Operator Test outcome or Gate verdicts, and a successful `complete` result still
writes `benchmark.json`, `tracer.json`, `profiler.json` and
`test-result.json`.

Behavior is terminal-only: nonterminal states (`running`/`idle`/`queued`) and a
read of an already-terminal task start neither hook, so an uncertain experience
write is never replayed. Preflight deadlines stay owned by the round-experience
service (`min(30s, remaining Mission/Round)`); collection remains capped at 3000
ms and neither budget is renewed here. This service adds no GPU, network, retry,
package or dependency behavior, and passing focused injected fakes demonstrates
only wiring and ordering, not that real GPU/N20 failures are fixed.
