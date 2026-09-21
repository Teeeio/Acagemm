# Autopilot Service Contract

Application boundary for automatic iteration progression. `advance(state)` returns `{ state, action }` and preserves pause behavior, fixed-profile rules, strict-source and candidate Baseline gates, candidate actions, and validation transitions. Specialized branches and effectful actions are injected through documented application-service ports; this module owns the final decision table and does not persist state.

Dispatch is by Mission class, and only the fixed Operator Profile class owns a
branch exclusively. A strict zero-source Mission first gets its own service — its
research and strict Baseline gates are the only thing allowed to advance that
Baseline — and when that service reports it has nothing left to do (`null`), the
tick falls through to the shared candidate/validation table rather than stopping.
Falling through is permitted only once the Baseline is `complete`: the shared
table's candidate Baseline branch is forbidden for a strict Mission, so an
incomplete Baseline that the strict service declines to advance stops the tick
instead of being handed to a different Baseline producer.

"An action is waiting for the client" is read from the pending action, not from
how the producing Agent process ended. A Codex run that finishes normally writes
`completed` (its phase is already `Candidate Plan 已生成`), and the Mission
projection then attaches a client-controlled `candidate.plan` action while
keeping that status, so the candidate/validation transitions accept a settled
Agent whose candidate is already verified. `completed` never selects the
candidate Baseline branch and never triggers the resume-the-main-round path;
those still require `awaiting_action`.

Candidate admission returning `patch_policy_rejected` reports action `needs_human`.
It never reports `candidate_applied` or `simulation_candidate_applied` for that
outcome; subsequent paused ticks remain `none`.
