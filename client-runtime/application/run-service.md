# Run Service Contract

Owns Mission run start across strict-zero-source research, Runtime preflight, fixed Operator arming, and normal Agent execution. It delegates durable command semantics to `executeCommand` and keeps HTTP response formatting in `run-routes.mjs`.

Input: Mission ID and run body (`goal`, `resume`, and command fields). Output is a transport-neutral outcome containing a command result, a research response, or an armed fixed Operator state. Preflight failures use `RUNTIME_PREFLIGHT_FAILED` (503); unknown Missions use `MISSION_NOT_FOUND` (404); command conflicts use `STATE_VERSION_CONFLICT`.

The service does not parse URLs, emit HTTP, or duplicate workflow policy.
