# Runtime Advance Service Contract

A newly diagnosed experience-read failure from automatic round preparation is
returned as `changed:true`, `iteration:experience_read_failed`, with the Mission
paused, so Runtime Lifecycle commits the original failure and clocks. The status
must be new in this advance and match Mission/Project/round/error identity. Stale
diagnostics and unrelated/unknown effect errors still propagate. Pausing prevents
automatic retries; an explicit resume retains all ordinary limits.

Exposes pure `canStartNewWork(state)` so the outer pipeline applies the same
pause, resource-release and loop/budget guards before any new dispatch or adoption.
`advance({ state })` also checks those guards itself. A paused Mission does not
run Autopilot or normal Iteration effects. Expired total/round wall-clock budgets
still release active resources and settle termination while paused; pausing is not
a way to extend the budget or leave old workers running. Checks resource-release barriers and loop/budget guards before dispatch. Exhausted guards call injected releaseResources(state, {reason}) for active resources and then settle Iteration without running Autopilot. Otherwise runs Autopilot, Iteration and final workflow reconciliation in order. Input is `{ state }`; output is `{ state, changed, actions }`. It does not persist state; callers retain the repository transaction boundary.
Guard-only advancement compares the resulting snapshot; an unchanged budget
terminal does not produce a new persisted version on every tick.

Explicit `loopStatus: 'stopped'` is stronger than pause and denies
`canStartNewWork` even if a stale `missionPaused` flag is false. After the release
barrier, advancement may only release an as-yet-active owner using
`releaseResources(state, {reason: 'mission_stop'})`; it never runs Autopilot,
adoption or a new budget settlement. Already-confirmed stops are unchanged with
`iteration: 'stopped'`. Pending/quarantined release retains its barrier and
original stopped intent. No budget, timestamp or test limit is renewed.
`pendingValidation` also denies `canStartNewWork` even if a stale pause flag is
false; a frozen untested candidate cannot trigger maintenance, adoption or another
dispatch. Its original budget may expire while the artifact remains exportable.
Regression: `node tests/runtime-advance-service-test.mjs` composes the real
iteration/release/stop-receipt policies through pending, quarantine and confirmed
projections, and checks ordinary pauses still terminate on budget expiry.
