# Phase 2 evidence governance acceptance

Status: Phase 2 hardware-free acceptance PASS (2026-09-12). The upstream ran
`npm.cmd run verify:non-hardware-robustness` on the final integrated tree: release
136 checks and non-hardware 38 checks, exit 0. All 485 recorded source/test files
matched their pre-run hashes afterward. See the [evidence index](evidence/p2-evidence-20260912/README.md)
and [machine verification](evidence/p2-evidence-20260912/verification.json).
This result does not certify a new live driver run, real diagnostic publication,
N=20 stability or Phase 3 Wiki ingestion.
Authority: TEAM_HANDOFF.md sections 6.12 and 14.6, following the completed
P1_FEEDBACK_ACCEPTANCE.md baseline (6a5ae54). This matrix is owned by the upstream
reviewer; implementation tasks must not edit it.

## Frozen scope and dependencies

Diagnostic facts -> diagnostic qualification and versioned Gate decision ->
production projection, adoption and knowledge governance -> shared presentation
and frozen round facts -> independent integration tests and both release gates.
Current documentation and real-run observer/sample-ledger preparation can proceed
in parallel. Wiki ingestion/selection and N=20 are separate subsequent milestones.
Keep the production API/Runtime/serialized Queue path, fixed profiles, independent
oracle, candidate admission, semantic binding and all budgets unchanged.

## Diagnostic contract

`client-runtime/evidence-decision.mjs` is an I/O-free shared domain contract.
Public `evaluateDiagnosticEvidence(kind, evidence, expectedBinding)` accepts
`tracer | profiler` and returns `schemaValid`, `available`, `evidenceEligible`,
`reasons` (stable reason codes). `available` means real collection completed,
not that content meets a rule. Mock/simulated provenance always wins over a
contradictory completed status. Missing status/source never proves availability.

Diagnostic envelopes retain format, status, source, binding and raw artifacts.
Binding uses candidateDigest and benchmark runId (task.payload.requestId), plus
sourceRunId, backend taskId and semanticDigest when those expectations exist.
Do not compare backend taskId to queue taskId; retain the queue remoteTaskId at
projection. Missing expected candidate/run identity cannot qualify real evidence.
Compare candidate digest and both run identities exactly, never stamp a mismatched
observation with current state. Frozen semanticDigest must also match.

The initial content rules require actual kernel measurements: tracer has at least
one named kernel event with finite nonnegative startUs and positive durationUs;
invalid kernel events fail. Profiler has a finite positive kernelDurationUs from
tool collection, not benchmark latency or tool process duration. If occupancy is
provided it must be finite in [0,1]; bandwidth must be finite and nonnegative.
Empty objects, arbitrary keys, string/NaN/Infinity values, tool-only trace events,
and p50/p95 copied from benchmark cannot satisfy these rules. Metric names carry
their documented units; raw artifact paths alone prove no measurement content.

Runner `OPERATOR_DIAGNOSTICS_MODE=unavailable|mock` defaults to unavailable fallback:
configured/installed real tools still execute; explicit mock uses status mocked,
source mock and simulated true. A successful tool process without an actual output
parser may be available but evidence-ineligible. Keep artifacts; do not synthesize
kernel events or populate profiler metrics from benchmark. A binding projection
helper must be hardware-free testable. No actual profiler availability is assumed.

## Single decision contract

`evaluateAcceptGate` returns `decision` alongside its compatible flat fields.
The decision has schemaVersion `operator-studio.evidence-decision/v1`, a fixed
policyVersion, and the following independently inspectable fields:

- binding: missionId, candidateId, candidateDigest, runId, taskId, sourceRunId,
  semanticDigest; unknown observations stay null.
- execution: kind (`live | simulation | cpu | unknown`), liveHardware and source.
  Explicit simulation/CPU signals cannot be overridden by liveHardware=true.
- correctness: { passed }; benchmark: { valid }.
- diagnostics: { tracer, profiler } with the three predicates and reason codes.
- adoption: { status: `allowed | reference | blocked | waiting_external_verification`,
  reasons }; publication: { status: `allowed | blocked | waiting_external_verification`,
  reasons }.

Retain existing correctness, profile, baseline, semantic and performance rules.
Audit every completeEvidence branch: local benchmark-core development permits
optional diagnostics; explicitly non-live simulation/CPU can exercise their
existing workflow with structured mock evidence; full real diagnostic evidence
requires both evidenceEligible predicates. Neither branch can bypass publication
requirements. Invalid benchmark values (including NaN, Infinity and nonpositive
latency) are not valid evidence.

Publication requires passed adoption, real hardware provenance, no explicit
development/shared-host restriction, and both qualified real diagnostics bound to
this candidate/run. Backend publishable=true is not sufficient authorization;
publishable=false is a restriction. Backend names are not new authorization
whitelists. Simulation/CPU/shared-host execution stays nonpublishable even if a
backend flips its boolean. Missing real diagnostic capability is recoverable;
malformed/wrong-binding evidence has explicit blocking reasons.

The pure domain computes decision once; flat Gate fields are projections of it.
Consumers preserve this same decision/version; do not reclassify truth from
publishable or infer publication from liveHardware. Legacy missing decisions are
explicitly unknown/nonpublishable, or recomputed at the domain boundary from the
bound retained result; no fabricated live facts or historical migration.

Production stores the exact decision at `benchmark.evidenceDecision` and keeps
the same value in candidate.acceptGate.decision / decisionReview.gate.decision.
Adoption copies it into currentBest.evidenceDecision; derived drafts/assets use
evidenceDecision too. Round facts' gate adds evidenceDecision when observed,
leaving legacy missing records unchanged. Presentation of the current test reads
benchmark.evidenceDecision, falling back to its matching Gate; presentation of
current best reads currentBest.evidenceDecision. Copies must not drift in meaning.

## Production behavior and acceptance matrix

1. Four groups: unavailable, mocked, valid real content, structurally valid but
   wrong binding. Exercise every completeEvidence branch and final publication.
2. Reject missing/current-other candidate/run/semantic identities, empty content,
   tool-duration events, benchmark-only metrics, malformed metric values, and
   contradictory simulated+completed/live flags. Valid real test doubles are
   contract tests, not actual live publication evidence.
3. Real shared-GPU adoptable result produces development draft/asset (never
   simulation or published), autoPublished=0 and development-only changes.
4. Simulated result remains simulation; qualified unrestricted real result can
   pass the domain policy in controlled tests. Old boolean-only results cannot.
5. Applying the same decision/draft version twice or after JSON restore is a
   governance no-op: assets, versions, timestamps, counters and events unchanged.
   A changed candidate/run or draft content/version must be processed once.
6. Adoption keeps the decision on currentBest and decisionReview; knowledge
   assets, TUI and workflow summary consume it. Archived round facts and next
   prompt preserve its version, execution classification and blocking reasons.
7. Required diagnostics unavailable pauses for external verification without
   removing the candidate or driving new Agent edits. Local development adoption
   may proceed with publication pending; a publication hold alone must not erase
   valid optimization results. Resume/retest uses existing production commands,
   same candidate admission and existing resource-release barrier.
8. Independent tests register in package scripts and BOTH verification checks.
   Nearest tests, release and non-hardware gates must terminate exit 0 on the final
   integrated tree. Interrupted checks are not PASS. Evidence stays project-local.

## Deferred evidence

Formal publication on a real instrumented target and N=20 stability are not
certified by this matrix's hardware-free tests. The updated E2E observer must
first complete a live run before a fixed-config N=20 batch. Full two-round success,
safe budget termination, candidate failure, infrastructure failure and missing
summary are separate outcomes; retain every attempt and never pool old/provider-
mixed runs into a current stability denominator.
