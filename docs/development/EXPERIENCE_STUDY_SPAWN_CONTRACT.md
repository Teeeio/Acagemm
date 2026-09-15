# Study default child startup correction (2026-09-15)

Authority: EXPERIENCE_STUDY_CONTRACT.md and EXPERIENCE_STUDY_ARTIFACT_CONTRACT.md.
This addendum changes no condition, matrix, budget, stop rule or denominator.

## Observed defect

Live dispatch task task_6ef7969614b947309b9da8010aa68a27, attempt
run_53e7e26de266490ab3168fb9c70b1948, stopped its first slot before the driver
started. The actual default smoke invoker created report/slot-01/logs/slot-01.log,
which also created report/slot-01. The existing smoke CLI then failed its required
exclusive mkdir with EEXIST. The retained slot log proves this. The platform
subsequently rejected the out-of-scope report log. No candidate/model/GPU result
was produced. Keep the failed nine-slot plan and its eight unstarted slots.

## Sole implementation route

In scripts/run-experience-condition-study.mjs, the actual default invoker must
write slot-NN.log under its artifactDir/logs, exactly matching the retained slot
logPath and the already documented layout. It must never create reportDir before
the smoke child starts. Do not widen report output permissions to hide this bug.

Export the existing createDefaultInvokeSmoke factory as a documented programmatic
process adapter: createDefaultInvokeSmoke({cwd, script}) returns the existing
async invocation port receiving index, condition, artifactDir, reportDir, snapshot,
gpuPython. Production uses the same existing fixed smoke script. The CLI gains no
mock flag, alternate script option, environment override or new scheduler.
Keep argv, shell:false, environment propagation, stream capture and exit semantics.

## Independent regression

The independent test author owns tests/experience-condition-study-test.mjs and
tests/README.md; the implementation author owns only the runner .mjs/.md pair.
Add cases to the already registered study test entry (no shared registration edit).
Use the real exported default adapter and a temporary inert Node child script:

1. Child checks its report directory does not exist, creates it exclusively,
   validates fixed smoke/affine argv and the condition/snapshot environment,
   and emits distinct stdout/stderr markers. Parent proves both exact markers
   in artifactDir/logs/slot-NN.log and no reportDir/logs created by the parent.
2. Child emits a success-looking marker and exits nonzero; parent preserves the
   real exit code and complete raw log. No synthetic receipt overrides it.
3. Pre-existing report directory remains non-overwritable; child exclusive mkdir
   fails nonzero and a pre-existing sentinel retains its exact bytes.

Fixtures run real local Node child processes, with no provider, Python, network,
Acagemm runtime or GPU. Do not replace the default invoker with a mock or match
implementation text. All current study cases stay mandatory. Authors run syntax
only before composition; upstream combines exact candidates and runs the study
suite plus required project checks. A passing stub-child regression is startup
plumbing evidence, not live hardware evidence.

After integration and source freeze, a separately identified fresh nine-slot
study may be run. It cannot erase or refill the failed old plan, and neither
plan is N20. Existing user GPU/DeepSeek authorization remains the applicable scope.
