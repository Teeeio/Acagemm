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
| `execution-package-import-service.mjs` | source import and trusted preparation through injected ports | immutable manifest and admission DTO |
| `mission-control-service.mjs` | Agent cancellation, human feedback, and Mission stop | persisted state and control result |
| `experience-api-service.mjs` | Project-scoped human experience CRUD plus KernelWiki snapshot import (`{snapshot,author}` only, owning Project checked first) | versioned guidance DTOs, import result, and conflicts |
| `round-experience-service.mjs` | Frozen per-round experience, selection-audit sidecar, verified observations, and the explicit `experienceCondition` study input applied before ranking/quota | frozen context, selection sidecar, and record status through injected ports |
| `shared-gpu-experience-verifier.mjs` | Revalidate shared-GPU package receipts at the composition boundary, including the strict released failed-candidate correctness path (real shared-GPU environment/probe, queue payload target/build/adapter and whole result agreement) | trusted verified observation (success or bounded failed summary) or explicit skip |
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
| `benchmark-package-preparation-service.mjs` | Shared-GPU execution package assembly, oracle admission, and trusted `preparedArtifactDigest` binding through injected store/adapter ports | request, mission, frozen matrix, mission run.py | admission-bound Benchmark request |
| `repository-adoption-service.mjs` | managed runtime candidate repository adoption | projected state | changed state |
| `autopilot-candidate-service.mjs` | automatic candidate priority selection | state | candidate DTO |
| `autopilot-context-service.mjs` | auto-tick context preparation | state | autopilot context |
| `autopilot-candidate-action-service.mjs` | candidate patch apply and recovery | candidate state | updated state, including typed admission rejection paused for human intervention |
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
injected repository/clock/ID ports. Its public `retrieveWithSelection(query)`
returns the frozen context plus the audited selection sidecar from one repository
read; when only `retrieve` is supplied, round-experience-service derives an
explicitly marked context-derived sidecar without changing the injected set.
`importKernelWiki(snapshot, { projectId, author })` wraps the pure apply API in one
repository transaction using the injected clock, so a KernelWiki snapshot is
imported atomically through the same store; the HTTP route
`POST /api/projects/:projectId/experiences/import-kernel-wiki` precedes the generic
ID matcher and accepts only `{snapshot,author}` within the existing body-size bound.
Production supplies it to
[round-experience-service.mjs](round-experience-service.md) and the project-scoped
human Experience API. Agent commands and automatic rounds persist one frozen
context; the Provider receives it as untrusted, attributed data. Terminal
collection requires a trusted package-execution verification receipt: the current
legacy backend has none, so it is explicitly skipped, not upgraded into evidence.

The explicit study condition is a frozen per-round input: `createRoundExperienceService({
..., experienceCondition })` accepts exactly `facts-only`, `local-only` or
`local-and-wiki` and applies it before ranking and quota, and the Runtime composition root
reads `OPERATOR_EXPERIENCE_CONDITION`. `facts-only` injects zero optional records while still
collecting the round's execution observation and mandatory round facts; `local-only` keeps
applicable local and execution records and excludes every
`selectionMetadata.source=kernel-wiki` unit; `local-and-wiki` keeps the unchanged D
selection. Unknown, null, empty or non-string values fail with `EXPERIENCE_INVALID` before any
state change, and a frozen same-round context cannot switch condition. The exact condition and
policy version are recorded in the persisted selection sidecar and the pre-send prompt audit,
so a receipt can be verified from retained originals. The study orchestration contract lives in
`scripts/experience-condition-study.mjs` and `scripts/run-experience-condition-study.mjs`
(nine-slot schedule, condition receipts, read-only report reader); the condition matrix has
independent acceptance in `tests/experience-condition-runtime-test.mjs` and
`tests/experience-condition-study-test.mjs`, registered once each in the release gate. Study results are exploratory only and are never
N20 — the report always states `strictN20Passed=false`.
Mutation/resume paths enforce [resource-release barriers](../cancellation-contract.md).
Runtime advancement checks budget guards before Autopilot and uses the injected
Mission control releaseResources port for budget shutdown. A pending release
prevents new dispatch, workspace mutation and adoption; an exhausted release
becomes an explicit `needs_human`/`blocked`/`quarantined` outcome while the
barrier remains fail-closed. `primaryFailure` (Provider/Agent cause) and
`releaseFailure` (cancellation/ownership cause) are persisted separately.
Snapshot queries remain read-only. Candidate Benchmark requests carry the
candidate's `sourceRunId`, so recovery attempts cannot be confused with the
run that actually produced the tested workspace. Baseline CPU requests include
their own separate frozen oracle.

Run Service receives an explicit nowMs clock. Fixed-Profile arming uses the
canonical iteration guards and freezes a permitted round before persistence;
exhausted limits are rejected synchronously, never cleared by manual start.
Only an explicitly admitted new round can replace a settled budget. Autopilot,
Agent preparation and replay consume that frozen active identity.


GPU experience startup now calls `round-experience-service.preflightCollection`
before collect in both `agent-round-service` and the manual runs command. The
trusted port is `createSharedGpuExperiencePreflight` from the documented
[shared-GPU verifier](shared-gpu-experience-verifier.md); failures block launch.
The new read-only stage consumes existing round/Mission time, independently of
the unchanged short collect timer. No cached environment bypasses admission.
