# Experiment Memory Contract

`experiment-memory.mjs` owns pure experiment/memory binding and descriptive audit
projection. It performs no storage, Provider, queue or Gate effects.

## Modes and creation

`resolveExperimentMemoryMode(mode, condition)` admits exactly:

| Mode | Actual optional retrieval | Storage scope |
| --- | --- | --- |
| `fixed-start-learning` | `local-only` | One Mission per independently initialized store; learning within its rounds |
| `facts-only-control` | `facts-only` | The same isolation, collection retained, optional injection disabled |
| `continuous-chain` | `local-only` | Explicit separate chain, same owning Project, ordered Mission members |

`bindMissionExperiment({state,mission,isolation,repository})` consumes trusted
startup admission and a validated current repository read. The Missions service
calls this injected port after domain validation and before workspace/persistence
effects. A first Mission must observe the pinned initial revision and record
count. Independent modes refuse a second Mission in the store. Chain members
retain current learning but receive new Mission/workspace/round state; they do
not inherit another Mission's best candidate or baseline evidence.

The server attaches `experiment.memory` with the initial snapshot, source,
configuration and manifest digests, initial/current store observations, actual
condition, storage experiment, Mission/Project identity and chain membership.
Client labels cannot supply this object or override the admitted condition or
manifest. Chain learning never changes historical project authorization.

`assertMissionExperiment({mission,isolation})` refuses generation when the Mission
does not match the admitted storage scope, or a controlled Mission is opened in
an ordinary Runtime. Legacy ordinary Missions remain usable. An explicit new
attempt in independent evaluation needs its own new experiment and Mission;
creating an unbound child inside the old store does not authorize generation.

All binding conflicts throw `EXPERIMENT_MEMORY_CONFLICT` (409).

## Prepared use and reporting

`buildExperimentMemoryUse({mission,roundId,context,selection,prompt,roundFacts,
priorRoundRequired})` checks the actual round context, repository revision,
selected record IDs/versions/sources and condition. It verifies that the exact
formatted experience block and required round facts occur in the actual prompt.
Facts-only never removes mandatory prior-round feedback. Conflicts fail before
the Provider start port. Ordinary unbound Missions return null.

The managed Agent Runtime writes this binding, query, selected records and
digests into the existing prompt audit before dispatch. The compact audit is
carried by Agent state, round archives and committed trace without rereading a
mutable experience store during reporting.

`summarizeExperimentMemory({experiment,generations})` classifies recorded runs as
`prepared_audit_consistent`, `not_recorded`, or `conflict`; the iteration report
exports these records and displays separate counts. Missing historical audits
remain unknown. `independentMemoryScope` describes the admitted storage policy,
not proof of independent timing or fair overall comparisons. Continuous chains
have a separate `chainId` and must not count toward independent repetitions.

Prepared audit consistency proves neither live Provider receipt nor use, learning
benefit or full experimental comparability. Model observations, real test results,
batch limits and frozen task/version identity require separate live evidence.

Verification: `test:experiment-memory` uses real file-backed retrieval, round
preparation, Agent Runtime, trace projection and report reconstruction, with a
Provider fixture. `test:experiment-storage` drives actual Mission HTTP creation
and restart for independent and continuous modes. Neither is GPU/model evidence.
