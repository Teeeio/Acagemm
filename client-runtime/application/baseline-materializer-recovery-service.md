# Baseline Materializer Recovery Service Contract

Handles failed, cancelled, or timed-out baseline Materializer runs. It consumes one bounded recovery budget, records rejected sources, redirects to synchronous Research when permitted, or projects `needs_human` when recovery is exhausted. Returns `{ state, action }`.
