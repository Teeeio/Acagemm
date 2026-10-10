# Main Round Orchestration Service Contract

Starts one main Agent round in fixed order: runtime capability description, preflight, rejected-candidate workspace recovery, strict artifact admission, recovery event/audit projection, then Agent round launch.

Input is `{ state, goal, retryMode? }`; output is the updated state. A blocked preflight returns the original state without recovery or launch. Runtime, workspace, event, audit, and Agent effects are injected; the service does not persist state or depend on HTTP/TUI modules.

## Research advisory delivery

`start` accepts the selected advisory material and its injection identity. When preflight blocks the
start it emits `research.advisory_preflight_blocked` and returns the state unchanged: the material is not
consumed, not marked submitted, and remains available for a later attempt. On success the advisory travels
to the Agent round, which renders it through the untrusted-advisory boundary and binds its digest to the
new Agent run; only that binding counts as a submission.
