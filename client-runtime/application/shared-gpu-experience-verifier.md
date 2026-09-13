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

## Failed candidate observations

`benchmark.status='failed'` (or a failed `result.status` / `observation` outcome)
selects an explicit strict path instead of the completed-only success checks; a
contradictory status therefore fails closed rather than falling through to the
legacy branch. It verifies, through the same trusted store/adapter ports:

- `benchmark` is a released `purpose=candidate` failed task and `result` is
  `status=failed`, `publishable=false`; the observation is `outcome=failed`,
  `operation=test`, `liveHardware=true`.
- The result environment is the real shared-GPU identity: `source='local-shared-gpu'`,
  `hardware='nvidia-gpu'`, `executionMode='gpu'`, no explicit
  `liveHardware=false`/`publishable=true` conflict, and a real `targetProbe` with
  nonempty `deviceName`/`driverVersion`. A mock/cpu/simulated source, hardware or
  mode and a probe-less environment are rejected on those declared fields (no
  free-text scanning).
- Top-level `result.correctness` is `status=failed`, `passed=false`, integer
  `total>=1`, `1<=executedCases<=total`, `caseResults.length=executedCases`,
  `passedCases=executedCases-1`, `failedCase=executedCases`, every preceding case
  passed with a nonempty real case name and the named final case failed.
  `result.error` / `correctness.failure` / the final case failure are the same
  typed value (`phase=correctness`, `role=candidate`, code one of
  `OPERATOR_CORRECTNESS_MISMATCH` / `OPERATOR_CANDIDATE_EXCEPTION`) with a
  nonempty `message`, `retryable=false` and a plain-object `details` as in the
  frozen producer DTO; `correctness.error` and each case `error` keep the real
  `error.message` string.
- `readTask` is mandatory. The queue task must be the failed, released
  `testTaskId`; its payload Mission/Workspace/candidate/digests/admission must
  agree with the evidence and active binding, a declared payload `purpose` must be
  `candidate`, and payload `target`/`build`/`adapter` must equal the selected
  package by full value. Its whole
  `experienceEvidence`/`correctness`/`error`/`executionPackage`/`environment`
  must equal the projection, so the real probe is taken from both sides rather
  than a one-sided projection.

A verified failed proof keeps the success proof shape (`verified`, `evidence`,
`summary`); its deterministic summary keeps the trusted-admission explanation and
appends a failed-correctness detail suffix capped at 2000 characters that carries
the typed code, phase/role, failed case name/category (each also bounded), total/
executed/passed counts and the real error prefix. Verified failed development
evidence stays non-publishable. Rejections are read-only: neither the projected
result, the observation evidence nor the queue receipt is rewritten.
