# Baseline Materializer Recovery Service Contract

Handles failed, cancelled, or timed-out baseline Materializer runs. It consumes one bounded recovery budget, records rejected sources, redirects to synchronous Research when permitted, or projects `needs_human` when recovery is exhausted. Returns `{ state, action }`.

## Unified research policy

Redirecting to a different authoritative source is still an automatic research entry, so it goes through
`resolveAutomaticResearch({ trigger: 'materializer_redirect' })`. When automatic research is disabled the
rejected source is recorded, the materializer is marked `redirected`, and the service returns
`needs_human` with `research_disabled_source_unresolved` — it never starts acquisition from another
branch and never adopts the rejected source.
