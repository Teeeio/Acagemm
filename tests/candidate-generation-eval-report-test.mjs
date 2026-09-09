import assert from 'node:assert/strict';
import {
  buildCandidateGenerationEvaluation,
  evaluateCandidateGeneration,
  normalizeGenerationTiming,
  normalizeTokenUsage,
} from '../tools/candidate-generation-eval/report.mjs';

const task = (correctness, benchmark) => ({
  status: 'completed',
  result: { correctness, benchmark },
});

const baseline = task({ passed: true, total: 4, passedCases: 4 }, [
  { profile: 'primary', value: 100, unit: 'us', metric: 'latency_p50' },
  { profile: 'small', p50Us: 50, unit: 'us', metric: 'latency_p50' },
]);
const candidate = task({ passed: true, total: 4, passedCases: 4 }, [
  { profile: 'primary', p50Us: 80, unit: 'us' },
  { profile: 'small', value: 60, unit: 'us' },
]);

assert.deepEqual(normalizeGenerationTiming({ wallClockMs: 123, queue: { waitMs: 20 }, run: { durationMs: 90 } }), {
  wallClockMs: 123, queueWaitMs: 20, executionMs: 90, unattributedMs: 13,
});
assert.deepEqual(normalizeGenerationTiming({ startedAt: '2026-01-01T00:00:00.000Z', completedAt: '2026-01-01T00:00:01.250Z' }).wallClockMs, 1250);
assert.deepEqual(normalizeTokenUsage(null), {
  inputTokens: null, outputTokens: null, reasoningTokens: null, cacheReadTokens: null,
  cacheWriteTokens: null, totalTokens: null, providerReportedTotal: null, completeness: 'unavailable', provider: null,
});
assert.equal(normalizeTokenUsage({ inputTokens: 10, outputTokens: 2, totalTokens: 12 }).completeness, 'exact');
assert.equal(normalizeTokenUsage({ inputTokens: 10, outputTokens: 2, totalTokens: 99 }).completeness, 'inconsistent');

const report = buildCandidateGenerationEvaluation({
  generationTiming: { wallClockMs: 123, queueWaitMs: 20, executionMs: 90 },
  generationUsage: { inputTokens: 10, outputTokens: 2, totalTokens: 12, completeness: 'exact', provider: 'codex' },
  candidateValidation: { passed: true, code: 'CODEX_CANDIDATE_DIFF_VERIFIED', digest: 'sha256:test', files: ['run.py'] },
  baselineTask: baseline, candidateTask: candidate,
  config: { metric: 'latency_p50', operator: 'vector_add' },
});
assert.equal(report.summary.generation.wallClockMs, 123);
assert.equal(report.summary.generation.queueWaitMs, 20);
assert.equal(report.summary.tokenUsage.completeness, 'exact');
assert.equal(report.summary.benchmark.performanceValid, true);
assert.equal(report.summary.benchmark.profiles.find((p) => p.profile === 'primary').speedup, 1.25);
assert.equal(report.summary.benchmark.profiles.find((p) => p.profile === 'small').speedup, 50 / 60);
assert.match(report.markdown, /Queue wait/);
assert.match(report.markdown, /1\.25x/);

const failed = evaluateCandidateGeneration({
  generationTiming: {}, generationUsage: { completeness: 'unavailable' },
  candidateValidation: { passed: true },
  baselineTask: baseline,
  candidateTask: task({ passed: false, total: 4, passedCases: 3, failure: { case: 'edge' } }, [{ profile: 'primary', value: 1 }]),
});
assert.equal(failed.summary.correctness.passed, false);
assert.equal(failed.summary.benchmark.performanceValid, false);
assert.equal(failed.summary.benchmark.profiles[0].speedup, null, 'correctness failure must invalidate performance');
assert.equal(failed.summary.generation.wallClockMs, null);
assert.equal(failed.summary.tokenUsage.totalTokens, null, 'missing tokens must remain null');
assert.match(failed.markdown, /Completeness: \*\*unavailable\*\*/);
assert.match(failed.markdown, /—/);

const throughput = buildCandidateGenerationEvaluation({
  baselineTask: task({ passed: true }, [{ profile: 'primary', value: 10, metric: 'throughput_items_per_second' }]),
  candidateTask: task({ passed: true }, [{ profile: 'primary', value: 20, metric: 'throughput_items_per_second' }]),
});
assert.equal(throughput.summary.benchmark.profiles[0].speedup, 2);

// Admission and task terminal status are hard prerequisites for a performance claim.
const noValidation = buildCandidateGenerationEvaluation({ baselineTask: baseline, candidateTask: candidate });
assert.equal(noValidation.summary.outcome, 'incomplete');
assert.equal(noValidation.summary.benchmark.performanceValid, false);
const failedTask = buildCandidateGenerationEvaluation({
  candidateValidation: { passed: true }, baselineTask: baseline,
  candidateTask: { status: 'failed', result: candidate.result },
});
assert.equal(failedTask.summary.benchmark.performanceValid, false);
assert.equal(failedTask.summary.benchmark.profiles[0].speedup, null);

const mismatched = buildCandidateGenerationEvaluation({
  candidateValidation: { passed: true },
  baselineTask: task({ passed: true }, [{ profile: 'primary', value: 10, unit: 'us', metric: 'latency_p50' }]),
  candidateTask: task({ passed: true }, [{ profile: 'primary', value: 5, unit: 'ms', metric: 'latency_p95' }]),
});
assert.equal(mismatched.summary.benchmark.profiles[0].invalidReason, 'unit_mismatch');
assert.equal(mismatched.summary.benchmark.profiles[0].speedup, null);
const nonPositive = buildCandidateGenerationEvaluation({
  candidateValidation: { passed: true },
  baselineTask: task({ passed: true }, [{ profile: 'primary', value: 0, unit: 'us' }]),
  candidateTask: task({ passed: true }, [{ profile: 'primary', value: 5, unit: 'us' }]),
});
assert.equal(nonPositive.summary.benchmark.profiles[0].invalidReason, 'measurement_non_positive');
const profileFailed = buildCandidateGenerationEvaluation({
  candidateValidation: { passed: true },
  baselineTask: task({ passed: true }, [{ profile: 'primary', value: 10, unit: 'us', correctness: { passed: false } }]),
  candidateTask: task({ passed: true }, [{ profile: 'primary', value: 5, unit: 'us', correctness: { passed: true } }]),
});
assert.equal(profileFailed.summary.benchmark.profiles[0].speedup, null);
assert.equal(profileFailed.summary.benchmark.performanceValid, false);
console.log('[candidate-generation-eval-report] timing, token uncertainty, correctness gating, and profile speedup passed');
