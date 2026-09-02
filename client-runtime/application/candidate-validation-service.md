# Candidate Validation Service Contract

Owns orchestration for applying a generated Candidate patch, submitting baseline or candidate Benchmark work, and rolling validation/evidence back to the Candidate stage.

## Public API

| Method | Input | Output |
|---|---|---|
| `applyPatch(body)` | required Candidate ID and command fields | command result with workspace and policy-check metadata |
| `startBenchmark(body)` | purpose, Candidate, matrix, and runner options | command result or stable validation response |
| `rollbackStage()` | none | command result with recovery metadata |

Candidate Benchmark submission requires an applied patch, a valid matrix, and a Candidate identity. Baseline submission is allowed from diagnosis, Candidate, or validation. Rollback is blocked while a human review is pending.

The service does not inspect or modify files, create checkpoints, submit hardware tasks, build evidence, or mutate workflow state. Those effects remain in command-registry rules and their injected ports. Fixed profile matrices and retry budgets must not be weakened here.
