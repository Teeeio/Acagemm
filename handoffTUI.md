# TUI Branch Handoff

Updated: 2026-09-02 (Asia/Shanghai)

## 1. Scope and branch boundary

This handoff is only for continued development and debugging of the `TUI` branch.

- Branch: `TUI`
- Active checkout: any clean checkout whose current branch is `TUI`; do not rely on the removed `.worktrees/local-c500-tester` path.
- Do not edit, merge, rebase, or commit against `main`.
- Run every edit, test, and Git command from the active `TUI` checkout.
- Preserve persisted test data and unrelated user changes. Do not delete `.local-c500-production` unless the user explicitly authorizes a destructive reset.

Before changing code, verify:

```powershell
git branch --show-current   # must print TUI
git status --short --branch
```

## 2. Current objective

Deliver a TUI test build that can be pulled onto a MetaX C550 machine and run with an already configured Claude Code account, without additional Operator Studio environment configuration. Everything except actual GPU execution should be closed and validated locally.

The production path is:

```text
TUI publish
-> production project and Mission APIs
-> Claude Code Research / Materializer / Iteration Agent
-> isolated Mission Workspace Git Diff admission
-> serial local-c500 operator-test queue
-> tools/local-c500-runner.py on C550
-> correctness and benchmark evidence
-> Accept Gate
-> KEEP/adopt or DISCARD/rollback
-> bounded iteration loop
```

The test build currently keeps six fixed Profiles. The latest comparison work focuses on two independent v0.1 Missions:

- `paged-mqa-logits-triton-v01`: `bf16_paged_mqa_logits`
- `flash-mla-decode-triton-v01`: `flash_mla_decode`

They are not one combined task. Each has its own workspace, baseline, candidates, test history, best version, and report.

The four earlier Profiles remain available:

- `paged-mqa-logits-triton`
- `flash-mla-decode-triton`
- `paged-decode-attention-maca` (display name: FlashInfer Paged Decode)
- `mla-paged-decode-attention-maca` (display name: FlashInfer MLA Paged Attention)

## 3. Immutable v0.1 Profile contract

The single source of truth is `client-runtime/fixed-operator-profiles.mjs`. Do not duplicate or casually normalize the shape definitions elsewhere.

For each v0.1 Mission:

- Correctness has 8 fixed shape groups, each executed for FP32, FP16, and BF16: 24 cases total.
- Benchmark has exactly 2 fixed BF16 profiles.
- Timing is `triton.testing.do_bench`, warmup 25, repetitions 100, median result.
- Shape, dtype, Oracle, tolerance, case name, and benchmark profile may not be reduced or changed after publication.
- OOM, compile failure, timeout, missing result, or a failed fixed case is a real failed attempt. Never silently downscale a shape.
- Initial correctness plus at most 3 correctness repair attempts means `maxCorrectnessAttempts = 4` within the same active candidate round.
- After correctness is established, execute exactly 3 performance rounds.
- A failed Agent generation with no valid Diff does not consume a performance round.
- A correctness failure consumes a bounded correctness repair attempt but does not advance the performance round.
- KEEP requires all fixed benchmark profiles to avoid regression and at least one profile to improve strictly. Otherwise DISCARD and restore the stable best workspace.
- The final output is the best correctness-passing version across the three performance rounds, not merely the third candidate.

Required deliverables are Profile-specific. Both retain `run.py` as the controlled runner bridge. The MQA Mission requires `paged_mqa_logits.py`; the MLA Mission requires `flash_mla.py`. Both also require `torch_ref.py`, `test_correctness.py`, `bench_perf.py`, and `report.md`.

The two operators must remain semantically independent. Do not merge them because both use paged cache or attention-like math.

## 4. Fixed workflow versus Agent freedom

Fixed workflow owns:

- Mission creation and Profile freezing
- workspace isolation and Git Diff admission
- queue serialization and task persistence
- exact correctness/benchmark matrix
- runner invocation and result validation
- provenance, Accept Gate, rollback/adoption, round accounting
- runtime restart contract and TUI state projection

Agents own:

- optional external research for implementation experience
- initial kernel implementation
- diagnosis and bounded repair of correctness failures
- performance optimization direction and code changes
- report content

For embedded fixed Profiles, external authoritative source collection is not a prerequisite. Research keeps local/network access for implementation experience, but it must not replace or mutate the frozen semantic/test contract.

The Iteration Agent is intentionally restricted to its Mission Workspace. Bash is disabled. Source Registry, parent directories, sibling projects, prior test tasks, and unrelated files are outside its boundary.

## 5. Runtime defaults and hardware boundary

- Default Agent runtime: `claude-code`
- Default test backend: `local-c500` compatibility name
- Default hardware mode: real hardware, not mock
- Device detection supports C550/C500 through PyTorch and `mx-smi`; current target is C550.
- Default tester state: `<checkout>/.local-c500-production`
- Default API port: `4275`
- Bundled Node: Linux x64 Node `24.19.0`
- Current runtime contract: v6. Pulling a newer checkout and starting through the supported launcher replaces a recognized older Operator Studio runtime automatically.
- `mcTracer` and `mcProfiler` are best-effort diagnostics. They are actively attempted but missing/failing tools do not block correctness, benchmark, Gate, or adoption.
- Only results with `environment.liveHardware=true` and live Gate provenance may be publishable. Simulation results must remain non-publishable.

## 6. Recent fixes already present

- `3981933`: preserve live evidence provenance across rounds.
- `5250984`: repair paused Mission lifecycle.
- `5efc111`: add the two independent Triton v0.1 comparison Profiles and strict suite Gate.
- `b4734ab`: stop borrowing the current empty benchmark to validate a previous live Gate; recover stale workflow pauses; isolate new Mission state.
- `60544c5`: make the runner asynchronous and observable; expose runner stage/progress; distinguish candidate generation attempts, correctness repairs, and performance rounds; improve TUI queue/activity display.
- `2006b36`: make Claude cold-start aware that `run.py` may not exist; instruct it to create missing deliverables; recover same-round generation after recoverable Claude failures while preserving auth/network/billing failures as non-recoverable.

Important state-machine behavior now expected:

- A real C550 candidate adopted in round 1 may enter round 2 after the benchmark object is reset without triggering `WORKFLOW_SIMULATION_PUBLISH_FORBIDDEN`.
- Space resume must not immediately complete or immediately re-pause due to an obsolete invariant.
- Publishing a new Mission must not inherit the previous Mission's `missionPaused` or `needs_human` state.
- A running queue task is authoritative over a stale persisted `needs_human` marker.
- Long GPU execution reports correctness/benchmark/diagnostic stages instead of appearing frozen.
- A recoverable Claude cold-start error such as trying to edit a missing `run.py` retries the same candidate round.

## 7. Current verification evidence

The following completed locally on 2026-09-02 after removing the standalone legacy CLI workflow and extracting the first production application/HTTP modules:

```powershell
npm run verify:local-c500-release
```

Result: `PASS: 55 checks completed`, including module boundaries, application-service contracts, workflow kernel, Claude adapter/workflow, iteration loop, Gate, workspace, queue, async local runner, fixed Profiles, C550 detection, language contract, test specification, TUI randomized snapshots, spinner, viewport, refresh ordering, terminal lifecycle, and Vite build.

The hardware-free robustness suite also completed on 2026-09-02:

```powershell
npm run verify:non-hardware-robustness
```

Result: `PASS: 25 checks completed without physical hardware`; its first check reruns the complete local C500 release suite. The full hardware-free suite was last run at the 54-check baseline; the subsequent Baseline Service extraction passed the 55-check release suite and Mission Smoke.

This is not proof that generated Triton kernels are fast or even compilable on C550. No C550 hardware exists in the local Windows verification environment. Actual PyTorch/Triton/MXMACA behavior, memory usage, compiler behavior, and latency must be verified on the remote machine.

## 8. Supported operator workflow test commands

Local non-hardware regression from the TUI worktree:

```powershell
npm run verify:local-c500-release
npm run test:smoke
```

Remote checkout, with Claude Code already authenticated:

```bash
git checkout TUI
git pull --ff-only origin TUI   # use gitee instead of origin on the isolated machine
bash scripts/c500-test.sh verify
bash scripts/c500-test.sh doctor
bash scripts/c500-test.sh start
```

Use `bash scripts/c500-test.sh start`, not a manually assembled environment. The launcher installs/uses bundled Node, scopes state to the current checkout, defaults to Claude Code plus real C550, stops only a recognized previous Operator Studio runtime, and starts the TUI.

Mock is only for workflow regression:

```bash
bash scripts/c500-test.sh mock
```

Do not use mock evidence to judge operator performance or publishability.

## 9. Observability and trace locations

All paths below are relative to the active tester home, normally `.local-c500-production/`:

- Runtime log: `logs/runtime.log`
- Persisted state: `data/`
- Runtime PID/identity: `runtime/operator-studio.pid`
- Projects and Mission repositories/workspaces: `projects/`
- Queue and task artifacts: `local-c500-tasks/`
- TUI exports (`E`): `exports/<MISSION_ID>.json`

Each real task directory can contain:

- `task.json`: submitted payload, status, logs, error
- `run.py`: candidate bridge actually executed
- `oracle.py`: separately controlled Oracle when supplied
- `runner-status.json`: live stage/progress heartbeat
- `correctness.json`: case-level correctness evidence, including the failed case when available
- `result.json`: final benchmark/environment result
- `analysis/mctracer/` and `analysis/mcProfiler/`: optional diagnostic artifacts

Useful API probes:

```bash
curl -s http://127.0.0.1:4275/api/health
curl -s http://127.0.0.1:4275/api/state
curl -s http://127.0.0.1:4275/api/operator-tests
tail -n 200 .local-c500-production/logs/runtime.log
```

When diagnosing a failure, reconstruct this sequence before editing code:

```text
Mission ID -> Agent run ID -> candidate Diff digest -> queue task ID
-> runner-status/correctness/result -> Gate -> rollback/adoption -> next round
```

Do not infer a runner failure from a static progress bar alone; inspect the task files and runtime events.

## 10. Repository and delivery state

At the time this handoff was written:

- `TUI` was clean and matched GitHub tracking branch `origin/TUI` at `2006b36` before adding this document.
- GitHub remote: `https://github.com/Teeeio/operator-studio-c500-tester.git`
- Gitee remote: `https://gitee.com/kirinn99/operator-studio-c500-tester.git`
- The local `gitee/TUI` tracking ref appeared 30 commits behind `TUI`. This observation may be stale until fetched, but the remote test machine previously pulled from Gitee, so synchronization must be verified explicitly.

Never put an access token in a remote URL, command history, source file, or this document. Use the operator's existing Git credential configuration.

After each accepted fix:

```powershell
git status --short --branch
npm run verify:local-c500-release
git push origin TUI:TUI
git push gitee TUI:TUI
```

Do not push `TUI` to `main`.

## 11. Open risks and next work

Highest-priority next action is a real C550 run of one v0.1 Profile through all three performance rounds, with an exported Mission and task artifacts retained.

Open risks:

- The largest frozen shapes can consume substantial C550 memory. An OOM must be shown accurately in TUI and task evidence; it must not cause a silent shape reduction.
- Claude Code behavior is nondeterministic. The latest cold-start recovery handles missing-file and recoverable generation failures, but new tool-call/error shapes may still need normalization.
- A local 39-check pass validates workflow contracts, not real Triton compilation or C550 performance.
- Persisted remote state may contain historical Missions and tasks. New Mission publication should isolate state, but do not destroy historical evidence to hide a lifecycle bug.
- Gitee may not contain the latest branch even when GitHub does. Confirm the exact commit on the machine with `git rev-parse HEAD`.
- Exact correctness/benchmark Profile rules are intentionally strict. If the runner and Profile disagree, repair the contract plumbing; do not weaken the Profile to make a test pass.

Recommended continuation sequence:

1. Confirm the remote checkout is on `TUI` and at least `2006b36` plus later handoff/fix commits.
2. Run `bash scripts/c500-test.sh verify` and `doctor`.
3. Publish one v0.1 Mission from TUI.
4. Observe Agent generation, Diff admission, correctness, benchmark, Gate, rollback/adoption, and all three performance rounds.
5. Export the Mission with `E` and retain the matching task directories.
6. Fix the first reproducible workflow divergence in `TUI`, add an automated regression, rerun the 39-check release gate, and sync both remotes.

## 12. Acceptance criteria for the next Agent

A workflow fix is complete only when:

- it is implemented only in the `TUI` worktree/branch;
- the exact fixed Profile semantics and shapes remain unchanged;
- the observed failure is represented in state, runtime events, task evidence, and TUI without contradiction;
- retry/rollback does not accidentally advance the performance round;
- simulation cannot become publishable and live C550 evidence is not downgraded across rounds;
- `npm run verify:local-c500-release` passes;
- the real-machine reproduction steps and resulting commit are recorded;
- GitHub and Gitee `TUI` branches are synchronized for the test operator.

