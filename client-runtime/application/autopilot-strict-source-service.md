# Autopilot Strict Source Service Contract

Advances strict-zero-source Missions through Research, semantic fallback, Baseline materialization, and candidate Agent start. Missing authoritative sources resolve to `needs_human`; simulation or unrelated sources are never admitted. Returns `{ state, action }` or `null`.

## Unified research policy

The necessary baseline-source research start goes through
`resolveAutomaticResearch({ trigger: 'baseline_source' })` with an explicit `acquire` phase and budget.
When automatic research is disabled the service returns an explicit `needs_human` state with
`loopStatusReason = research_disabled_source_unresolved` instead of starting acquisition or relaxing the
source gate.
