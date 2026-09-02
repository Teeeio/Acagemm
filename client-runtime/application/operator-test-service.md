# Operator Test Service Contract

## Purpose

Exposes read and cancellation use cases for the serialized Operator Test Queue without leaking HTTP concerns into the queue adapter.

## Public API

| Export | Input | Output | Errors |
|---|---|---|---|
| `list()` | none | `{ tasks, queueFile }` | queue errors |
| `get(taskId)` | queue task ID | task view | `OPERATOR_TEST_QUEUE_NOT_FOUND` |
| `cancel(taskId)` | queue task ID | terminal or cancel-requested task view | `OPERATOR_TEST_QUEUE_NOT_FOUND`, queue lock errors |

## Invariants

- Queue submission and execution remain serialized by `operator-test-queue.mjs`.
- Terminal task outcomes remain atomic and cancellation remains idempotent.
- This service does not submit tests, mutate Mission state, interpret evidence, or call hardware directly.

## Dependencies And Side Effects

The only dependency is an injected queue port exposing `path`, `list`, `get`, and `cancel`. Side effects are exactly those of that queue port.

## Verification

```bash
npm run test:operator-test-service
npm run test:queue
npm run test:module-boundary
```
