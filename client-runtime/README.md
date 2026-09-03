# Client Runtime Module Contract

## Purpose

`client-runtime` is the local application backend. It owns Mission state, workflow orchestration, Agent coordination, isolated workspaces, serialized operator tests, evidence decisions, and local persistence.

## Inputs

- HTTP commands from the TUI or Web client.
- Agent events and structured results from registered runtimes.
- Operator-test snapshots from the configured test backend.
- Persisted state and command journal entries from the active tester home.

All external outcomes must be normalized before changing Mission state.

## Outputs

- Versioned product state exposed by `/api/state`.
- Runtime health and capability descriptions.
- Runtime events, audit records, candidate evidence, and Gate decisions.
- Mission Workspace changes, checkpoints, test tasks, and artifacts.

## Module Catalog

| Module | Responsibility | Primary input | Primary output |
|---|---|---|---|
| `local-server.mjs` | Runtime bootstrap and transitional orchestration | HTTP request, current state | delegated route/service calls |
| `server/` | HTTP transport and thin route adapters | request/response and injected services | HTTP/SSE/static responses |
| `application/` | transport-neutral use-case orchestration | commands, queries, injected ports | application results and stable errors |
| `application/projects-service.mjs` | Project lifecycle and repository bootstrap | Project command/query | Project DTO or saved state |
| `application/missions-service.mjs` | Mission list and creation | Mission input, state and workspace port | saved Mission state |
| `application/mission-query-service.mjs` | Mission selection and event queries | Mission ID, event cursor | saved state or event DTO |
| `application/semantic-service.mjs` | Semantic Snapshot freeze | Mission semantic draft | frozen snapshot and saved state |
| `application/research-service.mjs` | Mission research start/cancel | Mission ID and research command | command result or saved state |
| `application/run-service.mjs` | Mission run start orchestration | Mission ID and run body | Agent, research, or armed state |
| `application/review-action-service.mjs` | Mission resume and human review lifecycle | review command | command result or resolved outcome |
| `application/decision-service.mjs` | adoption, rejection, and adoption reversal | decision command | command result and recovery metadata |
| `application/candidate-validation-service.mjs` | Patch, Benchmark, and stage rollback orchestration | Candidate/Benchmark command | command result or validation response |
| `application/baseline-service.mjs` | authoritative Baseline materialization orchestration | source and matrix command | command result and materializer run ID |
| `application/operator-test-service.mjs` | serialized test task queries and cancellation | task ID and queue port | task DTO or queue metadata |
| `application/mission-control-service.mjs` | explicit Mission lifecycle controls | IDs or feedback body | persisted state and control result |
| `application/knowledge-service.mjs` | Knowledge draft editing and asset references | draft/reference command | persisted state or governance response |
| `application/runtime-query-service.mjs` | Runtime state, preflight, and active workspace projections | Mission ID or query | state, readiness, or workspace DTO |
| `application/runtime-state-service.mjs` | TUI state patch and pause/budget commands | state command body | persisted state or stable validation error |
| `application/reset-service.mjs` | guarded Demo Reset orchestration | reset command | reset product state |
| `application/source-service.mjs` | source repository registration and counting | Mission source root | source references/count |
| `application/iteration-research-service.mjs` | Agent research start/cancel coordination | research command | updated state |
| `application/round-recovery-service.mjs` | rejected-round checkpoint restoration | round state/workspace | recovery metadata |
| `application/agent-round-service.mjs` | Agent round initialization and launch | round input | updated state |
| `application/round-preflight-service.mjs` | generation settlement and runtime preflight | round input | round context |
| `application/round-artifact-guard.mjs` | strict baseline artifact admission | mission/state | pass or stable error |
| `application/baseline-source-service.mjs` | baseline source policy selection | mission/state | source selection |
| `application/materializer-policy-service.mjs` | baseline materializer state policy | materializer state | policy action |
| `application/baseline-failure-projection.mjs` | baseline failure state projection | benchmark state | changed flag |
| `application/benchmark-projection-service.mjs` | Operator Test snapshot projection | benchmark state | changed state |
| `application/repository-adoption-service.mjs` | Accept Gate repository adoption | projected state | changed state |
| `application/autopilot-candidate-service.mjs` | automatic candidate priority selection | state | candidate DTO |
| `application/autopilot-context-service.mjs` | automatic iteration context preparation | state | autopilot context |
| `application/autopilot-candidate-action-service.mjs` | automatic candidate apply/resume actions | candidate state | updated state |
| `application/autopilot-validation-service.mjs` | automatic candidate benchmark start | candidate state | updated state |
| `application/autopilot-service.mjs` | automatic iteration progression boundary | runtime state | state/action result |
| `application/autopilot-baseline-research-service.mjs` | baseline research and unresolved-source handling | Mission state | state/action result |
| `application/autopilot-fixed-profile-service.mjs` | fixed Profile post-baseline progression | Mission state | state/action result |
| `application/autopilot-strict-source-service.mjs` | strict source autopilot progression | Mission state | state/action result |
| `application/autopilot-candidate-baseline-service.mjs` | ordinary candidate baseline progression | Mission state | state/action result |
| `application/baseline-benchmark-service.mjs` | baseline benchmark command submission | baseline context | updated state |
| `application/baseline-materializer-command-service.mjs` | baseline materializer command submission | baseline context | updated state |
| `application/baseline-source-inspection-service.mjs` | strict baseline source verification | baseline context | validation/state |
| `application/baseline-materializer-recovery-service.mjs` | materializer failure recovery and research redirect | materializer state | state/action |
| `state-store.mjs` | state compatibility, transitions, persistence | product state, snapshot | normalized persisted state |
| `state-repository.mjs` | serialize state access and enforce optimistic versions | load/save adapters, mutation | isolated snapshot or saved state |
| `iteration-loop.mjs` | bounded iteration policy | Mission state, injected deps | next workflow state/action |
| `workflow-kernel.mjs` | invariants and recovery projection | product state | violations/effect/reconciled state |
| `runtime-events.mjs` | append canonical Mission events | state, type, payload, source | appended event |
| `agent-runtime.mjs` | Agent use-case lifecycle | Mission context, runtime events | Agent state/results |
| `agent-runtime/` | definitions, registry, dispatch, capabilities | runtime ID, operation | definition or provider call |
| `operator-test-queue.mjs` | serialized test lifecycle | test payload | persisted task snapshot |
| `local-c500-service-client.mjs` | C550 execution | queue task payload | correctness/benchmark artifacts |
| `workspace-manager.mjs` | Git workspace isolation | Mission/repository/candidate | Diff/checkpoint/restore result |
| `fixed-operator-profiles.mjs` | immutable operator contracts | Profile ID | frozen Profile/test matrix |
| `semantic-snapshot.mjs` | bind semantics to evidence | Mission/Profile/test task | immutable semantic digest |

## Invariants

- State transitions preserve active Mission projection consistency.
- Runtime API, SSE projection, and auto tick state access share the State Repository exclusive queue.
- No simulation result is publishable.
- Test evidence and workspace candidate identities match.
- External failures use `workflow-error.mjs` normalization.
- Runtime events use `runtime-events.mjs`; do not define local event appenders.
- Provider capability checks use the Agent Runtime registry.

## Dependency Rules

- Pure policy modules may depend on shared contracts, not adapters.
- Adapters may depend on Node APIs and external processes.
- `state-store.mjs` must not import the Agent service facade.
- Provider clients must not import HTTP routes or TUI modules.

## Verification

```bash
npm run test:workflow-kernel
npm run test:loop
npm run test:runtime
npm run test:queue
npm run test:state-store-projection
npm run test:state-repository
npm run test:projects-service
npm run test:missions-service
npm run verify:local-c500-release
```
