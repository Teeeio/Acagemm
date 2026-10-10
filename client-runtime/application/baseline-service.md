# Baseline Service Contract

## Purpose

Coordinates the command that expands an authoritative Baseline source into the single-file `run.py` form used by production validation.

## Public API

| Export | Input | Output | Errors |
|---|---|---|---|
| `materialize(body)` | optional `baselineSource`/`source`, matrix, and materializer command fields | command result containing persisted state and materializer run ID | workflow guard errors, `BASELINE_SOURCE_REQUIRED`, `STATE_VERSION_CONFLICT` |

## Invariants

- Materialization is allowed only during diagnosis, Candidate, or validation.
- Fixed Profile matrices, shapes, dtypes, and correctness cases are not altered.
- A materialized Baseline is not Candidate evidence and cannot make simulation evidence publishable.
- Idempotency and persisted state transitions remain command-registry responsibilities.

## Dependencies And Side Effects

The service depends only on injected state, command, and guard ports. It does not select source authority, access files, create directories, start an Agent, or write state directly. Those effects belong to the `materialize-baseline` command and its injected adapters.

## Verification

```bash
npm run test:baseline-service
npm run test:baseline-materializer-agent
npm run test:module-boundary
```
