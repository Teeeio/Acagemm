# Generation Origin and Stage Timing Contract

When a Mission has `targetProfile`, generation conditions include its normalized
versioned contents. Replay cannot silently change that declared architecture.
Missions without a profile retain their original conditions shape and digest.

Origins also freeze the Mission's nullable `attemptOrigin`: explicit new attempts
retain parent Mission/experiment/candidate/task and immutable manifest identity.
Replay rejects changes to that lineage; legacy absent and null values agree.

Pure metadata functions; no filesystem, Provider, queue, workflow or scoring effects.

`createExperimentIdentity(input?)` validates creation-only Mission metadata:
`id,batchId,taskId,condition` are bounded opaque identifiers; `replicate` is a
positive safe integer; `manifestDigest` is an optional SHA-256 reference. Omitted
input allocates an experiment UUID. Unknown fields or invalid values return
`INVALID_EXPERIMENT_IDENTITY` (400) before Mission mutation. New Missions retain
the identity through selection/restart. Older Missions are not retrospectively
assigned an experiment. Metadata describes an experiment; it does not enforce its
manifest or grant memory/hardware access. H16 owns manifest admission.

`captureGenerationOrigin({state,mission,checkpoint?,goal,capturedAt})` freezes
Mission/Project/experiment/round, generation goal and semantic/test/language
conditions with their canonical digest, plus the exact pre-generation checkpoint.
The parent is `bound_current_best` only when a checkpoint explicitly belongs to
this Mission and its digest equals the current-best candidate digest. Otherwise
it is `workspace_unattributed` or `not_observed`, with null parent fields. The
checkpoint is a code identity, not test evidence. A foreign Mission checkpoint
fails with `GENERATION_ORIGIN_CONFLICT` (409).

`freezeGenerationOrigin(previous, observed)` reuses an explicitly supplied origin.
Mission/Project/round/experiment, conditions or start-workspace
digest drift fails before a Provider effect. A later current best or timestamp
cannot rewrite ancestry. Manual start records experience intent before checkpoint
effects, observes origin before Provider start, then persists it in the prepared
payload before applying state. Input intent cannot be amended after checkpoint
effects. A crash before the prepared payload preserves the journal's unknown-effect
blocker; prepared replay restores origin without another launch. Automatic start captures at the same checkpoint boundary
and preserves it even when the Provider returns a different state object.

`elapsedObservation(start,end)` returns timestamps, nullable `durationMs`, and
`observed`, `not_observed` or `clock_conflict`. No zero or observer-clock fallback
is fabricated. `generationTimings(agent)` reports preparation and generation;
`testTimings(benchmark)` reports queue wait, dispatch and backend test execution.
The queue retains its submission times separately from backend-observed
`executionStartedAt`. Managed Agent terminal projection records the backend's
actual `completedAt` as `generationCompletedAt` only after resource release.
Missing old/provider timestamps remain unknown. Test time may include compilation;
it is not kernel latency. These records do not sum overlapping work or calculate
performance scores. Evaluation owns those interpretations.

Origins/timings enter Agent and archived-round records; event history preserves
the original qualification of failures and results. `iteration-trace` uses the
same pure functions. No fixed shapes, budgets or acceptance rules change.

Verify `test:generation-origin`, `test:agent-start-context`,
`test:agent-round-service`, `test:round-feedback-integration`,
`test:operator-test-queue`, `test:agent-runtime-candidate-admission`, and
`test:iteration-trace`. Effects in these tests are injected doubles or isolated
local files, not live model/GPU optimization evidence.
