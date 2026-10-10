// Single source of truth for the correctness-coverage manifest.
//
// Why this exists: the frozen runners report `total` as the case count the
// contract *requested*, not the count that actually ran. A run that aborts after
// the first failing case still reports `total: 24`. So `passed === true` plus a
// `total` floor cannot distinguish "every case passed" from "the first case
// passed and the rest never ran" — and the second one must never be adopted as a
// correct candidate. The manifest is written by the runner that performed the
// run (`tools/local-c500-runner.py`) and consumed here.
//
// The Python writer is authoritative for the wire shape; this module exists so
// the gate, the runners' in-process double, and the test producers cannot drift
// from it independently.
export const CORRECTNESS_COVERAGE_SCHEMA = 'operator-studio.correctness-coverage/v1';

// `source` records why the prefix plan looks the way it does: 'frozen' (a
// declared prefix ran first), 'none' (nothing declared), 'disabled' (declared but
// switched off for this run), 'not_evaluated' (the run never got far enough).
export const createCoverage = ({
  required, planned = required, executed = planned, passed = executed,
  skippedReason = null, prefix = null,
} = {}) => {
  const count = (value) => Math.max(0, Math.floor(Number(value) || 0));
  const requiredCases = count(required);
  const plannedCases = count(planned);
  const executedCases = count(executed);
  const passedCases = count(passed);
  return {
    schemaVersion: CORRECTNESS_COVERAGE_SCHEMA,
    requiredCases,
    plannedCases,
    executedCases,
    passedCases,
    skippedCases: Math.max(0, plannedCases - executedCases),
    skippedReason: skippedReason ?? null,
    prefix: prefix ? { size: count(prefix.size), source: String(prefix.source || 'none'), names: (prefix.names || []).map(String), passed: prefix.passed ?? null } : { size: 0, source: 'none', names: [], passed: null },
    complete: requiredCases > 0 && plannedCases === requiredCases && executedCases === plannedCases && passedCases === executedCases && skippedReason == null,
  };
};

// A correctness record for a producer that did not run the frozen runner: a
// scripted scenario, a process double, a test fixture. It describes a complete
// pass over `total` cases. It is honest about what it is only when the record
// that carries it also carries its own provenance (`simulated`/`source`), so
// never use this to make a real run look more complete than it was.
export const completeCorrectness = (total, { prefix = null, executed } = {}) => {
  const count = Math.max(0, Math.floor(Number(total) || 0));
  const executedCases = executed === undefined ? count : Math.max(0, Math.floor(Number(executed) || 0));
  return {
    passed: true,
    total: count,
    executedCases,
    passedCases: executedCases,
    coverage: createCoverage({ required: count, planned: count, executed: executedCases, passed: executedCases, prefix }),
  };
};

// The Accept Gate's pass-path rule. `total` alone is not evidence of coverage,
// so it is checked against the manifest rather than trusted.
export const coverageIsComplete = (correctness) => {
  const coverage = correctness?.coverage;
  if (!coverage || typeof coverage !== 'object') return false;
  if (coverage.complete !== true) return false;
  if (coverage.skippedReason !== null && coverage.skippedReason !== undefined) return false;
  // Preserve numeric-string records without coercing null, booleans or containers
  // into counts. Evidence counts are discrete and must be exactly representable.
  const count = (value) => {
    if (typeof value !== 'number' && (typeof value !== 'string' || value.trim() === '')) return NaN;
    const number = Number(value);
    return Number.isSafeInteger(number) && number >= 0 ? number : NaN;
  };
  const total = count(coverage.requiredCases);
  const planned = count(coverage.plannedCases);
  const executed = count(coverage.executedCases);
  const passed = count(coverage.passedCases);
  const skipped = count(coverage.skippedCases);
  if (![total, planned, executed, passed, skipped].every(Number.isSafeInteger) || total <= 0) return false;
  // Keep the existing total/manifest agreement rule and producer compatibility.
  const declared = Number(correctness?.total);
  if (Number.isFinite(declared) && declared !== total) return false;
  if (skipped !== 0 || passed !== executed || planned !== total || executed !== planned) return false;
  // Legacy records may omit these counters; explicitly invalid counters must fail.
  for (const [key, expected] of [['executedCases', executed], ['passedCases', passed]]) {
    if (Object.hasOwn(correctness, key) && count(correctness[key]) !== expected) return false;
  }
  return true;
};
