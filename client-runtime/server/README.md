# Server Module Contract

模块归属：后端 HTTP Transport。完整的上下游边界和建议主责角色见
[`docs/development/MODULE_OWNERSHIP.md`](../../docs/development/MODULE_OWNERSHIP.md)。

## Purpose

`server/` owns HTTP transport concerns and thin route adapters. It translates HTTP requests into calls on injected services and translates results or errors into transport responses.

## Responsibilities

- JSON response envelopes and request-body limits.
- SSE framing and static-file delivery.
- Route matching and HTTP status selection.
- System health/runtime endpoints.
- Filesystem endpoint adaptation through `filesystem-service.mjs`.
- Project endpoint adaptation through an injected application service.

## Non-Responsibilities

- Mission, iteration, Gate, Agent, Candidate, or hardware policy.
- Persisted state mutation.
- Provider selection or C550 execution.
- Duplicating application-service validation.

## Public API

| Module | Input | Output |
|---|---|---|
| `http.mjs` | request/response, bridge, static config | JSON/SSE/static transport helpers |
| `system-routes.mjs` | HTTP context and injected runtime descriptor | handled boolean and response |
| `filesystem-service.mjs` | directory commands | directory DTO or stable error |
| `filesystem-routes.mjs` | HTTP context and filesystem service | handled boolean and response |
| `project-routes.mjs` | HTTP context and Projects application service | handled boolean and response |
| `mission-routes.mjs` | HTTP context and Missions application service | handled boolean and response |
| `mission-query-routes.mjs` | HTTP context and Mission query service | handled boolean and JSON/SSE response |
| `semantic-routes.mjs` | HTTP context and Semantic application service | handled boolean and JSON response |
| `research-routes.mjs` | HTTP context and Research application service | handled boolean and JSON response |
| `run-routes.mjs` | HTTP context and Run application service | handled boolean and JSON response |
| `review-action-routes.mjs` | Resume and review request/cancel/resolve HTTP contexts | handled boolean and JSON response |
| `decision-routes.mjs` | Adopt, reject, and adoption-reversal HTTP contexts | handled boolean and JSON response |
| `candidate-validation-routes.mjs` | Patch, Benchmark, and rollback HTTP contexts | handled boolean and JSON response |
| `baseline-routes.mjs` | Baseline materialization HTTP context | handled boolean and JSON response |
| `operator-test-routes.mjs` | Operator Test list/detail/cancel HTTP contexts | handled boolean and JSON response |
| `mission-control-routes.mjs` | Run cancel, human feedback, and Mission stop contexts | handled boolean and JSON response |
| `knowledge-routes.mjs` | Knowledge draft, reference, and retired publication HTTP contexts | handled boolean and JSON response |
| `runtime-query-routes.mjs` | Runtime state, preflight, and workspace GET contexts | handled boolean and JSON response |
| `runtime-state-routes.mjs` | Runtime state PATCH context | handled boolean and JSON response |
| `reset-routes.mjs` | test-fixture reset POST context | handled boolean and JSON response |

## Route Contract

Every route handler receives `{ request, response, url }` and returns `true` when handled or `false` when it does not own the route. Dependencies are injected when the route group is created.

## Invariants

- Route modules do not import `state-store.mjs`, Agent clients, queue implementations, or TUI code.
- Project routes do not perform Project validation, persistence, Git, or filesystem work.
- JSON responses retain the `__bridge` envelope.
- Request bodies are limited to 1 MB by default.
- Invalid JSON returns the stable `REQUEST_JSON_INVALID` error.
- Filesystem paths are resolved before use and directory names reject separators/system-reserved characters.
- Review routes only map transport fields; pending-review and outcome validation belongs to the application service.
- Decision routes do not apply adoption, knowledge, validation, or recovery state changes.
- Candidate validation routes do not inspect workspaces, submit test tasks, or restore checkpoints.
- Baseline routes do not select source authority, start materializer Agents, or mutate Baseline state.
- Operator Test routes do not implement queue locking, polling, retry, cancellation, or hardware rules.
- Knowledge routes do not enforce draft mutability, writable fields, reference uniqueness, or publication policy.
- Reset routes do not select providers, check runtime capability, or mutate persisted state directly.

## Verification

```bash
npm run test:server-routes
npm run test:smoke
npm run test:boundary
npm run verify:local-c500-release
```
