# Benchmark Projection Service Contract

Projects a running Operator Test task into Mission benchmark state, using queue-first and test-service fallback reads. Completed results are persisted to mission artifacts; transient service errors become stable `lastServiceError` metadata. Input/output are `{ state }` plus `{ changed, state }`.
