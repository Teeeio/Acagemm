# Baseline Failure Projection Contract

Projects a failed baseline benchmark into explicit `baseline.status = failed` state exactly once. Returns a boolean indicating whether state changed. Runtime event emission is injected; no HTTP, filesystem, or persistence access is allowed.
