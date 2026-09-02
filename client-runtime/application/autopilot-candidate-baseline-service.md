# Autopilot Candidate Baseline Service Contract

Coordinates baseline preparation for ordinary candidate Missions. It starts baseline commands, launches managed-runtime source research when needed, and projects unresolved research into explicit human review. Returns `{ state, action }` or `null` when the candidate-baseline branch does not apply.
