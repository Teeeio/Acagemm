# Runtime and Audit Events Contract

## Public API

- `appendRuntimeEvent(state, type, payload = {}, source = { kind: 'adapter' })`:
  appends a canonical Mission event with ID, next sequence, timestamp and source;
  retains the latest 500 events and returns the appended record.
- `addAuditEvent(state, title, detail, tone = 'blue', icon = 'Activity')`:
  prepends an audit/display record with locale time; retains the latest 30 and
  returns that record. The state-store export aliases this implementation.

Both return null for missing state and mutate only their supplied state's event
arrays. Payload/source objects are not promised to be deep cloned.

## Boundaries

No imports, persistence, SSE/HTTP delivery or provider execution. The clock
supplies event metadata. Audit events are display history, not the durable command
journal or a substitute for queue/state terminal persistence.

## Verification

Run `npm run test:state-domain-boundary` and `npm run test:module-boundary`.
Changes to limits, event fields or sequence semantics require consumer/test and
contract updates.
