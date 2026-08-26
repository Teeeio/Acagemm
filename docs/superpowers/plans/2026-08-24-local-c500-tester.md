# Local C500 Tester Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build an isolated command-line/TUI local C500 mission tester that lets users publish a mission, add human notes, inspect a panel, and export reports while the fixed test workflow runs inside the tool.

**Architecture:** The implementation lives only under `tools/local-c500-tester/` plus isolated test and package script entries. The CLI owns mission state and short summaries; the Python harness owns local correctness/benchmark/profile execution. No client runtime, UI, remote queue, or mission state-machine files are modified.

**Tech Stack:** Node.js ESM CLI, Python 3 harness, JSONL/JSON reports, no new npm dependencies.

---

### Task 1: CLI contract and isolated state

**Files:**
- Create: `tests/local-c500-tester-test.mjs`
- Create: `tools/local-c500-tester/cli.mjs`
- Create: `tools/local-c500-tester/README.md`
- Modify: `package.json`

- [ ] **Step 1: Write failing tests**

Add tests that run the CLI in a temp data dir and assert:
- `mission create` records a mission with time/token budget and expected environment versions.
- `panel --once` renders mission, budget, environment, current best, and recent events.
- package scripts point to the isolated CLI.

- [ ] **Step 2: Verify tests fail**

Run: `node tests/local-c500-tester-test.mjs`

Expected: FAIL because `tools/local-c500-tester/cli.mjs` does not exist.

- [ ] **Step 3: Implement minimal CLI**

Implement `mission create`, `mission note`, `panel --once`, `export`, and `doctor --mock`. Persist only under `LOCAL_C500_TESTER_HOME` or `.local-c500-tester/`.

- [ ] **Step 4: Verify tests pass**

Run: `node tests/local-c500-tester-test.mjs`

Expected: PASS.

### Task 2: Python harness wrapper

**Files:**
- Create: `tools/local-c500-tester/harness.py`
- Create: `tools/local-c500-tester/fixtures/vector_add/run.py`
- Modify: `tests/local-c500-tester-test.mjs`

- [ ] **Step 1: Write failing tests**

Add tests for `mission run --mock --operator-path tools/local-c500-tester/fixtures/vector_add` that assert `summary.json`, `rounds.jsonl`, `environment.json`, and operator snapshot are written.

- [ ] **Step 2: Verify tests fail**

Run: `node tests/local-c500-tester-test.mjs`

Expected: FAIL because harness and run command are missing.

- [ ] **Step 3: Implement harness and run command**

The harness imports a Python operator project, checks `get_inputs`, `run`, and `reference`, runs correctness and benchmark, and emits compact JSON. In `--mock`, it returns deterministic C500-like results without requiring hardware.

- [ ] **Step 4: Verify tests pass**

Run: `node tests/local-c500-tester-test.mjs`

Expected: PASS.

### Task 3: Budget and report accounting

**Files:**
- Modify: `tools/local-c500-tester/cli.mjs`
- Modify: `tests/local-c500-tester-test.mjs`

- [ ] **Step 1: Write failing tests**

Assert each round records elapsed time, tokens used, completion status, stop reason, baseline latency, candidate latency, speedup, and tool availability.

- [ ] **Step 2: Verify tests fail**

Run: `node tests/local-c500-tester-test.mjs`

Expected: FAIL until accounting fields are present.

- [ ] **Step 3: Implement accounting**

Update mission and round records after each run; keep agent-facing context limited to `summary.json`.

- [ ] **Step 4: Verify tests pass**

Run: `node tests/local-c500-tester-test.mjs`

Expected: PASS.

### Task 4: Final verification

**Files:**
- All above.

- [ ] **Step 1: Run isolated tester tests**

Run: `node tests/local-c500-tester-test.mjs`

- [ ] **Step 2: Run build**

Run: `npm run build`

- [ ] **Step 3: Confirm no client runtime files changed**

Run: `git status --short`

Expected: Changes are limited to `package.json`, `tests/local-c500-tester-test.mjs`, `tools/local-c500-tester/`, and this plan.
