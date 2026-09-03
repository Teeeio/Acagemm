# Main Round Orchestration Service Contract

Starts one main Agent round in fixed order: runtime capability description, preflight, rejected-candidate workspace recovery, strict artifact admission, recovery event/audit projection, then Agent round launch.

Input is `{ state, goal, retryMode? }`; output is the updated state. A blocked preflight returns the original state without recovery or launch. Runtime, workspace, event, audit, and Agent effects are injected; the service does not persist state or depend on HTTP/TUI modules.
