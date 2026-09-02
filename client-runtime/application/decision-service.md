# Decision Service Contract

Owns direct candidate adoption, rejection for supplemental validation, and reversal of a published adoption.

## Public API

| Method | Input | Output |
|---|---|---|
| `adopt(body)` | optional adoption note | command result |
| `reject()` | none | command result |
| `revertAdoption()` | none | command result with optional recovery metadata |

`adopt` requires completed evidence and no pending human review. Reversal requires the published stage. Already completed adoption or reversal returns a transport-neutral `skipped_idempotent` command result.

The service owns orchestration guards only. Candidate adoption, validation reset, knowledge maintenance, repository revert, checkpoint restore, audit events, and runtime events remain command-registry responsibilities.
