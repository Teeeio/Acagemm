# State Domain Decoupling Goal

## Consensus

- Context: 2026-09-07, continuing the completed Gate/evidence/storage extraction.
- Objective: separate remaining Mission/Project and Knowledge rules from the
  state-store compatibility facade, migrate callers and prove behavior compatibility.
- Success: I/O-free domain dependency graphs; no Application state-store defaults;
  existing exports and state format retained; local contracts/ownership updated;
  release and non-hardware verification both pass.
- Non-goals: new product features, new workflow, schema or hardware semantics,
  live Agent/hardware execution, Git commits, unrelated worktree cleanup.
- Invariants: fixed Profile/test cases/dtypes/shapes/budgets, Candidate/Workspace
  evidence identity, simulation non-publication, serialized queue/atomic terminal
  persistence, read-only queries and explicit advancement all remain unchanged.

## Requirement-to-implementation mapping

| Requirement | Planned boundary | Verification |
|---|---|---|
| Shared defaults without adapter imports | state-reference-data, mission-state-shapes | import graph and state factory parity |
| Knowledge/acceptance state transitions | knowledge-state | live/simulation, review, maximize and repeat-governance tests |
| Mission/Project normalization and transitions | injected mission-project-state factory | path ports, switching/cloning, Project errors and frozen test contracts |
| Initial snapshots and reference projections | state-initialization, state-reference-runtime | seed/product parity and existing fixture workflow tests |
| Persistence compatibility | state-store facade | original exports, schema/version, read isolation and corruption/journal tests |
| Explicit application dependencies | existing service constructors / local-server | injected-port tests and dependency gate |

Module names may be adjusted if inspection reveals a simpler acyclic boundary.
All production assembly remains at the existing composition root.

## Design decisions and rejected paths

- Inject two path values (rootDir/workspaceDir) and two path queries
  (workspaceDirForMission/missionSourceDirFor). Domain code may format paths using
  node:path but may not import storage-paths or workspace implementations.
- Keep existing empty-Mission fallback and assigned-Mission path formulas distinct.
- Knowledge depends on shared data/contracts, never Mission normalization.
  Initial-state factories consume the Mission domain factory, not the reverse.
- Do not infer permissions to repair adjacent legacy semantics during extraction.
  Mission switching currently does not project appliedCandidateId; candidate
  attribution continues using its existing admitted context. Project key and
  source-root formatting also retain existing behavior.
- Do not treat toPublishedKnowledgeAsset as independent provenance authorization:
  it formats validated/Level-3 records; maintenance enforces live-vs-simulation
  downgrade before producing assets.
- Rejected: importing the compatibility facade from newly extracted rules;
  silently changing defaults or using a second workflow to simplify tests.

## Trace

| Step | Input / action | Status / evidence |
|---|---|---|
| 1. Baseline | Previous batch: 98 release checks; 26 non-hardware checks including release and CPU E2E | previously passed; current Goal results recorded in step 6 |
| 2. Inventory | Capture current 1284-line facade and analyze top-level bindings | source snapshot retained in task context; explicit dependency map |
| 3. Independent critique | Review dependency closure and compatibility traps | four path inputs accepted; pure token usage contract identified |
| 4. Verification first | Separate threads establish Mission/Project and Knowledge behavior tests | 14 Mission/Project cases and Knowledge guard/source scenarios pass |
| 5. Extraction/integration | Six canonical modules; five Application services now require domain ports | 62 prior exports retained; 40 moved definitions have identical AST; 290 old/new observations match |
| 6. Final gates | Domain/application recursive import guard, factory ports and compatibility tests | 23 domain nodes / 54 application closure nodes pass; 100 release checks and 26 non-hardware checks (including release and CPU E2E) pass; 62 changed modules pass syntax validation |

## Execution state

- Current stage: complete on 2026-09-07; Goal acceptance satisfied.
- Next action: hand off the completed Goal; no further implementation is required
  by this scope.
- Completion evidence: state-store reduced from 1284 to 126 lines; all 62 prior
  exports retained. Release and non-hardware gates exited successfully; independent
  integration review found no blocking issues. Diff whitespace checks pass.
- Execution limits: no live Agent or physical hardware execution, no Git commit,
  and no unrelated worktree cleanup.
- Rollback point: pre-extraction source in task context; preserve all preceding
  uncommitted work. Do not use reset/checkout or revert unrelated edits.
- Reopen consensus only if preserving behavior is incompatible with the domain
  boundary, a schema/rule change is needed, or new authority is required.
- Open risks: legacy fallback data remains deliberate; no adjacent product-policy
  repair was included. Factory wiring preserves ensure/project/version ordering.

## Probe correction and evidence

The initial whole-state hash was unstable: the random temporary repository path
was part of the frozen semantic digest. Repeating the unchanged code reproduced
the variation. This was a probe issue, not evidence of a product regression.
With stable virtual repository paths and old/new modules in the same clock/home,
all 290 observations matched byte-for-byte. SHA-256:
`89c8c73a0debee2b077f9f2abf77758a3bfd55c28e823779c058f48a02391f5b`.
The temporary pre-extraction implementation was removed after this comparison;
only canonical production rules and maintained regression tests remain.
