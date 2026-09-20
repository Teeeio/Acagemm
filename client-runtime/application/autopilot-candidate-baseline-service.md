# Autopilot Candidate Baseline Service Contract

Coordinates baseline preparation for ordinary candidate Missions. It starts baseline commands, launches managed-runtime source research when needed, and projects unresolved research into explicit human review. Returns `{ state, action }` or `null` when the candidate-baseline branch does not apply.

## Unified research policy

The candidate-baseline research start uses `resolveAutomaticResearch({ trigger: 'baseline_source' })`
with an explicit `acquire` phase. When automatic research is disabled it records
`baseline.source_unresolved` with the policy reason code and returns `needs_human` rather than starting
research or falling back to a semantic baseline.
