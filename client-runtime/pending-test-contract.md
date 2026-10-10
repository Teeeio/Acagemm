# Frozen candidate test admission

`assertPendingTestReceipt(state,snapshot)` requires the recorded queue task,
request, Mission, purpose and candidate digest. Candidate receipts also bind the
generation source run; explicit execution-evidence identities must agree. It
validates ownership before raw projection and does not evaluate a Gate.

`pendingTestIdentity(state, {missionId,manifestDigest})` binds the explicit request
to the active Mission's immutable pending DTO. `assertPendingTestAdmission` also
checks stopped/recovery/resource states and the original round/Mission clocks.
Neither method renews a deadline. `pendingTestInputs` consumes a bundle verified
by the pending-store port and derives frozen Mission, matrix, candidate, independent
baseline and declared dependency bytes; binary dependencies retain base64 encoding.
Files declared as `oracle` in the frozen source policy remain in the immutable
bundle for provenance and workspace checks, but never enter implementation
dependencies. Acceptance bytes come only from the frozen independent baseline.
This is role-based; an undeclared dependency that collides with the adapter's
acceptance path still fails normal package validation.

Baseline source and materializer provenance are frozen alongside the oracle.
Legacy bundles without provenance remain exportable but cannot borrow authority
from a later baseline. A conflicting materializer digest fails admission. The
existing baseline resolver still validates source policy and materialization.

The lifecycle is stored separately in `iterationStats.pendingTest`:
`baseline_running → baseline_complete → candidate_running → results_ready`.
Failure, cancellation or failed admission produce `failed`, `cancelled` or `blocked`.
The original `pendingValidation` DTO never changes. Both queue commands use the
existing journal, package preparation and serialized queue. The candidate must
reference this submission's completed baseline run. Request deadlines never exceed
the original clocks. No mutable workspace read, new Agent or clock reset occurs.

Candidate receipts set `benchmark.decisionDeferred` and remain ungraded until
feedback settlement verifies workspace identity. Tests do not change current best,
adopt or publish the detached candidate. This increment does not yet admit expired
artifacts as new attempts or implement feedback-driven iteration (H07/H08).

Verification: `test:pending-test-submission`, `test:pending-candidate-store` and
the production release gate. Fixture receipts in these checks are not GPU evidence.
