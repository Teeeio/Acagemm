# Mission source boundary contract

This adapter belongs to the existing TUI -> Production API client intake path. It does not mutate Runtime state, call a model, run operator tests, or write user-selected sources.

## Public interface

- `inspectMissionSources(selections = [], { includeIgnoredPaths = [] } = {})`: inspect selected absolute paths. Returns `selections`, `files` (path, size, SHA-256), `totalBytes`, `excludedFiles`, `generatedFiles`, `sourcePolicy`, `reviewDigest`, and an internal `contents` Map. Production API previews omit `contents`.
- `stageMissionSources(home, selections, expectedFiles, options = {})`: options contain `includeIgnoredPaths`, `expectedReviewDigest` and `expectedPolicyDigest`. Reinspects before creating a staged repository and refuses changed bytes, list or policy. Returns `repository`, `cleanup`, final `files`, `sourcePolicy` and `reviewDigest`.
- `sourcePickerRows` projects the exact review rows used by rendering and keyboard handling. Excluded rows carry `excluded`, `canInclude`, `reasonCode`, `reason` and absolute `sourcePath`; generated entry rows are disabled. A selected ordinary ignored file carries `includedIgnored: true` for explicit reversal.

## Invariants

Sensitive credential names and credential directories are excluded before reading file bodies. They cannot be selected back. This is a filename boundary, not a content-based secret detector; users must still avoid credentials in ordinary source files. .git, tool storage, dependency packages and caches are excluded. .gitignore is policy input rather than editable model source.

Ordinary files excluded by .gitignore remain visible with a reason. Each required dependency can be selected back by its exact task-relative path; directory opt-in and path escape are refused. The UI must show the resulting file list before confirmation, including exclusions and any generated run.py. Missing run.py creates only the disclosed NotImplementedError stub, with a known size and SHA-256; it creates no test evidence.

Native Git ignore matching uses disposable isolated Git metadata, never the source repository's config/index/info-exclude, global config, hooks or filters. It honors .gitignore files inside selected directories and repository ancestry, including negation and nested rules. Tracked status does not bypass declared .gitignore. Non-repository selections use their selected directory boundary (or the selected file's parent). The temporary metadata is cleaned in both success and failure. No source content is sent to Git: only path names and policy files are read.

The versioned source policy binds sorted exact opt-in paths and all applicable .gitignore byte digests. The review digest also binds selections, accepted files, generated files and excluded-file reasons. A confirmation must carry both policy and review identities into staging; refreshing preview is not implicit reconfirmation. File bytes and ignore policies changed after confirmation require a new user review. Downstream task declarations, model-readable inventory, frozen candidate and export must consume this same approved final list.

Existing callers without new options preserve exact file-list/byte verification; the interactive confirmed path requires the new identities. Original count, per-file, total-byte, safe-path, collision and link checks remain. Discovery additionally caps 8,192 entries and 512 directories so excluded trees cannot create an unbounded traversal.

## Local verification

`node tests/mission-source-boundary-test.mjs` uses only generated temporary files and isolated Git metadata. It exercises credential exclusion, gitignore negation, explicit dependency selection, policy/source drift refusal, byte-identical staging, and disclosed generated entry. It does not call models, hardware or network. The parent release verification remains serialized.
