# Shared GPU Experience Verifier

`createSharedGpuExperienceVerifier({ executionPackageStore, packageAdapter, now })`
is a composition-root adapter for shared-host GPU development evidence. It
ignores worker-provided verification flags and revalidates the durable package
admission, prepared-artifact digest, Mission/Workspace/Candidate binding and
terminal result identity. It returns a trusted observation proof or an explicit
non-verified code; successful proofs remain non-publishable development
evidence.

Evidence equality is a full structural value comparison over the authorized
receipt, not a serialized string comparison. The runner appends `architecture`
after `liveHardware`, while the canonical recorded evidence places it among the
declared fields, so equal values with different key order must verify. Digests
are still normalized (case and `sha256:` prefix) before comparison, and every
declared or unknown extra field must match exactly: an explicit `sm100` is not
the same as `sm86`, an omitted `architecture` is not equivalent to a declared
one, and worker-added fields such as `verified: true` still fail. The
comparison does not relax prepared-artifact, admission, candidate, workspace or
queue-result validation.
