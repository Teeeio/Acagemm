# Research Service Contract

Owns Mission research start and cancellation commands. It delegates durable command semantics to `executeCommand` and run cancellation to Agent Runtime.

`start(missionId, body)` validates/activates the Mission, applies the shared mutation guard, and returns the command result. `cancel(missionId, runId)` requires the requested Mission to be active, cancels the Agent run, and persists the resulting state.

Stable errors: `MISSION_NOT_FOUND` (404), `AGENT_MISSION_MISMATCH` (409), and `STATE_VERSION_CONFLICT` (mapped by the route). The service does not parse HTTP or emit responses.
