# `import-kernel-wiki.mjs` — pinned KernelWiki snapshot builder

Builds one import snapshot from the git blobs of an exact KernelWiki commit. It
does not import anything itself: the operator imports the resulting file through
the production HTTP API (`POST /api/projects/:projectId/experiences/import-kernel-wiki`)
inside an isolated Runtime.

```
node scripts/import-kernel-wiki.mjs --source PATH --commit HEX --out NEWFILE [--reviews JSONFILE]
```

| Flag | Meaning |
|---|---|
| `--source PATH` | Local clone of `mit-han-lab/KernelWiki` (may be a bare or work tree clone; the working tree is never read) |
| `--commit HEX` | Full 40-character lowercase commit to pin, for example `b6b4301f15e8ce6955a56776690643ce5db369e6` |
| `--out NEWFILE` | Snapshot file to write; the only file this command creates. It must not exist yet and must resolve outside `--source` (see below) |
| `--reviews JSONFILE` | Optional JSON array of project review assertions (frozen input, for example `docs/development/kernel-wiki-reviews.json`); read as given, never widened |

Exit codes: `0` snapshot written, `2` usage error, `1` read or build failure. A
failure never leaves a partial output file, because Git is read completely and the
whole snapshot validates before the file is written.

`--out` is refused with a usage error (exit `2`) when the file already exists or
when it resolves inside `--source`. The check compares real (symlink-resolved)
paths both literally and case-folded, and the final write uses the exclusive `wx`
flag, so an existing file is never truncated, replaced or raced into, and the
pinned clone can never be polluted by its own output.

## What it reads

- `wiki/**.md` blobs at `--commit` (`git ls-tree` + `git cat-file`), sorted by
  path. Non-markdown entries under `wiki/` are skipped and reported on stderr.
- The `LICENSE` blob at `--commit`. The MIT copyright line and the full license
  text are copied into the snapshot provenance (`license`, covered by
  `snapshotDigest`); a license that is not MIT fails instead of being recorded.
  The license text is copied **verbatim**, exactly as the blob stores it: the
  trailing newline, any leading or trailing whitespace and any CRLF/LF endings are
  preserved, so `snapshotDigest` covers the actual upstream text. The MIT check
  and the copyright line come from a read-only normalized probe that is never
  stored, and nothing else about the license is rewritten.

It never checks out, fetches, pulls, commits or otherwise mutates the source
repository, never reads dirty working files, and performs no network, model or GPU
work. `GIT_OPTIONAL_LOCKS=0` and `GIT_TERMINAL_PROMPT=0` keep the clone untouched
and non-interactive. Git trust is scoped through the existing
`createScopedGitEnvironment` helper with a generated config file in an explicit
temporary directory; global Git configuration is never edited.

## What it writes

Exactly one new snapshot file: `{schemaVersion, sourceCommit, units, snapshotDigest,
license}` with deterministic unit order and a canonical envelope digest. It writes
no live Runtime storage, no workflow state, no vendored copy of the KernelWiki
source tree, and it never modifies or removes anything already on disk. `--out` is
printed on success together with the page count, unit count and `snapshotDigest`.

Provenance such as `performance_claims` is retained only inside each page's
`sourceDigest`; it is never interpreted as measured performance or as
applicability, and KernelWiki topics never become `scope.tags`.

## Bounded snapshots

Snapshots stay bounded: the importer rejects any page above the 8000-character
content bound instead of truncating it, caps a build at 256 pages, and the
production server keeps its request body limit. Use explicit per-page errors and
bounded inputs rather than disabling request limits on the import route.

## Operator follow-up

The author does not run this against the real clone and does not fetch it; the
operator owns the pinned clone and the frozen review file. After a successful
build the operator imports the snapshot twice into an isolated Runtime to confirm
zero duplicates and an unchanged revision, and verifies the selected IDs and
content in the final prompt of a new round. Pages missing from a later snapshot
are not deleted by the importer; only the units present in the file are created or
advanced.

Author check: `node --check scripts/import-kernel-wiki.mjs`.
