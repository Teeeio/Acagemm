# Autopilot Service Contract

Application boundary for automatic iteration progression. `advance(state)` returns `{ state, action }` and preserves pause behavior, fixed-profile rules, strict-source and candidate Baseline gates, candidate actions, and validation transitions. Specialized branches and effectful actions are injected through documented application-service ports; this module owns the final decision table and does not persist state.

Candidate admission returning `patch_policy_rejected` reports action `needs_human`.
It never reports `candidate_applied` or `simulation_candidate_applied` for that
outcome; subsequent paused ticks remain `none`.
