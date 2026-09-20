# KernelWiki selection replay — read-only historical evidence (`replay-kernel-wiki-selection.mjs`)

Status: read-only diagnostic over **already-persisted** run artifacts. It answers
one question that no existing tool answers: *in the runs we already have, was a
KernelWiki unit actually selected, on what reason, and does the selected unit
declare applicability that matches the round's target?*

**It is a historical replay, not a model or GPU benefit validation.** It starts no
model, provider, GPU, scheduler or child process; it writes nothing; it re-runs no
optimization round; it relaxes no baseline, oracle, correctness, budget, task or
evidence-publication constraint.

## Evidence order (the whole point of this script)

1. **Primary evidence — the persisted `roundExperienceSelection` audit.** It records
   the selection that actually happened in that round and does not change when the
   store gains records later.
2. **Secondary, confounded — `--recheck` re-runs `retrieveExperienceSelection`
   against today's store.** Three confounds are confirmed, not hypothetical:
   - the on-disk store is **final**: records written after that round are visible
     today (verified: in `r8/a/slot-03` the store revision went `2 -> 3` after the
     round, and the only added record carries `createdAt` three minutes *after* the
     round's `loopStartedAt`);
   - the audit does **not** persist `preferredIds` / `repeatedAttempts`, which do
     participate in ranking, so the ranking cannot be replayed exactly.
   - the **injection quotas are not part of `policyVersion`**, so a re-run applies
     *today's* caps while the audit recorded the caps in force at the time
     (`selection.quotas`). Rounds audited under a different cap are therefore not
     directly comparable — the cap must be read from the audit, not from the code.

   `recheckSelection` therefore always returns a `confounds` list, and the CLI
   prints a reminder that a recheck difference must not be read as "what happened".
   A recheck verdict is one of:

   | Verdict | Meaning |
   | --- | --- |
   | `same` | identical selected set |
   | `differs-only-by-post-round-records` | nothing selected at the time was lost, and every added record's `createdAt` is after the replay clock — i.e. store visibility changed, not the selection |
   | `differs` | unexplained difference; treat as a lead only |
   | `skipped` | no replay clock (`loopStartedAt` absent), or the audited `policyVersion` differs from the current one |
   | `error` | the re-run threw; the message is reported instead of a crash |

   `differs-only-by-post-round-records` is deliberately worded as a statement about
   the **set** of records that existed at the time. It does **not** claim the
   ranking and quota outcomes were reproduced position for position.

## Relevance, and why the two architecture sources stay separate

A KernelWiki record declares applicability in two different places, and they mean
different things:

- `selectionMetadata.applicability.architectures` — the **reviewed** applicability
  (what the review asserts this unit may be transferred to);
- `selectionMetadata.architectures` — the **raw source page's** own list.

The report prints both plus their union, and labels which one produced the match
(`architectureBasis`: `reviewed-applicability` / `source-page-only` / `none`).
Merging them into one field would make "reviewed for this target" indistinguishable
from "the source page happened to mention this target". Only the union is compared
against the round's target; hardware is compared from the reviewed block only.

Feature relevance is a **term overlap**, not a score: the vocabulary is
`topics ∪ tokens(pageId)`, and each match is reported as
`structure:generic_affine ~ "<matched term>"` so a human can judge the basis.
Topic-free units are reported as `no-feature-topic-overlap` rather than silently
counted as a hit.

## Defects vs. relevance warnings

`defects` (non-zero exit) are only "something that should not have been injected":

| Code | Meaning |
| --- | --- |
| `unreviewed-wiki-injected` | a selected KernelWiki unit whose `applicability.mode` is `unreviewed` (or has no `reviewId`) |
| `wiki-item-missing-provenance` | a selected KernelWiki item with no matching `sources[]` sidecar entry |
| `provenance-without-item` | a `sources[]` entry with no corresponding selected item |
| `wiki-record-absent-from-final-store` | the selected record no longer exists at that version in the final store, so relevance cannot be re-derived from the store (the audit itself remains evidence) |

`relevanceWarnings` (informational) are `declared-architecture-excludes-target` and
`no-feature-topic-overlap`. Weak relevance is never reported as a defect.

## Did the injection cap ever bind? (read from the audits, never asserted)

`summarize` reports `quotaProfiles` — one row per cap value actually recorded in the
audits (`selection.quotas.wiki`, or `(not recorded)` for older audits, never
back-filled with today's value) with the audit count, the highest number of Wiki
items that cap ever admitted, and how many entries that cap's audits excluded for
`quota-wiki`. `wikiCapBinds` counts audits in which a candidate was excluded for
`quota-wiki`.

The only observable of "the cap was binding" is a recorded `quota-wiki` exclusion.
A short list of injected Wiki items is *not* evidence that the cap was reached — it
is equally consistent with a cap that never mattered. Current corpus: 32 audits
recorded `wiki: 6` with a maximum of one Wiki item injected and zero `quota-wiki`
exclusions, 22 recorded no quota at all — so **the 6 -> 3 change is inert on the
observed data**. That is the honest reading: the corpus neither supports nor
contradicts the tightening. (The binding-`quota-wiki` arithmetic is unit-tested
against synthetic rows; the corpus numbers above are what the real artifacts say.)

## Corpus discovery

A run directory is one that has **both** `runtime/experiences/experiences.json` and
`data/mock-db.json`. Audits are deduped by `contextId` (the same round's selection is
written through two paths).

Directories that look like a **repository checkout snapshot** (`package.json` +
`client-runtime/`) are never descended into. `.operator-studio-local` holds full
frozen copies of the code tree which contain `experiences.json`-shaped files;
counting a fixture as a real run would destroy the evidence value of this report.
Skipped snapshots are listed in the report so the omission is visible, not silent.
`node_modules` is skipped for the same reason at a coarser level.

## Usage

```
node scripts/replay-kernel-wiki-selection.mjs [--root <dir>]... [--run <runDir>]... [--recheck] [--json]
```

`--root` defaults to `<repo>/.operator-studio-local` and is repeatable; `--run`
selects explicit run directories and disables discovery.

Exit codes: `0` report produced with no defects; `1` usage error or defects found;
`2` no readable run directory.

`npm run replay:kernel-wiki-selection` runs the default over the local artifacts.

## Pure exports (unit-tested)

| Export | Meaning |
| --- | --- |
| `REPLAY_SCHEMA_VERSION` | `operator-studio.kernel-wiki-selection-replay/v1` |
| `declaredApplicability(metadata)` | reviewed vs. raw applicability, kept separate |
| `wikiRelevance({ record, target, features })` | per-unit relevance with named basis |
| `selectionDefects({ selection, wikiItems })` | the four defect codes above |
| `relevanceWarnings({ wikiItems })` | the two warning codes above |
| `exclusionSummary(selection)` | exclusion counts by reason, with `unreviewed` surfaced |
| `buildAuditRow({ runDir, selection, loopStartedAt, records })` | one audit → one report row |
| `summarize(rows)` | corpus aggregate |
| `recheckSelection({ store, selection, now })` | the confounded secondary check |
| `discoverRunDirs(root)` / `collectAudits(db)` / `readRun(runDir)` / `replayRuns({...})` | I/O layer |

## What this script does not do

- It does not modify, migrate or rewrite any run directory or experience store.
- It does not import the KernelWiki snapshot or re-verify `unitDigest` against it;
  it reports the provenance a selected record carries.
- It does not renumber or re-score relevance; it reports overlap and declared
  applicability for human review.
