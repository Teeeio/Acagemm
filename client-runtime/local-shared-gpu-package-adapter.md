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
