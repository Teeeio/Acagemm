# Agent Round Service Contract

## Purpose / Responsibilities

Starts one iteration Agent round after preflight/recovery. It records the shared round budget before effects, collects prior verified observations, freezes experience, resets run state, restores fixture workspaces or records managed checkpoints, then delegates to the existing Agent runtime. No second workflow, HTTP, persistence or hardware execution.

## Public API / Inputs

`createAgentRoundService({...existingPorts,roundExperience,nowMs})` returns `{startRound}`. Existing reset/workspace/checkpoint/Agent/event/capability ports remain required. New required ports are `roundExperience.prepare/collect` and `nowMs:()=>number` in epoch milliseconds; no default effect implementation.

`startRound({state,mission,goal,workspace,runtimeMode})` returns the resulting state. mission must identify its project and active Mission. The canonical `ensureRoundBudgetStarted` owns roundId/start/deadline; this service never derives a second identity or renews same-round retry time.

## Outputs / Invariants

Order: ensure budget → collect old Benchmark → prepare context → verify budget/context → reset → fixture workspace or managed checkpoint → verify budget → Agent start. Experience calls are capped at 3000 ms and remaining round time. A retrieval/verification/storage failure or expired budget prevents subsequent Agent dispatch; it is not an empty-context fallback.

`agentRuntime.startRun` receives existing parameters plus `{roundId,experienceContext}`. The same validated object is stored in `state.iterationStats.roundExperience`; the returned state's iterationStats retains it and the admitted roundBudget. Runtime prompt formatting uses the public experience-contract formatter, owned outside this service.

Managed checkpoint history remains capped at five. Reference-fixture `handled:false` still uses startAgentRun and the existing mission.run_started event; it receives the same persisted context through state. This service does not promote fixture/CPU observations or change Gate/Profile semantics.

## Dependencies / Side Effects

Only pure `round-budget-contract` and `experience-contract` imports. Workspace, Agent, runtime events and experience effects are injected. Persistence and initial HTTP-run command replay remain composition-root/command-journal responsibilities.

## Error Contract

Missing ports are TypeError. Budget, context, experience, workspace and Agent errors propagate without silently retrying. An already-started external operation's uncertainty is handled by its owning port, not inferred as released here.

## Verification / Change Checklist / Limitations

Run `node tests/agent-round-service-test.mjs` and `node tests/round-experience-service-test.mjs`; all Agent/workspace effects are fakes. Update this contract, constructor callers and tests when ports/order change. The service does not persist a failed attempt itself, authorize projects, verify evidence receipts, or format provider prompts. Initial HTTP commands use the same budget/context through their existing journal path.
