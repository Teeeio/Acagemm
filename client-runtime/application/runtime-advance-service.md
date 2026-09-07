# Runtime Advance Service Contract

Exposes pure `canStartNewWork(state)` so the outer pipeline applies the same
pause, resource-release and loop/budget guards before any new dispatch or adoption.
`advance({ state })` also checks those guards itself. A paused Mission does not
run Autopilot or normal Iteration effects. Expired total/round wall-clock budgets
still release active resources and settle termination while paused; pausing is not
a way to extend the budget or leave old workers running. Checks resource-release barriers and loop/budget guards before dispatch. Exhausted guards call injected releaseResources(state, {reason}) for active resources and then settle Iteration without running Autopilot. Otherwise runs Autopilot, Iteration and final workflow reconciliation in order. Input is `{ state }`; output is `{ state, changed, actions }`. It does not persist state; callers retain the repository transaction boundary.
Guard-only advancement compares the resulting snapshot; an unchanged budget
terminal does not produce a new persisted version on every tick.
