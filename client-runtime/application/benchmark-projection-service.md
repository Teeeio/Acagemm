# Benchmark Projection Service Contract

Projects a running Operator Test task into Mission benchmark state, using queue-first and test-service fallback reads. Completed results are persisted to mission artifacts; transient service errors become stable `lastServiceError` metadata. Input/output are `{ state }` plus `{ changed, state }`.

This is an advancement-only service: artifact writes and evidence projection are
not query behavior. Production injects collectExperience to record terminal
candidate observations through the trusted round-experience service. Missing
package bindings are explicitly skipped; observation failures remain visible in
iterationStats.experienceCollection without rewriting test/Gate evidence. Final
rounds are collected here even when no subsequent Agent round is started. Its queue `get` port is bound to read-only `readTask`; the
surrounding pipeline calls `processTests()` once before projecting the snapshot.
