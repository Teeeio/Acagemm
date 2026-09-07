# Runtime Lifecycle Service Contract

Separates committed-state inspection from explicit runtime advancement.

- `read()`: calls the injected snapshot reader with `recover: false`, attaches
  the runtime descriptor, and returns an isolated snapshot. It never invokes the
  pipeline, repairs storage, acknowledges a journal entry, or persists state.
- `advance()`: checks the runtime owner, reads with `recover: true`, skips all
  progression when command recovery is blocked, then runs the advance pipeline.
  It persists the returned state only when the pipeline reports a change.
- Ports: `readState(options)`, `persistState(state)`, `describeRuntime()`,
  `pipeline.advance({ state, runtime })`, and optional `canAdvance()`.
- Owner loss rejects advancement with `RUNTIME_OWNER_UNAVAILABLE` (409) but does
  not prevent read-only inspection. Storage and recovery errors are preserved.

The caller holds the State Repository exclusive lock around the entire operation.
The service does not acquire another lock, cache snapshots, or share in-flight
advancement with readers. Command-level commits and recovery commits still follow
their existing atomic persistence protocol.

Verification: `test:runtime-lifecycle-service`, `test:runtime-read-isolation`.
