# Controlled experience-condition study — pure contract (`experience-condition-study.mjs`)

Status: pure, I/O-free verification contract for the opt-in experience-condition
study. Authority: `docs/development/EXPERIENCE_STUDY_CONTRACT.md` §B and
`docs/development/PHASE3_WIKI_CONTRACT.md`.

Importing this module has **no side effects**: no Runtime, provider, CLI, model,
GPU, scheduler, filesystem, clock or network access. It owns the frozen nine-slot
schedule and the per-condition verification of a prepared-before-send prompt audit
against the imported KernelWiki snapshot. It defines no second selection
algorithm, quota, Gate or workflow: every mode delegates the actual facts and the
actual D selection verification to `scripts/shared-gpu-acceptance.mjs`.

## Study design

Three conditions, in this exact order per block:

| Block | Order |
| --- | --- |
| 1 | `facts-only`, `local-only`, `local-and-wiki` |
| 2 | `local-only`, `local-and-wiki`, `facts-only` |
| 3 | `local-and-wiki`, `facts-only`, `local-only` |

Nine independent affine invocations — three per condition — each with a fresh
isolated project/store/mission, two distinct verified candidates and two actual
rounds under the existing fixed smoke budgets. All conditions import the **same**
fixed snapshot before the baseline/Mission can start, so only selection changes.
This is a 3-per-condition exploratory comparison, **not** N20 and not a
significance claim.

The source snapshot is `docs/development/evidence/p3-wiki-20260915/snapshot.json`
(source `b6b4301f15e8ce6955a56776690643ce5db369e6`, snapshotDigest
`c849536ce799c7de4ac88fc770fb5f66ebad72350a92af42a8acb96d83557cd4`).

The study-only goal suffix is byte-identical for all conditions and is appended
only when an explicit study condition is configured; the default driver goal is
unchanged.

## Exports

| Export | Meaning |
| --- | --- |
| `EXPERIENCE_STUDY_SCHEMA_VERSION` | `operator-studio.experience-condition-study/v1` |
| `EXPERIENCE_CONDITIONS` | frozen ordered `['facts-only', 'local-only', 'local-and-wiki']` |
| `EXPERIENCE_STUDY_BLOCKS` / `EXPERIENCE_STUDY_SLOTS` | `3` / `9` |
| `EXPERIENCE_STUDY_GOAL_POLICY_VERSION` | `operator-studio.experience-study-goal/v1` |
| `EXPERIENCE_STUDY_GOAL_SUFFIX` | the fixed study-only goal suffix |
| `CONDITION_AUDIT_ASSERTIONS` | human-readable assertion list carried on every receipt |
| `buildStudySchedule()` | deterministic `[{index:1..9, block:1..3, condition}]` |
| `studySnapshotIdentity(snapshot)` | validated snapshot identity |
| `verifyExperienceConditionAudit({...})` | per-condition receipt, throws on mismatch |

## `buildStudySchedule()`

Deterministic and pure. Returns exactly nine frozen entries; per block the
condition order rotates left by one, so every condition appears exactly once per
block and three times overall. Index is `1..9` in block order, which is the
order the runner spawns.

## `studySnapshotIdentity(snapshot)`

Runs the production `validateKernelWikiSnapshot` (which independently recomputes
every per-unit content digest **and** the envelope digest) and returns
`{schemaVersion, sourceCommit, snapshotDigest, unitCount, reviewedSm86UnitIds}`.
A tampered or truncated snapshot therefore cannot be used as a study source, and
`reviewedSm86UnitIds` lists only units whose review asserts `sm86` — an
unreviewed unit can never qualify.

## `verifyExperienceConditionAudit({ condition, audit, sourceRound, experiences, missionId, projectId, snapshot })`

Throws unless `condition` is one of the three exact values. Every mode then runs
the **same strict common checks**:

- `verifyRoundFactsAudit({audit, sourceRound, missionId, projectId})` — identity,
  independently recomputed prompt digest/UTF-8 bytes, exact frozen source-archive
  facts, the prompt's own `MISSION ITERATION CONTEXT` equality and the
  candidate/queue bindings (see `shared-gpu-acceptance.md`);
- the frozen selection audit records the exact scheduled condition (a top-level
  `experienceCondition` and a `selection.experienceCondition` must agree when both
  are present; nothing is inferred);
- the **actual prompt is the authority**: its parsed `UNTRUSTED EXPERIENCE DATA`
  items and version map are compared to the audited selection sidecar, every
  selected entry must have an item in the prompt and vice versa (same id, version
  and origin), and the prompt context id equals the selection context id;
- the audited `sources` sidecar must correspond **one to one** with the KernelWiki
  items the actual prompt carries: no sidecar-only identity, no duplicate entry, no
  Wiki item missing from the sidecar, no borrowed identity, and every claimed
  `unitDigest`/`sourceCommit`/`sourcePath`/`sourceDigest`/`pageId` must equal the
  actual prompt item's — so a sidecar-only, duplicated or fabricated Wiki identity
  is rejected.

Per-condition additions:

- **`facts-only`** — zero prompt items, zero selected entries, empty version map,
  no reported Wiki sources. It additionally requires the source-round candidate
  execution experience to have been **durably collected** (exactly one bound
  record by mission + candidate id + patch digest + queue request id). A lost
  collection would otherwise look identical to a valid zero selection.
- **`local-only`** — runs the original strict `verifyContinuationAudit` and
  rejects **every** KernelWiki item in the actual prompt.
- **`local-and-wiki`** — runs the original strict `verifyContinuationAudit` and
  requires at least one selected KernelWiki unit, each bound to the imported
  snapshot **field for field**: the record id must be the canonical per-project
  KernelWiki record id of a snapshot unit, the `unitDigest` must match exactly one
  imported unit, and the prompt item's **complete `selectionMetadata`** (source,
  page id, source path, type, topics, symptoms, techniques, architectures and the
  whole review applicability — mode, review id, hardware, architectures, required
  capabilities, software) plus its `title`/`content`/`version` must be canonically
  equal to that unit's own values. Nothing is read from the selection sidecar, so a
  partially forged or re-reviewed identity cannot pass. The unit must carry a
  reviewed applicability with `sm86` + `nvidia-gpu` and stay human guidance:
  `source: 'human'`, `kind: 'guidance'`, `status: 'active'`,
  `verification.status: 'unverified'`, `verification.publishable: false`,
  `verification.evidenceClass: 'human-guidance'`. Unreviewed units and
  incompatible architectures are rejected.

A reviewed transfer unit is its own stable unit
(`<pageId>-transfer-<reviewId>`) and is bound as such; only a raw page has the
page id as its unit id. This mirrors the production importer's unit ownership
rule.

Every mode returns a serializable receipt (`schemaVersion`, `condition`,
`missionId`, `projectId`, validated `snapshot` identity, `facts`, `sourceRound`,
`audit`, prompt/selection counts, `selectedWiki`, `injectedExperience`,
`wikiRequired`, `assertions`). Missing evidence throws; nothing is synthesized,
and no sidecar count is trusted on its own.

## Relationship to the default verifier

`facts-only` must **never** make the default strict verifier pass:
`verifyContinuationAudit` still requires exactly one bound execution experience
whose complete unchanged content is in the actual prompt. The study's
`facts-only` receipt is the only place a zero-experience prompt is accepted, and
only together with proof that the source-round experience was collected.

## Hardware-free checks

```bash
node --check scripts/experience-condition-study.mjs
```

The module is pure, so it is exercised by importing it and calling
`buildStudySchedule()` / `studySnapshotIdentity()` / `verifyExperienceConditionAudit()`
on independently constructed fixtures; no GPU, model or live run is involved.

## Boundaries

Pure reporting only. This module never starts a process, never writes a file,
never selects experience itself and never relaxes the strict continuation
contract. The condition interface itself (`query.selection.experienceCondition` /
`OPERATOR_EXPERIENCE_CONDITION`) belongs to the runtime contract, not here; this
module only verifies what the production artifacts say.
