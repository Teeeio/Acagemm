# Application Module Contract

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
| `knowledge-service.mjs` | Knowledge draft editing, asset references, and retired manual publication | persisted state or governance response |
| `runtime-query-service.mjs` | Runtime state, preflight, and active workspace queries | state/workspace query | transport-neutral query DTOs |
| `runtime-state-service.mjs` | TUI state patch, budget validation, and pause/resume command | state command body | persisted state or stable validation error |
| `reset-service.mjs` | Runtime capability guard and Demo Reset orchestration | reset command | reset product state |
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

## Dependency Direction

```text
server routes -> application services -> domain functions / injected ports
```

Application services may import pure domain/state transition functions. Filesystem, Git workspace, persistence, clocks, and other effects must be injected at construction time.

## Verification

```bash
npm run test:projects-service
npm run test:module-boundary
npm run test:smoke
```
