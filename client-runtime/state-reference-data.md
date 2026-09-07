# State Reference Data Contract

## Purpose

Share legacy fixture records and metadata without dependencies. These literals
are not independent evidence of live execution.

## Responsibilities

Own the records below; preserve their IDs, ordering, nested fields, labels and
numerical examples.

## Non-Responsibilities

No Mission creation, normalization, Gate/capability decisions or Provider discovery.
`agentProfiles` is distinct from `fixed-operator-profiles.mjs`;
`capabilityRegistry` is distinct from the Agent Runtime registry.

## Public API

| Export | Input | Output |
|---|---|---|
| `knowledgeDrafts` | None | Shared array of three structured drafts |
| `candidateEvaluations` | None | Shared array of three reference Candidates |
| `failureRecords` | None | Shared array containing the failure example |
| `agentProfiles` | None | Shared array of three presentation profiles |
| `capabilityRegistry` | None | Shared object with `skills` and `tools` arrays |

## Inputs

None. Source literals are evaluated once per module instance. Hardware, metrics,
versions and dates describe retained examples, with no runtime configuration input.

## Outputs

Imports receive the same mutable object/array references. `const` protects only
the export binding: nested values are not frozen. The three historical data
exports remain available through the state-store compatibility facade.

## Invariants

- Reference `Level 3`, correctness and Gate labels never substitute for bound
  live-hardware evidence or authorize publishing simulation/CPU results.
- Keep the legacy shared-reference behavior. Do not silently introduce deep
  freezing, per-import copies, ID changes or normalization here.
- Mission domain construction clones draft/Candidate/failure defaults;
  initialization clones profile/catalog metadata. Other callers retain their
  existing shallow-copy behavior. Not every API promises a deep clone.

## Dependencies

No imports. Consumers include Mission/Project state, state initialization,
Knowledge state and reference-runtime projection. Dependencies must not point
back from these literals to their consumers or to effect implementations.

## Side Effects

None beyond allocating module-scoped data. The module reads no clock and performs
no I/O. A consumer that mutates an exported value changes what other importers
observe; callers needing isolated editable data must explicitly clone it.

## Error Contract

No callable validation API, error codes or retry behavior. Importing these values
does not validate later consumer mutations.

## Example

```js
import { knowledgeDrafts } from './state-reference-data.mjs';
const editableDrafts = structuredClone(knowledgeDrafts);
```

## Verification

```bash
npm run test:knowledge-state
npm run test:mission-project-state
npm run test:state-domain-boundary
npm run test:smoke
```

## Change Checklist

Review schema compatibility, identity, clone boundaries and facade tests together.

## Known Limitations

Historical/example metrics and statuses are not current telemetry, an external
Knowledge catalog, or runtime permission authority.
