# Pending test progress

`createPendingTestProgressService({missionState,benchmarkProjection,executeCommand,
journal,registry,persistState}).advance({state})` continues previously submitted
frozen candidates in the production advancement pipeline. Baseline completion
admits a candidate command through the same registry/journal; no new queue exists.
Budget/release admission failure records a blocked submission. Errors after command
preparation propagate to journal recovery rather than being treated as absent work.

Inactive Missions use `createMissionRuntimeView` / `mergeMissionRuntimeView` from
the Mission domain. Projection and command persistence preserve visible selection,
other Mission slots, global journal sequence and trace outbox. All operations run
under the existing writer scope, with no nested repository lock. Queries never call
this service. Queue dispatch is nonblocking; already committed inactive test tasks
remain dispatchable. No Agent, repository adoption or generation is started.

Before preparing the candidate command, the service commits the projected baseline
and reopens the owning view at that committed version. A crash during submission
therefore cannot discard the evidence that admitted the candidate. The frozen
Benchmark command opts into Mission-scoped journal recovery. Tests cover loss
before/after queue submission and failure saving candidate state, preserving the
visible Mission, baseline identity, original deadline and exactly one queue task.
