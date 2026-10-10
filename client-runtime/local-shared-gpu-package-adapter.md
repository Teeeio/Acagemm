# Local shared-GPU execution package adapter

`local-shared-gpu-package-adapter.mjs` is the trusted Python adapter used by
the MVP package store. It materializes every candidate, dependency and frozen
acceptance file into an adapter-owned private directory. The runner receives
only that directory, so host paths and imports are never used as package
inputs.

## Adapter identity and port mapping

Two separate frozen exports, on purpose:

| Export | Content | Enters the package manifest |
|---|---|---|
| `SHARED_GPU_PACKAGE_ADAPTER` | identity: `id`, `version`, `languages` | yes — it is part of the digest |
| `SHARED_GPU_PACKAGE_PORT` | wiring: `adapterId`, `language`, `environmentId`, `candidateEntrypoint`, `acceptanceEntrypoint`, `checks` | no |

The preparation service used to hardcode this Python/NVIDIA combination, so another
backend meant editing the service. The combination now travels with the adapter that
implements it. Keeping the wiring out of the identity matters: adding a field to the
identity would silently shift the digest of every package manifest, including
prepared artifacts a restart still references.

## Unverified targets are refused, not substituted

`createSharedGpuEnvironmentResolver` consults
[target-capability-registry](target-capability-registry.md) before probing. An
environment that is registered but has no verified target machine (Ascend, MUSA)
fails with `PACKAGE_ENVIRONMENT_UNVERIFIED` and **no runtime probe is started**.
It is deliberately not reported as `PACKAGE_ENVIRONMENT_UNKNOWN`: that would read as
"wrong name", inviting a retry under another name and eventually a run attributed to
the wrong vendor.

The adapter records a content digest for the prepared artifact and verifies
every file before admission and submission. Preparation is idempotent for the
same package identity and reports confirmed release when a failed preparation
has removed its temporary staging directory. Runtime probing is read-only and
is provided by `createSharedGpuEnvironmentResolver`.

For Python packages, preparation performs syntax validation and checks that
relative or package-local imports resolve to files in the manifest. External
imports (such as `torch` and the standard library) are supplied by the pinned
environment layer; this check is not an OS sandbox and does not install or
vendor host dependencies.

### Validation subprocess ownership

`createSharedGpuPackageAdapter({rootDir, execFileImpl?})` accepts an optional
Node-compatible `execFile` test port; production uses the real `execFile`.
Python AST validation owns `stdin`, `stdout` and `stderr` error listeners locally.
An I/O failure (for example Windows `ENOTCONN`) cancels that validator and returns
`PACKAGE_VALIDATION_TRANSPORT_FAILED`, retaining the first stream name, original
code/syscall/message and cause. It never becomes a syntax verdict or success.
There is no process-global exception handler or transport retry.

The callback and actual child `close` must both arrive before validation settles:
an AbortError callback or successful kill request alone is not release proof.
The existing preparation AbortSignal/deadline and output limit remain in force;
until close, the package store keeps its timeout quarantine and cannot admit a
test. After close the stage is cleaned and the terminal failure is recorded.
Cleanup failure retains unconfirmed release. An on-disk stage without a terminal
receipt is `unknown`/unconfirmed during inspection, not `not_started`/released.

`node tests/local-shared-gpu-package-adapter-test.mjs` checks normal AST validation,
invalid local imports, the original unhandled-stream crash in an isolated Node
process, all three real pipe failure paths and callback-before-close quarantine.
These software checks launch no model or GPU execution.

Python AST validation starts in the adapter's private root, not its deeper
digest/preparation stage. All package-root and source arguments remain absolute,
and Python `-I` remains mandatory. This avoids the observed Windows child-start
failure when the stage exceeds 260 characters, while preserving syntax and
package-local import validation against the original immutable files. The
regression uses real Python with an over-260-character stage, checks byte identity,
and confirms invalid package-local imports still fail. A private adapter root
that itself exceeds the host's process working-directory limits can still fail;
the owned stream boundary reports that failure without crashing Runtime.


The production composition root supplies the package inspection timeout to the
runtime probe (default 30000 ms, capped at the probe's 30000 ms maximum). The
resolver's 30000 ms cache TTL is unchanged. `resolve(id, {refresh: true})`
invalidates the cached entry and joins or starts a fresh query; concurrent readers
join it and a failed refresh cannot fall back to the old entry. Experience
preflight uses this option before collection to avoid expiry mid-collection;
it does not serve stale cache entries or authorize
execution. Direct callers of the probe retain its generic default timeout.

## Error codes

| Code | Meaning |
|---|---|
| `PACKAGE_ENVIRONMENT_UNKNOWN` | the environment id is not registered at all |
| `PACKAGE_ENVIRONMENT_UNVERIFIED` | registered, but no verified target machine; never substituted by another capability |
| `PACKAGE_LANGUAGE_UNSUPPORTED` | the verified capability for this environment does not cover the Mission's implementation language (raised by the preparation service, not by this adapter) |
| `PACKAGE_ENVIRONMENT_INVALID` | the probe returned an environment that is not the registered one |
| `PACKAGE_SOURCE_INVALID` / `PACKAGE_VALIDATION_TIMEOUT` | Python syntax/import validation failed or ran out of deadline |
| `PACKAGE_VALIDATION_TRANSPORT_FAILED` | owned Python validation subprocess stream failed; original transport details retained, never accepted as validation |
| `PACKAGE_STORAGE_UNSAFE` / `PACKAGE_PREPARED_ARTIFACT_CHANGED` | prepared-artifact storage or identity is not trustworthy |
