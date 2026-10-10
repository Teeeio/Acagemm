# Iteration Evaluation Contract

`buildIterationEvaluation({missionId, records, source})` is a pure, deterministic
projection of the committed latest-fact trace view. Identical record replays count
once; conflicting versions and foreign identities fail `EVALUATION_RECORD_INVALID`.
It does not query a Provider, mutate state, re-run a Gate, or grant publication.
`renderIterationEvaluationMarkdown(report)` renders a compact human-readable view.

The report separates:

- Experiment memory: admitted mode, fixed initial identities and separately
  identified continuous chains; actual prepared selections and required feedback
  bindings per generation. Missing audits are unknown, conflicting bindings are
  explicit. Prepared consistency is not proof of Provider use or benefit. See
  [experiment-memory.md](experiment-memory.md).

- Reliability: test lifecycle counts (including failed, cancelled and unfinished),
  observed generation failures, unconfirmed release, budget events, actual human
  feedback/resolutions and requests for help. Unknown failure class stays
  `unclassified`; the report does not blame candidate code for infrastructure.
  Generation timeouts count as failed executions even when workflow readiness was
  completed for candidate salvage. Retry metadata remains visible without making
  a subsequently successful response fail.
- Efficiency: **observed** canonical Gate progress/adoption eligibility versus
  resolved outcomes; preparation/generation/queue/dispatch/test times with known
  and unknown counts; per-run exact Token coverage. Unknown usage and cost remain
  null, including old zero placeholders marked unavailable. Overlapping stage
  sums never become end-to-end elapsed time.
- Candidate performance: every candidate test, its bound decision and per-profile
  measurements/dispersion. Speedup uses the submission-frozen comparison baseline,
  never whichever baseline is current when reporting. Terminal execution, matching
  package receipts and comparison conditions, canonical candidate qualification,
  complete correctness coverage, unique profiles, explicit equal metric/unit,
  positive numbers and no explicit unsettled reading are required. Otherwise
  speedup is null with reasons; raw observations remain available. Supported
  latency/time metrics use baseline/candidate; explicitly known throughput metrics
  use candidate/baseline. The report adds no Gate verdict or publication authority.

Correctness oracle source, first observed generation workspace and measured
baseline runs have different fields. A `naive_v0` label does not prove the exact
initial implementation was measured or that a baseline is competitive. Missing
roles stay unassigned. A task manifest can supply the missing experimental
evidence in the later harness stage; this module must not infer it from a name.

`source` carries committed head, snapshot version/time, coverage, record count and
canonical record digest. Export includes raw facts and Markdown. The same raw facts
and source reconstruct the exact report; no current clock enters calculation.
Available-snapshot-only legacy coverage stays explicit. Counts concern observed
records, not missing historical executions. Sample dispersion is not independent
repeat dispersion; no p95/stddev or missing repeated-run data is synthesized.

Application integration is through `iteration-trace-service.mjs#evaluate`; HTTP
uses `/api/missions/:id/evaluation` and `/evaluation/export`. TUI's I history
panel consumes the canonical export and preserves its full snapshot on export.
The older `tools/candidate-generation-eval/report.mjs` remains a separate
single-run development report; production does not import developer tools.

Verification: `test:iteration-evaluation`, `test:iteration-trace`,
`test:runtime-read-isolation`, `test:state-domain-boundary` and the release gate.
Fixtures are not hardware or model evidence.
