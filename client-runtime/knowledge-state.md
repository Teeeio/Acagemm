# Knowledge State Contract

Adoption persists `currentBest.candidateDigest` and `currentBest.evidenceRunId`
alongside its own `evidenceDecision`. Decision matching requires all three
candidate ID/digest/benchmark run fields; a partial identity does not match.

## Purpose

Own in-memory adoption and Knowledge transitions, retaining the `state-store`
compatibility exports.

## Responsibilities

Build maintenance records/assets and apply adoption and maintenance outcomes.

## Non-Responsibilities

Gate evaluation, Workspace binding verification, repository commits, persistence,
external publication, and Agent or hardware execution belong to other modules.

## Public API

| Export | Input | Output |
|---|---|---|
| `EVIDENCE_DECISION_DRAFT_STATUS` / `EVIDENCE_DECISION_ASSET_STATUS` | – | Frozen status vocabularies |
| `PUBLISHED_EVIDENCE_LEVEL` / `DEVELOPMENT_EVIDENCE_LEVEL` / `SIMULATION_EVIDENCE_LEVEL` / `UNKNOWN_EVIDENCE_LEVEL` | – | Frozen evidence-level labels |
| `classifyEvidenceDecision(decision)` | Unified decision or `null` | `{known, executionKind, adoptionStatus, publicationStatus, draftStatus, assetStatus, evidenceLevel, confidence, publication, publishable, reason}` |
| `validateEvidenceDecision(decision)` | Unified decision or `null` | `{valid, reason}` structure/consistency check |
| `resolveGovernanceDecision(state, draft)` | State and draft | The decision that governs the record |
| `createKnowledgeMaintenanceState(status = 'idle')` | Legacy status label | New mutable maintenance record |
| `toPublishedKnowledgeAsset(draft, version = 'v1.0')` | Draft with `hardware` array | New asset record |
| `markCandidateAccepted(state, note, source = 'policy')` | Candidate state and disposition | Acceptance ISO timestamp |
| `runAutomaticAdoption(state, note?)` | Evaluated Candidate state | Same state object |
| `runKnowledgeMaintenance(state)` | Adopted state and drafts | Same state object |

## Inputs

Callers supply normalized state and bound evidence. A selected Candidate must
exist on any adoption path that passes the guards. No input validation is added.

## Outputs

Acceptance replaces matching Candidate records. Adoption updates best/review/stage/
maintenance/Agent; maintenance replaces drafts/assets and completes review/Agent.
Both append runtime/audit events without changing snapshot versions. Formatting is
shallow and leaves input intact.

## Invariants

The unified evidence decision (`operator-studio.evidence-decision/v1`) is the only
classification authority. `classifyEvidenceDecision` first requires an already
recognized, complete v1 DTO: exact schema/policy version, full binding key set,
known execution kind, boolean correctness/benchmark, both diagnostic predicates
with reason arrays, and known adoption/publication statuses. It then checks
internal consistency: execution `kind` and `liveHardware` must agree in both
directions (`live` ⇔ `liveHardware: true`); adoption `allowed` requires passing
correctness/benchmark with no reasons; publication `allowed` requires allowed
adoption, live execution, both eligible diagnostics, and a non-empty
`candidateId`/`candidateDigest`/`runId` binding — a fully-shaped binding object
whose identity fields are all null cannot be published from eligible flags alone.
It never recomputes the authoritative policy; a malformed, incomplete or
future-schema record returns `unknown` / `未知证据`, non-publishable — a single
`publication.status` field never authorizes.

With a valid DTO it maps as follows, and no other field may be substituted:

- `publication.status === 'allowed'` ⇒ draft `validated`, asset `published`,
  evidence level `Level 3`.
- Otherwise, `execution.kind === 'live'` ⇒ draft/asset `development`, evidence
  level `真实开发证据`, `publication` `waiting`/`blocked`, `publishable: false`.
- `execution.kind === 'unknown'` ⇒ draft/asset `unknown`, evidence level
  `未知证据`, `publication: 'blocked'`, `publishable: false`. An unclassified
  execution is never relabelled as simulation.
- Explicit simulation/CPU execution ⇒ `simulation` / `模拟证据`, non-publishable
  (unchanged).
- `waiting_external_verification` publication is explicit; it is never collapsed
  into `blocked` or into an auto-publication.

`resolveGovernanceDecision` keeps each record's own bound decision. For a draft it
uses `draft.evidenceDecision` only when valid and its binding matches the draft's
explicit candidate/digest/run identity (`evidenceBinding`, else
`sourceCandidate`). Only an explicit, complete candidate+digest+run binding may
backfill a decision from the current run, and only when that decision's binding
matches it; a draft without identity stays `unknown`. For state-level resolution
the canonical `benchmark.evidenceDecision` — then `decisionReview.gate.decision`
and `decisionReview.evidenceDecision` — is used only when its binding matches the
current candidate/run. `currentBest.evidenceDecision` is never a global source,
and one draft/run's decision is never applied to another. The historical
experience library is never written.

- `toPublishedKnowledgeAsset` classifies from `draft.evidenceDecision`; it does
  not grant publication authority. A legacy draft without a decision yields
  `unknown`/blocked and is not published.
- Real hardware and publishability are separate dimensions: a live, non-shared
  result can be `development` while remaining non-publishable.
- Maintenance accepts only the decision's `execution` fields as provenance; it
  never infers live from `environment.liveHardware` or a Gate boolean.
- Change outcomes are `auto_published` only when the decision publication is
  `allowed`; a `development_only` draft can never be written as `auto_published`.
  `reviewRequired` counts drafts that were not published.
- Idempotency is content-based, never timestamp-based. The maintenance record
  stores an input fingerprint over each draft's own resolved decision (full
  decision except the generated `evaluatedAt`, including diagnostics) plus its
  stable content fields (including `version`, `evidence`, `evidenceBinding`);
  derived status/level/confidence/publication and generated codes/timestamps are
  excluded, and global stage/Agent/benchmark fields are excluded so an unrelated
  new benchmark cannot re-run maintenance over old drafts. A repeated tick or JSON
  restore with the same inputs is a no-op: events, timestamps, counters and asset
  versions stay byte-identical. A changed draft content/version or bound
  decision/run is reprocessed exactly once.
- Adoption retains review-Gate, Candidate-Gate, then legacy fallback precedence.
  A review Gate for another candidate is ignored; a Gate's embedded decision is
  copied only when bound to the adopted candidate/run (otherwise it is dropped,
  never copied from elsewhere). Pending human review or missing identity returns
  unchanged. Managed runtimes require `patchDigest` and the selected Gate's
  `passed === true`. An existing decision whose `adoption.status !== 'allowed'`
  returns the state unchanged.
- `markCandidateAccepted` only records the acceptance disposition: it never
  mutates the original Gate/`passed`/`result`/decision, so human adoption cannot
  rewrite the Gate conclusion.
- Best `verified` follows `decision.publication.status === 'allowed'`;
  `liveHardware` follows `decision.execution.liveHardware`. `currentBest` and
  `decisionReview` retain the same `evidenceDecision` clone as the Gate. No
  execution evidence is rewritten.
- Maximize keeps stage `evidence`; ordinary adoption uses `curation`, then
  maintenance uses `published`. Maintenance stage `published` is a workflow stage
  and does not equal formal asset publication; asset publication state is the
  explicit `published`/`waiting`/`blocked` field. This stage alone does not prove
  live evidence.

## Dependencies

Only `state-reference-data`, `mission-objective`, `evidence-state`, `runtime-events`,
the I/O-free `evidence-decision` schema/policy constants and declarative Agent
capabilities/registry/definitions. No facade, storage, Workspace, HTTP or Provider
implementation imports.

## Side Effects

Memory mutations above; `Date`/`Date.now()` supply timestamps and message IDs.
Canonical appenders retain 500 runtime events and 30 audit records. No I/O.

## Error Contract

No new error codes or retries. Guarded adoption returns unchanged; malformed
records retain native JavaScript errors, including missing `draft.hardware`.

## Example

```js
const maintenance = createKnowledgeMaintenanceState('ready');
```

## Verification

```bash
npm run test:knowledge-state
npm run test:mission-project-state
npm run test:state-domain-boundary
```

## Change Checklist

Preserve exports, shapes, guards, source downgrade and tests.

## Known Limitations

Legacy mappings are not a general conflict engine. Completed maintenance is a
no-op when the input fingerprint is unchanged and every draft already has an
asset; legacy records with no decision fingerprint as `unknown` and remain
non-publishable until re-evaluated at a domain boundary. Records are not frozen;
Agent messages have no cap here.
