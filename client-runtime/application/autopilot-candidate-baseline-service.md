# Autopilot Candidate Baseline Service Contract

Coordinates baseline preparation for ordinary candidate Missions. It starts baseline commands, launches managed-runtime source research when needed, and projects unresolved research into explicit human review. Returns `{ state, action }` or `null` when the candidate-baseline branch does not apply.

## Unified research policy

The candidate-baseline research start uses `resolveAutomaticResearch({ trigger: 'baseline_source' })`
with an explicit `acquire` phase. When automatic research is disabled it records
`baseline.source_unresolved` with the policy reason code and returns `needs_human` rather than starting
research or falling back to a semantic baseline.

## Terminal unresolved source projection

The managed-runtime terminal branch (`runId` present, terminal research status, `runPhase !== 'acquire'`)
now also records `state.workflowFailure = buildBaselineSourceFailure({ state, mission, now })` in
addition to the existing `baseline.source_unresolved` event and audit entry, which are unchanged. The
projection keeps `phase='baseline.source'`, `source='baseline-source'`, `retryable=false` and the
frozen research identity, original error and deep-cloned source constraints; the decision itself
(`needs_human`) and every other branch are untouched. `now` is an optional injected clock for
deterministic tests.
