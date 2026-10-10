import { normalizeAcceptancePolicy } from './business-acceptance.mjs';

const DEFAULT_CATEGORIES = ['minimal', 'representative', 'boundary', 'ragged'];
const DEFAULT_BENCHMARK_PROFILES = ['primary', 'small', 'boundary'];

const positiveInteger = (value, fallback) => {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : fallback;
};
const nonnegativeSeed = (value, fallback) => {
  const number = Number(value);
  return value !== null && value !== '' && Number.isSafeInteger(number) && number >= 0 ? number : fallback;
};

// A fraction strictly inside (0, 1). Used for the measurement-settling tolerance,
// where 0 would mean "demand a bit-identical reading" and 1 would mean "any reading
// counts as settled" — both of which are useless as a contract.
const fraction = (value, fallback) => {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 && number < 1 ? number : fallback;
};

// The frozen measurement contract's settling rule.
//
// Why it exists: warmup counts alone are not enough. The scored profile is measured
// first in a fresh process, and on a 10-20us compute-bound kernel three warmup calls
// do not bring the device to a steady state — the same frozen artifact then reads
// anywhere from 9.2 to 17.4us depending on whether that process happened to catch a
// boosted clock. Measured across fresh processes, the old contract landed on the
// wrong value 4 times out of 6, and two artifacts that are reproducibly 40% apart
// were recorded as an identical tie, so a real gain was reported as no gain.
//
// The rule: keep taking whole settlements of the scored profile until two consecutive
// ones agree within `settleTolerance`, then score the last one. On this timer one tick
// is ~1.024us (11% of a 9.2us reading), so a 2% tolerance means "two consecutive
// settlements landed on the same tick" — it cannot be satisfied by two independent
// readings drifting together.
//
// Reaching `maxSettlements` without agreement is not a pass and not a failure: it is
// the runner reporting that this reading did not settle. The Accept Gate must then
// refuse to call a tie a "no gain" rather than decide on an unstable number.
export const DEFAULT_SETTLE_TOLERANCE = 0.02;
export const DEFAULT_MAX_SETTLEMENTS = 8;

export const createMissionTestSpec = (input = {}) => {
  // A declared fast pre-test prefix is carried through verbatim. This function
  // rebuilds the spec from a fixed set of keys, so any key it does not copy back is
  // silently dropped — a declared prefix that vanishes here would look, to the
  // runner, exactly like a profile that never declared one.
  const prefix = Array.isArray(input.correctness?.prefix) ? input.correctness.prefix.map(String) : null;
  // Declared benchmark shapes are carried the same way: dropping them here would
  // let the baseline pick any shape for a profile whose shape was declared.
  const shapes = Array.isArray(input.benchmark?.shapes) ? structuredClone(input.benchmark.shapes) : null;
  // Per-dtype tolerances, the cosine bound and the declared tensor contract are
  // carried too: dropping them would silently fall back to the looser base
  // atol/rtol and let a candidate or baseline ignore the declared dtype/shape.
  const plain = (value) => value && typeof value === 'object' && !Array.isArray(value);
  const dtypeTolerance = plain(input.correctness?.dtypeTolerance) ? structuredClone(input.correctness.dtypeTolerance) : null;
  const cosLimit = Number.isFinite(input.correctness?.requireCosDiffBelow) ? input.correctness.requireCosDiffBelow : null;
  const tensors = plain(input.correctness?.tensors) ? structuredClone(input.correctness.tensors) : null;
  return {
    schemaVersion: 'operator-studio.test-spec/v1',
    ...(input.acceptancePolicy != null ? { acceptancePolicy: normalizeAcceptancePolicy(input.acceptancePolicy, input.benchmark) } : {}),
    generation: {
      owner: 'baseline-materializer-agent',
      source: 'authoritative-semantics',
      deterministic: true,
      seed: nonnegativeSeed(input.seed, 20260826),
    },
    correctness: {
      requestedCases: positiveInteger(input.correctnessCases ?? input.correctness?.requestedCases, 24),
      requiredCategories: Array.isArray(input.correctness?.requiredCategories) && input.correctness.requiredCategories.length
        ? input.correctness.requiredCategories.map(String)
        : DEFAULT_CATEGORIES,
      atol: Number.isFinite(Number(input.correctness?.atol)) ? Number(input.correctness.atol) : 1e-3,
      rtol: Number.isFinite(Number(input.correctness?.rtol)) ? Number(input.correctness.rtol) : 1e-3,
      requireNamedCases: true,
      ...(prefix ? { prefix } : {}),
      ...(dtypeTolerance ? { dtypeTolerance } : {}),
      ...(input.correctness?.toleranceScope !== undefined ? { toleranceScope: input.correctness.toleranceScope } : {}),
      ...(cosLimit !== null ? { requireCosDiffBelow: cosLimit } : {}),
      ...(tensors ? { tensors } : {}),
    },
    benchmark: {
      requiredProfiles: Array.isArray(input.benchmark?.requiredProfiles) && input.benchmark.requiredProfiles.length
        ? input.benchmark.requiredProfiles.map(String)
        : DEFAULT_BENCHMARK_PROFILES,
      warmup: positiveInteger(input.warmup ?? input.benchmark?.warmup, 50),
      repeats: positiveInteger(input.repeats ?? input.benchmark?.repeats, 200),
      metrics: ['p50_us', 'p95_us', 'min_us', 'max_us'],
      primaryProfile: String(input.benchmark?.primaryProfile || 'primary'),
      settleTolerance: fraction(
        input.settleTolerance ?? input.benchmark?.settleTolerance,
        DEFAULT_SETTLE_TOLERANCE,
      ),
      maxSettlements: positiveInteger(
        input.maxSettlements ?? input.benchmark?.maxSettlements,
        DEFAULT_MAX_SETTLEMENTS,
      ),
      ...(shapes ? { shapes } : {}),
    },
  };
};

export const normalizeMissionTestMatrix = (matrix = {}) => {
  const testSpec = matrix.testSpec?.schemaVersion === 'operator-studio.test-spec/v1'
    ? createMissionTestSpec({
      ...matrix,
      ...matrix.testSpec,
      correctness: matrix.testSpec.correctness,
      benchmark: matrix.testSpec.benchmark,
      seed: matrix.testSpec.generation?.seed,
    })
    : createMissionTestSpec(matrix);
  return {
    ...structuredClone(matrix),
    environments: Array.isArray(matrix.environments) && matrix.environments.length ? matrix.environments : ['C550'],
    stages: Array.isArray(matrix.stages) && matrix.stages.length ? matrix.stages : ['Correctness', 'Full Benchmark'],
    correctnessCases: testSpec.correctness.requestedCases,
    warmup: testSpec.benchmark.warmup,
    repeats: testSpec.benchmark.repeats,
    // Lifted to the top level beside warmup/repeats so the runner reads the declared
    // policy from the same place it already reads the rest of the measurement contract.
    settleTolerance: testSpec.benchmark.settleTolerance,
    maxSettlements: testSpec.benchmark.maxSettlements,
    testSpec,
  };
};

export const testSpecAgentInstruction = (matrix = {}) => {
  const normalized = normalizeMissionTestMatrix(matrix);
  return [
    `Executable test specification JSON: ${JSON.stringify(normalized.testSpec)}`,
    `Add get_test_cases() returning exactly ${normalized.testSpec.correctness.requestedCases} named cases as {"name": string, "category": string, "inputs": <get_inputs-compatible value>}. Cover every required category and make generation deterministic.`,
    normalized.testSpec.correctness.prefix?.length
      ? `The correctness.prefix list only reorders execution: those cases run first, every other listed case still runs, and a pass still requires all ${normalized.testSpec.correctness.requestedCases} cases. It never reduces the case set.`
      : '',
    normalized.testSpec.correctness.dtypeTolerance
      ? `Correctness tolerance is per dtype (${normalized.testSpec.correctness.toleranceScope === 'output-dtype' ? 'each output tensor dtype' : "the case's floating dtype"}): ${Object.entries(normalized.testSpec.correctness.dtypeTolerance).map(([dtype, value]) => `${dtype} ${value.atol}/${value.rtol}`).join(', ')}; other dtypes use atol ${normalized.testSpec.correctness.atol} / rtol ${normalized.testSpec.correctness.rtol}.`
      : '',
    normalized.testSpec.correctness.tensors
      ? `Tensor contract is enforced: every case's inputs must be a mapping with exactly the declared dtype and rank (${normalized.testSpec.correctness.tensors.inputs.map((tensor) => `${tensor.name}:${tensor.dtype}[${tensor.shape.join(',')}]${tensor.layout ? `@${tensor.layout}` : ''}`).join(' ')}), a named dimension taking one value per case; run(inputs) must not modify its inputs; its output must have the declared dtype and shape (${normalized.testSpec.correctness.tensors.outputs.map((tensor) => `${tensor.name}:${tensor.dtype}[${tensor.shape.join(',')}]${tensor.layout ? `@${tensor.layout}` : ''}`).join(' ')}; several outputs are a mapping keyed by name or a tuple in this order). A baseline case that breaks the input contract fails as an oracle contract error; a candidate that mutates inputs or breaks the output contract fails correctness.`
      : '',
    `Add get_benchmark_inputs() returning named benchmark profiles as {"name": string, "inputs": <get_inputs-compatible value>}; the first profile must be named ${normalized.testSpec.benchmark.primaryProfile} and is the Accept Gate metric.`,
    normalized.testSpec.benchmark.shapes?.length
      ? `Benchmark shapes are frozen: each profile's inputs must be a mapping keyed by the declared tensor names, whose tensors have exactly these shapes (inputs not listed keep their declared shape), and the runner rejects any other shape: ${normalized.testSpec.benchmark.shapes.map((shape) => `${shape.name} -> ${Object.entries(shape.inputShapes).map(([name, dims]) => `${name}[${dims.join(',')}]`).join(' ')}`).join('; ')}.`
      : '',
    'Keep get_inputs() for compatibility. reference(inputs) is the independent correctness oracle; run(inputs) is the implementation under test.',
  ].join('\n');
};
