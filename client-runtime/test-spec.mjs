const DEFAULT_CATEGORIES = ['minimal', 'representative', 'boundary', 'ragged'];
const DEFAULT_BENCHMARK_PROFILES = ['primary', 'small', 'boundary'];

const positiveInteger = (value, fallback) => {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : fallback;
};

export const createMissionTestSpec = (input = {}) => ({
  schemaVersion: 'operator-studio.test-spec/v1',
  generation: {
    owner: 'baseline-materializer-agent',
    source: 'authoritative-semantics',
    deterministic: true,
    seed: positiveInteger(input.seed, 20260826),
  },
  correctness: {
    requestedCases: positiveInteger(input.correctnessCases ?? input.correctness?.requestedCases, 24),
    requiredCategories: Array.isArray(input.correctness?.requiredCategories) && input.correctness.requiredCategories.length
      ? input.correctness.requiredCategories.map(String)
      : DEFAULT_CATEGORIES,
    atol: Number.isFinite(Number(input.correctness?.atol)) ? Number(input.correctness.atol) : 1e-3,
    rtol: Number.isFinite(Number(input.correctness?.rtol)) ? Number(input.correctness.rtol) : 1e-3,
    requireNamedCases: true,
  },
  benchmark: {
    requiredProfiles: Array.isArray(input.benchmark?.requiredProfiles) && input.benchmark.requiredProfiles.length
      ? input.benchmark.requiredProfiles.map(String)
      : DEFAULT_BENCHMARK_PROFILES,
    warmup: positiveInteger(input.warmup ?? input.benchmark?.warmup, 50),
    repeats: positiveInteger(input.repeats ?? input.benchmark?.repeats, 200),
    metrics: ['p50_us', 'p95_us', 'min_us', 'max_us'],
    primaryProfile: String(input.benchmark?.primaryProfile || 'primary'),
  },
});

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
    environments: Array.isArray(matrix.environments) && matrix.environments.length ? matrix.environments : ['C500'],
    stages: Array.isArray(matrix.stages) && matrix.stages.length ? matrix.stages : ['Correctness', 'Full Benchmark'],
    correctnessCases: testSpec.correctness.requestedCases,
    warmup: testSpec.benchmark.warmup,
    repeats: testSpec.benchmark.repeats,
    testSpec,
  };
};

export const testSpecAgentInstruction = (matrix = {}) => {
  const normalized = normalizeMissionTestMatrix(matrix);
  return [
    `Executable test specification JSON: ${JSON.stringify(normalized.testSpec)}`,
    `Add get_test_cases() returning exactly ${normalized.testSpec.correctness.requestedCases} named cases as {"name": string, "category": string, "inputs": <get_inputs-compatible value>}. Cover every required category and make generation deterministic.`,
    `Add get_benchmark_inputs() returning named benchmark profiles as {"name": string, "inputs": <get_inputs-compatible value>}; the first profile must be named ${normalized.testSpec.benchmark.primaryProfile} and is the Accept Gate metric.`,
    'Keep get_inputs() for compatibility. reference(inputs) is the independent correctness oracle; run(inputs) is the implementation under test.',
  ].join('\n');
};
