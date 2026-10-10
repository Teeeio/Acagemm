# Baseline Source Failure Projection Contract

`buildBaselineSourceFailure({ state, mission, now })` returns a serialized, non-retrying
`baseline.source` workflow error without mutating its inputs or selecting a source.
It reads the actual `state.researchAgent`; original code, message and HTTP status (also
from nested errors) are retained. Cancelled, timed-out and completed-without-source
states override classification; failed research uses the existing error classifier.

Details snapshot the research identity, actual research directory, complete original
error and Mission source constraints. Missing facts stay null. Time comes from
completedAt, then the previous failure with the same known execution identity, then
the injected clock. A missing runId never borrows an old timestamp.

Only the two existing terminal unresolved-source service branches invoke this projection.
It has no I/O, retry, recovery-budget, event or persistence side effects. TUI display
separately requires the current human-action state and matching research identity.
