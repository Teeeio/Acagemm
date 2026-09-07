# Knowledge State Contract

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

- `toPublishedKnowledgeAsset` only formats `validated` + `Level 3` as `published`;
  it does not independently grant publication authority or verify provenance.
- Maintenance accepts only `environment.liveHardware === true` as live. Other
  inputs, including CPU/simulation evidence, downgrade drafts and assets to
  simulation. Live provenance still cannot promote an ineligible draft.
- Adoption retains review-Gate, Candidate-Gate, then legacy fallback precedence.
  Pending human review or missing identity returns unchanged. Managed runtimes
  require `patchDigest` and the selected Gate's `passed === true`.
- Best `verified` follows `gate.publishable === true`; `liveHardware` additionally
  requires live benchmark provenance. No execution evidence is rewritten.
- Maximize keeps stage `evidence`; ordinary adoption uses `curation`, then
  maintenance uses `published`. This stage alone does not prove live evidence.

## Dependencies

Only `state-reference-data`, `mission-objective`, `evidence-state`, `runtime-events`
and declarative Agent capabilities/registry/definitions. No facade, storage,
Workspace, HTTP or Provider implementation imports.

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
no-op only when counts match and all assets have the expected source status;
mixed live drafts can be processed again. Records are not frozen; Agent messages
have no cap here.
