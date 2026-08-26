# Local C500 Full Workflow Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace the local C500 tester's demo-only execution and loop with a contract-compatible local backend and client-style workflow while preserving explicit smoke mode and truthful mock provenance.

**Architecture:** Keep policy and state transitions in a workflow entrypoint, move Python/C500 execution behind a `submitTest / pollTest / cancelTest` adapter, and use isolated Mission Workspace diffs as candidate admission authority. Agent-facing discovery, materialization, and candidate generation are explicit capability interfaces; they may use Codex when available and must return `needs_human` or `no_candidate` rather than fabricate a fallback.

**Tech Stack:** Node.js ESM, Python harness, Ink TUI, JSON mission artifacts, Git diff manifests, existing `client-runtime` contracts.

---

### Task 1: Local C500 Adapter Contract

**Files:**
- Create: `tools/local-c500-tester/local-c500-adapter.mjs`
- Create: `tests/local-c500-adapter-contract-test.mjs`
- Create: `tests/local-c500-mock-boundary-test.mjs`
- Modify: `tools/local-c500-tester/cli.mjs`
- Modify: `package.json`

- [ ] Add failing tests for submit/poll/cancel, baseline/candidate results, digest and shape binding, and mock provenance.
- [ ] Extract harness, tracer, and profiler execution behind the adapter.
- [ ] Make the adapter persist task state under the mission directory and return queue-compatible task views.
- [ ] Make mock output synthetic only, with `liveHardware: false` and `source: simulation`.
- [ ] Run adapter tests and the existing tester test.

### Task 2: Workspace Candidate Admission

**Files:**
- Create: `tools/local-c500-tester/candidate-admission.mjs`
- Create: `tests/local-c500-candidate-diff-test.mjs`
- Modify: `tools/local-c500-tester/cli.mjs`

- [ ] Add failing tests requiring a changed-file manifest or an explicit no-candidate result.
- [ ] Snapshot the mission workspace before each candidate.
- [ ] Capture a SHA-256 diff digest and changed files after candidate generation.
- [ ] Reject repeated unchanged candidates and bind test tasks to the captured digest.
- [ ] Run candidate admission and tester regressions.

### Task 3: Client-Style Workflow Projection

**Files:**
- Create: `tools/local-c500-tester/workflow-entry.mjs`
- Create: `tools/local-c500-tester/state-projection.mjs`
- Create: `tests/local-c500-workflow-parity-test.mjs`
- Modify: `tools/local-c500-tester/cli.mjs`
- Modify: `tools/local-c500-tester/tui-state.mjs`

- [ ] Add tests proving publish, baseline-first, candidate test, budget, pause/resume/stop, and `needs_human` are represented by one workflow state.
- [ ] Move loop decisions out of `cli.mjs` into workflow-entry and make the CLI a command/persistence shell.
- [ ] Project state for TUI without exposing internal paths.
- [ ] Preserve one-current-mission archive behavior.
- [ ] Run parity, adapter, and existing tester tests.

### Task 4: Local-First Discovery and Materialization

**Files:**
- Create: `tools/local-c500-tester/source-discovery.mjs`
- Create: `tools/local-c500-tester/materializer.mjs`
- Create: `tests/local-c500-discovery-materialization-test.mjs`
- Modify: `tools/local-c500-tester/operator-registry.json`
- Modify: `tools/local-c500-tester/workflow-entry.mjs`

- [ ] Add tests for valid local material, invalid local material, missing material, and semantically unresolved material.
- [ ] Search registry/project sources first and record provenance and validation evidence.
- [ ] Add an online/research capability hook that returns structured material; do not silently substitute a template.
- [ ] Generate and structurally validate entry, reference adapter, shape plan, and metadata when material is sufficient.
- [ ] Stop as `needs_human` when operator semantics or comparable baseline cannot be established.

### Task 5: Real Candidate Agent Boundary

**Files:**
- Create: `tools/local-c500-tester/candidate-agent.mjs`
- Create: `tests/local-c500-candidate-agent-test.mjs`
- Modify: `tools/local-c500-tester/workflow-entry.mjs`
- Modify: `tools/local-c500-tester/candidate-admission.mjs`

- [ ] Add tests for agent context, changed-file candidate, no-candidate, and failure result.
- [ ] Invoke Codex CLI when configured, scoped to the Mission Workspace.
- [ ] Provide mission, source evidence, baseline, failures, profiler/tracer summary, human notes, current best, and budget in the agent context.
- [ ] Require a real diff manifest; never manufacture a candidate JSON record without changed code.
- [ ] Continue with `no_candidate` or `needs_human` when the agent is unavailable or semantically blocked.

### Task 6: Accept Gate, Adoption, and Knowledge

**Files:**
- Create: `tools/local-c500-tester/accept-gate.mjs`
- Create: `tests/local-c500-accept-gate-test.mjs`
- Modify: `tools/local-c500-tester/workflow-entry.mjs`
- Modify: `tools/local-c500-tester/tui-state.mjs`

- [ ] Add tests for accepted, rejected, regression, incomplete evidence, digest mismatch, and mock-only results.
- [ ] Require correctness, valid benchmark, tracer/profiler completion, trusted baseline, same runner/shape, digest match, and truthful provenance.
- [ ] Apply accepted patches to the iteration repository and record positive experience.
- [ ] Record rejected candidates as negative experience.
- [ ] Prevent mock evidence from publishing as real hardware knowledge.

### Task 7: End-to-End Verification

**Files:**
- Create: `tests/local-c500-e2e-test.mjs`
- Modify: `tools/local-c500-tester/README.md`
- Modify: `package.json`

- [ ] Run mock E2E with a real mission, generated candidate diff, local adapter, Gate, and simulation provenance.
- [ ] Run real adapter smoke with configured local tools when available.
- [ ] Verify restart/resume and budget stop retain current best and provenance.
- [ ] Run all local tester tests, client intent/loop/gate/workspace/queue tests, and production build.
- [ ] Record remaining environment-dependent gaps without claiming real C500 validation when unavailable.
