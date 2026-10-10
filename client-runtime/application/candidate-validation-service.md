# Candidate Validation Service Contract

Continuation reports a diagnosed experience-read error after its diagnostic
payload commits. It returns no run receipt and retains pending feedback for
explicit retry; see [generation-preparation](../generation-preparation.md).

Owns orchestration for applying a generated Candidate patch, submitting baseline or candidate Benchmark work, and rolling validation/evidence back to the Candidate stage.

## Public API

| Method | Input | Output |
|---|---|---|
| `applyPatch(body)` | required Candidate ID and command fields | command result with workspace and policy-check metadata |
| `startBenchmark(body)` | purpose, Candidate, matrix, and runner options | command result or stable validation response |
| `rollbackStage()` | none | command result with recovery metadata |
| `getPendingCandidate(missionId)` | existing Mission ID | verified frozen pending-candidate bundle and its persisted identity, through `readPendingCandidate` |
| `submitPendingCandidate(missionId,{manifestDigest})` | active frozen candidate identity only | existing journaled Benchmark command receipt, or idempotent receipt |
| `settlePendingCandidate(missionId,{manifestDigest})` | active frozen identity | workspace-bound feedback through the journal |
| `continuePendingCandidate(missionId,{manifestDigest})` | settled frozen identity | one Agent run, or its original committed receipt |
| `newPendingAttempt(missionId,{manifestDigest})` | expired frozen identity | one new paused Mission with source lineage, or its original committed receipt; see `pending-attempt-command.md` |

Pending export is a snapshot query for either the active or a saved Mission. It
never advances the workflow, probes hardware, or reads the mutable workspace.
Missing Missions/candidates are 404; corrupt artifact errors remain explicit.
The bundle contains untested source bytes, not an execution admission or verdict.

Explicit submit applies [frozen test admission](../pending-test-contract.md), not
the ordinary paused-Mission mutation guard. It starts the frozen baseline, then
the production pipeline admits its candidate. Repeated submissions return the
existing receipt; generic `startBenchmark` refuses `pendingManifestDigest`.

Candidate Benchmark submission requires an applied patch, a valid matrix, and a Candidate identity. Baseline submission is allowed from diagnosis, Candidate, or validation. Rollback is blocked while a human review is pending.

The service does not inspect or modify files, create checkpoints, submit hardware tasks, build evidence, or mutate workflow state. Those effects belong to the Candidate and Benchmark command modules and their injected ports. Fixed profile matrices and retry budgets must not be weakened here.
