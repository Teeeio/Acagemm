# Baseline Failure Projection Contract

Projects a failed baseline benchmark into explicit `baseline.status = failed` state exactly once. Returns a boolean indicating whether state changed. Runtime event emission is injected; no HTTP, filesystem, or persistence access is allowed.

A release-confirmed cancelled baseline also projects baseline.status=cancelled, BASELINE_TEST_CANCELLED and cancelledAt, with bound run/task identity in baseline.cancellation_projected. It never reports a still-running baseline or a correctness failure. Projection remains idempotent and retains source/evidence/clock data; unconfirmed release and candidate tasks are excluded. The existing explicit test retry performs any next execution.
