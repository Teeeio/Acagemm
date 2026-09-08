# Execution package storage and admission adapter

createExecutionPackageStore accepts a private cache root, a trusted environment
registry and language adapters. assemble produces a canonical immutable manifest
and content-addressed blobs; validate rechecks all bytes, layers and the current
environment identity. File content supports UTF-8 and base64, without archive
extraction or any online dependency installation.

prepare requires an OS-enforced container/namespace/AppContainer/Windows Sandbox
environment. A plain host Python subprocess is explicitly unavailable. The MVP
also admits an explicitly registered `shared-host-gpu` environment when the
target is a GPU, `policy.allowSharedHostGpu=true`, and
`policy.packageBoundary=adapter-enforced`. This shared, non-isolated
development mode is never publishable evidence. The
trusted adapter must perform target build/load checks within its deadline and
return matching content identities plus resourceRelease.confirmed=true.
Admission records are stored outside the Mission Workspace and cannot be replaced
with caller validated flags. Submission and execution must call verifyAdmission.

Preparation intent precedes external work. Timeout aborts the adapter and retains
a durable quarantined claim; a restart cannot retry unknown preparation. A late
result is discarded and only explicit resource-release confirmation enables a new
preparation. Returning/rejecting a Promise is not proof of worker termination.

The store does not install runtimes, implement an OS sandbox or own the test
queue. Environment.resolve is responsible for inspecting actual locked runtime
and transitive dependency layers. An adapter supplied by untrusted task content
is forbidden. Tests use contract doubles and do not prove sandbox enforcement.

The cache root has one owning Runtime process; its short metadata transactions
serialize instances within that process, including Windows case aliases. It is
not a cross-process writer lock or a hostile concurrent-filesystem sandbox.
Admission TTL is a positive integer, default one hour and maximum one day.

`execution-package-import.mjs` is the application-facing ingestion adapter for
unpacked source directories and tar/tar.gz/zip archives (using the host `tar`
reader). It recursively collects
regular files (or reads archive members without extracting them), normalizes
portable POSIX paths, rejects symlinks/devices/hardlinks and requires explicit
candidate and independent acceptance entrypoints. All bytes are passed to
`assemble` as content-addressed data; no dependency is installed and no source
is executed during import. The caller must still provide the trusted
environment, adapter, Mission/Workspace/Candidate binding and frozen test spec,
then call `prepare` before submitting a test request.

Verification: node tests/execution-package-store-test.mjs

Adapter registration declares supported languages and exact version, plus
verifyPreparedArtifact for real immutable build/runtime output revalidation.
Read-only environment/artifact inspections are bounded and receive AbortSignal.
reconcilePreparation uses authoritative adapter.inspectPreparation; unknown or
malformed resource state stays quarantined. Every late/recovery write compares
preparationId before mutation. Admission verification also checks the current
ready preparation record, so superseded or discarded admission IDs cannot run.
