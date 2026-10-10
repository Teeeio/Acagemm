# Baseline Source Inspection Service Contract

Validates a strict-zero-source baseline reference through the workspace inspection port. Invalid or unverified references set `needs_human` state and emit `baseline.source_unverified`. Input is `{ state, mission, baselineSource }`; output is `{ valid, state }`.
