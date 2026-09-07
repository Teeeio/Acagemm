# Evidence State Shapes Contract

## Responsibility and API

I/O-free factories for the existing decision-review and Baseline schema:

- `createDecisionReviewState(status = 'idle')`: new review state, including
  policy/signals and status-dependent approval, recommendation and resolution.
- `normalizeBaselineKind(kind)`: `naive_v0` or default `pytorch_reference`.
- `createBaselineSourcePolicy(kind, overrides = {})`: source authority and
  single-file expansion policy with caller overrides.
- `createBaselineResolutionState(overrides = {}, kind)`: resolution metadata.
- `createBaselineRequirementState(overrides = {})`: required/kind/status,
  source policy, resolution, evidence/materializer and persisted oracle reference.

Defaults and override precedence preserve the existing snapshot schema. Factories
return new top-level records but do not promise deep cloning of supplied evidence,
source or materializer objects. Resolved review metadata uses the current clock.

## Boundaries and invariants

No imports, I/O, queue/provider execution, adoption or Gate decisions. These are
shape factories, not authorization or fixed-Profile validators. In particular,
constructing a source policy or evidence record never proves live provenance.
Fixed Profile semantics remain exclusively in `fixed-operator-profiles.mjs`.
Malformed values retain existing JS behavior; there are no new error codes.

The original `state-store.createDecisionReviewState` export is an alias.
The remaining factories are canonical shared APIs for Gate/projection/state
normalization, not a new persisted format.

## Verification

Run `npm run test:state-domain-boundary` and `npm run test:gate`.
Any default or shape change requires snapshot compatibility review and updates
to callers, tests and this contract.
