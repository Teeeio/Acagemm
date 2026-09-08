import path from 'node:path';

const SPEC_VERSION = 'operator-studio.generic-mission/v1';
const TEST_SPEC_VERSION = 'operator-studio.test-spec/v1';

const fail = (message, code = 'GENERIC_MISSION_SPEC_INVALID') => {
  const error = new Error(message);
  error.code = code;
  error.status = 400;
  throw error;
};

const text = (value, field) => {
  const result = String(value ?? '').trim();
  if (!result) fail(`${field} must be a non-empty string`);
  return result;
};

const absolutePath = (value, field) => {
  const result = path.resolve(text(value, field));
  if (!path.isAbsolute(result)) fail(`${field} must be an absolute path`);
  return result;
};

const validateTestSpec = (matrix) => {
  const spec = matrix?.testSpec;
  if (!spec || spec.schemaVersion !== TEST_SPEC_VERSION) fail(`testMatrix.testSpec must use ${TEST_SPEC_VERSION}`);
  const correctness = spec.correctness || {};
  const benchmark = spec.benchmark || {};
  if (!Number.isInteger(correctness.requestedCases) || correctness.requestedCases < 1) fail('testSpec.correctness.requestedCases must be a positive integer');
  if (!Array.isArray(correctness.requiredCategories) || correctness.requiredCategories.length === 0) fail('testSpec.correctness.requiredCategories must be non-empty');
  if (!Array.isArray(benchmark.requiredProfiles) || benchmark.requiredProfiles.length === 0) fail('testSpec.benchmark.requiredProfiles must be non-empty');
  if (!benchmark.primaryProfile || !benchmark.requiredProfiles.includes(benchmark.primaryProfile)) fail('testSpec.benchmark.primaryProfile must be one of requiredProfiles');
  if (!Number.isInteger(benchmark.warmup) || benchmark.warmup < 1 || !Number.isInteger(benchmark.repeats) || benchmark.repeats < 1) fail('testSpec benchmark warmup/repeats must be positive integers');
  return structuredClone(spec);
};

export const normalizeGenericMissionSpecification = (input = {}) => {
  if (input.schemaVersion !== SPEC_VERSION) fail(`schemaVersion must be ${SPEC_VERSION}`);
  const goal = text(input.goal, 'goal');
  const title = text(input.title || goal.slice(0, 80), 'title');
  const repository = absolutePath(input.repository || input.projectRoot, 'repository');
  const projectRoot = absolutePath(input.projectRoot || (path.basename(repository).toLowerCase() === 'repository' ? path.dirname(repository) : repository), 'projectRoot');
  const implementation = input.implementation && typeof input.implementation === 'object' ? structuredClone(input.implementation) : fail('implementation is required');
  const requestedLanguage = text(implementation.language, 'implementation.language').toLowerCase();
  const languageAliases = {
    python: 'pytorch-python',
    pytorch: 'pytorch-python',
    'pytorch-python': 'pytorch-python',
    triton: 'triton',
    cuda: 'cuda-cpp-extension',
    'cuda-cpp': 'cuda-cpp-extension',
    'cuda-cpp-extension': 'cuda-cpp-extension',
    'mxmaca-cpp-extension': 'mxmaca-cpp-extension',
  };
  const language = languageAliases[requestedLanguage];
  if (!language) fail(`unsupported implementation.language: ${requestedLanguage}`, 'GENERIC_MISSION_LANGUAGE_UNSUPPORTED');
  const entrypoints = Array.isArray(implementation.entrypoints) && implementation.entrypoints.length
    ? implementation.entrypoints.map((item) => text(item, 'implementation.entrypoints[]'))
    : ['run'];
  const hardware = Array.isArray(input.hardware) && input.hardware.length ? input.hardware.map(String) : ['nvidia-gpu'];
  const testMatrix = structuredClone(input.testMatrix || {});
  const testSpec = validateTestSpec(testMatrix);
  const sourceFiles = Array.isArray(input.sourceFiles) ? input.sourceFiles.map((item) => {
    if (!item || typeof item !== 'object') fail('sourceFiles entries must be objects');
    const relativePath = text(item.path, 'sourceFiles[].path').replaceAll('\\', '/');
    if (relativePath.startsWith('/') || relativePath.split('/').includes('..')) fail('sourceFiles paths must remain inside the repository');
    return { path: relativePath, role: String(item.role || 'dependency') };
  }) : [];
  if (!sourceFiles.some((item) => item.role === 'entrypoint')) fail('sourceFiles must declare at least one entrypoint file');
  const operator = input.operatorProfile && typeof input.operatorProfile === 'object' ? structuredClone(input.operatorProfile) : {
    operator: text(input.operator || `${language}-operator`, 'operator'),
    version: 'generic-v1',
  };
  return {
    schemaVersion: SPEC_VERSION,
    title,
    goal,
    repository,
    projectRoot,
    hardware,
    metric: text(input.metric || 'latency p50', 'metric'),
    implementation: { ...implementation, id: implementation.id || language, language: requestedLanguage, entrypoints },
    operatorProfile: operator,
    sourceFiles,
    testMatrix: { ...testMatrix, testSpec },
    sourcePolicy: structuredClone(input.sourcePolicy || { mode: 'existing-source-project', strictZeroSource: false }),
    baseline: input.baseline ? structuredClone(input.baseline) : null,
    testScenario: input.testScenario ? structuredClone(input.testScenario) : { id: 'generic-operator-v1', researchEnabled: input.researchEnabled !== false },
    objective: structuredClone(input.objective || { mode: 'maximize', metric: text(input.metric || 'latency p50', 'metric'), direction: 'minimize' }),
    missionBudgetMs: input.missionBudgetMs == null ? null : Number(input.missionBudgetMs),
    start: input.start === true,
  };
};

export const GENERIC_MISSION_SPEC_VERSION = SPEC_VERSION;

export const genericMissionSpecExample = Object.freeze({
  schemaVersion: SPEC_VERSION,
  title: 'Custom operator iteration',
  goal: 'Optimize the operator while preserving the declared test contract.',
  repository: 'F:/work/my-operator-project',
  hardware: ['nvidia-gpu'],
  metric: 'latency p50',
  implementation: { language: 'python', entrypoints: ['run'], allowedFiles: ['run.py', 'oracle.py', 'deps/**'] },
  operatorProfile: { operator: 'custom.operator', version: 'v1', semantics: 'project-owned' },
  sourceFiles: [{ path: 'run.py', role: 'entrypoint' }, { path: 'oracle.py', role: 'oracle' }],
  testMatrix: { environments: ['nvidia-gpu'], testSpec: { schemaVersion: TEST_SPEC_VERSION, generation: { deterministic: true, seed: 1 }, correctness: { requestedCases: 4, requiredCategories: ['minimal', 'representative', 'boundary', 'ragged'], atol: 0.001, rtol: 0.001 }, benchmark: { requiredProfiles: ['primary', 'small', 'boundary'], primaryProfile: 'primary', warmup: 2, repeats: 5 } } },
  start: false,
});
