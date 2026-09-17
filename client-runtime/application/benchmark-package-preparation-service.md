# Benchmark package preparation service

`createBenchmarkPackagePreparer({ executionPackageStore, packageAdapter })` returns
an async `({ request, mission, matrix, missionRunPy }) => preparedRequest` port.
The composition root injects the trusted execution package store and the existing
`SHARED_GPU_PACKAGE_ADAPTER` identity object (id/version/languages), then passes the
port to `createBenchmarkCommands`. The adapter implementation instance is not the
identity object and must not be substituted for it.

The port assembles candidate run.py, declared implementation files, independent
oracle.py and frozen testSpec, then prepares the package through the injected store.
Its only imports are the pure domain contract: `canonicalJson` and the canonical
`contentDigest` from
[execution-package-contract](../execution-package-contract.md). It never imports
the persistence store directly; the store remains an injected port, so this
application module has no transitive dependency on package storage.
It preserves candidate and semantic digest selection, mission/workspace bindings,
checks, limits and the existing deadline calculation. The returned request includes
`preparedArtifactDigest` from the trusted admission; a caller-supplied digest is
overwritten. No result or queue receipt is used to backfill request identity.

Missing testSpec throws `PACKAGE_TEST_SPEC_REQUIRED` (409); missing independent
oracle throws `PACKAGE_ORACLE_INVALID` (409). Store errors propagate. Failed
preparation submits no test. Effects are confined to the injected store; this module
does not own filesystem storage, HTTP, GPU execution, evidence acceptance or prompts.

The existing strict failed-experience verifier continues to reject absent or
conflicting prepared-artifact identity. Behavioral verification belongs to
`tests/queue-prepared-binding-test.mjs`, including the production preparation port,
Benchmark command, persisted queue and failed-result verification boundaries.
Frozen acceptance: `docs/development/QUEUE_PREPARED_BINDING_ACCEPTANCE.md`.
