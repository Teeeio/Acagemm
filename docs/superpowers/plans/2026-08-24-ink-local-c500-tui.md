# Ink Local C500 TUI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the local C500 tester readline panel with an Ink component TUI that can create missions, keep UI mode during refresh, and monitor background runners.

**Architecture:** Keep the existing mission JSON files, Python harness, and background runner behavior. Split CLI data/runner logic into small modules that both the CLI and Ink TUI can call. The Ink UI manages screen mode and form drafts separately from refreshed mission data.

**Tech Stack:** Node.js ESM, React 18, Ink, JSON state files, existing Python harness.

---

### Task 1: Extract state and runner helpers

**Files:**
- Create: `tools/local-c500-tester/state.mjs`
- Create: `tools/local-c500-tester/runner.mjs`
- Modify: `tools/local-c500-tester/cli.mjs`
- Test: `tests/local-c500-tester-test.mjs`

- [ ] **Step 1: Write failing tests**

Assert that `panel --create --json` creates a running background mission and that the background process completes by writing `summary.json`.

- [ ] **Step 2: Verify failure**

Run: `node tests/local-c500-tester-test.mjs`

Expected: FAIL if the extracted helpers or behavior are missing.

- [ ] **Step 3: Extract helpers**

Move filesystem state helpers and runner helpers out of `cli.mjs` without changing JSON schema.

- [ ] **Step 4: Verify pass**

Run: `node tests/local-c500-tester-test.mjs`

Expected: PASS.

### Task 2: Add Ink dependency and TUI entrypoint

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Create: `tools/local-c500-tester/tui.mjs`
- Modify: `tools/local-c500-tester/cli.mjs`
- Test: `tests/local-c500-tester-test.mjs`

- [ ] **Step 1: Write failing tests**

Assert package dependencies include `ink`, `tester:c500` launches `tools/local-c500-tester/tui.mjs`, and CLI snapshot commands still work.

- [ ] **Step 2: Verify failure**

Run: `node tests/local-c500-tester-test.mjs`

Expected: FAIL until Ink entrypoint and dependency are present.

- [ ] **Step 3: Install dependency and wire entrypoint**

Run `npm install ink@5`.

Update `tester:c500` to `node tools/local-c500-tester/tui.mjs`.

- [ ] **Step 4: Verify pass**

Run: `node tests/local-c500-tester-test.mjs`

Expected: PASS.

### Task 3: Build componentized dashboard

**Files:**
- Create: `tools/local-c500-tester/components/Layout.mjs`
- Create: `tools/local-c500-tester/components/MissionList.mjs`
- Create: `tools/local-c500-tester/components/MissionDetail.mjs`
- Create: `tools/local-c500-tester/components/EventLog.mjs`
- Create: `tools/local-c500-tester/components/DoctorPanel.mjs`
- Modify: `tools/local-c500-tester/tui.mjs`
- Test: `tests/local-c500-tester-test.mjs`

- [ ] **Step 1: Write failing tests**

Assert a non-interactive Ink render command contains section labels: `Missions`, `Details`, `Environment`, `Latest Round`, `Events`, and shortcut line `[C] Create`.

- [ ] **Step 2: Verify failure**

Run: `node tests/local-c500-tester-test.mjs`

Expected: FAIL until components render.

- [ ] **Step 3: Implement components**

Create plain Ink components with Box/Text layout and a deterministic `--once` render path for tests.

- [ ] **Step 4: Verify pass**

Run: `node tests/local-c500-tester-test.mjs`

Expected: PASS.

### Task 4: Add create form and preserve mode during refresh

**Files:**
- Create: `tools/local-c500-tester/components/CreateMissionForm.mjs`
- Modify: `tools/local-c500-tester/tui.mjs`
- Test: `tests/local-c500-tester-test.mjs`

- [ ] **Step 1: Write failing tests**

Assert a test render starts in create mode, refreshes mission data, and still shows the create form draft rather than returning to dashboard.

- [ ] **Step 2: Verify failure**

Run: `node tests/local-c500-tester-test.mjs`

Expected: FAIL until UI mode is independent of refreshed data.

- [ ] **Step 3: Implement form state**

Use React state for `mode`, `selectedMissionId`, and `draft`. Refresh only mission data.

- [ ] **Step 4: Verify pass**

Run: `node tests/local-c500-tester-test.mjs`

Expected: PASS.

### Task 5: Final verification and docs

**Files:**
- Modify: `tools/local-c500-tester/README.md`

- [ ] **Step 1: Update docs**

Document `npm run tester:c500` as the Ink TUI entry and keep CLI debug commands.

- [ ] **Step 2: Run tester tests**

Run: `npm run test:local-c500-tester`

Expected: PASS.

- [ ] **Step 3: Run build**

Run: `npm run build`

Expected: PASS.

- [ ] **Step 4: Confirm isolation**

Run: `git status --short`

Expected: changes remain in isolated local tester paths plus package dependency files.
