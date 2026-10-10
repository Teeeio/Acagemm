import path from 'node:path';
import { ACCEPTANCE_POLICY_SCHEMA, normalizeAcceptancePolicy } from '../../client-runtime/business-acceptance.mjs';
import { isKnownOperatorLanguage, normalizeOperatorLanguage } from '../../client-runtime/operator-language.mjs';
import { parsePerformanceThreshold, parseRelativeImprovementTarget } from '../../client-runtime/mission-objective.mjs';
import { createExperimentIdentity } from '../../client-runtime/generation-origin.mjs';
import { normalizeMissionTargetProfile } from '../../client-runtime/mission-target-profile.mjs';

const SPEC_VERSION = 'operator-studio.generic-mission/v1';
const TEST_SPEC_VERSION = 'operator-studio.test-spec/v1';
const own = (record, key) => record && Object.hasOwn(record, key) ? record[key] : undefined;

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
  const result = text(value, field);
  if (!path.isAbsolute(result) && !path.win32.isAbsolute(result)) fail(`${field} must be an absolute path`);
  return path.resolve(result);
};

export const normalizeSourcePath = (value, field = 'source path') => {
  const result = text(value, field).replaceAll('\\', '/');
  if (result.startsWith('/') || /[:*?\u0000-\u001f]/u.test(result)
    || result.split('/').some((part) => !part || part === '..' || part === '.' || part.toLowerCase() === '.git' || /[. ]$/u.test(part))) fail(`${field} must remain inside the repository (仓库相对路径)`);
  return result;
};

const formText = (value, field) => {
  if (typeof value !== 'string' || !value.trim() || value.length > 8000) fail(`${field} 必须明确填写 (required, max 8000 characters)`);
  return value.trim();
};
const formNumber = (value, field, { integer = false, positive = false, fraction = false } = {}) => {
  const raw = formText(value, field);
  const grammar = integer ? /^\d+$/u : /^(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/u;
  const number = Number(raw);
  if (!grammar.test(raw) || !Number.isFinite(number) || (integer && !Number.isSafeInteger(number))
    || number < 0 || (positive && number <= 0) || (fraction && (number <= 0 || number >= 1))) fail(`${field} 数值无效；${integer ? (positive ? '必须是正整数' : '必须是非负整数') : fraction ? '必须在 0 与 1 之间' : '必须是非负有限数值'}`);
  return number;
};
const formList = (value, field, separator = ',') => {
  const values = formText(value, field).split(separator).map((item) => item.trim());
  if (values.some((item) => !item) || new Set(values).size !== values.length) fail(`${field} 不允许空条目或重复条目`);
  return values;
};
const tensorList = (value, field) => formList(value, field, ';').map((entry) => {
  const match = /^([A-Za-z_][\w]*):([A-Za-z][\w]*)\[([^\]]*)\]@([^;]+)$/u.exec(entry);
  if (!match) fail(`${field} 格式：x:float32[N,K]@contiguous；多个张量用英文分号分隔`);
  const shape = !match[3].trim() ? [] : match[3].split(',').map((dimension) => {
    const item = dimension.trim();
    if (/^\d+$/u.test(item) && Number.isSafeInteger(Number(item))) return Number(item);
    if (/^[A-Za-z_]\w*$/u.test(item)) return item;
    fail(`${field} shape 只接受非负整数或命名维度`);
  });
  return { name: match[1], dtype: match[2], shape, layout: match[4].trim() };
});

const FORM_TARGETS = ['nvidia-gpu', 'C500', 'Ascend910B', 'C550', 'ascend-npu'];

// Per-dtype tolerance typed as "atol/rtol", or one number used for both. A blank
// dtype keeps the base atol/rtol; only dtypes of the declared tensors are frozen.
export const parseDtypeTolerance = (value, dtype) => {
  const raw = String(value ?? '').trim();
  if (!raw) return null;
  const parts = raw.split('/');
  if (parts.length > 2) fail(`${dtype} 容差格式：atol/rtol，或一个数同时作为两者`);
  const [atol, rtol = atol] = parts.map((part) => formNumber(part.trim(), `${dtype} 容差`));
  return { atol, rtol };
};
export const declaredTensorDtypes = (draft = {}) => Array.from(new Set(['semanticInputs', 'semanticOutputs'].flatMap((field) => {
  try { return tensorList(draft[field], field).map((tensor) => tensor.dtype); } catch { return []; }
})));
export const declaredOutputDtypes = (draft = {}) => {
  try { return [...new Set(tensorList(draft.semanticOutputs, 'semanticOutputs').map((tensor) => tensor.dtype))]; } catch { return []; }
};
// The declared tensors are frozen into the test spec so the runner can hold the
// baseline and the candidate to them (dtype and shape; named dims bind per case).
const frozenTensors = (tensors) => tensors.map(({ name, dtype, shape, layout }) => {
  if (!['contiguous', 'strided', 'channels_last', 'scalar'].includes(layout)) fail(`布局 ${layout} 暂无可执行校验，请选择 contiguous / strided / channels_last / scalar`);
  if (layout === 'scalar' && shape.length !== 0) fail('scalar 布局要求零维张量');
  if (layout === 'channels_last' && shape.length !== 4) fail('channels_last 布局要求四维张量');
  return { name, dtype, shape: [...shape], layout };
});
const TENSOR_NAME = /^[A-Za-z_]\w*$/u;

// Benchmark shapes: `benchmarkShapes: [{ name: 'small', dims: { M: '128', K: '64' } }]`.
// Each item names one benchmark profile and gives a positive value to every
// named dimension of the declared tensors, so the frozen test spec can carry the
// exact input shape of every profile and the runner can reject any other shape.
// No items means the baseline author chooses the shapes (profile names only).
const namedDimensions = (tensors) => Array.from(new Set(tensors.flatMap((tensor) => tensor.shape.filter((item) => typeof item === 'string'))));
const SHAPE_NAME = /^[A-Za-z_][\w-]*$/u;
const MAX_BENCHMARK_SHAPES = 16;
const shapeValue = (value) => String(value ?? '').trim();
const shapeDims = (item) => (item && typeof item.dims === 'object' && !Array.isArray(item.dims) ? item.dims : {});
// Per-item problems, shared by submission (benchmarkShapes) and the form's
// per-row feedback so a row shown as valid is exactly what submission accepts.
// A blank dimension value counts as missing, never as a stray dimension.
export const benchmarkShapeProblems = (draft = {}) => {
  if (draft.benchmarkShapes === undefined) return null;
  if (!Array.isArray(draft.benchmarkShapes)) return { general: 'benchmarkShapes 必须是 shape 列表', items: [] };
  const items = draft.benchmarkShapes;
  if (!items.length) return null;
  let inputs = null;
  let outputs = [];
  try { inputs = uniqueTensors(draft.semanticInputs, 'semanticInputs'); } catch { /* reported on semanticInputs */ }
  try { outputs = uniqueTensors(draft.semanticOutputs, 'semanticOutputs'); } catch { /* reported on semanticOutputs */ }
  const required = inputs ? namedDimensions([...inputs, ...outputs]) : null;
  // Only inputs whose shape moves with the profile are checked; scalars and
  // fixed-size tensors keep their declared shape in every profile.
  const varying = inputs ? inputs.filter((tensor) => tensor.shape.some((item) => typeof item === 'string')) : [];
  const general = items.length > MAX_BENCHMARK_SHAPES ? `性能 shape 最多 ${MAX_BENCHMARK_SHAPES} 个`
    : inputs && !varying.length ? '输入张量没有命名维度（如 [M,N]），无法按 shape 区分性能场景；删除全部 shape 即可' : null;
  const names = items.map((item) => shapeValue(item?.name));
  return {
    general, required, varying,
    items: items.map((item, index) => {
      const name = names[index];
      const dims = shapeDims(item);
      const keys = Array.from(new Set([...(required || []), ...Object.keys(dims).filter((dim) => shapeValue(dims[dim]))]));
      return {
        name,
        nameProblem: !name ? 'shape 名称必须填写'
          : !SHAPE_NAME.test(name) ? 'shape 名称只用字母、数字、_ 或 -，且以字母或 _ 开头'
            : names.indexOf(name) !== index ? `shape 名称「${name}」重复` : null,
        dims: Object.fromEntries(keys.map((dim) => {
          const raw = shapeValue(own(dims, dim));
          if (required && !required.includes(dim)) return [dim, `张量中已没有维度 ${dim}；清空此项`];
          if (!raw) return [dim, `缺少维度 ${dim} 的数值`];
          if (!/^\d+$/u.test(raw) || !Number.isSafeInteger(Number(raw)) || Number(raw) < 1) return [dim, `维度 ${dim} 必须是正整数`];
          return [dim, null];
        })),
      };
    }),
  };
};
const benchmarkShapes = (draft) => {
  const problems = benchmarkShapeProblems(draft);
  if (!problems) return null;
  if (problems.general) fail(problems.general);
  problems.items.forEach((item, index) => {
    if (item.nameProblem) fail(`第 ${index + 1} 个性能 shape：${item.nameProblem}`);
    const dimProblem = Object.values(item.dims).find(Boolean);
    if (dimProblem) fail(`性能 shape「${item.name}」${dimProblem}`);
  });
  return problems.items.map((item, index) => {
    const values = shapeDims(draft.benchmarkShapes[index]);
    const dims = Object.fromEntries(Object.keys(item.dims).map((dim) => [dim, Number(shapeValue(values[dim]))]));
    return {
      name: item.name, dims,
      inputShapes: Object.fromEntries(problems.varying.map((tensor) => [tensor.name, tensor.shape.map((entry) => (typeof entry === 'string' ? dims[entry] : entry))])),
    };
  });
};
const declaredShapes = (draft) => { try { return benchmarkShapes(draft); } catch { return null; } };
const knownLanguage = (value) => typeof value === 'string' && value.trim() && isKnownOperatorLanguage({ language: value.trim() });
const uniqueTensors = (value, field) => {
  const entries = tensorList(value, field);
  if (new Set(entries.map((entry) => entry.name)).size !== entries.length) fail(`${field} 张量名称不能重复`);
  return entries;
};
const formBaseline = (draft) => {
  if (draft.sourceMode === 'managed' && !draft.baselineFile?.trim() && draft.execution === 'save') return null;
  const baselineFile = normalizeSourcePath(formText(draft.baselineFile, 'baselineFile'), 'baselineFile');
  if (draft.sourceMode === 'managed' && !draft.importedFiles?.some((file) => file.path === baselineFile)) fail('请从已导入素材中选择独立基线');
  if (knownLanguage(draft.language)) {
    const writable = new Set(normalizeOperatorLanguage({ language: draft.language.trim() }).allowedFiles.map((name) => name.toLowerCase()));
    if (writable.has(baselineFile.toLowerCase())) fail('独立 baselineFile 不能是候选允许写入的文件', 'GENERIC_BASELINE_NOT_INDEPENDENT');
  }
  return baselineFile;
};

// One rule per form field. The specification builder below and the TUI's
// per-field feedback call the same rule, so a field shown as valid is exactly
// what submission accepts for that field. Cross-field checks that depend on a
// sibling (baseline vs. writable files, dependencies vs. baseline, primary vs.
// required profiles) run when that sibling is itself valid.
const formFieldRules = Object.freeze({
  execution: (draft) => (['save', 'generate-only', 'start'].includes(draft.execution) ? draft.execution : fail('请选择保存、仅生成或启动本地迭代')),
  language: (draft) => {
    const language = formText(draft.language, 'language');
    if (!isKnownOperatorLanguage({ language })) fail('请选择实现语言', 'GENERIC_MISSION_LANGUAGE_UNSUPPORTED');
    return language;
  },
  target: (draft) => {
    const target = formText(draft.target, 'target');
    return FORM_TARGETS.includes(target) ? target : fail('请选择目标硬件');
  },
  targetArchitecture: (draft) => {
    const architecture = draft.targetArchitecture;
    if (architecture == null || (typeof architecture === 'string' && !architecture.trim())) return null;
    return normalizeMissionTargetProfile({ architecture }, [draft.target]);
  },
  repository: (draft) => {
    if (draft.sourceMode === 'managed' && !draft.repository) return path.resolve('__operator_studio_managed_draft__');
    const repository = formText(draft.repository, 'repository');
    absolutePath(repository, 'repository');
    return repository;
  },
  operator: (draft) => formText(draft.operator, 'operator'),
  goal: (draft) => formText(draft.goal, 'goal'),
  baselineFile: formBaseline,
  dependencyFiles: (draft) => {
    if (draft.sourceMode === 'managed') return (draft.importedFiles || []).map((file) => normalizeSourcePath(file.path))
      .filter((name) => name !== 'run.py' && name !== draft.baselineFile);
    if (!draft.dependencyFiles?.trim()) return [];
    const dependencies = formList(draft.dependencyFiles, 'dependencyFiles').map((entry) => normalizeSourcePath(entry));
    let baselineFile = null;
    try { baselineFile = normalizeSourcePath(formText(draft.baselineFile, 'baselineFile'), 'baselineFile').toLowerCase(); } catch { /* reported on baselineFile */ }
    const reserved = ['run.py', baselineFile].filter(Boolean);
    if (dependencies.some((entry) => reserved.includes(entry.toLowerCase()))
      || new Set(dependencies.map((entry) => entry.toLowerCase())).size !== dependencies.length) fail('dependencyFiles 不得重复入口、基线或其他文件');
    return dependencies;
  },
  semanticInputs: (draft) => frozenTensors(uniqueTensors(draft.semanticInputs, 'semanticInputs')),
  semanticOutputs: (draft) => frozenTensors(uniqueTensors(draft.semanticOutputs, 'semanticOutputs')),
  semanticMath: (draft) => formText(draft.semanticMath, 'semanticMath'),
  semanticConstraints: (draft) => formList(draft.semanticConstraints, 'semanticConstraints', ';'),
  semanticBoundaries: (draft) => formList(draft.semanticBoundaries, 'semanticBoundaries', ';'),
  seed: (draft) => formNumber(draft.seed, 'seed', { integer: true }),
  requestedCases: (draft) => formNumber(draft.requestedCases, 'requestedCases', { integer: true, positive: true }),
  requiredCategories: (draft) => {
    const categories = formList(draft.requiredCategories, 'requiredCategories');
    let cases = null;
    try { cases = formNumber(draft.requestedCases, 'requestedCases', { integer: true, positive: true }); } catch { /* reported on requestedCases */ }
    if (cases !== null && categories.length > cases) fail(`必测类别有 ${categories.length} 类，正确性数量至少要 ${categories.length}（每类至少一个用例）`);
    return categories;
  },
  atol: (draft) => formNumber(draft.atol, 'atol'),
  rtol: (draft) => formNumber(draft.rtol, 'rtol'),
  cosineTolerance: (draft) => formNumber(draft.cosineTolerance ?? '1e-5', 'cosineTolerance', { positive: true }),
  dtypeTolerance: (draft) => {
    const values = draft.dtypeTolerance && typeof draft.dtypeTolerance === 'object' && !Array.isArray(draft.dtypeTolerance) ? draft.dtypeTolerance : {};
    const entries = declaredOutputDtypes(draft).map((dtype) => [dtype, parseDtypeTolerance(own(values, dtype), dtype)]).filter(([, tolerance]) => tolerance);
    return entries.length ? Object.fromEntries(entries) : null;
  },
  benchmarkShapes,
  // Declared shapes are the benchmark profiles; the separate name list is then unused.
  requiredProfiles: (draft) => {
    const shapes = benchmarkShapes(draft);
    return shapes ? shapes.map((shape) => shape.name) : formList(draft.requiredProfiles, 'requiredProfiles');
  },
  primaryProfile: (draft) => {
    const primary = formText(draft.primaryProfile, 'primaryProfile');
    let profiles = declaredShapes(draft)?.map((shape) => shape.name) || null;
    if (!profiles) try { profiles = formList(draft.requiredProfiles, 'requiredProfiles'); } catch { /* reported on requiredProfiles */ }
    if (profiles && !profiles.includes(primary)) fail(`primaryProfile 必须是性能场景之一：${profiles.join(', ')}`);
    return primary;
  },
  acceptancePolicyMode: (draft) => {
    const mode = draft.acceptancePolicyMode ?? 'legacy';
    if (!['legacy', 'protected'].includes(mode)) fail('请选择旧任务策略或保护场景策略');
    return mode;
  },
  protectedProfiles: (draft) => {
    if ((draft.acceptancePolicyMode ?? 'legacy') !== 'protected') return null;
    const required = formFieldRules.requiredProfiles(draft);
    const primary = formFieldRules.primaryProfile(draft);
    const profiles = String(draft.protectedProfiles || '').trim() === 'all' ? required : formList(draft.protectedProfiles, 'protectedProfiles');
    if (profiles.some((name) => !required.includes(name)) || !profiles.includes(primary)) fail('保护场景必须来自性能场景，并包含主场景；填写 all 保护全部场景');
    return profiles;
  },
  maxRegressionPercent: (draft) => {
    if ((draft.acceptancePolicyMode ?? 'legacy') !== 'protected') return null;
    const percent = formNumber(draft.maxRegressionPercent, '允许退化百分比');
    if (percent >= 100) fail('允许退化百分比必须在 0（不允许退化）与 100 之间');
    return percent;
  },
  warmup: (draft) => formNumber(draft.warmup, 'warmup', { integer: true, positive: true }),
  repeats: (draft) => formNumber(draft.repeats, 'repeats', { integer: true, positive: true }),
  settleTolerance: (draft) => formNumber(draft.settleTolerance, 'settleTolerance', { fraction: true }),
  maxSettlements: (draft) => formNumber(draft.maxSettlements, 'maxSettlements', { integer: true, positive: true }),
  timeBudget: (draft) => (draft.timeBudget ? formNumber(draft.timeBudget, 'timeBudget', { integer: true, positive: true }) : null),
});

// Presentation feedback only: returns the message submission would raise for
// this one field, or null. It never replaces missionSpecificationFromForm.
export const checkMissionFormField = (draft = {}, field) => {
  const rule = formFieldRules[field];
  if (!rule) return null;
  try { rule(draft); return null; } catch (error) { return error.message; }
};

// Pure form -> the same generic Mission specification. No file reads, inferred
// test coverage, fixed Profile defaults, materializer status or execution here.
export const missionSpecificationFromForm = (draft = {}) => {
  const rule = (field) => formFieldRules[field](draft);
  rule('execution');
  const language = rule('language');
  const target = rule('target');
  const targetProfile = rule('targetArchitecture');
  const operator = rule('operator');
  const baselineFile = rule('baselineFile');
  const dependencies = rule('dependencyFiles');
  const adapter = normalizeOperatorLanguage({ language });
  const inputs = rule('semanticInputs');
  const outputs = rule('semanticOutputs');
  const shapes = rule('benchmarkShapes');
  const dtypeTolerance = rule('dtypeTolerance');
  const goal = rule('goal');
  const targetLatencyUs = parsePerformanceThreshold({ goal });
  const targetRelativeImprovement = parseRelativeImprovementTarget({ goal });
  const acceptancePolicy = rule('acceptancePolicyMode') === 'protected' ? normalizeAcceptancePolicy({
    schemaVersion: ACCEPTANCE_POLICY_SCHEMA, protectedProfiles: rule('protectedProfiles'), maxRegressionFraction: rule('maxRegressionPercent') / 100,
    successTarget: targetLatencyUs !== null ? { mode: 'latency-limit', value: targetLatencyUs }
      : targetRelativeImprovement !== null ? { mode: 'relative-improvement', value: targetRelativeImprovement } : { mode: 'strict-improvement' },
  }, { requiredProfiles: rule('requiredProfiles'), primaryProfile: rule('primaryProfile') }) : null;
  return normalizeGenericMissionSpecification({
    schemaVersion: SPEC_VERSION,
    repository: rule('repository'), goal,
    objective: { mode: targetLatencyUs !== null || targetRelativeImprovement !== null ? 'threshold' : 'maximize', metric: 'latency p50', direction: 'minimize',
      ...(targetLatencyUs !== null ? { targetLatencyUs } : {}), ...(targetRelativeImprovement !== null ? { targetRelativeImprovement } : {}) },
    implementation: { language: adapter.id, entrypoints: ['run'] }, hardware: [target],
    ...(targetProfile ? { targetProfile } : {}),
    operatorProfile: { operator, version: 'generic-v1' },
    sourceFiles: [{ path: 'run.py', role: 'entrypoint' }, ...dependencies.map((file) => ({ path: file, role: 'dependency' })), ...(baselineFile ? [{ path: baselineFile, role: 'oracle' }] : [])],
    ...(baselineFile ? { baselineFile } : {}),
    semanticDraft: { operator, inputs, outputs,
      math: { formula: rule('semanticMath') },
      invariants: rule('semanticConstraints'),
      edgeCases: { behavior: rule('semanticBoundaries') },
    },
    testMatrix: { environments: [target], testSpec: {
      schemaVersion: TEST_SPEC_VERSION,
      ...(acceptancePolicy ? { acceptancePolicy } : {}),
      generation: { deterministic: true, seed: rule('seed') },
      correctness: {
        requestedCases: rule('requestedCases'),
        requiredCategories: rule('requiredCategories'),
        atol: rule('atol'), rtol: rule('rtol'),
        toleranceScope: 'output-dtype', requireCosDiffBelow: rule('cosineTolerance'),
        ...(dtypeTolerance ? { dtypeTolerance } : {}),
        tensors: { inputs: frozenTensors(inputs), outputs: frozenTensors(outputs) },
      },
      benchmark: {
        requiredProfiles: rule('requiredProfiles'), primaryProfile: rule('primaryProfile'),
        warmup: rule('warmup'),
        repeats: rule('repeats'),
        settleTolerance: rule('settleTolerance'),
        maxSettlements: rule('maxSettlements'),
        ...(shapes ? { shapes } : {}),
      },
    } },
    missionBudgetMs: rule('timeBudget'),
    executionMode: draft.execution === 'generate-only' ? 'generate-only' : 'iterate',
    start: draft.execution !== 'save',
  });
};

const validateTestSpec = (matrix) => {
  const spec = matrix?.testSpec;
  if (!spec || spec.schemaVersion !== TEST_SPEC_VERSION) fail(`testMatrix.testSpec must use ${TEST_SPEC_VERSION}`);
  const correctness = spec.correctness || {};
  const benchmark = spec.benchmark || {};
  if (spec.generation?.deterministic !== true || !Number.isSafeInteger(spec.generation?.seed) || spec.generation.seed < 0) fail('testSpec.generation must declare deterministic=true and a non-negative integer seed');
  for (const field of ['atol', 'rtol']) if (!Number.isFinite(correctness[field]) || correctness[field] < 0) fail(`testSpec.correctness.${field} must be a non-negative finite number`);
  if (!Number.isSafeInteger(correctness.requestedCases) || correctness.requestedCases < 1) fail('testSpec.correctness.requestedCases must be a positive integer');
  const names = (value) => Array.isArray(value) && value.length > 0 && value.every((name) => typeof name === 'string' && name.trim());
  if (!names(correctness.requiredCategories)) fail('testSpec.correctness.requiredCategories must contain non-empty names');
  if (correctness.requiredCategories.length > correctness.requestedCases) fail('testSpec.correctness.requestedCases must be at least the number of requiredCategories');
  const plain = (value) => value && typeof value === 'object' && !Array.isArray(value);
  const tolerance = (value) => Number.isFinite(value) && value >= 0;
  if (correctness.toleranceScope !== undefined && correctness.toleranceScope !== 'output-dtype') fail('unsupported correctness.toleranceScope');
  if (correctness.dtypeTolerance !== undefined && !(plain(correctness.dtypeTolerance)
    && Object.values(correctness.dtypeTolerance).every((entry) => plain(entry) && tolerance(entry.atol) && tolerance(entry.rtol)))) fail('testSpec.correctness.dtypeTolerance must map dtype names to non-negative finite {atol, rtol}');
  if (correctness.requireCosDiffBelow !== undefined && !(Number.isFinite(correctness.requireCosDiffBelow) && correctness.requireCosDiffBelow > 0)) fail('testSpec.correctness.requireCosDiffBelow must be a positive finite number');
  if (correctness.tensors !== undefined) {
    const side = (list) => Array.isArray(list) && list.length > 0 && new Set(list.map((tensor) => tensor?.name)).size === list.length
      && list.every((tensor) => plain(tensor) && TENSOR_NAME.test(String(tensor.name)) && typeof tensor.dtype === 'string' && TENSOR_NAME.test(tensor.dtype)
        && Array.isArray(tensor.shape) && tensor.shape.every((dim) => (Number.isSafeInteger(dim) && dim >= 0) || (typeof dim === 'string' && TENSOR_NAME.test(dim)))
        && (tensor.layout === undefined || ['contiguous', 'strided', 'channels_last', 'scalar'].includes(tensor.layout))
        && (tensor.layout !== 'scalar' || tensor.shape.length === 0)
        && (tensor.layout !== 'channels_last' || tensor.shape.length === 4));
    if (!plain(correctness.tensors) || !side(correctness.tensors.inputs) || !side(correctness.tensors.outputs)) fail('testSpec.correctness.tensors must list {name, dtype, shape} inputs and outputs with integer or named dimensions');
  }
  if (!names(benchmark.requiredProfiles)) fail('testSpec.benchmark.requiredProfiles must contain non-empty names');
  if (!benchmark.primaryProfile || !benchmark.requiredProfiles.includes(benchmark.primaryProfile)) fail('testSpec.benchmark.primaryProfile must be one of requiredProfiles');
  if (spec.acceptancePolicy != null) normalizeAcceptancePolicy(spec.acceptancePolicy, benchmark);
  if (!Number.isSafeInteger(benchmark.warmup) || benchmark.warmup < 1 || !Number.isSafeInteger(benchmark.repeats) || benchmark.repeats < 1) fail('testSpec benchmark warmup/repeats must be positive integers');
  if (benchmark.settleTolerance !== undefined && (!Number.isFinite(benchmark.settleTolerance) || benchmark.settleTolerance <= 0 || benchmark.settleTolerance >= 1)) fail('benchmark.settleTolerance must be between 0 and 1');
  if (benchmark.maxSettlements !== undefined && (!Number.isSafeInteger(benchmark.maxSettlements) || benchmark.maxSettlements < 1)) fail('benchmark.maxSettlements must be a positive integer');
  if (benchmark.shapes !== undefined) {
    const dims = (value) => value && typeof value === 'object' && !Array.isArray(value);
    const valid = Array.isArray(benchmark.shapes) && benchmark.shapes.length === benchmark.requiredProfiles.length
      && benchmark.shapes.every((shape, index) => dims(shape) && shape.name === benchmark.requiredProfiles[index]
        && dims(shape.dims) && Object.values(shape.dims).every((item) => Number.isSafeInteger(item) && item > 0)
        && dims(shape.inputShapes) && Object.keys(shape.inputShapes).length > 0
        && Object.values(shape.inputShapes).every((tensor) => Array.isArray(tensor) && tensor.every((item) => Number.isSafeInteger(item) && item >= 0)));
    if (!valid) fail('testSpec.benchmark.shapes must list one {name, dims, inputShapes} per requiredProfiles entry, in the same order, with integer dimensions');
  }
  for (const [field, declared] of [['correctnessCases', correctness.requestedCases], ['warmup', benchmark.warmup], ['repeats', benchmark.repeats], ['settleTolerance', benchmark.settleTolerance], ['maxSettlements', benchmark.maxSettlements]]) {
    if (matrix[field] !== undefined && matrix[field] !== declared) fail(`testMatrix.${field} conflicts with testSpec`);
  }
  return structuredClone(spec);
};

export const normalizeGenericMissionSpecification = (input = {}) => {
  if (input.schemaVersion !== SPEC_VERSION) fail(`schemaVersion must be ${SPEC_VERSION}`);
  const goal = text(input.goal, 'goal');
  const title = text(input.title || goal.slice(0, 80), 'title');
  const repository = absolutePath(input.repository || input.projectRoot, 'repository');
  const projectRoot = absolutePath(input.projectRoot || (path.basename(repository).toLowerCase() === 'repository' ? path.dirname(repository) : repository), 'projectRoot');
  const implementation = input.implementation && typeof input.implementation === 'object' ? structuredClone(input.implementation) : fail('implementation is required');
  // The alias table lives only in the adapter registry. A second copy here could
  // accept a language the registry does not resolve (or refuse one it does), and
  // the store's create path would then reject a Mission this API had just
  // normalized. `language` below is the canonical id, so the stored record and the
  // validated value are the same value.
  const requestedLanguage = text(implementation.language, 'implementation.language').toLowerCase();
  if (!isKnownOperatorLanguage({ language: requestedLanguage })) fail(`unsupported implementation.language: ${requestedLanguage}`, 'GENERIC_MISSION_LANGUAGE_UNSUPPORTED');
  const language = normalizeOperatorLanguage({ language: requestedLanguage }).id;
  const entrypoints = Array.isArray(implementation.entrypoints) && implementation.entrypoints.length
    ? implementation.entrypoints.map((item) => text(item, 'implementation.entrypoints[]'))
    : ['run'];
  const hardware = Array.isArray(input.hardware) && input.hardware.length ? input.hardware.map(String) : ['nvidia-gpu'];
  const targetProfile = normalizeMissionTargetProfile(input.targetProfile, hardware);
  const testMatrix = structuredClone(input.testMatrix || {});
  const testSpec = validateTestSpec(testMatrix);
  const sourceFiles = Array.isArray(input.sourceFiles) ? input.sourceFiles.map((item) => {
    if (!item || typeof item !== 'object') fail('sourceFiles entries must be objects');
    const relativePath = text(item.path, 'sourceFiles[].path').replaceAll('\\', '/');
    if (relativePath.startsWith('/') || relativePath.includes(':') || relativePath.split('/').some((part) => !part || part === '..' || part === '.')) fail('sourceFiles paths must remain inside the repository');
    return { path: relativePath, role: String(item.role || 'dependency') };
  }) : [];
  if (!sourceFiles.some((item) => item.role === 'entrypoint')) fail('sourceFiles must declare at least one entrypoint file');
  if (input.missionBudgetMs != null && (!Number.isSafeInteger(Number(input.missionBudgetMs)) || Number(input.missionBudgetMs) <= 0)) fail('missionBudgetMs must be a positive integer or null');
  const operator = input.operatorProfile && typeof input.operatorProfile === 'object' ? structuredClone(input.operatorProfile) : {
    operator: text(input.operator || `${language}-operator`, 'operator'),
    version: 'generic-v1',
  };
  const executionMode = input.executionMode ?? 'iterate';
  if (!['generate-only', 'iterate'].includes(executionMode)) fail('executionMode must be generate-only or iterate');
  if (input.semanticDraft !== undefined && (!input.semanticDraft || typeof input.semanticDraft !== 'object' || Array.isArray(input.semanticDraft))) fail('semanticDraft must be an object');
  if (input.experiment !== undefined) createExperimentIdentity(input.experiment);
  return {
    schemaVersion: SPEC_VERSION,
    title,
    goal,
    repository,
    projectRoot,
    hardware,
    ...(targetProfile ? { targetProfile } : {}),
    metric: text(input.metric || 'latency p50', 'metric'),
    implementation: { ...implementation, id: implementation.id || language, language: requestedLanguage, entrypoints },
    operatorProfile: operator,
    sourceFiles,
    testMatrix: { ...testMatrix, testSpec },
    sourcePolicy: structuredClone(input.sourcePolicy || { mode: 'existing-source-project', strictZeroSource: false }),
    baseline: input.baseline ? structuredClone(input.baseline) : null,
    ...(input.baselineFile !== undefined ? { baselineFile: normalizeSourcePath(input.baselineFile, 'baselineFile') } : {}),
    ...(input.semanticDraft !== undefined ? { semanticDraft: structuredClone(input.semanticDraft) } : {}),
    executionMode,
    ...(input.experiment !== undefined ? { experiment: structuredClone(input.experiment) } : {}),
    testScenario: input.testScenario ? structuredClone(input.testScenario) : { id: 'generic-operator-v1' },
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
