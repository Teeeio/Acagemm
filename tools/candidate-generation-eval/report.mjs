// Pure reporting for the 03 candidate-generation development harness.
// This module deliberately has no queue, gate, persistence, or production-state
// dependencies. It only normalizes an observed run into machine/readable data.

const finite = (value) => {
  if (value == null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
};

const firstFinite = (...values) => {
  for (const value of values) {
    const n = finite(value);
    if (n != null) return n;
  }
  return null;
};

const clone = (value) => value == null ? value : structuredClone(value);
const text = (value, fallback = '—') => value == null || value === '' ? fallback : String(value);
const bool = (value) => value === true ? true : value === false ? false : null;
const failedTaskStatuses = new Set(['failed', 'cancelled', 'canceled', 'timed_out', 'quarantined', 'error']);
const taskCanProvidePerformance = (task) => !failedTaskStatuses.has(String(task?.status || '').toLowerCase());
const comparableLabel = (value) => value == null ? null : String(value).trim().toLowerCase();

const duration = (value) => {
  const n = finite(value);
  return n == null || n < 0 ? null : n;
};
const timestampDiff = (start, end) => {
  if (!start || !end) return null;
  const a = Date.parse(start); const b = Date.parse(end);
  return Number.isFinite(a) && Number.isFinite(b) && b >= a ? b - a : null;
};

/** Normalize timing without silently turning an absent measurement into zero. */
export const normalizeGenerationTiming = (raw = {}) => {
  const source = raw && typeof raw === 'object' ? raw : {};
  const queueWaitMs = duration(firstFinite(
    source.queueWaitMs, source.queueMs, source.queue?.waitMs, source.queue?.durationMs,
    source.queue?.wait, source.waitMs, timestampDiff(source.submittedAt, source.startedAt),
    timestampDiff(source.queue?.submittedAt, source.queue?.startedAt), timestampDiff(source.queue?.queuedAt, source.queue?.startedAt),
  ));
  const executionMs = duration(firstFinite(
    source.executionMs, source.runMs, source.providerMs, source.runtimeMs,
    source.run?.durationMs, source.execution?.durationMs, source.provider?.durationMs,
    timestampDiff(source.execution?.startedAt, source.execution?.completedAt), timestampDiff(source.provider?.startedAt, source.provider?.completedAt),
  ));
  let wallClockMs = duration(firstFinite(source.wallClockMs, source.generationMs, source.durationMs));
  if (wallClockMs == null && source.startedAt && (source.completedAt || source.finishedAt || source.endedAt)) {
    const started = Date.parse(source.startedAt);
    const completed = Date.parse(source.completedAt || source.finishedAt || source.endedAt);
    if (Number.isFinite(started) && Number.isFinite(completed) && completed >= started) wallClockMs = completed - started;
  }
  if (wallClockMs == null && queueWaitMs != null && executionMs != null) wallClockMs = queueWaitMs + executionMs;
  const unattributedMs = wallClockMs != null && queueWaitMs != null && executionMs != null
    ? Math.max(0, wallClockMs - queueWaitMs - executionMs) : null;
  return { wallClockMs, queueWaitMs, executionMs, unattributedMs };
};

const tokenValue = (usage, ...keys) => firstFinite(...keys.map((key) => usage?.[key]));

/**
 * Preserve token uncertainty. `null` means the provider did not report that
 * field; it is never rendered as a zero-cost run.
 */
export const normalizeTokenUsage = (raw = null) => {
  const usage = raw?.tokenUsage || raw?.usage || raw || {};
  const inputTokens = tokenValue(usage, 'inputTokens', 'input_tokens', 'input');
  const outputTokens = tokenValue(usage, 'outputTokens', 'output_tokens', 'output');
  const reasoningTokens = tokenValue(usage, 'reasoningTokens', 'reasoning_tokens', 'reasoning');
  const cacheReadTokens = tokenValue(usage, 'cacheReadTokens', 'cache_read_input_tokens', 'cachedInputTokens');
  const cacheWriteTokens = tokenValue(usage, 'cacheWriteTokens', 'cache_creation_input_tokens', 'cache_write_input_tokens');
  const totalTokens = tokenValue(usage, 'totalTokens', 'total_tokens', 'total');
  const providerReportedTotal = tokenValue(usage, 'providerReportedTotal', 'provider_reported_total');
  let completeness = ['exact', 'inconsistent', 'unavailable'].includes(usage.completeness) ? usage.completeness : null;
  if (!completeness) {
    const comparableTotal = providerReportedTotal ?? totalTokens;
    completeness = inputTokens != null && outputTokens != null && comparableTotal != null
      ? (comparableTotal === inputTokens + outputTokens ? 'exact' : 'inconsistent')
      : 'unavailable';
  }
  return {
    inputTokens, outputTokens, reasoningTokens, cacheReadTokens, cacheWriteTokens,
    totalTokens, providerReportedTotal, completeness,
    provider: usage.provider || null,
  };
};

const resultOf = (task) => task?.result || task?.outcome || task || {};

export const normalizeCorrectness = (task = null) => {
  const result = resultOf(task);
  let source = result.correctness || task?.correctness || null;
  if (!source && Array.isArray(result.benchmark)) {
    const profileCorrectness = result.benchmark.map((entry) => entry?.correctness).filter((entry) => entry && typeof entry === 'object');
    if (profileCorrectness.length && profileCorrectness.every((entry) => typeof entry.passed === 'boolean')) {
      const passedCases = profileCorrectness.reduce((sum, entry) => sum + (Number(entry.passedCases ?? (entry.passed ? entry.total : 0)) || 0), 0);
      const total = profileCorrectness.reduce((sum, entry) => sum + (Number(entry.total) || 0), 0) || null;
      const passed = profileCorrectness.every((entry) => entry.passed === true);
      source = { passed, total, passedCases, failedCases: total == null ? null : total - passedCases };
    }
  }
  if (!source || typeof source !== 'object') return { passed: null, total: null, passedCases: null, failedCases: null, status: 'unavailable', failure: null };
  const passed = bool(source.passed);
  const total = firstFinite(source.total, source.requestedCases, source.expectedCases);
  const passedCases = firstFinite(source.passedCases, source.executedCases != null && passed === true ? source.executedCases : null);
  const failedCases = firstFinite(source.failedCases, source.failedCase ? 1 : null, passed === false && total != null && passedCases != null ? total - passedCases : null);
  return {
    passed, total, passedCases, failedCases,
    status: passed === true ? 'passed' : passed === false ? 'failed' : (source.status || 'unknown'),
    failure: clone(source.failure || source.error || null),
  };
};

const benchmarkEntries = (task) => {
  const result = resultOf(task);
  let raw = Array.isArray(result.benchmark) ? result.benchmark : result.benchmark && typeof result.benchmark === 'object' ? [result.benchmark] : [];
  // Accept a profile map as a convenience for standalone development reports.
  if (raw.length === 1 && !raw[0].profile && !raw[0].name && !('value' in raw[0]) && !('p50Us' in raw[0])) {
    raw = Object.entries(result.benchmark).map(([profile, value]) => ({ profile, ...(value && typeof value === 'object' ? value : { value }) }));
  }
  return raw.map((entry, index) => {
    const profile = entry.profile ?? entry.group ?? entry.name ?? `profile-${index + 1}`;
    const value = firstFinite(entry.value, entry.p50Us, entry.latencyP50Us, entry.throughput, entry.p50, entry.metrics?.p50Us, entry.metrics?.latencyP50Us, entry.measurement?.value);
    return { profile: String(profile), value, unit: entry.unit || (entry.p50Us != null ? 'us' : null), metric: entry.metric || null, samples: firstFinite(entry.samples, entry.repeats), correctness: normalizeCorrectness({ result: { correctness: entry.correctness } }) };
  });
};

const speedupFor = (baseline, candidate, metric) => {
  if (baseline == null || candidate == null || candidate <= 0 || baseline <= 0) return null;
  const name = String(metric || '').toLowerCase();
  return /throughput|bandwidth|flops|tops|items.?per.?second/.test(name) ? candidate / baseline : baseline / candidate;
};

/** Build the complete JSON report. No input object is mutated. */
export const buildCandidateGenerationEvaluation = ({
  generationTiming = {}, generationUsage = null, usage = null, candidateValidation = null,
  generation = null, baselineTask = null, candidateTask = null, config = {},
} = {}) => {
  const timing = normalizeGenerationTiming(Object.keys(generationTiming || {}).length ? generationTiming : generation?.timing || {});
  const tokens = normalizeTokenUsage(generationUsage ?? usage ?? generation?.usage);
  const validation = candidateValidation && typeof candidateValidation === 'object' ? {
    passed: bool(candidateValidation.passed), code: candidateValidation.code || null,
    digest: candidateValidation.digest || null, files: Array.isArray(candidateValidation.files) ? [...candidateValidation.files] : null,
  } : { passed: null, code: null, digest: null, files: null };
  const baselineCorrectness = normalizeCorrectness(baselineTask);
  const candidateCorrectness = normalizeCorrectness(candidateTask);
  const metric = config.metric || config.benchmarkMetric || config.objectiveMetric || null;
  const baseline = benchmarkEntries(baselineTask);
  const candidate = benchmarkEntries(candidateTask);
  const baselineByProfile = new Map(baseline.map((entry) => [entry.profile, entry]));
  const candidateByProfile = new Map(candidate.map((entry) => [entry.profile, entry]));
  const profiles = [...new Set([...baseline.map((entry) => entry.profile), ...candidate.map((entry) => entry.profile)])].map((profile) => {
    const b = baselineByProfile.get(profile); const c = candidateByProfile.get(profile);
    const profileMetric = metric || c?.metric || b?.metric || 'latency_p50';
    const profileCorrectnessPassed = b?.correctness?.passed !== false && c?.correctness?.passed !== false;
    const correctnessPassed = baselineCorrectness.passed === true && candidateCorrectness.passed === true
      && profileCorrectnessPassed && taskCanProvidePerformance(baselineTask) && taskCanProvidePerformance(candidateTask)
      && comparableLabel(b?.unit) === comparableLabel(c?.unit)
      && comparableLabel(b?.metric || profileMetric) === comparableLabel(c?.metric || profileMetric);
    const measurementPositive = b?.value != null && c?.value != null && b.value > 0 && c.value > 0;
    let invalidReason = null;
    if (!taskCanProvidePerformance(baselineTask) || !taskCanProvidePerformance(candidateTask)) invalidReason = 'task_failed';
    else if (b?.correctness?.passed === false || c?.correctness?.passed === false) invalidReason = 'correctness_failed';
    else if (b?.value == null || c?.value == null) invalidReason = 'measurement_unavailable';
    else if (!measurementPositive) invalidReason = 'measurement_non_positive';
    else if (comparableLabel(b?.unit) !== comparableLabel(c?.unit)) invalidReason = 'unit_mismatch';
    else if (comparableLabel(b?.metric || profileMetric) !== comparableLabel(c?.metric || profileMetric)) invalidReason = 'metric_mismatch';
    return { profile, metric: profileMetric, baselineValue: b?.value ?? null, candidateValue: c?.value ?? null, unit: c?.unit || b?.unit || null, speedup: correctnessPassed && measurementPositive ? speedupFor(b?.value, c?.value, profileMetric) : null, performanceValid: correctnessPassed && measurementPositive, invalidReason };
  });
  const correctness = { baseline: baselineCorrectness, candidate: candidateCorrectness, passed: candidateCorrectness.passed === true && baselineCorrectness.passed === true };
  const performanceValid = validation.passed === true && profiles.length > 0 && correctness.passed && profiles.every((profile) => profile.performanceValid);
  const summary = {
    schemaVersion: 'operator-studio.candidate-generation-evaluation/v1',
    generatedAt: new Date().toISOString(), config: clone(config), generation: timing, tokenUsage: tokens,
    candidateValidation: validation, correctness,
    benchmark: { metric: metric || profiles[0]?.metric || null, profiles, performanceValid },
    outcome: validation.passed === false ? 'candidate_invalid' : performanceValid ? 'evaluated' : 'incomplete',
  };
  return { summary, markdown: renderCandidateGenerationEvaluationMarkdown(summary) };
};

const formatMs = (value) => value == null ? '—' : `${Number(value.toFixed(2))} ms`;
const formatToken = (value) => value == null ? '—' : Math.round(value).toLocaleString('en-US');
const formatNumber = (value) => value == null ? '—' : Number(value.toFixed(4)).toString();
const cell = (value) => text(value).replaceAll('|', '\\|');

export const renderCandidateGenerationEvaluationMarkdown = (summary = {}) => {
  const generation = summary.generation || {}; const tokens = summary.tokenUsage || {};
  const correctness = summary.correctness || {}; const benchmark = summary.benchmark || {};
  const lines = [
    '# Candidate Generation Evaluation', '',
    `- Outcome: **${text(summary.outcome, 'unknown')}**`,
    `- Candidate validation: **${correctnessStatus(summary.candidateValidation?.passed)}**${summary.candidateValidation?.code ? ` (${summary.candidateValidation.code})` : ''}`,
    '', '## Generation', '',
    '| Wall clock | Queue wait | Provider/runtime | Unattributed |', '|---:|---:|---:|---:|',
    `| ${formatMs(generation.wallClockMs)} | ${formatMs(generation.queueWaitMs)} | ${formatMs(generation.executionMs)} | ${formatMs(generation.unattributedMs)} |`,
    '', '## Token usage', '',
    `Completeness: **${text(tokens.completeness, 'unavailable')}**`, '',
    '| Input | Output | Reasoning | Total |', '|---:|---:|---:|---:|',
    `| ${formatToken(tokens.inputTokens)} | ${formatToken(tokens.outputTokens)} | ${formatToken(tokens.reasoningTokens)} | ${formatToken(tokens.totalTokens)} |`,
    '', '## Correctness and benchmark', '',
    `- Baseline correctness: **${correctnessStatus(correctness.baseline?.passed)}**; candidate correctness: **${correctnessStatus(correctness.candidate?.passed)}**`,
    '', '| Profile | Baseline | Candidate | Speedup | Performance valid |', '|---|---:|---:|---:|---|',
    ...(Array.isArray(benchmark.profiles) && benchmark.profiles.length ? benchmark.profiles.map((p) => `| ${cell(p.profile)} | ${cell(p.baselineValue)} | ${cell(p.candidateValue)} | ${p.speedup == null ? '—' : `${formatNumber(p.speedup)}x`} | ${p.performanceValid ? 'yes' : 'no'} |`) : ['| — | — | — | — | no |']),
    '', 'Speedup is baseline/candidate for latency-like metrics and candidate/baseline for throughput-like metrics. A correctness failure or missing measurement invalidates speedup.', '',
  ];
  return lines.join('\n');
};

const correctnessStatus = (value) => value === true ? 'passed' : value === false ? 'failed' : 'unknown';

export const evaluateCandidateGeneration = buildCandidateGenerationEvaluation;
export const createCandidateGenerationEvaluationReport = buildCandidateGenerationEvaluation;
