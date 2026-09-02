# Autopilot Service Contract

Application boundary for automatic iteration progression. `advance(state)` returns `{ state, action }` and must preserve serialized tick ordering, pause behavior, fixed-profile rules, research/baseline gates, candidate actions, and validation transitions. The current implementation is injected during the transitional extraction and will be moved behind this boundary incrementally.
