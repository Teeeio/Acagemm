# Single Current Publish Mission Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Align the local C500 tester with the client mental model by exposing only one current mission, a single Publish action, and internal operator/workspace resolution.

**Architecture:** Keep CLI debug compatibility, but make Ink TUI operate only on `.local-c500-tester/current`. Publishing archives the previous current mission, resolves the operator from an internal registry, prepares an isolated workspace, writes mission/report state, and starts the background runner immediately. The TUI no longer asks for or displays operator paths.

**Tech Stack:** Node.js ESM, React 18, Ink, JSON registry/state files, existing Python harness.

---

### Task 1: Registry-backed publish flow

**Files:**
- Create: `tools/local-c500-tester/operator-registry.json`
- Create: `tools/local-c500-tester/operator-templates/vector_add/run.py`
- Modify: `tools/local-c500-tester/cli.mjs`
- Test: `tests/local-c500-tester-test.mjs`

- [ ] **Step 1: Write failing tests**

Add assertions that `panel --publish --operator vector_add --json` returns `status: running`, writes `.local-c500-tester/current/mission.json`, prepares `.local-c500-tester/current/workspace/operator/run.py`, and does not require `--operator-path`.

- [ ] **Step 2: Verify failure**

Run: `node tests/local-c500-tester-test.mjs`

Expected: FAIL because `panel --publish` and registry resolution do not exist.

- [ ] **Step 3: Implement publish**

Add registry loading, archive-current, isolated workspace preparation, and background runner startup from the copied workspace.

- [ ] **Step 4: Verify pass**

Run: `node tests/local-c500-tester-test.mjs`

Expected: PASS.

### Task 2: Single current Ink console

**Files:**
- Modify: `tools/local-c500-tester/tui-state.mjs`
- Modify: `tools/local-c500-tester/components/Dashboard.mjs`
- Modify: `tools/local-c500-tester/components/CreateMissionForm.mjs`
- Modify: `tools/local-c500-tester/tui.mjs`
- Test: `tests/local-c500-tester-test.mjs`

- [ ] **Step 1: Write failing tests**

Assert snapshot output contains `Current Mission Console` and `[P] Publish`, does not contain `Missions`, and the publish form does not contain `Operator path`.

- [ ] **Step 2: Verify failure**

Run: `node tests/local-c500-tester-test.mjs`

Expected: FAIL until the TUI is single-current.

- [ ] **Step 3: Implement single-current console**

Render only current mission state, rename form to publish, and map `P` to publish form.

- [ ] **Step 4: Verify pass**

Run: `node tests/local-c500-tester-test.mjs`

Expected: PASS.

### Task 3: Final verification

**Files:**
- Modify: `tools/local-c500-tester/README.md`

- [ ] **Step 1: Update docs**

Document the single publish flow and internal registry.

- [ ] **Step 2: Run tests**

Run: `npm run test:local-c500-tester`

Expected: PASS.

- [ ] **Step 3: Run build**

Run: `npm run build`

Expected: PASS.
