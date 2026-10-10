# Generation preparation diagnostics

`generation-preparation.mjs` is a pure shared contract. It validates a persisted
`iterationStats.generationPreparationFailure` against its Mission, Project,
source run, semantic digest, feedback manifest and original Mission clock.
`isDraftPreparationRetry` identifies only a failed first draft read with no run
or feedback. It grants no budget, resource, semantic or workspace exemption.
`throwPreparationFailure` converts a committed command diagnostic into the
original application error after persistence, keeping HTTP formatting outside.

The Agent command catches only an explicitly bound `roundExperienceStatus`
read failure before checkpoint/Provider effects. It returns a prepared diagnostic
payload and no run ID. Journal apply pauses the Mission, retains the failure and
read status, and emits `generation.preparation_failed`. Journal recovery replays
that payload without querying a repaired store or starting work. Ordinary
unknown-effect recovery and admission failures keep their existing behavior.

The next round's admitted budget stays inside the diagnostic while existing
pending feedback, test receipts, facts, counters and their completed round stay
unchanged. Explicit retry uses the same admitted deadline and Mission clock.
After a successful start the active diagnostic is cleared; its runtime event
remains in durable history. A read failure is not a model execution or test result.

TUI imports only these pure identity predicates. It shows bound next-round read
failure even while the old test's round remains active in the saved view, and
sends an explicit draft retry through the existing production API.
