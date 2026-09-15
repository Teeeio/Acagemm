# Experience-condition study runner (`run-experience-condition-study.mjs`)

Status: thin nine-slot orchestration for the controlled experience-condition
study. Authority: `docs/development/EXPERIENCE_STUDY_CONTRACT.md` §B,
`scripts/experience-condition-study.md` and `scripts/run-shared-gpu-regression-batch.md`.

## Scope

This runner implements **no second driver, scheduler, provider, Gate, matrix or
acceptance threshold**:

- every scheduled slot runs the unchanged existing smoke batch CLI
  `scripts/run-shared-gpu-regression-batch.mjs --mode smoke --families affine`
  as a child process (`process.execPath`, absolute script path, `shell: false`,
  fixed argv), which in turn runs the unchanged live driver;
- classification, release barrier and stop logic of that batch are reused, never
  reimplemented;
- the only thing this runner fixes is the condition/snapshot environment for the
  child (`E2E_EXPERIENCE_CONDITION`, `E2E_KERNEL_WIKI_SNAPSHOT`). No credential
  value is copied into any artifact.

Importing the module has no side effects: no spawn, no write, no provider, GPU or
model call. Only the CLI executes a study.

## CLI

```bash
node scripts/run-experience-condition-study.mjs \
  --snapshot <absolute kernel-wiki snapshot> \
  --artifact-dir <absolute> \
  --report-dir <absolute> \
  --gpu-python <absolute>

# read-only verification of a retained report (no process/model/GPU start)
node scripts/run-experience-condition-study.mjs --verify-report <report dir|study.json>
```

Argument rules (all enforced **before** any effect; unknown, repeated, missing or
invalid arguments throw and the CLI exits non-zero):

- `--snapshot` must be an absolute existing file; it is validated and its digest
  recomputed before anything is created or spawned. It must contain at least one
  reviewed `sm86` KernelWiki unit.
- `--artifact-dir` / `--report-dir` must be absolute, must not be the repository
  root or one of its ancestors, must differ and must not overlap, and the
  snapshot must stay outside both. Alias/junction paths are resolved
  (`realpath` of the deepest existing ancestor) and re-checked before any
  directory is created.
- `--report-dir` must **not exist yet**; it is created non-recursively and never
  overwritten.
- `--gpu-python` must be absolute.
- `--verify-report` accepts no other argument and is the only read-only mode.

## Denominator and schedule

`report-dir/study.json` (`operator-studio.experience-condition-study/v1`) is
written **before the first child process starts** and atomically replaced
(`tmp` + `rename`) after every state change. It always keeps the full frozen
nine-slot denominator with `requestedSlots: 9`:

```
{index, block, condition, status, startedAt, finishedAt, exitCode, signal,
 artifactDir, reportDir, logPath, runRoot, conditionAudit, designIdentity,
 standardFingerprint, metrics, originals, issues}
```

Per-slot directories are `slot-NN` under the given artifact/report roots, and
each slot keeps its **own exclusive** pair: the same pair is handed to
`invokeSmoke` and to `readInvocation`, so a raw-evidence reader can never borrow
a parent directory or another slot's originals. The child's raw stdout/stderr log
is retained at `<artifact-root>/slot-NN/logs/slot-NN.log` — inside the slot's own
artifact directory, never inside its `--report-dir`, which the child creates
non-recursively and refuses to inherit. A slot that is never
spawned because the study stopped stays present as `status: "stopped"` with
`study_stopped`; there is no replacement, no top-up and no tenth sample.
`strictN20Passed` is always `false`: a study result is never labeled strict N20,
and the batch runner additionally rejects the study environment for `--mode n20`
before it creates a directory or spawns anything.

Progress is emitted live as `DISPATCH_PROGRESS {json}` lines (`phase` / `completed`
/ `total` / `message`).

## Safety stop (before the next spawn)

A slot is only accepted when **all** of the following hold; any other outcome
records the issue, sets `stopReason` and leaves the remaining slots unstarted:

- the **real child exit code** is `0` — a zero-exit stdout claim never overrides
  a non-zero exit (`smoke_exit_code:<n>`);
- the retained attempt/summary pair is schema-valid and terminal, and the
  **exact existing smoke release semantics** (`continuationSafety`, exported by
  the batch runner) hold: every required stop receipt is confirmed **and** the
  teardown stop is confirmed **and** a spawned runtime retained its exit. A
  confirmed teardown never masks an unconfirmed receipt, and a missing field
  stays unknown (`unsafe_continuation: ...`);
- the workflow outcome is a complete `full_success` (`not_full_success: ...`);
- the condition receipt's condition and snapshot digest match the scheduled slot
  (`condition_mismatch`, `snapshot_digest_mismatch`);
- both `primary` and `small` baseline profile latencies exist and at least two
  **distinct** candidates each pass correctness, confirm release and report live
  hardware (`baseline_profile_missing:*`, `fewer_than_two_candidates`,
  `candidates_not_distinct`, `candidate_correctness_failed`,
  `candidate_release_unconfirmed`, `candidate_not_live_hardware`,
  `candidate_profile_missing:*`);
- the provider model is fully observed (`observed_model_missing`) and the code
  commit/content digest are present (`source_identity_missing`);
- the recorded `config.promptPolicy` describes **this** slot:
  `experienceCondition` equals the scheduled condition, `wikiSnapshotDigest`
  equals the imported snapshot, and `studyGoalPolicyVersion` /
  `experienceSelectionPolicyVersion` are the frozen study goal policy and the
  production D selection policy (`study_config_mismatch: ...`);
- the complete standard configuration fingerprint is **comparable**
  (`standard_fingerprint_not_comparable: ...`): any unknown required field keeps
  the slot out of the shared design identity instead of being silently dropped;
- the observed model, source and **shared design identity** are identical to the
  first fully observed slot (`observed_model_drift`, `source_or_config_drift`,
  `shared_design_identity_drift`).

The shared design identity is the standard configuration fingerprint with
**only** `config.promptPolicy.experienceCondition` removed — model, source,
snapshot digest, matrix, budget and goal-policy fields all stay in, so a drift in
any of them still splits the identity. Each slot also retains its complete
standard fingerprint.

An `invokeSmoke`/`readInvocation` port must return a plain object (`record`
included); an `Error` or any other adapter object is refused as
`raw_evidence_invalid` even though it is typeof `"object"`, so a failed read can
never be mistaken for a green slot.

## Raw evidence readers

The default `readInvocation` reads and re-verifies the retained raw files and
never trusts receipt counts:

- the retained candidate task and its single `runHistory` archive matched by
  candidate digest **and** durable queue request id;
- the prepared-before-send audit for exactly the frozen target round (never the
  newest file, never a same-round recovery run);
- the retained experience store (`runRoot/runtime/experiences/experiences.json`,
  the production `OPERATOR_RUNTIME_DIR` file — always required, latest version per
  record; a missing store is an unreadable slot, never "zero selected
  experience");
- the retained per-slot smoke `batch.json`, which must record exactly one affine
  smoke invocation with exit code `0`, `full_success`, comparability and a run
  root strictly inside that slot's own artifact directory (the independent record
  of the real child exit);
- the recomputed `verifyExperienceConditionAudit` receipt, which is compared to
  the driver's own `runRoot/study-audit.json`; that file is a sidecar and is never
  the authority.

Only fields the real producer writes are read (`summary.summaries[]` carries
`missionId`/`workflowWritesAfterStart`; `attempt.familyOutcomes[]` carries the
same family/mission binding); a field that is genuinely absent stays `null`
instead of being invented, and no reader path can turn a healthy live run into a
"missing field" stop.

Per-invocation metrics are recomputed from the retained state/task benchmark and
the driver's terminal attempt: baseline and candidate per-profile latency
(`primary` and `small` reported separately, never pooled), candidate identity and
digest, correctness, elapsed time, and the model request count (every started
agent run counts as one provider request). Missing values stay `null` — nothing is
invented, and there is no remeasurement outside the queue.

`comparison` is descriptive only (`descriptiveOnly: true`,
`significanceClaimed: false`), grouped per condition and per profile.

## Ports (fixtures only)

`runExperienceStudy(options, ports)` accepts `invokeSmoke({index, condition,
artifactDir, reportDir, snapshot, gpuPython})` returning `{exitCode, signal?}`
and `readInvocation({index, condition, artifactDir, reportDir, snapshot})`
returning `{runRoot, record, conditionAudit, metrics, originals:[{role,path,sha256,bytes}]}`
where `record` is the existing `readRunRecord` DTO. Both ports receive the
slot's **own** `artifactDir`/`reportDir` pair. These ports exist **only** for
hardware-free fixtures; the CLI can never enable mocks.

## `--verify-report` (read-only counterpart)

`verifyStudyReport(reportPath)` re-reads the imported snapshot and, for every
slot, that slot's **own** raw originals (prepared-before-send prompt audit,
state/task benchmark, run record, production experience store and the retained
hash manifest) through the same reader the runner used. It recomputes — and
refuses anything that disagrees with:

- the frozen nine-slot schedule and the lockstep slot identity
  (`index`/`block`/`condition`), so a reordered, duplicated or re-labeled slot is
  rejected;
- the layout: one exclusive `slot-NN` directory pair per slot, one shared
  artifact root and one shared report root (distinct, non-overlapping, outside the
  repository), the snapshot outside both, and the verified file being that report
  root's `study.json`;
- `runnerSchemaVersion`, `requestedSlots: 9`, `strictN20Passed: false`, the
  goal-policy version and the start/finish timestamps; a `running` report (or a
  slot that never reached a final status) is never verified;
- every retained original's SHA-256 **and** byte length;
- per slot: the real exit code, release/terminal safety, `full_success`, the
  condition receipt, the observed model, the comparable standard fingerprint, the
  study prompt-policy constraints, the shared design identity, the per-profile
  metrics and the retained issue list;
- report level: `design` (source, model, per-condition standard fingerprints),
  `comparison` (recomputed per profile, descriptive only), `stopReason` and
  `status` — all recomputed from the originals in schedule order.

A slot that recorded evidence must reproduce exactly; an issue the reader
recomputes may never be dropped from the retained list (a false green and a
softened summary are both refused), and an extra retained issue must be a named
child/port failure (`log_open_failed:`, `smoke spawn failed:`,
`smoke process error:`, `log_write_failed:`, `invokeSmoke threw:`,
`raw_evidence_invalid:`) — the reader never guesses a diagnosis.

A slot that genuinely failed stays **readable**: a non-zero smoke exit, a real
model/source/design drift in one slot or a port failure keeps its recorded issues
(and its non-zero exit must not be contradicted by a `batch.json` that claims
`passed`); it is verified as a failure rather than being treated as unreadable or
silently dropped from the denominator.

`ok: true` means "this retained report matches its originals", never "the study
succeeded": `status`, `stopReason`, `slotCounts` and `strictN20Passed: false`
carry the real outcome, so a stopped/failed pilot is a valid, reviewable
diagnostic result. The verifier starts no Runtime, CLI, model, GPU or other
process and writes nothing.

## Exit codes

| Situation | Exit code |
| --- | --- |
| all nine slots completed with no stop condition | `0` |
| any slot failure, unknown/different observed model, unconfirmed release, missing artifact, source/config/condition/snapshot drift, audit failure | `1` |
| argument/setup error (before any spawn) | `1` |
| `--verify-report` on an intact report | `0` |
| `--verify-report` on a changed/rejected report | `1` |

## External save and boundaries

The large raw run directories/logs belong in the private scratch/external
`--artifact-dir` (`DISPATCH_SCRATCH_DIR` in a dispatch run); only the small
`study.json` report and each slot's `slot-NN/batch.json` + `ledger.json` are
written to `--report-dir`. Nothing is
deleted to improve a ratio, no sample is synthesized or back-filled, and no real
GPU/model execution happens while verifying this tooling.

## Hardware-free verification

```bash
node --check scripts/run-experience-condition-study.mjs
```

The runner is exercised without a GPU by importing it and calling
`parseStudyArguments()` / `runExperienceStudy(options, {invokeSmoke, readInvocation})`
with injected ports, or `verifyStudyReport()` over a fixture report; no child
process is spawned in those modes.
