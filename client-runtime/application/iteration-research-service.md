# Iteration Research Service Contract

Owns the Agent/Workspace coordination for starting and cancelling iteration research. Inputs are state, mission, direction, workspace, and optional synchronous/run phase flags; `startResearch` returns the updated state and is a no-op for unmanaged runtimes. Workspace creation and Agent lifecycle are injected ports. No HTTP or persistence access is allowed.

## Explicit phases only

`startResearch` no longer supplies a default `runPhase`. The caller must pass one of
`RESEARCH_PHASES`; anything else is rejected with `RESEARCH_PHASE_REQUIRED` (missing) or
`RESEARCH_PHASE_UNKNOWN`. The default phase was how the generic stagnation escalation silently
re-entered `acquire` and went looking for baseline repositories again, so it was removed rather than
documented. `budgetMs`, `trigger` and `origin` are forwarded to the Agent runtime unchanged.
