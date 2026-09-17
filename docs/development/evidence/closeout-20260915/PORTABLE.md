# Portable evidence bundle (2026-09-15 closeout)

`portable-evidence.py` packages the retained originals into one relocatable
directory and re-proves the frozen acceptance claims from that directory alone.
It is Python standard library only, and it never uses a shell, a network call, a
provider, a GPU, a model, Git at verification time, or a package install. It
never deletes a path.

Authoritative behaviour lives in `ACCEPTANCE.md` (§ *Portable evidence writer*)
and in the immutable `inputs.json`; this file only explains how to drive it.

## Commands

```
python portable-evidence.py build  --repo <repo> --archives-root <dir> --out <NEW_DIRECTORY>

python portable-evidence.py verify --bundle <DIRECTORY> --scratch <NEW_DIRECTORY> --report <PATH>
```

`--archives-root` is the explicit `.operator-studio-local` base; every archive
path in `inputs.json` is resolved below it. Both `--out` and `--scratch` must be
**new** directories — an existing one is refused rather than overwritten.

### Output path safety

`verify` settles every path rule *before it writes anything*:

* `--report` must be a **new file**; an existing file, directory or symlink is
  refused rather than overwritten, and its parent directory must already exist.
* `--report` must lie **outside** `--bundle` and outside `--scratch`.
* `--scratch` must not overlap `--bundle` in either direction (no scratch inside
  the bundle, no bundle inside the scratch).

These comparisons use `realpath` plus `normcase`, so directory symlinks, `..`
segments and case aliases cannot smuggle a path past them. When the `--report`
path itself is unsafe it is **never written** — not even a failure report, which
would otherwise clobber a file of the bundle under verification. Such a run
reports the problem on stdout and stderr and exits `1`. A legal `--report` is
written normally for both success and failure, and is always a new file.

Exit code `0` means every check passed; `1` means at least one check failed (the
reason is in the report and on stdout); `2` means the CLI itself was misused.

### build

Reads `docs/development/evidence/closeout-20260915/inputs.json` from `--repo`,
then materialises a bundle:

| Bundle path | Content |
| --- | --- |
| `portable-evidence.py` | this script, byte-copied |
| `inputs.json` | the immutable input list, byte-copied |
| `repo/<path>` | the frozen reader and the four helper modules, at their repository-relative paths |
| `archives/<path>` | the eight byte-original ZIPs |
| `MANIFEST.sha256` | relative-path SHA256 list of every payload file above |

The reader and helpers are read from the Git-frozen blob
(`git show <sourceCommit>:<path>`) when Git can serve it, otherwise from the
checked-out file; in both cases the bytes are accepted **only** if their SHA256
equals the SHA256 declared in `inputs.json`. Archive bytes are accepted only
against their declared SHA256 as well. All inputs are verified before a single
byte of the bundle is written, so a rejected input leaves no partial bundle.

Because the helpers are placed at their real repository-relative paths, the
unmodified reader can be pointed straight at `<bundle>/repo`, and its own
relative imports (`./shared-gpu-acceptance.mjs`,
`../client-runtime/model-observation.mjs`, `../client-runtime/cancellation-contract.mjs`)
resolve without editing a frozen file.

### verify

Verification is layered and strictly ordered:

0. **Output path safety** — the `--bundle` / `--scratch` / `--report`
   relationships above are validated first, before any file is written or
   created. An unsafe `--report` is reported on stdout/stderr and never written.
1. **Payload membership, bytes and SHA256** — `MANIFEST.sha256` is parsed with
   path validation (relative, forward slashes, no `..`, no absolute path, no
   drive letter, no backslash, no duplicate) and compared against the actual
   bundle contents. Missing, extra and mutated files all fail.
2. **Declared input SHA256** — every reader, helper and archive path declared in
   `inputs.json` is re-hashed inside the bundle. This layer is independent of the
   manifest, so regenerating the manifest after tampering does not help.
3. **Per-entry archive integrity of all eight ZIPs** — member names are checked
   for traversal, absolute paths, drive letters, backslashes and duplicates;
   symlinked and encrypted members are refused; every file member's length and
   CRC32 are recomputed by decompressing it.
4. **Extraction** — only after 1–3 pass. Each archive goes to its own fresh
   directory under `--scratch`, with bytes written verbatim, so historical
   absolute path strings inside the originals are preserved exactly. Every member
   name is validated a second time at write time and each destination is proven
   to stay inside the scratch root.
5. **Reader replay** — the bundled, unmodified reader runs once per replay group
   with the bundled helper repository and the explicit extracted run roots.

If any of 1–3 fails, nothing is extracted and Node is never started.

### What verify reports

The `--report` JSON records the manifest size, each input's declared vs actual
SHA256, each archive's shape and integrity verdict, the extraction targets, the
Node version, and per group: the real subprocess exit code, stdout/stderr size
and SHA256, and the recomputed values.

Recomputation is against `inputs.json`, never against a summary flag:

* `coverage.invocations` / `result.runCount` / `verifiedRuns` / `fullSuccessRuns`
  versus `expectations.<group>.runs`
* `coverage.candidateTasks` and `coverage.distinctCandidateDigests` versus
  `expectations.<group>.candidates`
* `coverage.modelRuns` versus `expectations.<group>.modelRuns`, plus a usable
  concrete model label in `coverage.models`
* `strictN20.eligible` versus `expectations.<group>.strictN20`, and
  `strictN20.requiredRuns` must be the frozen 20

So the expected shape is 1/20/1 invocations, 2/40/4 candidates, 2/44/4 actual
model observations, and strict N20 eligible for the `n20` group only.

Full reader stdout and stderr are preserved under `<scratch>/reader/<group>.stdout.json`
and `<scratch>/reader/<group>.stderr.txt`; the report keeps only digests and the
recomputed numbers, so it stays bounded.

## Relocation and offline guarantees

`verify` takes a `--bundle` directory and a `--scratch` directory and nothing
else. It does not read the source checkout, Git, npm, provider configuration,
GPU state, the network, or any original absolute path: the retained absolute
paths are data inside the originals, never a lookup. The JSON report describes
the relocated bundle, so it is portable too.

Node is the only external program. It is invoked without a shell, with a
reduced environment that drops `GIT_*`, `NPM_*`, `NODE_*` and every proxy
variable, and with the scratch directory as its working directory.

## Boundaries

* **User configuration is excluded.** No credentials, provider settings, proxy
  configuration, `AGENTS.md`, `.codex`/`.dispatch` state or unrelated repository
  file is copied into the bundle. Only the reader, the four helpers, the eight
  listed ZIPs, `inputs.json` and this script are.
* **Failed history is preserved, not skipped.** All eight archives are hashed and
  entry-verified. Only the three whose `inputs.json` `replay` field names a group
  (`smoke`, `n20`, `coverage`) are successful-run replay inputs; the other five
  keep their failed/unknown outcomes and are reported as integrity-checked but
  not replayed. Nothing is upgraded, relabelled or dropped.
* **No cleanup.** Scratch and report contents are left in place for inspection;
  the tool deletes nothing, and no check depends on deleting anything.
* **Not claimed here.** This tool re-proves the retained reader's own verdict. It
  is not a stability claim, not a publishable-hardware result, and not Phase 3.

## Status of this document

This script and document were authored in an isolated workspace that had
**neither the archives-root nor the frozen commit** available, so no real bundle
was built or verified here. The author ran only targeted syntax/CLI checks plus a
scratch-only self-check of the output-path rules (report inside the bundle,
report inside the scratch, scratch inside the bundle, pre-existing report, and a
legal new report), confirming the sentinel file is never overwritten and an
unsafe report is never written. Directory-symlink creation is not permitted in
that workspace, so the symlink-alias path is exercised by Root instead.
Building the actual bundle from the integrated tool, relocating it outside the
source and original directories, and running the offline positive/negative checks
belong to Root, as specified in `ACCEPTANCE.md` (§ *Upstream acceptance*). No
result of that real run is anticipated or claimed above.
