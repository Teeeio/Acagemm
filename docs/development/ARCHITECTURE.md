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
| `client-runtime/iteration-loop.mjs` | iteration decisions and bounded loop transitions | filesystem persistence, TUI |
| `client-runtime/workflow-kernel.mjs` | workflow outcomes, invariants, recovery projection | provider or hardware calls |
| `client-runtime/state-store.mjs` | persisted state compatibility and state transitions | HTTP response formatting |
| `client-runtime/operator-test-queue.mjs` | serialized task lifecycle and queue persistence | Mission policy and UI |
| `client-runtime/local-c500-service-client.mjs` | C550 task execution adapter and artifacts | Mission iteration decisions |
| `client-runtime/workspace-manager.mjs` | isolated workspace, Diff, checkpoint and restore | Gate decisions |
| `client-runtime/local-server.mjs` | API bootstrap and application orchestration | duplicated domain rules |
| `client-runtime/application` | transport-neutral use-case orchestration and injected effect ports | HTTP formatting, TUI rendering |
| `client-runtime/server` | HTTP helpers and thin route adapters | workflow rules, persisted state mutation |

`local-server.mjs` is the process composition root: it may construct services, bind effect ports, own process lifecycle, and wrap loaded-state projection in the State Repository lock. Workflow decisions and multi-step use cases belong in focused application/domain modules with local contracts. Existing large domain modules such as `state-store.mjs` and `iteration-loop.mjs` remain public domain boundaries; do not grow them with transport or adapter behavior.

## Shared Contracts

- Runtime events: `client-runtime/runtime-events.mjs`
- Agent capability definitions: `client-runtime/agent-runtime/definitions.mjs`
- Agent capability queries: `client-runtime/agent-runtime/capabilities.mjs`
- Workflow outcome and invariant rules: `client-runtime/workflow-kernel.mjs`
- Workflow error normalization: `client-runtime/workflow-error.mjs`
- Fixed operator semantics: `client-runtime/fixed-operator-profiles.mjs`
- Semantic evidence binding: `client-runtime/semantic-snapshot.mjs`

## State Mutation Rule

`state-repository.mjs` is the process-local coordination boundary. API requests, SSE state projection, and auto tick share its exclusive queue. New independent command-style state changes should use `update()` with an expected state version. Projection code that already runs inside `runExclusive()` must use the loaded snapshot plus `persist()`; calling `update()` there would recursively enter the queue and deadlock. Do not add direct `loadState()` or `saveState()` calls to HTTP, TUI, Agent, or hardware adapter code.

## Documentation Rule

Every module directory has a `README.md`. A new directory must include one based on `MODULE_CONTRACT_TEMPLATE.md`. Contract changes and their documentation belong in the same pull request.

The Chinese module ownership and onboarding index is maintained in
[`MODULE_OWNERSHIP.md`](MODULE_OWNERSHIP.md). Update it whenever responsibility moves between
modules or a new first-class module is introduced.
