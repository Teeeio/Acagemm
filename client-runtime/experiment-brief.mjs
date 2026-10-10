// The attempt brief's vocabulary, as a leaf contract.
//
// Producer (`operator-test-evidence.mjs`) and consumer (`candidate-generation/admission.mjs`)
// must not be able to disagree about what "this attempt produced no observation about
// the candidate" means: the producer writes it onto the failed round, and the consumer
// reads it to decide whether re-testing an identical artifact is the same experiment or
// a second attempt to buy a hardware measurement slot. Shipping the string literal in
// both places would let the two drift apart silently, so it lives here — with no
// imports of its own, since admission is a pure module and must stay one.
export const EXPERIMENT_BRIEF_SCHEMA_VERSION = 'operator-studio.experiment-brief/v1';

// The two outcomes the routing distinguishes. A third value would be a third policy,
// and there is no third policy: either the observation says something about the
// candidate (fix the failing case) or it does not (retest the same artifact once the
// environment is back).
export const NEXT_ACTION_RETEST_SAME_CANDIDATE = 'retest_same_candidate';
export const NEXT_ACTION_FIX_FAILED_CASE = 'fix_failed_case';

// A brief says "no observation" only when it says the attempt should be retried. An
// absent brief (a record from before briefs existed) is NOT evidence of no observation:
// treating it as one would let every legacy round re-open its digest for re-testing.
export const briefProducedNoObservation = (brief) => brief?.nextAction === NEXT_ACTION_RETEST_SAME_CANDIDATE;
