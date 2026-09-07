# State Identifiers Contract

## Public API and responsibility

- `safeMissionId(value)`: legacy storage/display key transformation; defaults to
  `mission` and replaces characters outside ASCII letters, digits, dot, dash
  and underscore with underscores.
- `projectIdForRepository(repository = '')`: existing `PRJ_` identifier from
  the first 16 uppercase hexadecimal characters of the UTF-8 repository label.
- `projectNameForRepository(repository = '')`: basename with slash normalization
  and the legacy `repository` fallback.

These are deterministic formatting helpers, not identity authorization,
collision-resistant hashing, canonical filesystem resolution, or path-traversal
validation. In particular, `safeMissionId` alone is not proof of path containment;
workspace adapters/callers retain their path trust checks.

## Dependencies and effects

Only `node:path` and the built-in Buffer conversion. No I/O or state mutation.
This extraction does not rename existing Missions, Projects or storage paths.
Malformed inputs retain existing coercion behavior.

## Verification

Run `npm run test:state-domain-boundary`, `npm run test:state-storage-adapters`
and `npm run test:projects-service`. Any identity-format change requires explicit
persisted-state/path migration review.
