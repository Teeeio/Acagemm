# Shared-GPU Agent iteration driver (`e2e-shared-gpu-agent-iteration.mjs`)

Status: the single live shared-GPU acceptance driver. It is a setup + read-only
observer: it starts the **production** Runtime, lets the production autopilot run,
and records what actually happened. It never injects a candidate, fakes a
provider, overrides the Gate, starts a second scheduler or mutates Runtime state
directly. Authority: `docs/development/REAL_GPU_REGRESSION.md`,
`docs/development/P2_EVIDENCE_ACCEPTANCE.md`,
`docs/development/MODEL_OBSERVATION_ACCEPTANCE.md`,
`docs/development/TEAM_HANDOFF.md` §6/§10/§12 and
`scripts/shared-gpu-acceptance.md`.

## What one invocation does

1. Reserves a loopback port, creates a fresh `mkdtemp` run root and writes a
   `running` `attempt.json` **before** the Runtime starts, so a killed attempt is
   still visible in the ledger instead of vanishing.
2. Spawns `client-runtime/local-server.mjs` with an isolated
   `OPERATOR_DATA_DIR` / `OPERATOR_RUNTIME_DIR` / `OPERATOR_BRIDGE_DIR` /
   `OPERATOR_EXECUTION_PACKAGE_DIR` / `OPERATOR_LOCAL_C500_DIR` under the run root.
3. For each family: creates a project, commits an independently written baseline
   `run.py`, creates the Mission, runs the naive baseline, then observes the
   production autopilot producing real candidate diffs through the shared GPU
   queue until the frozen budgets stop it.
4. Verifies each family through the pure helpers in
   `scripts/shared-gpu-acceptance.mjs` (family outcome, budget-safe terminal,
   response-model evidence, stop receipt) and writes the terminal
   `attempt.json` / `summary.json` / `runtime.log`.

Every wait is bounded by `E2E_GPU_TIMEOUT_MS`; the driver asserts real evidence
at each step and throws rather than reporting an unproven success.

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `E2E_AGENT_RUNTIME` | `claude-code` | provider (`codex-cli` is an explicit override) |
| `E2E_AGENT_MODEL` | — | declared model label; stays `declared` provenance, never `observed` |
| `OPERATOR_CODEX_MODEL` | `gpt-5.6-sol` | codex-only tier; ignored by other providers |
| `E2E_GPU_FAMILIES` | `affine,reduction,normalization` | families to run |
| `E2E_GPU_CANDIDATE_TASKS` | `2` | candidate tasks per family (1–3) |
| `E2E_GPU_TIMEOUT_MS` | `720000` | mission budget (30 s – 30 min) |
| `OPERATOR_MAIN_AGENT_BUDGET_MS` | `180000` | main-agent budget |
| `OPERATOR_CODEX_LOGICAL_CLEANUP_MS` | `60000` | logical cleanup budget |
| `E2E_GPU_ARTIFACT_DIR` | `<repo>/.tmp-real-agent` | artifact parent override |

`E2E_GPU_ARTIFACT_DIR` only redirects the **parent**: every run still gets its own
`mkdtemp` run root below it, so large raw run directories/logs can live in the
private scratch/external directory outside the repository snapshot. The matrix,
test spec, task timeout, candidate-task count and all budgets are fixed in the
driver and are not affected by the override.

The declared model is never promoted to an observation. The responding model is
read only from provider-reported `assistant.message.model` in the current
attempt's own `bridge` records, and only that fully observed value can make a run
comparable.

## Artifacts

Retained under the run root:

```
attempt.json                  terminal attempt (config, family outcomes, cleanup, evidence)
summary.json                  driver summary (per-family summaries, model observation)
runtime.log                   merged Runtime stdout/stderr
<family>-state.json           retained state + task projection per family
bridge/prompt-audits/*.json   production prepared-before-send prompt audits
study-audit.json              study mode only (see below)
```

The driver prints its retained run root on one `[gpu-agent-e2e] retained
artifacts: <path>` line; the batch runner takes the run root only from that line
and never guesses it.

`config.promptPolicy.experienceSelectionPolicyVersion` always records the
production D selection policy version that actually governed the round (never the
obsolete retrieve-only constant), so a fingerprint can never describe a policy
that did not run.

## Opt-in controlled experience-condition study

Two environment variables turn this driver into an explicit study invocation:

| Variable | Meaning |
| --- | --- |
| `E2E_EXPERIENCE_CONDITION` | exactly `facts-only` \| `local-only` \| `local-and-wiki` |
| `E2E_KERNEL_WIKI_SNAPSHOT` | absolute path to an existing KernelWiki snapshot; required with any condition, rejected without one |

Both are validated at startup, **before** any CLI/model/GPU/Runtime process is
spawned. An explicit but empty/unknown condition is invalid and never falls back
to the default; a snapshot without a condition is rejected, so a study result can
never be silently produced or labeled as an ordinary run. The snapshot is parsed
and its digest recomputed before anything starts.

Study mode changes exactly four things:

1. **Condition to the Runtime** — the condition is passed as
   `OPERATOR_EXPERIENCE_CONDITION`. In default mode the ambient variable is
   **deleted** rather than inherited, so an operator shell can never silently
   change the strict oracle's selection.
2. **Snapshot import** — immediately after project creation and before the
   Mission exists or any baseline can auto-start, the fixed snapshot is imported
   through the existing production HTTP API
   (`POST /api/projects/:id/experiences/import-kernel-wiki`). All three conditions
   import the same source, so only selection changes; the import result is
   retained verbatim. The default driver never touches experiences.
3. **Goal** — the fixed study-only suffix is appended to the goal. The
   unconfigured default goal stays byte-identical.
4. **Verification** — `verifyExperienceConditionAudit` (see
   `scripts/experience-condition-study.md`) replaces the strict continuation
   verifier for this invocation only. Every other mode keeps the original
   `verifyContinuationAudit`.

`config.promptPolicy` additionally records `experienceCondition`,
`wikiSnapshotDigest` and `studyGoalPolicyVersion`
(`operator-studio.experience-study-goal/v1`). These fields enter the standard
fingerprint like every other configuration value; only `experienceCondition` is
removed when computing the shared design identity used to check that the nine
slots are comparable.

Study mode also retains `runRoot/study-audit.json`: the explicit condition, the
fixed snapshot identity, the candidate binding, the verbatim import result and
the **pure** condition receipt. That file is a sidecar — the read-only study
verifier recomputes the receipt from the raw artifacts and refuses any
disagreement.

The candidate set, test matrix, correctness/Gate/recovery rules, stop/release
barrier, budgets and model-observation invariants are identical in all modes. A
study invocation is not strict N20 evidence: the batch runner rejects the study
environment for `--mode n20` before it spawns anything, and the study report
always reports `strictN20Passed: false`.

## Verification

```bash
node --check scripts/e2e-shared-gpu-agent-iteration.mjs
node tests/shared-gpu-acceptance-test.mjs
```

The driver itself needs a real shared GPU and provider route; all of its decision
logic lives in the pure modules above, which are exercised without hardware.
