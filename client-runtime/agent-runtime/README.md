# Agent Runtime Module Contract

模块归属：后端 Agent Runtime Adapter。完整的上下游边界和建议主责角色见
[`docs/development/MODULE_OWNERSHIP.md`](../../docs/development/MODULE_OWNERSHIP.md)。

## Purpose

This module defines provider-neutral Agent capabilities and dispatch. It lets production workflow code ask what a runtime supports and invoke a logical operation without branching on provider names.

## Public API

| File | Input | Output |
|---|---|---|
| `definitions.mjs` | none | frozen runtime definitions |
| `registry.mjs` | runtime ID and capability | definition/capability inspection |
| `capabilities.mjs` | runtime ID | managed-workspace boolean |
| `engine.mjs` | registry and provider clients | provider-neutral invocation engine |
| `usage.mjs` | provider events/usage | canonical token usage |

## Invariants

- A definition declares transport, operation mapping, capabilities, usage semantics, and workspace authority.
- Production admission is capability-based, not provider-name-based.
- Managed-workspace runtimes must define a failure classifier.
- Registry definitions are immutable after construction.

## Non-Responsibilities

- Mission persistence and selection.
- HTTP request handling.
- Candidate Gate decisions.
- TUI rendering.
- C550 execution.

## Side Effects

Definitions, registry, capabilities, and usage normalization are pure. Provider process/network side effects remain in the clients and `agent-runtime.mjs` facade.

## Verification

```bash
npm run test:agent-runtime-registry
npm run test:runtime
npm run test:claude
npm run test:codex
npm run test:opencode
```
