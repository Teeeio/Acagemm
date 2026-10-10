# Autopilot Strict Source Service Contract

Advances strict-zero-source Missions through Research, semantic fallback, Baseline materialization, and candidate Agent start. Missing authoritative sources resolve to `needs_human`; simulation or unrelated sources are never admitted. Returns `{ state, action }` or `null`.

## Unified research policy

The necessary baseline-source research start goes through
`resolveAutomaticResearch({ trigger: 'baseline_source' })` with an explicit `acquire` phase and budget.
When automatic research is disabled the service returns an explicit `needs_human` state with
`loopStatusReason = research_disabled_source_unresolved` instead of starting acquisition or relaxing the
source gate.

## Terminal unresolved source projection

When the research agent reaches a terminal state without a verifiable source, the service records
`state.workflowFailure = buildBaselineSourceFailure({ state, mission, now })` before returning the
unchanged `needs_human` action. The projected error keeps `phase='baseline.source'`,
`source='baseline-source'`, `retryable=false` and stop policy derived by the shared
`workflow-error.mjs` rules (cancelled -> `user_cancel`/`stopped`, timed_out -> `timeout`,
completed-without-source -> `configuration`; only these statuses override the category, while a
`failed` research keeps its real original code, message and category — never a blanket one).
Any terminal status without an original error reports `BASELINE_SOURCE_UNRESOLVED` with the
explicit no-verifiable-baseline-source message. `details` carries the frozen research identity
(`missionId`, `runId`, `threadId`, `startedAt`, `researchStatus`, `runPhase`,
`researchDir = research.researchDir || null` — the materializer workspace helper is never used
here), a deep clone of the FULL original error and the deep-cloned source constraints; no source
is ever synthesized. `now` is an optional injected clock consulted only when neither
`research.completedAt` nor a previous `baseline.source` failure with the identical nonempty
`runId`/`missionId`/`startedAt`/`researchStatus`/`runPhase` identity supplies the time.
The strict unhandled `acquire` path still returns `none`.

Original code, message and valid HTTP status are preserved, including nested error records;
only status-specific category and the non-retrying policy override the original classification.
The helper reads the same `state.researchAgent` record as the service, not a Mission fallback.
