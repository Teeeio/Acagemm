# Autopilot Service Contract

Application boundary for automatic iteration progression. `advance(state)` returns `{ state, action }` and preserves pause behavior, fixed-profile rules, strict-source and candidate Baseline gates, candidate actions, and validation transitions. Specialized branches and effectful actions are injected through documented application-service ports; this module owns the final decision table and does not persist state.
