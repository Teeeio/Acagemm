# Benchmark package preparation service

`createBenchmarkPackagePreparer({ executionPackageStore, packageAdapter, packagePort })`
returns an async `({ request, mission, matrix, missionRunPy }) => preparedRequest` port.
The composition root injects the trusted execution package store, the frozen adapter
**identity** object (id/version/languages) and that adapter's **port mapping**.

## Identity and wiring are different objects

| Injected | Content | Enters the package manifest |
|---|---|---|
| `packageAdapter` | adapter identity: `id`, `version`, `languages` | yes — it is part of the digest |
| `packagePort` | wiring: `adapterId`, `language`, `environmentId`, `candidateEntrypoint`, `acceptanceEntrypoint`, `checks` | no |

The language/backend combination used to be hardcoded here, so pointing the platform
at another backend meant editing this file. It now travels with the adapter that
implements it. The two are kept apart on purpose: adding a wiring field to the
identity would silently shift the digest of every package, including prepared
artifacts a restart still references. `tests/package-port-test.mjs` pins that.

The port mapping is **required**. Missing mapping, a mapping that names a different
adapter than the injected identity, or a mapping with a blank field all fail at
**construction time** (`PACKAGE_PORT_MISSING`, `PACKAGE_PORT_MISMATCH`,
`PACKAGE_PORT_INVALID`). There is deliberately no fallback: falling back to the
Python/NVIDIA combination is exactly what this layer stopped doing.

The port assembles the candidate entrypoint, declared implementation files, the
independent acceptance entrypoint and the frozen testSpec, then prepares the package
through the injected store. It never imports the persistence store directly; the store
remains an injected port, so this application module has no transitive dependency on
package storage.

Its imports are the pure domain contracts, all documented public APIs:
`canonicalJson` and the canonical `contentDigest` from
[execution-package-contract](../execution-package-contract.md),
`normalizeOperatorLanguage` from [operator-language](../operator-language.md), and
`capabilitySupportsLanguage` / `findTargetCapability` from
[target-capability-registry](../target-capability-registry.md).

## Implementation-language admission

Before a Mission is accepted, the preparation port asks whether the backend can run
the Mission's **implementation** language and refuses with
`PACKAGE_LANGUAGE_UNSUPPORTED` (409) when it cannot, carrying
`{ environmentId, language, capabilityId, covered }`.

This closes a declaration/enforcement divergence: the platform advertised
`cuda-cpp-extension` as a first-class implementation language and told the agent to
write `operator.cu`, while no registered backend covered it and
`capabilitySupportsLanguage` had no production call site at all. The failure was not
immediate — the Mission was accepted and then died in the build stage, with an error
that looked like a broken toolchain rather than "this backend does not run that
language".

Two boundaries are deliberate:

- The vocabulary is the **implementation** language (an `operator-language` adapter
  id), not the package language. `cuda-cpp-extension` is still a Python package with
  an extra `operator.cu`; the package bridge language stays `python`.
- The check applies only to a capability that is registered **and** available. An
  environment the registry has no opinion about (a backend plugged in through another
  adapter) and a registered-but-unverified one are left to the environment resolver,
  which already refuses them with `PACKAGE_ENVIRONMENT_UNKNOWN` /
  `PACKAGE_ENVIRONMENT_UNVERIFIED`. Deciding it twice would give two authorities with
  two different reasons, and would drop the contract that this layer is
  backend-agnostic.
It preserves candidate and semantic digest selection, mission/workspace bindings,
checks, limits and the existing deadline calculation. The returned request includes
`preparedArtifactDigest` from the trusted admission; a caller-supplied digest is
overwritten. No result or queue receipt is used to backfill request identity.

Missing testSpec throws `PACKAGE_TEST_SPEC_REQUIRED` (409); missing independent
oracle throws `PACKAGE_ORACLE_INVALID` (409); an uncovered implementation language
throws `PACKAGE_LANGUAGE_UNSUPPORTED` (409). Store errors propagate. Failed
preparation submits no test. Effects are confined to the injected store; this module
does not own filesystem storage, HTTP, GPU execution, evidence acceptance or prompts.

The existing strict failed-experience verifier continues to reject absent or
conflicting prepared-artifact identity. Behavioral verification belongs to
`tests/queue-prepared-binding-test.mjs` (production preparation port, Benchmark
command, persisted queue and failed-result verification boundaries) and
`tests/package-port-test.mjs` (adapter-owned port mapping; the service must not
hardcode a vendor combination). Frozen acceptance:
`docs/development/QUEUE_PREPARED_BINDING_ACCEPTANCE.md`. Onboarding a new backend:
`docs/development/adapter-onboarding/README.md`.
