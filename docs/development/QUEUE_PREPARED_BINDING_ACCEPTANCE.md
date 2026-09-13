# Queue prepared-artifact binding acceptance

Frozen by upstream on 2026-09-13 after real smoke task
`task_baf9fc222be74e38afb3fbd67eb545c6` (code `f3a5446`).

The real failed candidate has a complete failed correctness result, but its
production queue payload omits `preparedArtifactDigest`. The strict experience
verifier rejects it with `EXECUTION_PACKAGE_QUEUE_RESULT_MISMATCH`. The backend
request has the digest after adapter resolution; that does not repair the earlier
queue receipt. Original evidence is in `evidence/queue-prepared-binding-20260913/`.

## Sole implementation route

Move the existing package preparation callback from `client-runtime/local-server.mjs`
into `client-runtime/application/benchmark-package-preparation-service.mjs`.
Export `createBenchmarkPackagePreparer({ executionPackageStore, packageAdapter })`,
returning the existing async `({ request, mission, matrix, missionRunPy }) => request`
port. `packageAdapter` is the existing SHARED_GPU_PACKAGE_ADAPTER identity.
Import pure `contentDigest`/`canonicalJson` through their existing documented APIs.
The composition root constructs this port when the store is enabled and passes it
to the existing Benchmark command. Preserve existing package assembly, semantics,
oracle checks, source files, error codes, candidate digest, deadline and limits.
The sole behavior addition is `preparedArtifactDigest: admission.preparedArtifactDigest`
in the returned trusted request. Never use a caller-supplied digest or the result
to fill a missing request identity. Existing strict failed-experience validation,
matrices, budgets, result DTOs and success behavior remain authoritative.
Update application README, Client Runtime README and MODULE_OWNERSHIP for the
documented public port. No other architecture or dependencies.

## Independently written test matrix

Add `tests/queue-prepared-binding-test.mjs`, registered in the existing release
verification script by this test task's single writer. Drive the exported production
preparer and the real `createBenchmarkCommands` preparation path into a real isolated
`createOperatorTestQueue` persisted request; package storage/admission and backend
may be injected deterministic port doubles. Do not hand-author the final queue
payload. Assert the production composition root uses this exported service through
the existing documented command injection (a focused wiring assertion is supplementary,
not a substitute for behavioral tests).

1. The trusted admission digest appears identically in returned request, recorded
   command intent, persisted queue payload and benchmark execution-package binding.
2. A conflicting caller digest is overwritten by the actual admission digest;
   unrelated fields and dependent implementation files survive unchanged.
3. Preserve missing testSpec -> PACKAGE_TEST_SPEC_REQUIRED and missing oracle ->
   PACKAGE_ORACLE_INVALID; no submission occurs on these preparation failures.
4. Project a complete typed failed-candidate result against the production-created
   queue request and run the unchanged strict experience verifier: accepted only
   with matching whole queue/result/environment/release identities and trusted ports.
5. Delete or change the persisted request's preparedArtifactDigest in independent
   negative cases: strict verifier rejects, without rewriting the request/result.

Use fixture results explicitly as hardware-free replay, never as live GPU proof.
The real smoke must be rerun after integration before a new 20-original batch.

## Verification and scope

Implementation author: syntax and nearest existing module-boundary checks only.
Test author: syntax against frozen interface; behavioral pass is only asserted on
the combined candidate tree. Root submits an independent read-only combination
command overlaying exact implementation and test task attempt/digest, accepts that
proof first, then reviews both deliveries. Run the new test plus existing failed
feedback/boundary tests there, and the existing cross-module release and non-hardware
gates at final integration. Missing required interfaces or a contradicted premise
must return a decision_request, not an alternative route.
