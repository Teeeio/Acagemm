# Runtime Advance Service Contract

Runs the serialized automatic progression tail in fixed order: Autopilot, Iteration Loop, final workflow reconciliation. Input is `{ state }`; output is `{ state, changed, actions }`. It does not persist state; callers retain the repository transaction boundary.
