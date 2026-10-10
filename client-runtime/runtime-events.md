# Runtime and Audit Events Contract

## Public API

- `appendRuntimeEvent(state, type, payload = {}, source = { kind: 'adapter' })`:
  appends a canonical Mission event with ID, next sequence, timestamp and source;
  retains the latest 500 events and returns the appended record.
- `addAuditEvent(state, title, detail, tone = 'blue', icon = 'Activity')`:
  prepends an audit/display record with opaque UUID ID, ISO timestamp and locale time; retains the latest 30 and
  returns that record. The state-store export aliases this implementation.

Both return null for missing state. Before trimming, both deep-clone the event
into the supplied state's `tracePending` outbox; their display arrays keep the
existing limits. Runtime event IDs are opaque UUIDs (sequence remains the SSE
cursor), avoiding clock/sequence collisions across restored snapshots.
The returned display record's payload/source objects are not promised to be deep
cloned; the trace outbox copy is independent.

## Boundaries

Imports only UUID metadata and the pure trace contract. No persistence,
SSE/HTTP delivery or provider execution. The clock
supplies event metadata. Audit events are display history, not the durable command
journal or a substitute for queue/state terminal persistence. The outbox becomes
durable only with a successful [traced state commit](iteration-trace.md).

## Verification

Run `npm run test:state-domain-boundary` and `npm run test:module-boundary`.
Changes to limits, event fields or sequence semantics require consumer/test and
contract updates.
