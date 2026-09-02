# Semantic Service Contract

Owns the Mission Semantic Snapshot freeze command. It validates through the canonical semantic-snapshot module, updates the Mission projection, appends a runtime event and audit record, then persists state.

Input: missionId and optional semanticDraft/snapshot. Output: frozen snapshot and saved state. `MISSION_NOT_FOUND` is returned for unknown Missions; semantic validation failures use `SEMANTIC_FREEZE_BLOCKED` and expose `issues`.

The service does not parse HTTP or emit SSE, and never starts Agent, test, or hardware work.
