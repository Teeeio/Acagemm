# Application Module Contract

模块归属：后端 Application Use Cases。完整的子域分组和建议主责角色见
[`docs/development/MODULE_OWNERSHIP.md`](../../docs/development/MODULE_OWNERSHIP.md)。

## Purpose

`application/` contains use-case orchestration between HTTP routes and domain or adapter modules. Each service exposes commands and queries without depending on HTTP request/response objects.

## Responsibilities

- Validate use-case input that is independent of transport.
- Coordinate state snapshots, domain mutations, filesystem ports, and workspace ports.
- Return transport-neutral result objects.
- Preserve domain errors and stable application error codes.

## Non-Responsibilities

- Match URLs, parse HTTP bodies, or write HTTP responses.
- Render TUI output.
- Reimplement state-store, workflow, Gate, Agent, or hardware rules.
- Import server route modules.

## Public API

| Module | Input | Output |
|---|---|---|
| `projects-service.mjs` | Project queries and commands | Project DTOs, saved state, and stable application errors |
| `missions-service.mjs` | Mission list and creation use cases | Mission list or saved state |
| `mission-query-service.mjs` | Mission selection and event queries | saved state or event DTO |
| `semantic-service.mjs` | Semantic Snapshot freeze command | frozen snapshot and saved state |
| `research-service.mjs` | Mission research start/cancel commands | command result or saved state |
| `run-service.mjs` | Mission run start orchestration | armed, research, or Agent run outcome |
| `review-action-service.mjs` | Resume and decision-review request/cancel/resolve actions | command result or resolved outcome |
| `decision-service.mjs` | Candidate adoption, rejection, and adoption reversal | command result and recovery metadata |
| `candidate-validation-service.mjs` | Patch application, Benchmark submission, and stage rollback | command result or stable validation response |
| `baseline-service.mjs` | Authoritative Baseline single-file materialization | command result and materializer run ID |
| `operator-test-service.mjs` | Operator Test Queue queries and cancellation | task DTOs and queue path |
| `mission-control-service.mjs` | Agent cancellation, human feedback, and Mission stop | persisted state and control result |
| `experience-api-service.mjs` | Project-scoped human experience CRUD | versioned guidance DTOs and conflicts |
| `round-experience-service.mjs` | Frozen per-round experience and verified observations | context and record status through injected ports |
| `shared-gpu-experience-verifier.mjs` | Revalidate shared-GPU package receipts at the composition boundary | trusted verified observation or explicit skip |
| `knowledge-service.mjs` | Knowledge draft editing, asset references, and retired manual publication | persisted state or governance response |
| `runtime-query-service.mjs` | Runtime state, preflight, and active workspace queries | state/workspace query | transport-neutral query DTOs |
| `runtime-state-service.mjs` | TUI state patch, budget validation, and pause/resume command | state command body | persisted state or stable validation error |
| `reset-service.mjs` | Runtime capability guard and test-fixture reset orchestration | reset command | reset fixture state |
| `source-service.mjs` | Git source registration and source counting | `{ state, mission }` | source references/count |
| `iteration-research-service.mjs` | Agent/Workspace research lifecycle coordination | research start/cancel input | updated state |
| `round-recovery-service.mjs` | rejected iteration checkpoint restoration | round state/workspace | recovery metadata |
| `agent-round-service.mjs` | Agent round reset, checkpoint, and launch | round input | updated state |
| `round-preflight-service.mjs` | generation settlement and runtime preflight composition | round input | round context |
| `round-artifact-guard.mjs` | strict baseline artifact admission | mission/state | pass or stable error |
| `baseline-source-service.mjs` | baseline source policy selection | mission/state | source selection |
| `materializer-policy-service.mjs` | baseline materializer state policy | materializer state | policy action |
| `baseline-failure-projection.mjs` | idempotent baseline failure projection | benchmark state | changed flag |
| `benchmark-projection-service.mjs` | Operator Test queue snapshot and artifact projection | benchmark state | changed state |
| `repository-adoption-service.mjs` | managed runtime candidate repository adoption | projected state | changed state |
| `autopilot-candidate-service.mjs` | automatic candidate priority selection | state | candidate DTO |
| `autopilot-context-service.mjs` | auto-tick context preparation | state | autopilot context |
| `autopilot-candidate-action-service.mjs` | candidate patch apply and recovery | candidate state | updated state |
| `autopilot-validation-service.mjs` | candidate benchmark start | candidate state | updated state |
| `autopilot-service.mjs` | automatic iteration progression boundary | runtime state | state/action result |
| `autopilot-fixed-profile-service.mjs` | fixed Profile post-baseline progression | Mission state | state/action result |
| `autopilot-strict-source-service.mjs` | strict source autopilot progression | Mission state | state/action result |
| `autopilot-candidate-baseline-service.mjs` | ordinary candidate baseline progression | Mission state | state/action result |
| `baseline-benchmark-service.mjs` | baseline benchmark command submission | baseline context | updated state |
| `baseline-materializer-command-service.mjs` | baseline materializer command submission | baseline context | updated state |
| `baseline-source-inspection-service.mjs` | strict baseline source verification | baseline context | validation/state |
| `baseline-materializer-recovery-service.mjs` | materializer failure recovery and research redirect | materializer state | state/action |
| `iteration-service.mjs` | formal iteration dependency boundary | iteration ports | immutable iteration API |
| `runtime-projection-service.mjs` | workflow and Agent state projection | state/runtime | projected state |
| `runtime-advance-service.mjs` | Autopilot, iteration, and reconcile tail | projected state | advanced state |
| `baseline-orchestration-service.mjs` | complete Baseline workflow orchestration | baseline command | updated state |
| `runtime-state-pipeline-service.mjs` | ordered explicit advancement pipeline | state/runtime snapshot | advanced state and changed flag |
| `runtime-lifecycle-service.mjs` | separate snapshot reads and effectful advancement | state/descriptor/pipeline ports | isolated state or advanced state |
| `runtime-maintenance-service.mjs` | runtime-specific policy and fixture progression | state/runtime mode and domain ports | changed state |
| `main-round-orchestration-service.mjs` | complete main Agent round orchestration | round command | updated state |

## Durable command handlers

| Module | Input | Output |
|---|---|---|
| `candidate-commands.mjs` | Candidate and workspace ports | Patch / rollback command definitions |
| `benchmark-command.mjs` | frozen test input and queue recovery port | recoverable Benchmark command |
| `decision-commands.mjs` | review, adoption and budget policy ports | decision command definitions |
| `agent-commands.mjs` | Agent and workspace ports | run, research and materializer commands |
| `workflow-command-policy.mjs` | state rules, capabilities and clock | command admission and adoption policy |

These handlers implement [the command journal protocol](../command-journal.md).
The composition root binds their ports. Preparation records external mutations through
`runEffect`; application changes only the provided state. Benchmark recovery queries
the queue using its frozen request ID and never processes tasks while looking them up.

## Dependency Direction

```text
server routes -> application services -> domain functions / injected ports
```

Application services may import pure domain/state transition functions. Filesystem, Git workspace, persistence, clocks, and other effects must be injected at construction time.

Gate/evidence/objective consumers use their canonical domain modules or injected
functions. Do not import state-workspace or state-snapshot-storage, including only
for a path helper: Projects receives workspaceDirForMission as a required port.
Mission/Project transition ports are required at construction time: Projects
receives projectState; Missions, Mission Query, Research and Run receive
missionState. Production supplies the canonical mission-project-state factory
bound to existing path queries. Missing transition methods fail construction;
there is no state-store default. Pure Research shapes come from
mission-state-shapes. The recursive import gate covers every Application module
and rejects direct or transitive storage/facade dependencies.

## Verification

```bash
npm run test:projects-service
npm run test:module-boundary
npm run test:smoke
```

## Generic iteration safety and experience ports

[experience-service.mjs](experience-service.md) provides project-scoped versioned
human guidance, execution observations and frozen retrieval contexts through
injected repository/clock/ID ports. Production supplies it to
[round-experience-service.mjs](round-experience-service.md) and the project-scoped
human Experience API. Agent commands and automatic rounds persist one frozen
context; the Provider receives it as untrusted, attributed data. Terminal
collection requires a trusted package-execution verification receipt: the current
legacy backend has none, so it is explicitly skipped, not upgraded into evidence.
Mutation/resume paths enforce [resource-release barriers](../cancellation-contract.md).
Runtime advancement checks budget guards before Autopilot and uses the injected
Mission control releaseResources port for budget shutdown. A pending release
prevents new dispatch, workspace mutation and adoption; snapshot queries remain
read-only. Baseline CPU requests include their own separate frozen oracle.

Run Service receives an explicit nowMs clock. Fixed-Profile arming uses the
canonical iteration guards and freezes a permitted round before persistence;
exhausted limits are rejected synchronously, never cleared by manual start.
Only an explicitly admitted new round can replace a settled budget. Autopilot,
Agent preparation and replay consume that frozen active identity.
