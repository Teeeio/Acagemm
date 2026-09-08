# Shared GPU Experience Verifier

`createSharedGpuExperienceVerifier({ executionPackageStore, packageAdapter, now })`
is a composition-root adapter for shared-host GPU development evidence. It
ignores worker-provided verification flags and revalidates the durable package
admission, prepared-artifact digest, Mission/Workspace/Candidate binding and
terminal result identity. It returns a trusted observation proof or an explicit
non-verified code; successful proofs remain non-publishable development
evidence.
