// Pure policy carried inside the existing frozen testSpec identity.
import { runnerMatches } from './runner-aliases.mjs';

export const ACCEPTANCE_POLICY_SCHEMA = 'operator-studio.acceptance-policy/v1';
const TARGET_MODES = new Set(['strict-improvement', 'relative-improvement', 'latency-limit']);
const fail = (message) => { const error = new Error(message); error.code = 'ACCEPTANCE_POLICY_INVALID'; throw error; };
export const normalizeAcceptancePolicy = (policy, benchmark = {}) => {
  if (policy == null) return null; // Existing tasks keep their original policy and identity.
  if (!policy || typeof policy !== 'object' || Array.isArray(policy) || policy.schemaVersion !== ACCEPTANCE_POLICY_SCHEMA) fail('Unsupported acceptancePolicy schema');
  const profiles = policy.protectedProfiles;
  const required = Array.isArray(benchmark.requiredProfiles) ? benchmark.requiredProfiles : [];
  if (!Array.isArray(profiles) || !profiles.length || profiles.some((name) => typeof name !== 'string' || !name.trim() || name !== name.trim())
    || new Set(profiles).size !== profiles.length || profiles.some((name) => !required.includes(name))
    || !profiles.includes(benchmark.primaryProfile)) fail('Protected profiles must be unique requiredProfiles and include primaryProfile');
  if (typeof policy.maxRegressionFraction !== 'number' || !Number.isFinite(policy.maxRegressionFraction) || policy.maxRegressionFraction < 0 || policy.maxRegressionFraction >= 1) fail('maxRegressionFraction must be a number in [0, 1)');
  const target = policy.successTarget;
  if (!target || !TARGET_MODES.has(target.mode)) fail('An explicit successTarget is required');
  if (target.mode !== 'strict-improvement' && (typeof target.value !== 'number' || !Number.isFinite(target.value) || target.value <= 0
    || target.mode === 'relative-improvement' && target.value >= 1)) fail('Invalid successTarget value');
  return { schemaVersion: ACCEPTANCE_POLICY_SCHEMA, protectedProfiles: [...profiles], maxRegressionFraction: policy.maxRegressionFraction,
    successTarget: { mode: target.mode, ...(target.mode !== 'strict-improvement' ? { value: target.value } : {}) } };
};

const valid = (value) => typeof value === 'number' && Number.isFinite(value) && value > 0;
const one = (measurements, profile) => {
  const matches = measurements.filter((item) => item?.profile === profile);
  return matches.length === 1 ? matches[0] : null;
};
const improves = (value, reference, minimize) => minimize ? value < reference : value > reference;
const epsilon = 1e-6;

export const evaluateBusinessAcceptance = ({ testSpec = {}, measurements = [], baselineEvidence = null, baselineReady = false,
  currentBest = {}, minimizesMetric = true, testSpecDigest = null } = {}) => {
  let policy;
  try { policy = normalizeAcceptancePolicy(testSpec.acceptancePolicy, testSpec.benchmark); } catch (error) {
    return { enabled: true, policySchema: testSpec.acceptancePolicy?.schemaVersion || null, valid: false,
      protectedProfilesPassed: false, targetReached: false, eligibleAsBest: false, profileComparisons: [], issues: [error.message] };
  }
  if (!policy) return { enabled: false };
  const issues = [];
  const baselineContractMatches = Boolean(testSpecDigest) && baselineEvidence?.testSpecDigest === testSpecDigest;
  if (!baselineContractMatches) issues.push('BASELINE_TEST_SPEC_MISMATCH');
  const baselineMeasurements = Array.isArray(baselineEvidence?.measurements) ? baselineEvidence.measurements : [];
  const profileComparisons = policy.protectedProfiles.map((profile) => {
    const candidate = one(measurements, profile);
    const reference = one(baselineMeasurements, profile);
    const comparable = baselineReady && baselineContractMatches && valid(candidate?.value) && valid(reference?.value)
      && candidate.settled !== false && reference.settled !== false
      && runnerMatches(candidate.environment, reference.environment) && Boolean(candidate.unit) && candidate.unit === reference.unit;
    const limit = comparable ? reference.value * (minimizesMetric ? 1 + policy.maxRegressionFraction : 1 - policy.maxRegressionFraction) : null;
    const passed = comparable && (minimizesMetric ? candidate.value <= limit * (1 + epsilon) : candidate.value >= limit * (1 - epsilon));
    if (!comparable) issues.push(`PROFILE_NOT_COMPARABLE:${profile}`);
    else if (!passed) issues.push(`PROFILE_REGRESSION:${profile}`);
    return { profile, candidate: candidate?.value ?? null, baseline: reference?.value ?? null, limit, comparable, passed,
      unit: candidate?.unit || reference?.unit || null };
  });
  const protectedProfilesPassed = profileComparisons.every((item) => item.passed);
  const primaryProfile = testSpec.benchmark?.primaryProfile;
  const primary = one(measurements, primaryProfile);
  const reference = one(baselineMeasurements, primaryProfile);
  const primaryComparable = baselineReady && baselineContractMatches && valid(primary?.value) && valid(reference?.value)
    && primary?.settled !== false && reference?.settled !== false
    && runnerMatches(primary?.environment, reference?.environment) && Boolean(primary?.unit) && primary.unit === reference.unit;
  const target = policy.successTarget;
  let targetReached = false;
  if (primaryComparable && protectedProfilesPassed) {
    if (target.mode === 'strict-improvement') targetReached = improves(primary.value, reference.value, minimizesMetric);
    else if (target.mode === 'relative-improvement') {
      const limit = reference.value * (minimizesMetric ? 1 - target.value : 1 + target.value);
      targetReached = minimizesMetric ? primary.value <= limit * (1 + epsilon) : primary.value >= limit * (1 - epsilon);
    } else targetReached = minimizesMetric && primary.unit === 'us' && primary.value <= target.value * (1 + epsilon);
  }
  // Gate eligibility is a permission, never a claim that adoption has happened.
  // Once best exists, its same-profile measurement is required; a display label
  // or an unmatched old record is not a comparison source.
  const bestExists = Boolean(currentBest.candidateId);
  const best = bestExists ? one(Array.isArray(currentBest.measurements) ? currentBest.measurements : [], primaryProfile) : reference;
  const bestComparable = bestExists
    ? valid(primary?.value) && valid(best?.value) && primary?.settled !== false && best?.settled !== false
      && runnerMatches(primary?.environment, best?.environment) && Boolean(primary?.unit) && primary.unit === best.unit
    : primaryComparable;
  if (!bestComparable) issues.push('CURRENT_BEST_NOT_COMPARABLE');
  const eligibleAsBest = protectedProfilesPassed && bestComparable && improves(primary.value, best.value, minimizesMetric);
  return { enabled: true, valid: true, policySchema: policy.schemaVersion, protectedProfiles: [...policy.protectedProfiles],
    maxRegressionFraction: policy.maxRegressionFraction, targetMode: target.mode, successTarget: { ...target },
    protectedProfilesPassed, targetReached, eligibleAsBest, profileComparisons, issues };
};
