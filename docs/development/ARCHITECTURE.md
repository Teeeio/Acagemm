# Development Architecture

## Production Path

```text
Ink TUI
  -> Production API client
  -> Client Runtime HTTP API
  -> Mission and iteration orchestration
  -> Agent Runtime / Workspace / Operator Test Queue
  -> C550 runner and evidence
  -> Accept Gate
  -> adoption or rollback
```

The removed standalone local CLI workflow is not a supported architecture. New command-line interfaces must call the production HTTP API instead of implementing Mission, Candidate, Gate, or iteration rules again.

## Module Boundaries

| Module | Owns | Must not own |
|---|---|---|
| `tools/local-c500-tester` | Ink UI, production API client, launcher, environment preflight | persisted state mutation, workflow rules |
| `client-runtime/agent-runtime` | runtime definitions, capabilities, dispatch contracts | Mission persistence, TUI rendering |
| `client-runtime/agent-runtime.mjs` | Agent use-case lifecycle and provider coordination | HTTP routing, hardware execution |
| `client-runtime/candidate-generation/` | pure Candidate prompt rendering and Workspace Diff/language/repeat admission | Agent process/provider lifecycle, Queue, Gate, adoption, iteration persistence |
| `client-runtime/iteration-loop.mjs` | iteration decisions and bounded loop transitions | filesystem persistence, TUI |
| `client-runtime/workflow-kernel.mjs` | workflow outcomes, invariants, recovery projection | provider or hardware calls |
| `client-runtime/state-store.mjs` | compatibility assembly, snapshot schema/version and recovery coordination | domain-rule bodies, new pure-policy consumers, HTTP formatting |
| `client-runtime/mission-project-state.mjs` | injected-path Mission/Project normalization and transitions | storage or Agent execution |
| `client-runtime/knowledge-state.mjs` | adoption and source-aware in-memory governance | external publication, workspace changes |
| `client-runtime/mission-state-shapes.mjs` | budget/Agent/Research/Iteration records | execution |
| `client-runtime/state-initialization.mjs` | seed/product construction from a Mission domain port | storage initialization |
| `client-runtime/state-reference-data.mjs`, `state-reference-runtime.mjs` | legacy fixture records and in-memory progression | live evidence or real execution |
| `client-runtime/accept-gate.mjs` | acceptance rules and Baseline evidence | I/O, test execution, adoption |
| `client-runtime/operator-test-evidence.mjs` | in-memory test evidence and decision projection | persistence, queue/provider execution |
| `client-runtime/state-workspace.mjs` | layout, fixture and checkpoint adapter | Gate rules, state-store imports |
| `client-runtime/state-snapshot-storage.mjs` | raw snapshot I/O and injected storage bootstrap | schema/version policy, workflow decisions |
| `client-runtime/operator-test-queue.mjs` | serialized task lifecycle and queue persistence | Mission policy and UI |
| `client-runtime/local-c500-service-client.mjs` | C550 task execution adapter and artifacts | Mission iteration decisions |
| `tools/local-shared-gpu-runner.py` | opt-in shared-host NVIDIA execution adapter and GPU timing | Mission policy, queue ownership, publication decisions |
| `client-runtime/workspace-manager.mjs` | isolated workspace, Diff, checkpoint and restore | Gate decisions |
| `client-runtime/local-server.mjs` | API bootstrap and application orchestration | duplicated domain rules |
| `client-runtime/application` | transport-neutral use-case orchestration and injected effect ports | HTTP formatting, TUI rendering |
| `client-runtime/server` | HTTP helpers and thin route adapters | workflow rules, persisted state mutation |

`local-server.mjs` is the process composition root: it may construct services, bind effect ports, own process lifecycle, and wrap mutations/explicit advancement in the State Repository lock. Snapshot reads observe atomic committed state without waiting on that lock. Workflow decisions and multi-step use cases belong in focused application/domain modules with local contracts. `iteration-loop.mjs` is an I/O-free policy boundary with injected execution ports.
`state-store.mjs` is a compatibility assembly/storage boundary, not a pure domain
module. Mission/Project and Knowledge rules now live in canonical modules.
The Mission/Project factory receives root/workspace strings and two path-query
ports; it imports neither storage configuration nor workspace implementations.
Initial-state construction consumes this domain factory, never the reverse.
The facade retains incoming snapshot schema/version policy and recovery ordering.

Command handlers and admission policy are application-owned:
`application/{candidate-commands,benchmark-command,decision-commands,agent-commands,workflow-command-policy}.mjs`.
The composition root registers their command definitions; it does not implement
their preparation or state-application bodies. The command journal persists intent
before effects and prepared results before state.

The production arrows describe runtime calls. Source dependencies on implementations
are bound at the composition root: application/domain code consumes pure contracts
and injected ports; adapters implement those ports. A runtime call to an adapter does
not authorize a direct import of its implementation into a domain module.

## Shared Contracts

- Language-neutral package/admission: `client-runtime/execution-package-contract.mjs`
- Resource-release barriers: `client-runtime/cancellation-contract.mjs`
- Versioned development experience: `client-runtime/experience-contract.mjs`
- Complete round wall clock: `client-runtime/round-budget-contract.mjs`
- Runtime and audit events: `client-runtime/runtime-events.mjs`
- Gate rules and evidence projection: `client-runtime/accept-gate.mjs`, `client-runtime/operator-test-evidence.mjs`
- Evidence state shapes and Mission objectives: `client-runtime/evidence-state.mjs`, `client-runtime/mission-objective.mjs`
- Stable legacy identifier formatting: `client-runtime/state-identifiers.mjs`
- Mission shapes and transitions: `client-runtime/mission-state-shapes.mjs`, `client-runtime/mission-project-state.mjs`
- Knowledge adoption/governance: `client-runtime/knowledge-state.mjs`
- Default records, initial snapshots and fixture projections: `client-runtime/state-reference-data.mjs`, `client-runtime/state-initialization.mjs`, `client-runtime/state-reference-runtime.mjs`
- Agent capability definitions: `client-runtime/agent-runtime/definitions.mjs`
- Agent capability queries: `client-runtime/agent-runtime/capabilities.mjs`
- Candidate generation contract: `client-runtime/candidate-generation/README.md`,
  `client-runtime/candidate-generation/CONSTRAINTS.md`
- Workflow outcome and invariant rules: `client-runtime/workflow-kernel.mjs`
- Workflow error normalization: `client-runtime/workflow-error.mjs`
- Fixed operator semantics: `client-runtime/fixed-operator-profiles.mjs`
- Semantic evidence binding: `client-runtime/semantic-snapshot.mjs`

The release gate checks the full static dependency graph of Gate, evidence,
objective, Mission/Project, Knowledge, initialization, shared-state and iteration
modules, including re-exports. Every Application module is checked transitively
as well; Mission/Project services require explicit transition ports, with no
state-store default. Declarative Agent capabilities and pure usage normalization
are shared contracts, not Provider execution. It rejects
concrete storage/workspace/provider dependencies and effectful Node builtins.
Storage initializer factories and Workspace initialization are injected to avoid
adapter-to-facade cycles. Legacy state-store exports remain compatible; no new
snapshot schema or hardware policy is introduced by these extractions. The
execution record and compatibility findings are in [the state domain Goal](STATE_DOMAIN_GOAL.md).

## State Mutation Rule

`state-repository.mjs` is the process-local coordination boundary. Mutating API commands and auto tick share its exclusive queue. Bounded request-body parsing occurs before it; snapshot GET/SSE do not enter it. New independent command-style state changes should use `update()` with an expected state version. Projection code that already runs inside `runExclusive()` must use the loaded snapshot plus `persist()`; calling `update()` there would recursively enter the queue and deadlock. Do not add direct `loadState()` or `saveState()` calls to HTTP, TUI, Agent, or hardware adapter code.


## Query and advancement boundary

Snapshot GET/SSE and task inspection use read-only ports. They do not repair
storage, recover commands, project running Agents, dispatch tests, adopt Candidates
or persist state. Queries read atomic committed snapshots without waiting for
external work under the mutation lock. Commands still use the process-local
exclusive queue. Operator tests dispatch by a short durable queue claim; backend
I/O runs outside the queue/state locks and cannot turn a query into execution.

Background tick and `POST /api/runtime/advance` call the same
`application/runtime-lifecycle-service.mjs` advancement entry. Initialization and
journal recovery precede the ordered application pipeline. An unresolved recovery
blocks all automatic effects. Default tick is enabled; deterministic harnesses set
`OPERATOR_AUTO_TICK=0` and POST explicit advancement instead of relying on GET.
This compatibility setting also disables automatic Candidate actions; explicit
advancement still runs recovery, projection and iteration settlement.

## Documentation Rule

Every module directory has a `README.md`. A new directory must include one based on `MODULE_CONTRACT_TEMPLATE.md`. Contract changes and their documentation belong in the same pull request.

The Chinese module ownership and onboarding index is maintained in
[`MODULE_OWNERSHIP.md`](MODULE_OWNERSHIP.md). Update it whenever responsibility moves between
modules or a new first-class module is introduced.
