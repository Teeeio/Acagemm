# Mission target profile

Selection freezes `targetCapabilityCatalogSnapshot()` with an independent catalog
schema version and content revision. This audit-only snapshot preserves the static
capabilities registered at retrieval; it does not supply observed Mission hardware,
architecture, software or features.

Pure, versioned optimization intent for first-round experience retrieval. It makes
no calls to a GPU, a provider, the filesystem or the target capability registry.
`normalizeMissionTargetProfile(value, hardware)` accepts an optional object with
`architecture` and optional canonical `hardware`, `schemaVersion`, `source`.
It returns null for absent configuration, otherwise
`{schemaVersion:'operator-studio.mission-target-profile/v1',source:'user-declared',hardware,architecture}`.
Only one explicit Mission hardware identity is allowed; hardware must match,
identifiers are bounded and normalized, and forged provenance/version/extra fields
fail with `MISSION_TARGET_PROFILE_INVALID` (400). No availability is implied.

The create-Mission boundary validates before state changes. Generic specification
import, managed form drafts and new-attempt copies retain the profile. Unknown
architecture is represented by an absent profile; it remains a usable task.
Suggestions help enter NVIDIA identifiers, while custom identifiers keep other
vendor targets configurable without inventing their capabilities or architecture.

Round experience uses same-Mission observed target first, otherwise this explicit
configuration, otherwise declared hardware with unknown architecture. A conflict
between configuration and actual observation blocks a new retrieval; neither
provenance nor execution evidence is rewritten. Same-round context and original
budgets remain frozen. Target attribution records the configuration contract
version and exact normalized profile with the frozen selection and read status.

Verification: `tests/mission-target-profile-test.mjs`, round-experience tests,
generic form/API integration and the release gate. Software fixtures are not live
hardware evidence. Configuring a target does not register or enable its backend.
