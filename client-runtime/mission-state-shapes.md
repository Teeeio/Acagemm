# Mission State Shapes Contract

## Purpose and responsibilities

Shared in-memory budget, Agent, iteration and research shapes. These helpers do
not own execution, persistence, Profile rules or acceptance decisions.

## Public API and inputs

- `normalizeMissionBudgetMs(valueOrInput = null)`: milliseconds or an object with
  precedence `missionBudgetMs`, `timeBudgetMs`, `missionBudgetHours`,
  `timeBudgetHours`; hours convert to milliseconds. Unset, empty, boolean, zero,
  negative and non-finite values return `null`; positive values are floored.
- `createCurrentBestState(candidateId = 'candidate-01')`: legacy fixture best;
  only `candidate-02` selects the second fixture, all other values select the first.
- `createResearchAgentState()`: idle research record, empty collections and a
  20-minute `budgetMs` value; this value does not enforce a deadline.
- `createIterationStats()`: zeroed round/retry counters, `loopStatus='running'`
  and `roundBudget=null`. Explicit main-round admission initializes the clock via
  [round-budget-contract](round-budget-contract.md); legacy snapshots do not receive
  a retrospective deadline. Frozen experience/status records live in iterationStats
  so the existing Mission snapshot/switch boundary preserves their ownership.
- `createResearchNote(input)`: note identified by `note_${runId}`. Inputs are
  `runId`, `direction`, `content`, `summary`, `researchDir`, `startedAt`,
  `completedAt`, optional `findings`, `suggestedDirections`, `sources` (empty
  arrays by default) and `value` (default `null`).
- `appendResearchNote(state, note)`: returns the note; prepends it, removes older
  notes with the same `runId`, and retains at most 50 notes.
- `createIdleAgent(missionId?, goal?)`: idle Agent metadata with legacy Mission
  defaults, initial messages/artifacts and no run ID.
- `createAwaitingAgent(missionId, goal, candidateName, hardware = 'C550')`:
  fixture Agent with a pending candidate plan and illustrative tool records.

## Outputs, effects and invariants

Factories return mutable records. `createResearchNote` retains supplied object
and array references; `appendResearchNote` mutates only `state.researchNotes` and
stores the supplied note. There are no imports, filesystem, process, provider or
hardware effects. Fixture messages, tool records and performance values never
establish live evidence. Fixed Profile semantics remain in
`fixed-operator-profiles.mjs`.

## Errors and limitations

Malformed inputs retain JavaScript coercion/errors; no new error codes or input
validator are introduced. Records are not deeply frozen. Budget normalization
is not admission validation or retry-budget enforcement.

Example: `normalizeMissionBudgetMs({ missionBudgetHours: 2 })` returns `7200000`.

## Verification and changes

Run `npm run test:mission-project-state`, `npm run test:state-domain-boundary`,
`npm run test:mission-budget` and `npm run test:research`. Update this contract,
callers and compatibility tests when shapes/defaults change.
