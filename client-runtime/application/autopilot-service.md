# Autopilot Service Contract

For persisted Mission `executionMode: generate-only`, dispatch short-circuits
before fixed/strict/ordinary baseline services. A verified candidate with
`candidate.plan`, a settled Agent and explicit `resourceRelease.confirmed:true`
may call the existing `candidateActionService.applyCandidate`. Other active
Mission resources and release barriers prevent freezing. A persisted
`pendingValidation` reports `candidate_frozen`; a policy refusal keeps the
existing human-intervention result. Pending/paused ticks return `none` without
starting baseline, tests, research or another generation. The iteration loop
independently enforces the same no-dispatch boundary. Legacy iterate dispatch
is unchanged.

Application boundary for automatic iteration progression. `advance(state)` returns `{ state, action }` and preserves pause behavior, fixed-profile rules, strict-source and candidate Baseline gates, candidate actions, and validation transitions. Specialized branches and effectful actions are injected through documented application-service ports; this module owns the final decision table and does not persist state.

Dispatch is by Mission class, and no class owns a branch exclusively. A strict
zero-source Mission first gets its own service — its research and strict Baseline
gates are the only thing allowed to advance that Baseline — and when that service
reports it has nothing left to do (`null`), the tick falls through to the shared
candidate/validation table rather than stopping. A fixed Operator Profile Mission
does the same: its own service leads while the Baseline is being established and
while it has its own work (experience research, starting the next round), and when
it reports `action: 'none'` the tick falls through instead of returning. Returning
there is the break point — the candidate is generated and its action is pending,
but nothing applies it, so the Mission stalls to the round budget.

Falling through is permitted only once the Baseline is `complete`: the shared
table's candidate Baseline branch is forbidden for a strict Mission, so an
incomplete Baseline that the strict service declines to advance stops the tick
instead of being handed to a different Baseline producer. A fixed Profile Mission
never reaches the fall-through with an incomplete Baseline either — that branch
establishes the Baseline itself and returns.

Falling through grants no new-round budget authority to either class. The
Autopilot is not consulted at all while `detectLoopGuard` reports a hit
(`runtime-advance-service`), so round, total and phased generation/Correctness
attempt limits still stop automatic flow before dispatch; the fixed Profile's
frozen counters and budget are unchanged by this table.

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
