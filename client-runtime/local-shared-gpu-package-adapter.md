# Local shared-GPU execution package adapter

`local-shared-gpu-package-adapter.mjs` is the trusted Python adapter used by
the MVP package store. It materializes every candidate, dependency and frozen
acceptance file into an adapter-owned private directory. The runner receives
only that directory, so host paths and imports are never used as package
inputs.

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


The production composition root supplies the package inspection timeout to the
runtime probe (default 30000 ms, capped at the probe's 30000 ms maximum). The
resolver's 30000 ms cache TTL is unchanged. `resolve(id, {refresh: true})`
invalidates the cached entry and joins or starts a fresh query; concurrent readers
join it and a failed refresh cannot fall back to the old entry. Experience
preflight uses this option before collection to avoid expiry mid-collection;
it does not serve stale cache entries or authorize
execution. Direct callers of the probe retain its generic default timeout.
