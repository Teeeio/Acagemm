# KernelWiki pinned import

Turns pages of a pinned KernelWiki commit into an experience snapshot and applies
that snapshot to the experience store as human guidance. It is the Phase 3 writer
B module described by `docs/development/PHASE3_WIKI_CONTRACT.md` section B and by
`TEAM_HANDOFF.md` sections 6 and 8.4.

## Purpose

Read a pinned KernelWiki commit through the CLI
(`scripts/import-kernel-wiki.mjs`), validate every unit and digest, and mutate the
experience store through the existing append/update APIs inside one repository
transaction.

## Responsibilities

- Parse the supported frontmatter subset (scalars, quoted scalars, inline lists,
  block string lists) and reject duplicate keys, duplicate page IDs, unsafe paths,
  missing required identity and oversized pages explicitly.
- Build a deterministic snapshot envelope with a canonical digest.
- Apply all units atomically: create, advance by expected version, or report an
  identical re-import as unchanged.
- Keep KernelWiki provenance in `selectionMetadata` and keep scope semantics
  strictly separate from KernelWiki topics.

## Non-Responsibilities

- No filesystem, Git, network, model, GPU or clock access; the pinned CLI owns Git
  reads and file output. No summarizer: reviewed-transfer content must be supplied
  by an explicit review assertion.
- No selection, ranking, quota or prompt rendering; that belongs to the
  experience-selection policy and the prepare path.
- No evidence, verification or publication authority. Every imported record is
  `source=human`, `kind=guidance`, `confidence=low`,
  `verification={status:'unverified', evidenceClass:'human-guidance', publishable:false}`.
- No architecture review of its own: the importer only transports the review
  assertions it is given and never widens them.

## Public API

| Export | Input | Output |
|---|---|---|
| `KERNEL_WIKI_SNAPSHOT_SCHEMA_VERSION` | – | `'operator-studio.kernel-wiki-snapshot/v1'` |
| `parseKernelWikiPage(text, {path})` | Raw page text and its `wiki/*.md` path | Frozen page: `{path, pageId, title, type, topics, symptoms, candidateTechniques, architectures, body, ignoredKeys, sourceDigest}` |
| `buildKernelWikiSnapshot({pages, sourceCommit, reviews, license})` | `pages=[{path,text}]` (max 256), fixed 40-hex commit, review assertions, optional license provenance | Frozen, fully validated snapshot envelope |
| `validateKernelWikiSnapshot(snapshot)` | Any snapshot value | The same snapshot, or an explicit error |
| `applyKernelWikiSnapshot(store, snapshot, {projectId,now,author})` | Mutable store draft, snapshot, import identity | `{changed, result:{created,updated,unchanged,records:[{id,version}],sourceCommit,snapshotDigest}}` |
| `kernelWikiRecordId(projectId, unitId)` | Project ID and unit ID | `'kw-' + first16(sha256(projectId)) + '-' + unitId` |

`license` is an additional optional input of `buildKernelWikiSnapshot`; the
envelope key `license` is explicitly allowed by the contract and is covered by
`snapshotDigest`. Everything else in the envelope is required.

## License provenance is verbatim

`license.text` is the one value this module carries **byte for byte**: the
LICENSE blob reaches the snapshot exactly as the pinned commit stores it, so its
trailing newline, any leading or trailing whitespace and any CRLF/LF line endings
are all preserved, and `snapshotDigest` covers that actual original text. Both
`buildKernelWikiSnapshot` (through `normalizeLicense`) and
`validateKernelWikiSnapshot` only *validate* it — string, some nonempty text, the
existing `8000`-character bound, and no control characters other than LF, CR and
tab — and never trim, rewrite or re-encode it. Changing the license text by a
single character changes the envelope digest.

Every other string, including unit `content` and the single-line
`license.spdx`/`license.path`/`license.copyright` fields, keeps the normalizing
validators described above; only the license text itself is exempt, because it is
provenance rather than injected content. The pinned CLI reads the blob the same
way: it derives the MIT assertion and the copyright line from a read-only
normalized probe and never stores that probe.

## Frontmatter subset

Consumed keys: `id`, `title`, `type`, `tags` (→ `topics`), `symptoms`,
`candidate_techniques`, `architectures`. `id` and `type` are required identity;
`title` falls back to the first `# ` heading and then to the page ID. A missing or
unsafe `id`, a missing `type`, a duplicate key, a duplicate page ID or path, an
unterminated block, a nested mapping under a consumed list key, a structured list
item, and a page above the 8000-character content bound all fail explicitly. The
importer never truncates upstream code or claims.

Every other key — including the upstream nested `performance_claims` block — is
skipped for selection and reported in `ignoredKeys`. It is still covered by
`sourceDigest` (SHA-256 of the complete original UTF-8 page text as supplied) and
is never read as verified performance or as applicability.

## Snapshot envelope

```
{schemaVersion, sourceCommit, units, snapshotDigest, license?}
```

Each unit is `{unitId, title, content, scope, selectionMetadata, evidenceRefs}`;
units are ordered by `unitId` ascending. `snapshotDigest` is the SHA-256 of the
canonical (recursively key-sorted) JSON of the envelope without `snapshotDigest`,
so rebuilds from the same inputs and the same review file are byte-stable. Each
unit's `selectionMetadata.unitDigest` is the SHA-256 of its injected `content`,
and `validateKernelWikiSnapshot` re-checks it before any store mutation.

`selectionMetadata` carries only the frozen keys: `source='kernel-wiki'`,
`sourceCommit`, `sourcePath`, `pageId`, `sourceDigest`, `unitDigest`, `type`,
`topics`, `symptoms`, `candidateTechniques`, `architectures` (the original
declared architectures) and `applicability`
(`{mode,reviewId,hardware,architectures,requiredCapabilities,software}`).
Applicability tokens are canonical lowercase. Metadata is provenance, not
evidence.

Content always cites the source: the page body or the reviewed transfer text,
followed by the KernelWiki path, the pinned commit and the blob URL. Reviewed
transfers additionally state that they are project-reviewed, unverified
suggestions.

## Scope, topics and reviews

- `scope.tags` stays empty. KernelWiki topics describe what a page discussed and
  are never copied into access constraints; they live in `selectionMetadata.topics`.
- A page without an explicit review is stored as `mode='unreviewed'` with empty
  applicability arrays and an empty scope. It is retained, including when its
  declared architectures do not fit any current target, but it can never
  auto-qualify.
- Both reviewed modes must declare a nonempty reviewed `architectures` list;
  a review that names no architecture asserts nothing and is rejected. An
  unreviewed page may still omit architectures — it is retained, but its
  applicability dimensions must all stay empty, so it can never auto-qualify and
  is never injected.
- An `architecture-specific` review qualifies the original unit: its scope and
  applicability carry the reviewed `hardware` and `architectures`.
- A `reviewed-transfer` review adds a separate stable unit
  `pageId + '-transfer-' + reviewId` with the explicitly supplied reviewed
  content, the original source metadata and the review ID, and keeps the raw unit
  as well. `topics` come from the review when supplied; symptoms and candidate
  techniques stay empty on the transfer unit so a summary never inherits
  technique hops it does not cover. Reviewed-transfer without explicit content is
  rejected.
- Reviews are project assertions, not model or provider verification, and grant
  no publication or runtime authority.

## Apply semantics

`applyKernelWikiSnapshot` validates the whole snapshot first, then for every unit
either appends a new record, advances the same record ID when content or
provenance changed (`expectedVersion`, never deleting old versions), or reports it
unchanged. An identical re-import returns `changed:false` and leaves the draft
untouched, so the repository revision does not move.

A pre-existing record with the same ID is only continued when it is a kernel-wiki
guidance record of this project **and** carries the same permanent ownership: the
same role (raw page or reviewed transfer), the same `pageId` and the same
`sourcePath`. A raw page keeps its record ID across review changes, so adding,
replacing or revoking an architecture-specific review is changed provenance that
advances the same ID to a new version. A reviewed transfer is bound to its review
ID (`pageId + '-transfer-' + reviewId`): a different review ID is a separate stable
unit with its own record, and is never used to take over another page or path.
Anything else — another page, another source path, another review ID, or a record
that is not kernel-wiki guidance of this project at all — is an explicit
`EXPERIENCE_ID_CONFLICT`, never overwritten. The full resulting store is
re-validated before returning on every path, including an identical no-op, so
`changed:false` always means the untouched draft is a complete valid store.
Atomicity comes from the caller's single `repository.transact`: a failure anywhere
imports nothing.

Pages missing from a later snapshot are **not** deleted. The importer only creates
and advances the units it is given, so a page removed upstream keeps its latest
version in the store; retention is reported here rather than by deleting history.

## Inputs

Callers supply a fixed commit, `pages` from git blobs (never dirty working
files), and optional review assertions. `applyKernelWikiSnapshot` requires the
mutable store draft and an import identity (`projectId`, `now`, `author`); `now`
must not precede the latest revision of a record it advances. The `selectionMetadata`
entry point stays the explicit import API: this module never writes it through a
generic create/update path.

## Verification

Author checks: `node --check client-runtime/kernel-wiki-import.mjs` and
`node --check scripts/import-kernel-wiki.mjs`. Independent tests
(`tests/kernel-wiki-import-test.mjs`) and shared registration belong to writer D;
cross-file behavior is checked only after exact candidate combination.
