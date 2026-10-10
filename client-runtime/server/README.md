# Server Module Contract

HTTP requests may carry `x-operator-runtime-instance` with the original
`pid|ownerPid|startedAt` bootstrap identity. The composition root supplies its
current identity to `createLocalHttpRequestValidator`; a missing header retains
existing behavior, while duplicate/mismatched supplied values return
`409 RUNTIME_ATTACHMENT_CONFLICT` before body parsing or mutation. This is an
optional connection precondition, not authentication. Existing local Host/Origin,
browser-write and request-body protections remain mandatory.

`POST /api/missions/:id/pending-candidate/new-attempt` forwards the manifest-only
body to Candidate Validation and returns 201 with the new paused Mission and
`started:false`. The application/journal own all creation and recovery rules.

Candidate routes include `POST /api/missions/:id/pending-candidate/settle` and
`.../continue`, forwarding only the identity body to Candidate Validation. They
return committed feedback (200) or generation (202), with idempotent receipts.
No workflow, Gate, workspace or budget rule is implemented in transport.

模块归属：后端 HTTP Transport。完整的上下游边界和建议主责角色见
[`docs/development/MODULE_OWNERSHIP.md`](../../docs/development/MODULE_OWNERSHIP.md)。

## Purpose

`server/` owns HTTP transport concerns and thin route adapters. It translates HTTP requests into calls on injected services and translates results or errors into transport responses.

## Responsibilities

- `POST /api/mission-drafts` forwards preparation save/update to Missions service
  (`{form,id?,revision?}`); `GET /api/mission-drafts/:id` reads it. These records
  cannot be selected or started as Missions. Existing Mission POST forwards
  optional `draftId,draftRevision` for atomic promotion.

- JSON response envelopes and request-body limits.
- Local Host/Origin and browser-write validation before body parsing or mutation queues; invalid URL/Host inputs return structured errors without terminating the server. See `http.md`.
- SSE framing and static-file delivery.
- Route matching and HTTP status selection.
- `POST /api/missions/:id/pending-candidate/submit` forwards `{manifestDigest}` to
  Candidate Validation and returns 202 with state/run/task identity. No source or
  matrix override is accepted. Repeats include `idempotent:true`; conflicts remain
  409. GET pending-candidate stays a read-only export query.
- System health/runtime endpoints.
- Filesystem endpoint adaptation through `filesystem-service.mjs`.
- Project endpoint adaptation through an injected application service.
- `POST /api/projects/import` delegates ordinary Git source snapshot import to Projects service and returns `201 {state, project}`; routes never copy source files themselves.
- Existing Mission creation forwards `missionPaused:true` for saved drafts; `/api/missions/:id/runs` forwards explicit `startDraft:true` to Run service for atomic fresh-draft admission. Routes do not unpause Missions themselves.
- `GET /api/missions/:id/traces` delegates kind/view/limit/cursor to the read-only
  trace service; see [the trace contract](../iteration-trace.md). It never selects
  a Mission, saves state or advances execution.
- `GET /api/missions/:id/evaluation` and `/evaluation/export` delegate descriptive
  reports and raw-fact exports to that same read-only service. HTTP adds no scoring
  policy or publication qualification; errors propagate without partial reports.
- `GET /api/missions/:id/pending-candidate` returns the application service's verified frozen source bundle and pending identity. It does not start tests, select a Mission, or produce test evidence.

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
| `iteration-trace-routes.mjs` | HTTP context and committed trace query service | handled boolean and paginated JSON response |
| `semantic-routes.mjs` | HTTP context and Semantic application service | handled boolean and JSON response |
| `research-routes.mjs` | HTTP context and Research application service | handled boolean and JSON response |
| `run-routes.mjs` | HTTP context and Run application service | handled boolean and JSON response |
| `review-action-routes.mjs` | Resume and review request/cancel/resolve HTTP contexts | handled boolean and JSON response |
| `decision-routes.mjs` | Adopt, reject, and adoption-reversal HTTP contexts | handled boolean and JSON response |
| `candidate-validation-routes.mjs` | Patch, Benchmark, and rollback HTTP contexts | handled boolean and JSON response |
| `baseline-routes.mjs` | Baseline materialization HTTP context | handled boolean and JSON response |
| `operator-test-routes.mjs` | Operator Test list/detail/cancel HTTP contexts | handled boolean and JSON response |
| `execution-package-routes.mjs` | execution-source import POST | immutable manifest/admission DTO from the import application service |
| `mission-control-routes.mjs` | Run cancel, human feedback, and Mission stop contexts | handled boolean and JSON response |
| `experience-routes.mjs` | Project-scoped experience GET/POST/PATCH | versioned guidance DTOs; no public observation writes |
| `knowledge-routes.mjs` | Knowledge draft, reference, and retired publication HTTP contexts | handled boolean and JSON response |
| `runtime-query-routes.mjs` | Runtime state, preflight, and workspace GET contexts | handled boolean and JSON response |
| `runtime-advance-routes.mjs` | Explicit runtime advancement POST | handled boolean and state response |
| `runtime-state-routes.mjs` | Runtime state PATCH context | handled boolean and JSON response |
| `reset-routes.mjs` | test-fixture reset POST context | handled boolean and JSON response |

## Route Contract

Every route handler receives `{ request, response, url }` and returns `true` when handled or `false` when it does not own the route. Dependencies are injected when the route group is created.

Snapshot GET and SSE use read-only state ports; task list/detail use read-only queue
ports. `POST /api/runtime/advance` calls the same application advancement service
as background tick under the State Repository lock. SSE revisions include stable
recovery status/code/command identity so transient recovery pauses are observable
without committing an artificial version or emitting on every inspection timestamp.
Routes do not implement either
workflow or recovery policy.

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

## Bounded body reads

[http.mjs](http.md) caches one bounded body read per request (default 5 seconds,
1 MB). The composition root reads write-request bodies before the mutation lock;
routes reuse the cached Promise. Timeout produces REQUEST_BODY_TIMEOUT (408),
flushes the error response and closes the request connection. Snapshot GET/SSE
observe committed state without waiting for the mutation queue.

Legacy local Claude host recovery uses the immutable [host recovery contract](../claude-host-recovery.md). Capture never releases resources; recovery requires independently verified later same-host Windows boot and leaves remote result/cost unknown.

The empty-body retire-execution Mission route delegates native transport absence plus permanent identity fencing to [execution retirement](../claude-execution-retirement.md). It never confirms original exit or remote completion; other unconfirmed queue resources remain barriers.

Host-only OPERATOR_RETIREMENT_ONLY_CONFIG selects [exact durable Job loss maintenance](../claude-job-loss-retirement.md). With pinned storage and automatic ticks disabled, the same production routes/services accept only health/state/queue GETs and the exact approved empty-body retirement POST. Other API requests return RETIREMENT_MAINTENANCE_ONLY. Maintenance reads the stored runtime descriptor, avoiding CLI/auth/GPU probes, and writes a distinct maintenance PID file.
