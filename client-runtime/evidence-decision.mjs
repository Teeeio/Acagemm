// I/O-free diagnostic qualification and versioned evidence-decision helpers.
//
// This module is a shared domain contract. It must stay dependency-free: for
// the checked pure-domain graph (tests/state-domain-boundary-test.mjs) it may
// not import storage, providers, application orchestration or Node effect
// builtins. It never mutates its inputs.
//
// Three independent predicates are reported for every diagnostic:
//   schemaValid     - the envelope has the documented format/fields
//   available       - a real collection actually completed (not mock/simulated)
//   evidenceEligible - the bound, real content satisfies the measurement rule
// schemaValid alone proves neither of the other two.

export const EVIDENCE_DECISION_SCHEMA_VERSION = 'operator-studio.evidence-decision/v1';
export const EVIDENCE_DECISION_POLICY_VERSION = 'operator-studio.evidence-policy/2026-09-12';

export const DIAGNOSTIC_KINDS = Object.freeze(['tracer', 'profiler']);

export const DIAGNOSTIC_REASONS = Object.freeze({
  UNKNOWN_KIND: 'diagnostic.kind.unknown',
  SCHEMA_MISSING: 'diagnostic.schema.missing',
  SCHEMA_INVALID: 'diagnostic.schema.invalid',
  STATUS_MISSING: 'diagnostic.status.missing',
  STATUS_NOT_COMPLETED: 'diagnostic.status.not_completed',
  SOURCE_MISSING: 'diagnostic.source.missing',
  SOURCE_INVALID: 'diagnostic.source.invalid',
  SIMULATED: 'diagnostic.simulated',
  BINDING_EXPECTED_MISSING: 'diagnostic.binding.expected_missing',
  BINDING_CANDIDATE_MISSING: 'diagnostic.binding.candidate_missing',
  BINDING_CANDIDATE_MISMATCH: 'diagnostic.binding.candidate_mismatch',
  BINDING_RUN_MISSING: 'diagnostic.binding.run_missing',
  BINDING_RUN_MISMATCH: 'diagnostic.binding.run_mismatch',
  BINDING_SOURCE_RUN_MISMATCH: 'diagnostic.binding.source_run_mismatch',
  BINDING_TASK_MISMATCH: 'diagnostic.binding.task_mismatch',
  BINDING_SEMANTIC_MISSING: 'diagnostic.binding.semantic_missing',
  BINDING_SEMANTIC_MISMATCH: 'diagnostic.binding.semantic_mismatch',
  BINDING_CONFLICT: 'diagnostic.binding.conflict',
  TRACER_NO_EVENT: 'diagnostic.tracer.no_kernel_event',
  TRACER_NO_MEASUREMENT: 'diagnostic.tracer.no_kernel_measurement',
  TRACER_INVALID_EVENT: 'diagnostic.tracer.invalid_kernel_event',
  PROFILER_DURATION_INVALID: 'diagnostic.profiler.kernel_duration_invalid',
  PROFILER_DURATION_MISSING: 'diagnostic.profiler.kernel_duration_missing',
  PROFILER_BENCHMARK_VALUE: 'diagnostic.profiler.benchmark_value_misuse',
  METRIC_OCCUPANCY_INVALID: 'diagnostic.metric.occupancy_invalid',
  METRIC_BANDWIDTH_INVALID: 'diagnostic.metric.bandwidth_invalid',
});

export const DECISION_REASONS = Object.freeze({
  CORRECTNESS_FAILED: 'adoption.correctness_failed',
  PROFILES_INCOMPLETE: 'adoption.profiles_incomplete',
  BENCHMARK_INVALID: 'adoption.benchmark_invalid',
  EVIDENCE_INCOMPLETE: 'adoption.evidence_incomplete',
  BASELINE_UNAVAILABLE: 'adoption.baseline_unavailable',
  SEMANTIC_BINDING_FAILED: 'adoption.semantic_binding_failed',
  BINDING_CONFLICT: 'adoption.binding_conflict',
  PERFORMANCE_NOT_MET: 'adoption.performance_not_met',
  DIAGNOSTICS_UNAVAILABLE: 'adoption.diagnostics_unavailable',
  DIAGNOSTICS_INELIGIBLE: 'adoption.diagnostics_ineligible',
  ADOPTION_NOT_ALLOWED: 'publication.adoption_not_allowed',
  EXECUTION_NOT_LIVE: 'publication.execution_not_live',
  RESTRICTED_ENVIRONMENT: 'publication.restricted_environment',
  PUBLICATION_DIAGNOSTICS_UNAVAILABLE: 'publication.diagnostics_unavailable',
  PUBLICATION_DIAGNOSTICS_INELIGIBLE: 'publication.diagnostics_ineligible',
});

// A recoverable reason means the real diagnostic capability is missing or
// unfinished, so external verification can still supply it. A blocking reason
// means the evidence itself is malformed, fabricated or bound to the wrong
// observation; collecting more of the same cannot repair it.
export const RECOVERABLE_DIAGNOSTIC_REASONS = Object.freeze([
  DIAGNOSTIC_REASONS.SCHEMA_MISSING,
  DIAGNOSTIC_REASONS.STATUS_MISSING,
  DIAGNOSTIC_REASONS.STATUS_NOT_COMPLETED,
  DIAGNOSTIC_REASONS.SOURCE_MISSING,
  DIAGNOSTIC_REASONS.SIMULATED,
  DIAGNOSTIC_REASONS.BINDING_EXPECTED_MISSING,
  DIAGNOSTIC_REASONS.TRACER_NO_EVENT,
  DIAGNOSTIC_REASONS.TRACER_NO_MEASUREMENT,
  DIAGNOSTIC_REASONS.PROFILER_DURATION_MISSING,
]);

export const BLOCKING_DIAGNOSTIC_REASONS = Object.freeze([
  DIAGNOSTIC_REASONS.UNKNOWN_KIND,
  DIAGNOSTIC_REASONS.SCHEMA_INVALID,
  DIAGNOSTIC_REASONS.SOURCE_INVALID,
  DIAGNOSTIC_REASONS.PROFILER_DURATION_INVALID,
  DIAGNOSTIC_REASONS.BINDING_CANDIDATE_MISSING,
  DIAGNOSTIC_REASONS.BINDING_CANDIDATE_MISMATCH,
  DIAGNOSTIC_REASONS.BINDING_RUN_MISSING,
  DIAGNOSTIC_REASONS.BINDING_RUN_MISMATCH,
  DIAGNOSTIC_REASONS.BINDING_SOURCE_RUN_MISMATCH,
  DIAGNOSTIC_REASONS.BINDING_TASK_MISMATCH,
  DIAGNOSTIC_REASONS.BINDING_SEMANTIC_MISSING,
  DIAGNOSTIC_REASONS.BINDING_SEMANTIC_MISMATCH,
  DIAGNOSTIC_REASONS.BINDING_CONFLICT,
  DIAGNOSTIC_REASONS.TRACER_INVALID_EVENT,
  DIAGNOSTIC_REASONS.PROFILER_BENCHMARK_VALUE,
  DIAGNOSTIC_REASONS.METRIC_OCCUPANCY_INVALID,
  DIAGNOSTIC_REASONS.METRIC_BANDWIDTH_INVALID,
]);

// Only an explicit `completed` status proves a real collection finished. Names
// such as `ok`, `success` or `succeeded` are not real completion markers.
const COMPLETED_STATUSES = new Set(['completed']);
const NON_REAL_STATUSES = new Set(['mock', 'mocked', 'simulation', 'simulated', 'fixture', 'stub', 'scripted', 'synthetic']);
// Substrings that mark non-real provenance. A backend/service name is not a
// publication whitelist; these are provenance signals only.
const NON_REAL_SOURCE_PATTERNS = Object.freeze(['mock', 'simulat', 'fixture', 'scripted', 'synthetic', 'stub', 'fake']);
// A source that is explicitly unknown/unavailable never proves a real
// collection; it may not be backfilled from `tool` or artifact paths.
const UNKNOWN_SOURCE_TOKENS = new Set(['unknown', 'unavailable', 'none', 'null', 'n/a', 'na', 'undefined', 'not_available', 'not-applicable']);
const BENCHMARK_SOURCE_PATTERNS = Object.freeze(['benchmark', 'latency']);

// Declared provenance containers. Explicit simulation metadata inside them is
// honoured whether the container is an object or an array, at any nesting
// depth; an array wrapper may not hide a simulated/mock source.
const PROVENANCE_CONTAINER_KEYS = Object.freeze(['source', 'artifacts', 'metadata', 'provenance', 'metrics', 'metricsSource', 'metricsProvenance']);
// Explicit non-real boolean markers. Only a strict `true` creates a signal.
const NON_REAL_MARKER_KEYS = Object.freeze(['simulated', 'mock', 'synthetic', 'fixture', 'scripted', 'stub', 'fake']);
// Declared provenance-kind fields whose string value may name a source. Raw
// artifact `path`/`name` values are deliberately excluded: a filename that
// merely contains "mock" proves nothing and never flips eligibility.
const PROVENANCE_SIGNAL_KEYS = Object.freeze(['kind', 'type', 'authority', 'source', 'metricsSource', 'provenance', 'tool', 'mode']);
// Bounded recursion: a visited set makes shared/cyclic objects safe and the
// depth cap keeps pathological input from exhausting the stack. Recursion only
// enters declared provenance containers (or nested objects already inside one)
// and never infers a source from arbitrary path/name values.
const MAX_PROVENANCE_DEPTH = 8;

const isPlainObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const hasOwn = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const nonEmpty = (value) => (typeof value === 'string' && value.trim() ? value.trim() : null);
const normalizeToken = (value) => nonEmpty(value)?.toLowerCase() ?? null;
const isNonRealToken = (token) => NON_REAL_SOURCE_PATTERNS.some((pattern) => token.includes(pattern));

const hasExplicitSimulationMarker = (record) => NON_REAL_MARKER_KEYS.some((key) => record[key] === true);

const containsSimulationMetadata = (value, depth = 0, seen = new WeakSet(), insideProvenance = false) => {
  if (!value || typeof value !== 'object') return false;
  if (depth > MAX_PROVENANCE_DEPTH) throw new RangeError('Diagnostic provenance depth exceeded');
  if (seen.has(value)) return false;
  seen.add(value);
  if (Array.isArray(value)) {
    return value.some((item) => containsSimulationMetadata(item, depth + 1, seen, insideProvenance));
  }
  if (!isPlainObject(value)) return false;
  if (hasExplicitSimulationMarker(value)) return true;
  for (const key of Object.keys(value)) {
    if (key === 'path' || key === 'name') continue;
    const child = value[key];
    if (typeof child === 'string') {
      if (PROVENANCE_SIGNAL_KEYS.includes(key) && isNonRealToken(child.trim().toLowerCase())) return true;
      continue;
    }
    if (child && typeof child === 'object' && (insideProvenance || PROVENANCE_CONTAINER_KEYS.includes(key))
      && containsSimulationMetadata(child, depth + 1, seen, true)) {
      return true;
    }
  }
  return false;
};

const pushReason = (reasons, code) => {
  if (!reasons.includes(code)) reasons.push(code);
};

// Explicit provenance only. Top-level `tool` and `artifacts` are deliberately
// excluded: a missing source cannot be backfilled by a tool name or an artifact
// path. An explicit source/metricsSource/provenance record may name its tool.
const collectExplicitSourceTokens = (envelope) => {
  const tokens = [];
  const visited = new WeakSet();
  const add = (value) => {
    if (typeof value === 'string') {
      const token = value.trim().toLowerCase();
      if (token) tokens.push(token);
      return;
    }
    if (isPlainObject(value)) {
      if (visited.has(value)) return;
      visited.add(value);
      for (const key of ['kind', 'type', 'authority', 'name', 'source', 'tool']) add(value[key]);
    }
  };
  add(envelope.source);
  add(envelope.metricsSource);
  add(envelope.provenance);
  return tokens;
};

const collectMetricSourceTokens = (envelope, metrics) => {
  const tokens = [];
  const visited = new WeakSet();
  const add = (value) => {
    if (typeof value === 'string') {
      const token = value.trim().toLowerCase();
      if (token) tokens.push(token);
      return;
    }
    if (isPlainObject(value)) {
      if (visited.has(value)) return;
      visited.add(value);
      for (const key of ['kind', 'type', 'authority', 'name', 'source']) add(value[key]);
    }
  };
  add(envelope.source);
  add(envelope.metricsSource);
  add(envelope.provenance);
  add(metrics.metricsSource);
  add(metrics.source);
  add(metrics.provenance);
  add(envelope.metricsProvenance);
  return tokens;
};

// Extract the identity a diagnostic envelope claims to describe. Queue task
// identities are intentionally never read here: the backend taskId is a
// separate observation and must be projected explicitly.
export const projectDiagnosticBinding = (evidence = {}) => {
  const envelope = isPlainObject(evidence) ? evidence : {};
  const binding = isPlainObject(envelope.binding) ? envelope.binding : {};
  const artifacts = isPlainObject(envelope.artifacts) ? envelope.artifacts : {};
  const candidate = isPlainObject(envelope.candidate) ? envelope.candidate : {};
  const pick = (...values) => {
    for (const value of values) {
      const token = nonEmpty(value);
      if (token) return token;
    }
    return null;
  };
  return {
    candidateDigest: pick(binding.candidateDigest, envelope.candidateDigest, candidate.digest, artifacts.candidateDigest),
    runId: pick(binding.runId, envelope.runId, envelope.requestId, artifacts.runId),
    taskId: pick(binding.backendTaskId, binding.taskId, envelope.backendTaskId, envelope.taskId, artifacts.backendTaskId),
    sourceRunId: pick(binding.sourceRunId, envelope.sourceRunId, artifacts.sourceRunId),
    semanticDigest: pick(binding.semanticDigest, envelope.semanticDigest, artifacts.semanticDigest),
  };
};

// Hardware-free projection of the candidate/run/semantic identity a diagnostic
// must match. Unknown observations stay null; callers never stamp a mismatched
// observation with current state. When the benchmark candidate and the applied
// candidate disagree the projection is marked as a conflict instead of silently
// preferring one of them.
export const buildExpectedDiagnosticBinding = (state = {}) => {
  const benchmark = isPlainObject(state.benchmark) ? state.benchmark : {};
  const benchmarkCandidate = isPlainObject(benchmark.candidate) ? benchmark.candidate : {};
  const missions = Array.isArray(state.missions) ? state.missions : [];
  const mission = missions.find((item) => item.id === state.activeMissionId) || {};
  const benchmarkCandidateId = nonEmpty(benchmarkCandidate.id);
  const appliedCandidateId = nonEmpty(state.appliedCandidateId);
  const candidateId = benchmarkCandidateId || appliedCandidateId;
  const appliedCandidate = (Array.isArray(state.candidateEvaluations) ? state.candidateEvaluations : [])
    .find((item) => item.id === candidateId) || {};
  const snapshot = isPlainObject(mission.semanticSnapshot) && mission.semanticSnapshot.status === 'frozen'
    ? mission.semanticSnapshot
    : null;
  const semanticBinding = isPlainObject(benchmark.semanticBinding) ? benchmark.semanticBinding : {};

  const benchmarkDigest = nonEmpty(benchmarkCandidate.digest);
  const appliedDigest = nonEmpty(appliedCandidate.patchDigest);
  const benchmarkSourceRun = nonEmpty(benchmarkCandidate.sourceRunId);
  const appliedSourceRun = nonEmpty(appliedCandidate.sourceRunId);

  const conflictReasons = [];
  if (benchmarkCandidateId && appliedCandidateId && benchmarkCandidateId !== appliedCandidateId) {
    conflictReasons.push('candidate_id_mismatch');
  }
  if (benchmarkDigest && appliedDigest && benchmarkDigest !== appliedDigest) {
    conflictReasons.push('candidate_digest_mismatch');
  }
  if (benchmarkSourceRun && appliedSourceRun && benchmarkSourceRun !== appliedSourceRun) {
    conflictReasons.push('source_run_id_mismatch');
  }

  return {
    missionId: nonEmpty(state.activeMissionId),
    candidateId,
    candidateDigest: benchmarkDigest || appliedDigest,
    runId: nonEmpty(benchmark.runId),
    // Backend task identity, retained at projection as benchmark.remoteTaskId.
    // The queue testTaskId is deliberately not a substitute.
    taskId: nonEmpty(benchmark.remoteTaskId) || nonEmpty(benchmark.backendTaskId),
    // The benchmark candidate's recorded source run falls back to the applied
    // candidate record; a contradiction between the two is a conflict.
    sourceRunId: benchmarkSourceRun || appliedSourceRun,
    semanticDigest: snapshot ? nonEmpty(snapshot.digest) : nonEmpty(semanticBinding.semanticDigest),
    conflict: conflictReasons.length > 0,
    conflictReasons,
  };
};

const diagnosticSchemaValid = (kind, envelope) => {
  if (kind === 'tracer') {
    return envelope.format === 'operator-trace/v1' && Array.isArray(envelope.events);
  }
  if (kind === 'profiler') {
    return envelope.format === 'operator-profile/v1' && isPlainObject(envelope.metrics);
  }
  return false;
};

// Only explicitly categorised kernel events count. Any malformed kernel event
// fails the whole tracer: a later valid event may not mask an invalid one.
const validateTracerContent = (envelope, reasons) => {
  const events = Array.isArray(envelope.events) ? envelope.events : [];
  const kernelEvents = events.filter((event) => isPlainObject(event) && normalizeToken(event.category) === 'kernel');
  if (!kernelEvents.length) {
    pushReason(reasons, events.length ? DIAGNOSTIC_REASONS.TRACER_NO_MEASUREMENT : DIAGNOSTIC_REASONS.TRACER_NO_EVENT);
    return false;
  }
  let invalid = false;
  for (const event of kernelEvents) {
    const name = nonEmpty(event.name);
    const startOk = Number.isFinite(event.startUs) && event.startUs >= 0;
    const durationOk = Number.isFinite(event.durationUs) && event.durationUs > 0;
    if (!name || !startOk || !durationOk) invalid = true;
  }
  if (invalid) {
    pushReason(reasons, DIAGNOSTIC_REASONS.TRACER_INVALID_EVENT);
    return false;
  }
  return true;
};

// Profiler content is judged from explicit provenance, never by guessing that a
// duration "looks like" a benchmark latency (units differ and equality proves
// nothing). A benchmark-only metric source is explicit misuse.
const validateProfilerContent = (envelope, reasons) => {
  const metrics = isPlainObject(envelope.metrics) ? envelope.metrics : {};
  let valid = true;
  const duration = metrics.kernelDurationUs;
  if (!Number.isFinite(duration) || duration <= 0) {
    pushReason(reasons, !hasOwn(metrics, 'kernelDurationUs')
      ? DIAGNOSTIC_REASONS.PROFILER_DURATION_MISSING : DIAGNOSTIC_REASONS.PROFILER_DURATION_INVALID);
    valid = false;
  }
  const metricSourceTokens = collectMetricSourceTokens(envelope, metrics);
  if (metricSourceTokens.some((token) => BENCHMARK_SOURCE_PATTERNS.some((pattern) => token.includes(pattern)))) {
    pushReason(reasons, DIAGNOSTIC_REASONS.PROFILER_BENCHMARK_VALUE);
    valid = false;
  }
  const invalidOccupancy = ['occupancy', 'occupancyRatio', 'achievedOccupancy'].some((key) =>
    hasOwn(metrics, key) && metrics[key] !== undefined
      && (!Number.isFinite(metrics[key]) || metrics[key] < 0 || metrics[key] > 1));
  if (invalidOccupancy) {
    pushReason(reasons, DIAGNOSTIC_REASONS.METRIC_OCCUPANCY_INVALID);
    valid = false;
  }
  const invalidBandwidth = ['bandwidth', 'bandwidthGBps', 'dramBandwidthGbps'].some((key) =>
    hasOwn(metrics, key) && metrics[key] !== undefined
      && (!Number.isFinite(metrics[key]) || metrics[key] < 0));
  if (invalidBandwidth) {
    pushReason(reasons, DIAGNOSTIC_REASONS.METRIC_BANDWIDTH_INVALID);
    valid = false;
  }
  return valid;
};

export const classifyDiagnosticReasons = (reasons = []) => {
  const set = new Set(Array.isArray(reasons) ? reasons : []);
  const blocking = BLOCKING_DIAGNOSTIC_REASONS.some((code) => set.has(code));
  const recoverable = !blocking && RECOVERABLE_DIAGNOSTIC_REASONS.some((code) => set.has(code));
  return { blocking, recoverable };
};

// Strict three-way qualification. Returns fresh objects and never mutates the
// envelope, the expected binding or the supplied state.
export function evaluateDiagnosticEvidence(kind, evidence, expectedBinding = {}) {
  if (!DIAGNOSTIC_KINDS.includes(kind)) {
    return { schemaValid: false, available: false, evidenceEligible: false, reasons: [DIAGNOSTIC_REASONS.UNKNOWN_KIND] };
  }
  const reasons = [];
  const envelope = isPlainObject(evidence) ? evidence : null;
  if (!envelope) {
    return { schemaValid: false, available: false, evidenceEligible: false, reasons: [DIAGNOSTIC_REASONS.SCHEMA_MISSING] };
  }
  const schemaValid = diagnosticSchemaValid(kind, envelope);
  if (!schemaValid) {
    return { schemaValid: false, available: false, evidenceEligible: false, reasons: [DIAGNOSTIC_REASONS.SCHEMA_INVALID] };
  }
  const status = normalizeToken(envelope.status);
  let nestedSimulation;
  try { nestedSimulation = containsSimulationMetadata(envelope); }
  catch {
    return { schemaValid: false, available: false, evidenceEligible: false, reasons: [DIAGNOSTIC_REASONS.SCHEMA_INVALID] };
  }
  const explicitSourceTokens = collectExplicitSourceTokens(envelope);
  const knownSourceTokens = explicitSourceTokens.filter((token) => !UNKNOWN_SOURCE_TOKENS.has(token));
  // Secondary provenance can veto a claim, but never fill missing provenance.
  const secondaryTokens = [
    ...collectExplicitSourceTokens(isPlainObject(envelope.artifacts) ? envelope.artifacts : {}),
    ...collectExplicitSourceTokens(isPlainObject(envelope.metrics) ? envelope.metrics : {}),
  ];
  const simulated = envelope.simulated === true
    || envelope.mock === true
    || envelope.synthetic === true
    || envelope.fixture === true
    || (isPlainObject(envelope.provenance) && (envelope.provenance.simulated === true || envelope.provenance.mock === true))
    || (isPlainObject(envelope.artifacts) && (envelope.artifacts.simulated === true || envelope.artifacts.mock === true))
    || nestedSimulation
    || (status !== null && NON_REAL_STATUSES.has(status))
    || knownSourceTokens.some(isNonRealToken)
    || secondaryTokens.some(isNonRealToken);
  if (simulated) {
    // Mock/simulated provenance always wins over a contradictory completed status.
    pushReason(reasons, DIAGNOSTIC_REASONS.SIMULATED);
    return { schemaValid: true, available: false, evidenceEligible: false, reasons };
  }
  if (!status) {
    pushReason(reasons, DIAGNOSTIC_REASONS.STATUS_MISSING);
    return { schemaValid: true, available: false, evidenceEligible: false, reasons };
  }
  if (!COMPLETED_STATUSES.has(status)) {
    pushReason(reasons, DIAGNOSTIC_REASONS.STATUS_NOT_COMPLETED);
    return { schemaValid: true, available: false, evidenceEligible: false, reasons };
  }
  if (!knownSourceTokens.length || explicitSourceTokens.some((token) => UNKNOWN_SOURCE_TOKENS.has(token))) {
    // Missing or explicitly unknown source never proves a real collection, and
    // a bare tool/artifact identity may not backfill it.
    pushReason(reasons, DIAGNOSTIC_REASONS.SOURCE_MISSING);
    return { schemaValid: true, available: false, evidenceEligible: false, reasons };
  }
  if (knownSourceTokens.some((token) => BENCHMARK_SOURCE_PATTERNS.some((pattern) => token.includes(pattern)))) {
    pushReason(reasons, DIAGNOSTIC_REASONS.SOURCE_INVALID);
    return { schemaValid: true, available: false, evidenceEligible: false, reasons };
  }

  const binding = projectDiagnosticBinding(envelope);
  const expected = isPlainObject(expectedBinding) ? expectedBinding : {};
  if (expected.conflict === true) {
    pushReason(reasons, DIAGNOSTIC_REASONS.BINDING_CONFLICT);
  }
  const expectedCandidate = nonEmpty(expected.candidateDigest);
  const expectedRun = nonEmpty(expected.runId);
  if (!expectedCandidate || !expectedRun) {
    pushReason(reasons, DIAGNOSTIC_REASONS.BINDING_EXPECTED_MISSING);
  } else {
    if (!binding.candidateDigest) pushReason(reasons, DIAGNOSTIC_REASONS.BINDING_CANDIDATE_MISSING);
    else if (binding.candidateDigest !== expectedCandidate) pushReason(reasons, DIAGNOSTIC_REASONS.BINDING_CANDIDATE_MISMATCH);
    if (!binding.runId) pushReason(reasons, DIAGNOSTIC_REASONS.BINDING_RUN_MISSING);
    else if (binding.runId !== expectedRun) pushReason(reasons, DIAGNOSTIC_REASONS.BINDING_RUN_MISMATCH);
  }
  const expectedSourceRun = nonEmpty(expected.sourceRunId);
  if (expectedSourceRun && binding.sourceRunId !== expectedSourceRun) {
    pushReason(reasons, DIAGNOSTIC_REASONS.BINDING_SOURCE_RUN_MISMATCH);
  }
  const expectedTask = nonEmpty(expected.taskId);
  if (expectedTask && binding.taskId !== expectedTask) {
    pushReason(reasons, DIAGNOSTIC_REASONS.BINDING_TASK_MISMATCH);
  }
  const expectedSemantic = nonEmpty(expected.semanticDigest);
  if (expectedSemantic) {
    if (!binding.semanticDigest) pushReason(reasons, DIAGNOSTIC_REASONS.BINDING_SEMANTIC_MISSING);
    else if (binding.semanticDigest !== expectedSemantic) pushReason(reasons, DIAGNOSTIC_REASONS.BINDING_SEMANTIC_MISMATCH);
  }

  const contentValid = kind === 'tracer'
    ? validateTracerContent(envelope, reasons)
    : validateProfilerContent(envelope, reasons);
  return {
    schemaValid: true,
    available: true,
    evidenceEligible: contentValid && reasons.length === 0,
    reasons,
  };
}

const collectEnvironmentTokens = (environment) => {
  const tokens = [];
  const add = (value) => {
    if (Array.isArray(value)) { value.forEach(add); return; }
    if (typeof value === 'string') {
      const token = value.trim().toLowerCase();
      if (token) tokens.push(token);
      return;
    }
    if (isPlainObject(value)) {
      for (const key of ['kind', 'type', 'mode', 'source', 'service', 'runtime', 'name']) add(value[key]);
    }
  };
  add(environment.executionMode);
  add(environment.mode);
  add(environment.runtime);
  add(environment.source);
  add(environment.service);
  add(environment.hardware);
  add(environment.provider);
  return tokens;
};

const isCpuToken = (token) => token === 'cpu' || token === 'local-cpu' || token === 'cpu-e2e'
  || token === 'cpu-runner' || token.startsWith('cpu-') || token.endsWith('-cpu') || token.includes('cpu-e2e');

// Execution classification is derived from explicit environment facts and is
// fail-closed: explicit simulation/mock/fixture/CPU signals always outrank a
// contradictory liveHardware=true. A truly unmarked result stays `unknown` and
// can never authorize publication.
export const classifyExecution = (environment = {}, result = {}) => {
  const env = isPlainObject(environment) ? environment : {};
  const mode = normalizeToken(env.executionMode) || normalizeToken(env.mode) || '';
  const runtime = normalizeToken(env.runtime) || '';
  const source = normalizeToken(env.source)
    || normalizeToken(env.runtime)
    || normalizeToken(env.service)
    || null;
  const tokens = collectEnvironmentTokens(env);
  const cpuSignal = isCpuToken(mode)
    || isCpuToken(source || '')
    || isCpuToken(runtime)
    || tokens.some(isCpuToken)
    || (normalizeToken(env.hardware) === 'cpu')
    || env.cpu === true;
  const simulationSignal = env.simulated === true
    || env.mock === true
    || result.simulated === true
    || mode.includes('simulat')
    || mode.includes('mock')
    || mode.includes('hardware-mock')
    || tokens.some(isNonRealToken);
  const sourceKnown = source !== null && !UNKNOWN_SOURCE_TOKENS.has(source);
  const kind = cpuSignal ? 'cpu' : simulationSignal ? 'simulation' : env.liveHardware === true && sourceKnown ? 'live' : 'unknown';
  return { kind, liveHardware: kind === 'live', source };
};

// Explicit development / shared-host restrictions are never publication
// authority. A backend publishable=true is not authorization and is ignored
// here; publishable=false is a restriction. Mock/fixture/scripted and CPU
// environments are restricted as well.
export const hasPublicationRestriction = (environment = {}) => {
  const env = isPlainObject(environment) ? environment : {};
  const source = normalizeToken(env.source);
  const mode = normalizeToken(env.executionMode) || normalizeToken(env.mode);
  const service = normalizeToken(env.service);
  const runtime = normalizeToken(env.runtime);
  const tokens = collectEnvironmentTokens(env);
  const sharedHost = tokens.some((token) => token === 'local-shared-gpu'
    || token.includes('shared-gpu')
    || token.includes('shared-host'));
  const development = tokens.some((token) => token === 'development'
    || token === 'dev'
    || token.startsWith('dev-')
    || token.endsWith('-development'));
  return env.publishable === false
    || env.development === true
    || env.sharedHost === true
    || env.allowSharedHostGpu === true
    || env.simulated === true
    || env.mock === true
    || source === 'simulation'
    || source === 'mock'
    || mode === 'shared-host-gpu'
    || mode === 'full-simulation'
    || mode === 'hardware-mock'
    || mode === 'cpu-e2e'
    || sharedHost
    || development
    || tokens.some(isNonRealToken)
    || (service !== null && isNonRealToken(service))
    || (runtime !== null && isNonRealToken(runtime));
};
