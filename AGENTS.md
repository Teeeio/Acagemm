# Operator Studio Development Contract

This repository uses module contracts to support parallel and AI-assisted development.

## Read Before Editing

1. Read `docs/development/ARCHITECTURE.md`.
2. Read the nearest `README.md` in the directory being changed.
3. Keep changes inside that module's responsibilities and public contract.
4. Update the module README when inputs, outputs, invariants, side effects, or public APIs change.

## Dependency Direction

The allowed direction is:

```text
TUI -> HTTP API -> application orchestration -> domain rules -> ports -> adapters
```

- Domain rules must not import TUI, HTTP, Claude, Codex, C550, or filesystem implementations.
- TUI code must not mutate persisted runtime state directly.
- HTTP routes must not duplicate workflow, Gate, Profile, or hardware rules.
- Cross-module imports should target documented public APIs. Do not add a deep import without documenting it.

## Non-Negotiable Invariants

- `client-runtime/fixed-operator-profiles.mjs` is the only source of fixed Profile semantics and test matrices.
- Simulation evidence must never become publishable live-hardware evidence.
- Candidate evidence must match the candidate applied to the Mission Workspace.
- Fixed shapes, dtypes, correctness cases, benchmark profiles, and retry budgets must not be weakened.
- Agent writes are limited to the active Mission Workspace.
- Operator tests remain serialized and persist terminal outcomes atomically.
- Production behavior belongs to the TUI -> Production API -> Client Runtime path. Do not recreate a second workflow.

## Required Verification

Run the nearest module tests while developing. Before merging a cross-module change, run:

```bash
npm run verify:local-c500-release
```

Hardware-free changes should also run `npm run verify:non-hardware-robustness` when time permits.
