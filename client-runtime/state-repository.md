# State Repository Module Contract

## Purpose

`state-repository.mjs` is the process-local coordination boundary for persisted product state. It serializes operations that may observe or change state and provides optimistic version checks for command-style updates.

## Responsibilities

- Serialize API, SSE projection, and auto-tick state work in submission order.
- Load isolated snapshots through an injected persistence adapter.
- Persist isolated results through an injected persistence adapter.
- Provide an atomic `load -> version check -> mutate -> save` update operation.
- Keep the queue usable after a rejected or failed operation.

## Non-Responsibilities

- Define the product state shape or migrations.
- Decide Mission, iteration, Gate, Agent, or hardware behavior.
- Implement cross-process locking.
- Replace the durable command journal.
- Normalize workflow errors or reconcile workflow invariants.

## Public API

| API | Input | Output | Error contract |
|---|---|---|---|
| `createStateRepository()` | `{ load, save, clone? }` | frozen repository | `TypeError` for missing adapters |
| `read(options?)` | persistence load options | isolated state snapshot | forwards load errors |
| `persist(state)` | complete product state | isolated saved state | forwards save errors |
| `runExclusive(operation)` | async function | operation result | forwards operation errors; queue continues |
| `update(mutate, options?)` | mutator and optional expected version | `{ state, result }` | `STATE_VERSION_CONFLICT` on mismatch |
| `pending()` | none | queued/running operation count | none |

## Inputs

- `load(options)` returns the current complete state.
- `save(state)` persists a complete state and returns the saved projection.
- `mutate(state)` may modify its isolated state argument and may return a value, or `{ state, result }` to replace the saved state explicitly.
- `expectedVersion` is an integer state version. `null` disables optimistic validation.

## Outputs and Side Effects

The module itself performs no filesystem I/O. Side effects belong to injected adapters. Returned state values are cloned so a caller cannot mutate the persisted object by retaining a reference.

## Invariants

- At most one exclusive operation executes at a time per repository instance.
- Operations begin in submission order.
- Failure never poisons later queue entries.
- A version mismatch never calls the mutator or save adapter.
- All Runtime state work that can trigger projection or persistence must enter through `runExclusive` or `update`.

## Current Integration

`local-server.mjs` uses one repository instance for normal API requests, SSE state projection, and auto tick. Existing command handlers still use `read()` and `persist()` inside `runExclusive`; they should migrate incrementally to `update()` as application services are extracted.

## Verification

```bash
npm run test:state-repository
npm run test:journal
npm run test:smoke
npm run verify:local-c500-release
```
