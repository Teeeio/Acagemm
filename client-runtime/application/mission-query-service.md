# Mission Query Service Contract

Owns Mission selection and runtime-event queries. Event streaming is delegated to an injected transport callback.

API: select(missionId) validates the ID, applies the canonical selectMission transition, and returns persisted state. events(missionId, after) returns mission events after the numeric sequence cursor without mutation.

`researchNotes(missionId)` returns the Mission research notes and a default research-agent projection; it does not persist the selection side effect.

Unknown IDs return MISSION_NOT_FOUND (404). The service has no HTTP or SSE dependencies.
