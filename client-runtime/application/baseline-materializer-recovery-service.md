# Baseline Materializer Recovery Service Contract

Handles failed, cancelled, or timed-out baseline Materializer runs. It consumes one bounded recovery budget, records rejected sources, redirects to synchronous Research when permitted, or projects `needs_human` when recovery is exhausted. Returns `{ state, action }`.

## Terminal failure record

On exhausted recovery or cancellation, `state.workflowFailure` uses the existing
serialized workflow-error contract (`phase: baseline.materializer`). It preserves
the original error code/message and stores the Mission ID, actual materializer
run ID/status/start time, materialization directory, source, complete original
error and recovery outcome in `details`. Missing identity/evidence is `null`,
never reconstructed from a candidate. The normal Mission state projection
persists this record; candidate `failureRecords` remain unchanged.

The record is terminal and not automatically retryable. Cancellation is
`user_cancel`, timeout is `timeout`; the existing `needs_human` status and
`baseline_materializer_failed` loop reason are unchanged. `occurredAt` uses the
recorded completion time, or the first observation time from the injected `now`
port. Repeated projection of the same Mission/run/status keeps that time and
does not append events or failure-history entries. A different run gets its own
time; a missing run ID cannot establish that two observations are the same run.
Successful/in-progress runs and permitted research redirects do not write this
terminal record. The record remains available as the last terminal diagnostic;
the existing TUI displays it as a current failure only while the corresponding
Mission/run/start time/status is blocked for `baseline_materializer_failed`.
Without a run ID, the diagnostic remains in state but the TUI shows only the
existing blocking reason rather than claiming that this is the current run's error.
Explicit resume or a newer run hides this old diagnostic without deleting it.
The cancellation record's `stopped` policy is its error classification, not a
change to the orchestration's existing `needs_human` state. No retries or failure
records for other workflow stages are added.

## Unified research policy

Redirecting to a different authoritative source is still an automatic research entry, so it goes through
`resolveAutomaticResearch({ trigger: 'materializer_redirect' })`. When automatic research is disabled the
rejected source is recorded, the materializer is marked `redirected`, and the service returns
`needs_human` with `research_disabled_source_unresolved` — it never starts acquisition from another
branch and never adopts the rejected source.
