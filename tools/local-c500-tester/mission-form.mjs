import { tuiOperatorProfiles } from '../../client-runtime/fixed-operator-profiles.mjs';
import { benchmarkShapeProblems, checkMissionFormField, declaredOutputDtypes, missionSpecificationFromForm, parseDtypeTolerance } from './mission-spec.mjs';
import { normalizeOperatorLanguage } from '../../client-runtime/operator-language.mjs';
import { describeMissionGoal } from '../../client-runtime/mission-objective.mjs';
import { missionArchitectureSuggestions } from '../../client-runtime/mission-target-profile.mjs';

const own = (record, key) => record && Object.hasOwn(record, key) ? record[key] : undefined;

// UI-only draft editing. Reading specifications, importing sources and validating
// frozen tests or execution capability belong to the Production API.
export const createMissionDraft = () => ({
  mode: 'generic', inputMode: 'form', specPath: '', repository: '', operator: '', goal: '',
  goalPreset: 'custom', goalValue: '', goalCustom: '',
  sourceMode: 'managed', sourceSelections: [], importedFiles: [],
  language: '', target: '', targetArchitecture: '', execution: 'save', timeBudget: '',
  dependencyFiles: '', baselineFile: '', semanticInputs: '', semanticOutputs: '', benchmarkShapes: [], semanticMath: '',
  semanticConstraints: '', semanticBoundaries: '', seed: '', requestedCases: '', requiredCategories: '',
  atol: '', rtol: '', requiredProfiles: '', primaryProfile: '', warmup: '', repeats: '',
  cosineTolerance: '1e-5', acceptancePolicyMode: 'protected', protectedProfiles: 'all', maxRegressionPercent: '0',
  settleTolerance: '', maxSettlements: '', measurementTier: '', dtypeTolerance: {},
  profileId: tuiOperatorProfiles[0].id, webResearchEnabled: false, requireAuthority: false,
});

const choices = Object.freeze({
  mode: ['generic', 'fixed-example'],
  inputMode: ['form', 'spec-file'],
  language: ['', 'pytorch-python', 'cuda-cpp-extension', 'triton', 'mxmaca-cpp-extension', 'ascend-cpp-extension'],
  target: ['', 'nvidia-gpu', 'C500', 'Ascend910B', 'C550', 'ascend-npu'],
  execution: ['save', 'generate-only', 'start'],
  acceptancePolicyMode: ['legacy', 'protected'],
  profileId: tuiOperatorProfiles.map((profile) => profile.id),
  webResearchEnabled: [false, true], requireAuthority: [false, true],
});
const labels = Object.freeze({
  sourceFiles: '导入素材 / Materials',
  mode: '任务类型 / Mode', specPath: '规格文件 / Spec', repository: '源码仓库 / Repository',
  operator: '算子 / Operator', goal: '目标 / Goal', language: '语言 / Language',
  target: '目标硬件 / Target', targetArchitecture: '目标架构（可选）', execution: '提交方式 / Action', timeBudget: '预算毫秒 / Budget',
  profileId: '固定示例 / Example', webResearchEnabled: '联网调研 / Research', requireAuthority: '权威来源 / Authority',
  inputMode: '填写方式 / Input', dependencyFiles: '依赖文件 / Dependencies', baselineFile: '独立基线 / Baseline file',
  semanticInputs: '输入张量 / Inputs', semanticOutputs: '输出张量 / Outputs', shapeAdd: '性能 shape / Shapes', semanticMath: '计算语义 / Math',
  semanticConstraints: '不变约束 / Constraints', semanticBoundaries: '边界行为 / Boundaries',
  seed: '确定性种子 / Seed', requestedCases: '正确性数量 / Cases', requiredCategories: '必测类别 / Categories',
  atol: '绝对容差 / atol', rtol: '相对容差 / rtol', requiredProfiles: '性能场景 / Profiles',
  primaryProfile: '主场景 / Primary', warmup: '预热次数 / Warmup', repeats: '测量次数 / Repeats',
  settleTolerance: '测量收敛容差 / Settle tolerance', maxSettlements: '收敛次数上限 / Max settlements',
  measurementTier: '测量强度 / Measurement',
  acceptancePolicyMode: '业务验收策略', protectedProfiles: '必保护场景', maxRegressionPercent: '允许延迟退化 / %',
  cosineTolerance: '余弦误差上限 / Cosine',
});
const choiceLabels = Object.freeze({
  generic: '通用任务 (generic)', 'fixed-example': 'C550 固定示例 (fixed example)',
  form: '交互填写 (form)', 'spec-file': '导入已有规格 (spec-file)',
  'from-spec': '沿用规格 (from spec)', save: '保存任务 (save)', start: '启动本地迭代 (start)',
  'generate-only': '仅生成候选 (generate-only)', legacy: '沿用旧任务主场景策略', protected: '保护场景并冻结目标',
  'nvidia-gpu': 'NVIDIA GPU', C500: '沐曦 C500 · 待机器验证', Ascend910B: '昇腾 910B · 待机器验证', C550: '沐曦 C550（历史固定示例）', 'ascend-npu': '昇腾 Ascend · 待验证',
});
// Compact names for inline option lists; the full label stays in choiceLabels.
const optionLabels = Object.freeze({
  generic: '通用任务', 'fixed-example': 'C550 示例', form: '交互填写', 'spec-file': '导入规格',
  'pytorch-python': 'PyTorch', 'cuda-cpp-extension': 'CUDA C++', triton: 'Triton', 'mxmaca-cpp-extension': 'MXMACA C++', 'ascend-cpp-extension': 'Ascend C++',
  'nvidia-gpu': 'NVIDIA GPU', C500: '沐曦 C500 · 待机器验证', Ascend910B: '昇腾 910B · 待机器验证', C550: '沐曦 C550（历史固定示例）', 'ascend-npu': '昇腾(待验证)',
  save: '保存', 'generate-only': '仅生成候选', start: '启动本地迭代', legacy: '旧策略', protected: '保护场景',
});
// Dim examples shown in empty fields. Never submitted and never auto-filled:
// every semantic and test value must still be typed explicitly.
const placeholders = Object.freeze({
  specPath: 'F:/work/task.generic-mission.json', repository: 'F:/work/my-operator', operator: 'affine',
  goal: '在保持语义的前提下降低延迟', dependencyFiles: '留空 = 无额外依赖；如 operator.cu, deps/helper.py', baselineFile: 'reference.py',
  semanticInputs: 'x:float32[N,K]@contiguous; s:float32[]@scalar', semanticOutputs: 'y:float32[N,K]@contiguous',
  semanticMath: 'y = x * s', semanticConstraints: '保持 dtype; 不修改输入', semanticBoundaries: 'N=0 返回空张量',
  seed: '0', requestedCases: '24', requiredCategories: 'minimal,boundary', atol: '1e-3', rtol: '1e-3',
  protectedProfiles: 'all 或 primary,small；必须包含主场景', maxRegressionPercent: '0 = 不允许退化；如 5',
  requiredProfiles: 'primary,small', primaryProfile: '上面性能场景中的一个', warmup: '50', repeats: '200',
  settleTolerance: '0.02', maxSettlements: '8', timeBudget: '留空 = 不设总预算；如 3600000',
});

// Common operator names offered as a starting point. Only a name: semantics,
// shapes and tests are still typed explicitly on the later pages.
const operatorSuggestions = Object.freeze(['matmul', 'softmax', 'layer_norm', 'rms_norm', 'attention', 'gelu', 'affine']);

// Goal templates. They only write goal text; what that text means is read back
// from the Runtime (describeMissionGoal), the same functions the Accept Gate uses.
const goalPresets = Object.freeze([
  { id: 'custom', label: '自定义' },
  { id: 'maximize', label: '持续优化', compose: () => '在保持语义的前提下持续优化延迟，越低越好' },
  { id: 'relative', label: '相对基线提升', unit: '%', compose: (value) => `在保持语义的前提下，延迟相对基线至少提升 ${value}%` },
  { id: 'absolute', label: '延迟上限', unit: 'us', compose: (value) => `在保持语义的前提下，延迟低于 ${value} us` },
]);
// Common test values. ←→ writes one into the field as an explicit pick; the
// same submission rule still checks it, and nothing is pre-filled.
const valuePresets = Object.freeze({
  seed: ['0', '1', '42'],
  requestedCases: ['8', '24', '64'],
  requiredCategories: ['minimal,boundary', 'minimal,representative,boundary', 'minimal,representative,boundary,ragged'],
  atol: ['1e-5', '1e-4', '1e-3', '1e-2', '0'],
  rtol: ['1e-5', '1e-4', '1e-3', '1e-2', '0'],
  requiredProfiles: ['primary', 'primary,small', 'primary,small,large'],
  warmup: ['10', '50', '100'],
  repeats: ['100', '200', '500'],
  settleTolerance: ['0.01', '0.02', '0.05'],
  maxSettlements: ['4', '8', '16'], maxRegressionPercent: ['0', '1', '5', '10'],
});
// Keep invalid numeric input visible for validation; never silently change values.

// Measurement tiers. Picking one writes its four concrete values into the draft
// (an explicit pick, frozen as numbers); 自定义 shows each value for editing.
const measurementFields = ['warmup', 'repeats', 'settleTolerance', 'maxSettlements'];
const measurementTiers = Object.freeze([
  { id: 'quick', label: '快速', values: { warmup: '10', repeats: '100', settleTolerance: '0.05', maxSettlements: '4' } },
  { id: 'standard', label: '标准', values: { warmup: '50', repeats: '200', settleTolerance: '0.02', maxSettlements: '8' } },
  { id: 'strict', label: '严格', values: { warmup: '100', repeats: '500', settleTolerance: '0.01', maxSettlements: '16' } },
  { id: 'custom', label: '自定义' },
]);
const tierOf = (draft = {}) => measurementTiers.find((tier) => tier.id === draft.measurementTier) || null;
// Blank (nothing picked yet) also shows the four rows, so each can be typed.
const measurementRowsShown = (draft) => !tierOf(draft)?.values;
const tierSummary = (draft) => `预热 ${draft.warmup || '?'} · 测量 ${draft.repeats || '?'} · 收敛容差 ${draft.settleTolerance || '?'} · 收敛上限 ${draft.maxSettlements || '?'}`;

// Correctness categories toggled with digit keys; typed custom categories stay.
const categoryDescriptions = Object.freeze([
  ['minimal', '最小规模'], ['representative', '典型规模'], ['boundary', '边界值（空、单元素、极值）'], ['ragged', '不规则 / 非对齐尺寸'],
]);
const categoryItems = (draft) => String(draft.requiredCategories || '').split(/[,，]/u).map((item) => item.trim());
const toggleCategory = (draft, name) => {
  const items = categoryItems(draft).filter(Boolean);
  const next = items.includes(name) ? items.filter((item) => item !== name) : [...items, name];
  const known = categoryDescriptions.map(([category]) => category);
  return [...known.filter((category) => next.includes(category)), ...next.filter((item) => !known.includes(item))].join(',');
};
// Digits toggle only while the text is blank or a complete list of known names,
// so a typed custom category can still contain digits.
const categoryTogglesActive = (draft) => {
  const items = categoryItems(draft);
  return !String(draft.requiredCategories || '').trim() || items.every((item) => categoryDescriptions.some(([category]) => category === item));
};
const categoriesNote = (draft) => {
  const described = Object.fromEntries(categoryDescriptions);
  const items = categoryItems(draft).filter(Boolean);
  return { tone: 'ok', text: `✓ ${items.length} 类：${items.map((item) => (own(described, item) ? `${item} ${own(described, item)}` : item)).join('、')}；每类至少一个用例` };
};

// Per-dtype tolerance rows `tol:<dtype>`, one per dtype of the declared tensors.
const tolFieldOf = (field) => (/^tol:([A-Za-z]\w*)$/u.exec(String(field)) || [])[1] || null;
const toleranceFields = (draft) => declaredOutputDtypes(draft).map((dtype) => `tol:${dtype}`);
const tolValueOf = (draft, dtype) => String(own(draft.dtypeTolerance, dtype) ?? '');
const withTolerance = (draft, dtype, value) => ({ ...draft, dtypeTolerance: { ...(draft.dtypeTolerance || {}), [dtype]: value } });
const tolerancePresets = (dtype) => (own({ float32: ['1e-4', '1e-5'], float16: ['1e-3', '1e-2'], bfloat16: ['1e-2', '2e-2'], float64: ['1e-7', '1e-6'] }, dtype)
  || (/^u?int|^bool$/u.test(dtype) ? ['0'] : ['1e-3']));

// Starting semantics for the suggested operators, written in the form's own
// syntax. A template is only a pick the user makes and can edit; it must still
// match what the independent baseline actually computes.
const semanticTemplates = Object.freeze({
  matmul: {
    inputs: 'a:float32[M,K]@contiguous; b:float32[K,N]@contiguous', outputs: 'c:float32[M,N]@contiguous',
    math: 'c[m,n] = Σ_k a[m,k] * b[k,n]',
    constraints: '输出 dtype 与输入一致; 不修改输入; 累加精度不低于 float32', boundaries: 'M=0 返回空张量; K=0 输出全 0; N=0 返回空张量',
  },
  softmax: {
    inputs: 'x:float32[M,N]@contiguous', outputs: 'y:float32[M,N]@contiguous',
    math: 'y[m,n] = exp(x[m,n] - max_j x[m,j]) / Σ_j exp(x[m,j] - max_j x[m,j])（沿最后一维）',
    constraints: '输出 dtype 与输入一致; 不修改输入; 每行之和为 1', boundaries: 'M=0 返回空张量; N=1 时输出全 1',
  },
  layer_norm: {
    inputs: 'x:float32[M,N]@contiguous; weight:float32[N]@contiguous; bias:float32[N]@contiguous', outputs: 'y:float32[M,N]@contiguous',
    math: 'y = (x - mean(x)) / sqrt(var(x) + 1e-5) * weight + bias（沿最后一维，有偏方差）',
    constraints: '输出 dtype 与输入一致; 不修改输入', boundaries: 'M=0 返回空张量',
  },
  rms_norm: {
    inputs: 'x:float32[M,N]@contiguous; weight:float32[N]@contiguous', outputs: 'y:float32[M,N]@contiguous',
    math: 'y = x / sqrt(mean(x^2) + 1e-6) * weight（沿最后一维）',
    constraints: '输出 dtype 与输入一致; 不修改输入', boundaries: 'M=0 返回空张量',
  },
  attention: {
    inputs: 'q:float32[B,H,S,D]@contiguous; k:float32[B,H,S,D]@contiguous; v:float32[B,H,S,D]@contiguous', outputs: 'o:float32[B,H,S,D]@contiguous',
    math: 'o = softmax(q @ kᵀ / sqrt(D)) @ v（沿 key 维 softmax，无 mask）',
    constraints: '输出 dtype 与输入一致; 不修改输入', boundaries: 'B=0 返回空张量; H=0 返回空张量',
  },
  gelu: {
    inputs: 'x:float32[N]@contiguous', outputs: 'y:float32[N]@contiguous',
    math: 'y = 0.5 * x * (1 + erf(x / sqrt(2)))（精确 erf 形式）',
    constraints: '输出 dtype 与输入一致; 不修改输入', boundaries: 'N=0 返回空张量',
  },
  affine: {
    inputs: 'x:float32[N,K]@contiguous; s:float32[]@scalar; b:float32[]@scalar', outputs: 'y:float32[N,K]@contiguous',
    math: 'y = x * s + b',
    constraints: '输出 dtype 与输入一致; 不修改输入', boundaries: 'N=0 返回空张量',
  },
});
const operatorAliases = Object.freeze({ gemm: 'matmul', mm: 'matmul', layernorm: 'layer_norm', rmsnorm: 'rms_norm', sdpa: 'attention' });
const semanticTemplateOf = (draft = {}) => {
  const name = String(draft.operator || '').trim().toLowerCase().replace(/[-\s]+/gu, '_');
  const key = own(operatorAliases, name) || name;
  return own(semanticTemplates, key) ? { name: key, ...semanticTemplates[key] } : null;
};
const templateDtypes = ['float32', 'float16', 'bfloat16'];
const genericShapes = ['[N]', '[M,N]', '[B,M,N]'];
const commonConstraints = ['输出 dtype 与输入一致; 不修改输入', '不修改输入', '无'];

// Serialization stays compatible with the spec/API, but is never an editable
// form row. Each tensor and dimension is edited through its own control.
const tensorSides = Object.freeze({ inputs: 'semanticInputs', outputs: 'semanticOutputs' });
const TENSOR_ENTRY = /^([^:[\]@]*)(?::([^[\]@]*))?(?:\[([^\]]*)\])?(?:@(.*))?$/u;
const tensorItemsOf = (draft, side) => {
  const text = String(draft[tensorSides[side]] || '').trim();
  if (!text) return [];
  return text.split(';').map((entry) => {
    const match = TENSOR_ENTRY.exec(entry.trim());
    // Keep malformed legacy records intact until that item is edited/deleted;
    // another item's edit must not discard them or expose a raw syntax editor.
    return match ? { name: match[1].trim(), dtype: (match[2] || '').trim(), shape: (match[3] || '').trim(), layout: (match[4] || '').trim() }
      : { name: '', dtype: '', shape: '?', layout: '', raw: entry };
  });
};
const tensorText = (items) => items.map((item) => item.raw ?? `${item.name}:${item.dtype}[${item.shape}]@${item.layout}`).join('; ');
const tensorDims = (item) => item.shape.trim() ? item.shape.split(',').map((dim) => dim.trim()) : [];
const tensorLayoutOptions = (item) => tensorDims(item).length === 0 ? ['scalar']
  : ['contiguous', 'strided', ...(tensorDims(item).length === 4 ? ['channels_last'] : [])];
const tensorLayoutLabels = { contiguous: '连续存储', strided: '任意步长', channels_last: '通道后置', scalar: '标量（自动）' };
const tensorFieldOf = (field) => {
  const match = /^tensor:(inputs|outputs):(\d+):(name|dtype|shape|layout|delete|dim:\d+)$/u.exec(String(field));
  return match ? { side: match[1], index: Number(match[2]), part: match[3].startsWith('dim:') ? 'dim' : match[3], dim: Number(match[3].split(':')[1]) } : null;
};
const tensorAddOf = (field) => (/^tensorAdd:(inputs|outputs)$/u.exec(String(field)) || [])[1] || null;
const tensorTemplateOf = (field) => (/^tensorTemplate:(inputs|outputs)$/u.exec(String(field)) || [])[1] || null;
const tensorFields = (draft, side) => {
  const items = tensorItemsOf(draft, side);
  return [...(!items.length && semanticTemplateOf(draft) ? [`tensorTemplate:${side}`] : []),
    ...items.flatMap((item, index) => ['name', 'dtype', 'shape', ...tensorDims(item).map((_, dim) => `dim:${dim}`), 'layout', 'delete']
      .map((part) => `tensor:${side}:${index}:${part}`)), `tensorAdd:${side}`];
};
const tensorValueOf = (draft, field) => {
  const tensor = tensorFieldOf(field);
  const item = tensorItemsOf(draft, tensor.side)?.[tensor.index];
  const value = tensor.part === 'dim' ? tensorDims(item)[tensor.dim] : item?.[tensor.part];
  return value === '?' ? '' : String(value ?? '');
};
const withTensorValue = (draft, field, value) => {
  const tensor = tensorFieldOf(field);
  const items = tensorItemsOf(draft, tensor.side).map((item, index) => {
    if (index !== tensor.index) return item;
    const { raw, ...updated } = item;
    if (tensor.part === 'dim') {
      const dims = tensorDims(item);
      dims[tensor.dim] = value.trim() ? value : '?'; // an unfinished/blank axis is not a scalar
      updated.shape = dims.join(',');
    } else updated[tensor.part] = value;
    if (tensor.part === 'shape') {
      const allowed = tensorLayoutOptions(updated);
      updated.layout = allowed.length === 1 ? allowed[0] : allowed.includes(item.layout) ? item.layout : '';
    }
    return updated;
  });
  return { ...draft, [tensorSides[tensor.side]]: tensorText(items) };
};
const tensorDtypes = ['float32', 'float16', 'bfloat16', 'float64', 'int32', 'int64', 'int8', 'bool'];
// Keep common choices first in a stable order. Prepending dimensions from the
// current tensor moves the selected symbol on every keypress and traps cycling.
const tensorDimensionSuggestions = ['B', 'M', 'N', 'K', 'C', 'H', 'W', 'D', 'S'];
const tensorNameSuggestions = { inputs: ['x', 'w', 'b', 's'], outputs: ['y', 'o'] };
const nextTensorName = (draft, side) => {
  const used = new Set(['inputs', 'outputs'].flatMap((name) => (tensorItemsOf(draft, name) || []).map((item) => item.name)));
  return [...tensorNameSuggestions[side], ...Array.from({ length: 16 }, (_, index) => `t${index + 1}`)].find((name) => !used.has(name)) || '';
};

// UI item copies retain the explicit tensor/test values, never the primary flag.
export const copyMissionFormItem = (draft, editor) => {
  const uniqueName = (base, names) => {
    let name = `${base}_copy`, suffix = 2;
    while (names.includes(name)) name = `${base}_copy${suffix++}`;
    return name;
  };
  const tensor = /^tensor:(inputs|outputs):(\d+)$/u.exec(editor || '');
  if (tensor) {
    const side = tensor[1], items = tensorItemsOf(draft, side), item = items[Number(tensor[2])];
    if (!item || item.raw) return { draft, issue: '请先修复张量字段，再复制。' };
    const names = ['inputs', 'outputs'].flatMap((key) => tensorItemsOf(draft, key).map((entry) => entry.name));
    const copy = { ...item, name: uniqueName(item.name || 'tensor', names) };
    return { draft: { ...draft, [tensorSides[side]]: tensorText([...items, copy]) }, editor: `tensor:${side}:${items.length}` };
  }
  const shape = /^shape:(\d+)$/u.exec(editor || '');
  if (shape) {
    const items = shapeItems(draft), item = items[Number(shape[1])];
    if (!item) return { draft, issue: '找不到该 shape。' };
    if (items.length >= 16) return { draft, issue: '最多配置 16 个性能 shape。' };
    const copy = { ...item, name: uniqueName(item.name || 'shape', items.map((entry) => entry.name)), dims: { ...item.dims }, primary: false };
    return { draft: { ...draft, benchmarkShapes: [...items, copy] }, editor: `shape:${items.length}` };
  }
  return { draft };
};
const tensorPartProblem = (draft, field) => {
  const tensor = tensorFieldOf(field);
  const items = tensorItemsOf(draft, tensor.side) || [];
  const value = String(items[tensor.index]?.[tensor.part] ?? '').trim();
  if (tensor.part === 'delete') return null;
  if (tensor.part === 'shape') {
    return null; // Each extent is validated on its own row.
  }
  if (tensor.part === 'dim') {
    const dimension = tensorValueOf(draft, field).trim();
    if (!dimension) return '必填：填写一个维度名或非负整数';
    if (/^\d+$/u.test(dimension)) return Number.isSafeInteger(Number(dimension)) ? null : '维度大小超出可精确表示的整数范围';
    return /^[A-Za-z_]\w*$/u.test(dimension) ? null : '填写非负整数或英文符号（字母/下划线开头）；暂不支持表达式';
  }
  if (!value) return { name: '必填：张量名', dtype: '必填：←→ 选择 dtype', layout: '必填：←→ 选择布局' }[tensor.part];
  if (tensor.part === 'name') {
    if (!/^[A-Za-z_]\w*$/u.test(value)) return '字母或下划线开头，只含字母、数字、_';
    if (items.filter((item) => item.name.trim() === value).length > 1) return '同一侧的张量名不能重复';
  }
  if (tensor.part === 'dtype' && !/^[A-Za-z]\w*$/u.test(value)) return 'dtype 名称无效';
  if (tensor.part === 'layout') {
    if (!tensorLayoutOptions(items[tensor.index]).includes(value)) return `布局 ${value} 不适用于当前 ${tensorDims(items[tensor.index]).length} 维形状，请重新选择`;
  }
  return null;
};
const tensorLabel = (draft, field) => {
  const tensor = tensorFieldOf(field);
  const side = tensor.side === 'inputs' ? '输入' : '输出';
  if (tensor.part === 'name') return `  ${side} ${tensor.index + 1} · 名称 / Name`;
  const name = tensorValueOf(draft, `tensor:${tensor.side}:${tensor.index}:name`).trim() || `${side} ${tensor.index + 1}`;
  if (tensor.part === 'dim') return `    ${name} · 第 ${tensor.dim + 1} 维`;
  if (tensor.part === 'delete') return `    − 删除 ${name}`;
  return `    ${name} · ${{ dtype: 'dtype', shape: '形状 / Shape', layout: '布局 / Layout' }[tensor.part]}`;
};

// Symbols bind sizes, not axis names. Repeated symbols are legal equality
// constraints, within a tensor and across every input/output in the same case.
export const missionDimensionNote = (draft, field) => {
  const tensor = tensorFieldOf(field);
  if (!tensor || !['dim', 'shape'].includes(tensor.part)) return null;
  const item = tensorItemsOf(draft, tensor.side)[tensor.index];
  if (!item) return null;
  const dims = tensorDims(item);
  const repeated = [...new Set(dims.filter((dim, index) => /^[A-Za-z_]\w*$/u.test(dim) && dims.indexOf(dim) !== index))];
  if (tensor.part === 'shape') return repeated.length ? { tone: 'warn', text: `等长约束：${repeated.map((dim) => `${dim} 用于第 ${dims.flatMap((value, index) => value === dim ? [index + 1] : []).join('、')} 维`).join('；')}；不是独立尺寸` } : null;
  const symbol = dims[tensor.dim];
  if (/^\d+$/u.test(symbol)) return { tone: 'muted', text: Number(symbol) === 0 ? '固定大小 0 表示空维度；标量应选择 0 维' : `固定大小 ${symbol}；不随性能 shape 改变` };
  if (!/^[A-Za-z_]\w*$/u.test(symbol || '')) return null;
  const references = ['inputs', 'outputs'].flatMap((side) => tensorItemsOf(draft, side).flatMap((entry, index) => tensorDims(entry).flatMap((dim, axis) => dim === symbol
    ? [{ side, index, axis, label: `${entry.name || (side === 'inputs' ? '输入' : '输出') + (index + 1)} 第${axis + 1}维` }] : [])));
  const local = references.filter((ref) => ref.side === tensor.side && ref.index === tensor.index);
  if (local.length > 1) return { tone: 'warn', text: `等长约束：本张量第 ${local.map((ref) => ref.axis + 1).join('、')} 维均为 ${symbol}，必须相等` };
  if (references.length > 1) return { tone: 'muted', text: `共享尺寸 ${symbol}：${references.slice(0, 3).map((ref) => ref.label).join('、')}${references.length > 3 ? ` 等 ${references.length} 处` : ''}；每组测试中相等` };
  const similar = tensorDimensions(draft).find((dim) => dim !== symbol && dim.toLowerCase() === symbol.toLowerCase());
  return { tone: similar ? 'warn' : 'muted', text: similar ? `${symbol} 与 ${similar} 大小写不同，表示两个独立尺寸` : `${symbol} 是尺寸变量；名称自定义、区分大小写，同名表示等长` };
};

// Constraints: digit keys toggle common ones; anything else typed is a note.
const constraintChoices = ['输出 dtype 与输入一致', '不修改输入', '累加精度不低于 float32', '确定性：同输入同输出'];
const constraintItems = (draft) => String(draft.semanticConstraints || '').split(';').map((item) => item.trim()).filter(Boolean);
const constraintTogglesActive = (draft) => {
  const text = String(draft.semanticConstraints || '');
  return !text.trim() || /;\s*$/u.test(text) || constraintItems(draft).every((item) => item === '无' || constraintChoices.includes(item));
};
const toggleConstraint = (draft, choice) => {
  const items = constraintItems(draft).filter((item) => item !== '无');
  const next = items.includes(choice) ? items.filter((item) => item !== choice) : [...items, choice];
  return [...constraintChoices.filter((item) => next.includes(item)), ...next.filter((item) => !constraintChoices.includes(item))].join('; ');
};
const constraintsNote = (draft) => {
  const items = constraintItems(draft);
  const picked = items.filter((item) => constraintChoices.includes(item));
  const notes = items.filter((item) => !constraintChoices.includes(item));
  return { tone: 'ok', text: `✓ ${picked.length ? `已选 ${picked.join('、')}` : '未选常用约束'}${notes.length ? `；备注：${notes.join('；')}` : ''}` };
};

// Boundaries: one row per named dimension choosing its behavior when it is 0,
// written as `D=0 <behavior>`; other typed boundary rules are kept as they are.
const zeroBehaviors = ['返回空张量', '输出全 0', '报错', '不适用'];
const boundaryFieldOf = (field) => (/^boundary:([A-Za-z_]\w*)$/u.exec(String(field)) || [])[1] || null;
const boundaryItems = (draft) => String(draft.semanticBoundaries || '').split(';').map((item) => item.trim()).filter(Boolean);
const zeroRuleOf = (item) => {
  const match = /^([A-Za-z_]\w*)=0 (.+)$/u.exec(item);
  return match && zeroBehaviors.includes(match[2]) ? { dim: match[1], behavior: match[2] } : null;
};
const boundaryValueOf = (draft, dim) => boundaryItems(draft).map(zeroRuleOf).find((rule) => rule?.dim === dim)?.behavior || '';
const withBoundary = (draft, dim, behavior) => {
  const items = boundaryItems(draft).filter((item) => item !== '无');
  const rules = Object.assign(Object.create(null), Object.fromEntries(items.map(zeroRuleOf).filter(Boolean).map((rule) => [rule.dim, rule.behavior])));
  if (behavior) rules[dim] = behavior; else delete rules[dim];
  const order = [...tensorDimensions(draft), ...Object.keys(rules)];
  const dims = order.filter((name, index) => rules[name] && order.indexOf(name) === index);
  return { ...draft, semanticBoundaries: [...dims.map((name) => `${name}=0 ${rules[name]}`), ...items.filter((item) => !zeroRuleOf(item))].join('; ') };
};
const boundaryFields = (draft) => tensorDimensions(draft).map((dim) => `boundary:${dim}`);
const isChoicePseudo = (field) => Boolean(boundaryFieldOf(field)) || ['dtype', 'shape', 'layout'].includes(tensorFieldOf(field)?.part);
// Options for a choice row; a custom current value stays visible and selected.
const withCurrent = (values, current) => (current && !values.includes(current) ? [...values, current] : values);
const cycle = (options, key, input) => {
  const step = key.leftArrow || input === '[' ? -1 : key.rightArrow || input === ' ' || input === ']' ? 1 : 0;
  if (!step || !options.length) return null;
  const at = options.findIndex((option) => option.selected);
  return options[at < 0 ? (step > 0 ? 0 : options.length - 1) : (at + step + options.length) % options.length].value;
};
const commonBoundaries = ['N=0 返回空张量', '无'];
// Benchmark shapes are structured items, one row for the name and one row per
// named dimension of the declared tensors; the user types each value. Field ids
// are `shape:<index>:name` and `shape:<index>:dim:<D>`; `shapeAdd` adds an item.
const tensorDimensions = (draft) => Array.from(new Set(['semanticInputs', 'semanticOutputs']
  .flatMap((field) => Array.from(String(draft[field] || '').matchAll(/\[([^\]]*)\]/gu), (match) => match[1].split(','))
  .flat().map((item) => item.trim()).filter((item) => /^[A-Za-z_]\w*$/u.test(item)))));
const shapeItems = (draft = {}) => (Array.isArray(draft.benchmarkShapes) ? draft.benchmarkShapes : []);
const shapesDeclared = (draft) => shapeItems(draft).length > 0;
const declaredShapeNames = (draft) => shapeItems(draft).map((item) => String(item?.name ?? '').trim()).filter(Boolean);
const shapeFieldOf = (field) => {
  const match = /^shape:(\d+):(name|dim):?(.*)$/u.exec(String(field));
  return match ? { index: Number(match[1]), part: match[2], dim: match[3] } : null;
};
const isShapeField = (field) => field === 'shapeAdd' || Boolean(shapeFieldOf(field));
// Dimensions asked for a shape: the tensors' named dimensions, plus any stale
// dimension that still holds a value so it is shown (as an error) until cleared.
const shapeDimensionsOf = (draft, item) => {
  const dims = item && typeof item.dims === 'object' && !Array.isArray(item.dims) ? item.dims : {};
  return Array.from(new Set([...tensorDimensions(draft), ...Object.keys(dims).filter((dim) => String(dims[dim] ?? '').trim())]));
};
const shapeFields = (draft) => [...shapeItems(draft).flatMap((item, index) => [`shape:${index}:name`,
  ...shapeDimensionsOf(draft, item).map((dim) => `shape:${index}:dim:${dim}`)]), 'shapeAdd'];
const shapeNameSuggestions = ['small', 'medium', 'large', 'xlarge'];
const nextShapeName = (draft) => [...shapeNameSuggestions, ...Array.from({ length: 16 }, (_, index) => `shape${index + 1}`)]
  .find((name) => !declaredShapeNames(draft).includes(name)) || '';
// Common sizes offered on ←→ for a dimension value; only an explicit pick.
const dimensionPresets = (draft, dim) => (own({ B: ['1', '2', '4', '8'], H: ['8', '12', '16', '32'], D: ['64', '128'] }, dim)
  || (tensorDimensions(draft).length === 1 ? ['1024', '4096', '65536', '1048576'] : ['128', '256', '512', '1024', '2048', '4096']));
const shapeValueOf = (draft, field) => {
  const shape = shapeFieldOf(field);
  const item = shape && shapeItems(draft)[shape.index];
  if (!item) return '';
  return String((shape.part === 'name' ? item.name : own(item.dims, shape.dim)) ?? '');
};
const withShapeValue = (draft, field, value) => {
  const shape = shapeFieldOf(field);
  // The primary mark lives on the item, so renaming (even via a cleared name) keeps it.
  const renamed = shape.part === 'name' && shapeItems(draft)[shape.index]?.primary === true;
  return { ...draft, ...(renamed ? { primaryProfile: value.trim() } : {}), benchmarkShapes: shapeItems(draft).map((item, index) => (index !== shape.index ? item
    : shape.part === 'name' ? { ...item, name: value } : { ...item, dims: { ...(item.dims || {}), [shape.dim]: value } })) };
};
const shapeLabel = (draft, field) => {
  const shape = shapeFieldOf(field);
  if (shape.part === 'name') {
    const primary = String(shapeItems(draft)[shape.index]?.name ?? '').trim() === String(draft.primaryProfile || '').trim() && String(draft.primaryProfile || '').trim();
    return `shape ${shape.index + 1} 名称${primary ? ' ★ 主场景' : ''} / Name`;
  }
  return `  ${String(shapeItems(draft)[shape.index]?.name || '').trim() || `shape ${shape.index + 1}`} · ${shape.dim}`;
};
const fieldLabel = (draft, field) => (shapeFieldOf(field) ? shapeLabel(draft, field) : tensorFieldOf(field) ? tensorLabel(draft, field)
  : tensorTemplateOf(field) ? `  ${tensorTemplateOf(field) === 'inputs' ? '输入' : '输出'}张量模板`
    : tensorAddOf(field) ? `  + ${tensorAddOf(field) === 'inputs' ? '输入' : '输出'}张量 / Add` : boundaryFieldOf(field) ? `  ${boundaryFieldOf(field)}=0 时 / When zero` : tolFieldOf(field) ? `  ${tolFieldOf(field)} 容差 / atol/rtol` : labels[field]);
const uniqueOptions = (options) => options.filter((option, index) => options.findIndex((other) => other.value === option.value) === index);

// ←→ presets for a free-text field, as [{ value, label }], or null.
const fieldPresets = (draft = {}, field) => {
  if (field === 'targetArchitecture') return missionArchitectureSuggestions(draft.target).map((value) => ({ value, label: value || '未指定' }));
  if (valuePresets[field]) return valuePresets[field].map((value) => ({ value, label: value }));
  const template = semanticTemplateOf(draft);
  if (field === 'semanticInputs' || field === 'semanticOutputs') {
    const side = field === 'semanticInputs' ? 'inputs' : 'outputs';
    // Output options start with the dtype already chosen for the inputs.
    const inputDtype = field === 'semanticOutputs' ? /^[^:;]+:([A-Za-z]\w*)\[/u.exec(String(draft.semanticInputs || '').trim())?.[1] : null;
    const dtypes = inputDtype ? [inputDtype, ...templateDtypes.filter((dtype) => dtype !== inputDtype)] : templateDtypes;
    if (template) return dtypes.map((dtype) => ({ value: template[side].replaceAll('float32', dtype), label: dtype }));
    const name = field === 'semanticInputs' ? 'x' : 'y';
    return genericShapes.map((shape) => ({ value: `${name}:${dtypes[0]}${shape}@contiguous`, label: shape }));
  }
  if (field === 'semanticMath') return template ? [{ value: template.math, label: `${template.name} 公式` }] : null;
  if (field === 'semanticConstraints' || field === 'semanticBoundaries') {
    const values = field === 'semanticConstraints' ? [template?.constraints, ...commonConstraints] : [template?.boundaries, ...commonBoundaries];
    return uniqueOptions(values.filter(Boolean).map((value) => ({ value, label: value })));
  }
  return null;
};

// A semantic value taken from a template still has to match the baseline.
const templateNote = (draft, field) => (field.startsWith('semantic') && semanticTemplateOf(draft)
  && fieldPresets(draft, field)?.some((option) => option.value === String(draft[field] || '').trim())
  ? { tone: 'muted', text: '✓ 格式正确 · 模板值：请确认与独立基线的实际计算一致' }
  : null);

const goalPresetOf = (draft = {}) => goalPresets.find((preset) => preset.id === draft.goalPreset) || goalPresets[0];
const goalValueProblem = (preset, value) => {
  const text = String(value ?? '').trim();
  if (!text) return preset.id === 'relative' ? '输入提升百分比，如 20' : '输入延迟上限（微秒），如 50';
  if (!/^\d+(?:\.\d+)?$/u.test(text)) return '只填数字，如 20 或 12.5';
  if (!(Number(text) > 0)) return '需要大于 0';
  if (preset.id === 'relative' && Number(text) >= 100) return '提升百分比需小于 100';
  return null;
};
const composeGoal = (preset, value) => {
  if (!preset.compose) return '';
  if (!preset.unit) return preset.compose();
  return goalValueProblem(preset, value) ? '' : preset.compose(String(value).trim());
};

// What the Runtime will make of the goal text, shown under the goal field.
export const missionGoalNote = (draft = {}) => {
  const goal = String(draft.goal || '').trim();
  if (!goal) return null;
  const { absoluteThreshold, relativeTarget } = describeMissionGoal({ goal });
  if (Number.isFinite(absoluteThreshold)) {
    return { tone: 'ok', text: `✓ 达标线：延迟 ≤ ${absoluteThreshold} us${/\d\s*ms\b/iu.test(goal) ? '（已从 ms 换算）' : ''}` };
  }
  if (Number.isFinite(relativeTarget)) {
    if (relativeTarget >= 1) return { tone: 'warn', text: '⚠ 提升 ≥ 100% 意味着延迟 ≤ 0，永远无法达标' };
    return { tone: 'ok', text: `✓ 达标线：延迟 ≤ 基线 × ${Number((1 - relativeTarget).toFixed(4))}（相对基线提升 ≥ ${Number((relativeTarget * 100).toFixed(4))}%）` };
  }
  return goalPresetOf(draft).id === 'maximize'
    ? { tone: 'ok', text: draft.acceptancePolicyMode === 'protected' ? '✓ 达标线：保护场景符合退化限制，且主场景严格优于基线；持平不算优化' : '✓ 沿用旧策略：不慢于当前最佳即采用，跑到预算或收敛' }
    : { tone: 'muted', text: draft.acceptancePolicyMode === 'protected' ? '未指定数值目标：冻结为主场景严格优于基线，并保护所选场景；可 ←→ 选数值模板' : '未识别数值目标：沿用旧任务主场景策略；可选保护场景策略' };
};

export const missionFormFields = (draft = {}) => (draft.mode === 'fixed-example'
  ? ['mode', 'profileId', 'webResearchEnabled', 'requireAuthority', 'timeBudget']
  : draft.inputMode === 'spec-file'
    ? ['mode', 'inputMode', 'specPath', 'repository', 'operator', 'goal', 'language', 'target', 'execution', 'timeBudget']
    : ['mode', 'inputMode', ...(draft.sourceMode === 'managed' ? ['sourceFiles'] : ['repository']), 'operator', 'goal', 'language', 'target', 'targetArchitecture', ...(draft.sourceMode === 'managed' ? [] : ['dependencyFiles']), 'baselineFile',
      ...tensorFields(draft, 'inputs'), ...tensorFields(draft, 'outputs'), ...shapeFields(draft),
      'semanticMath', 'semanticConstraints', 'semanticBoundaries', ...boundaryFields(draft),
      // Declared shapes are the benchmark profiles (the primary is marked on a
      // shape name row), so neither the name list nor the primary row is asked for.
      'seed', 'requestedCases', 'requiredCategories', 'atol', 'rtol', ...toleranceFields(draft), 'cosineTolerance',
      ...(shapesDeclared(draft) ? [] : ['requiredProfiles', 'primaryProfile']),
      'acceptancePolicyMode', ...(draft.acceptancePolicyMode === 'protected' ? ['protectedProfiles', 'maxRegressionPercent'] : []),
      'measurementTier', ...(measurementRowsShown(draft) ? measurementFields : []), 'execution', 'timeBudget']);

export const displayMissionField = (draft, field) => {
  if (field === 'acceptancePolicyMode' && !draft.acceptancePolicyMode) return choiceLabels.legacy;
  if (field === 'protectedProfiles' && draft.protectedProfiles === 'all') return '全部已声明性能场景（随任务冻结）';
  if (field === 'targetArchitecture') return draft.targetArchitecture || '未指定 · 架构未知';
  if (field === 'shapeAdd') return shapesDeclared(draft) ? '+ 再添加一个 shape · Enter' : '+ 添加 shape · Enter（可选，不添加则由基线决定）';
  if (shapeFieldOf(field)) return shapeValueOf(draft, field) || '必填 (required)';
  if (tolFieldOf(field)) return tolValueOf(draft, tolFieldOf(field)) || '沿用通用容差';
  if (tensorAddOf(field)) return `+ 添加${tensorAddOf(field) === 'inputs' ? '输入' : '输出'}张量 · Enter`;
  if (tensorTemplateOf(field)) return `按 ${semanticTemplateOf(draft).name} 模板添加 · Enter`;
  if (tensorFieldOf(field)?.part === 'delete') return '删除此张量 · Enter';
  if (tensorFieldOf(field)) return tensorValueOf(draft, field) || (tensorFieldOf(field).part === 'shape' ? '标量 []' : '必填 (required)');
  if (boundaryFieldOf(field)) return boundaryValueOf(draft, boundaryFieldOf(field)) || '未指定';
  if (field === 'measurementTier') return tierOf(draft)?.label || '请选择';
  if (field === 'sourceFiles') return draft.importedFiles?.length ? `${draft.importedFiles.length} 个文件 · Enter 查看或更改` : '可选 · Enter 选择文件 / 文件夹';
  if (field === 'baselineFile' && draft.sourceMode === 'managed') return draft.baselineFile || '稍后配置（可先保存任务）';
  const entry = draft[field];
  if (field === 'profileId') return tuiOperatorProfiles.find((profile) => profile.id === entry)?.title || '请选择示例';
  if (typeof entry === 'boolean') return entry ? '开启 (on)' : '关闭 (off)';
  if (choices[field]) return choiceLabels[entry] || entry || (draft.inputMode === 'spec-file' ? '沿用规格 (from spec)' : '请选择 (required)');
  if (entry) return String(entry);
  if (field === 'specPath') return '必填：JSON 规格绝对路径';
  if (field === 'timeBudget') return draft.mode === 'fixed-example' ? '沿用固定示例预算' : draft.inputMode === 'spec-file' ? '沿用规格预算' : '未设置总预算';
  if (draft.inputMode === 'spec-file') return '沿用规格 (optional override)';
  if (field === 'dependencyFiles') return '无额外依赖；入口固定 run.py';
  return '必填 (required)';
};

export const missionSubmitLabel = (draft) => draft.mode === 'fixed-example'
  ? '创建并启动示例'
  : draft.execution === 'start' ? '创建并启动本地迭代' : draft.execution === 'generate-only' ? '创建并仅生成候选' : '保存任务';

export const missionFormHint = (draft, field) => {
  if (field === 'sourceFiles') return '系统管理任务目录；只拷贝所选素材，原文件保持不变。Enter 打开选择器。';
  if (field === 'baselineFile' && draft.sourceMode === 'managed') return 'Enter 导入基线 · ←→ 从已导入的 .py 文件选择；run.py 是候选入口，不能作为独立基线。';
  if (draft.mode === 'fixed-example') return '示例使用冻结的语义和测试矩阵；执行需匹配 C550 后端。';
  if (field === 'specPath') return 'generic-mission/v1：包含冻结测试规格与基线。';
  if (field === 'operator') return '←→ 选常用算子名，或直接输入项目里的名称；语义和测试仍在后面几页明确填写。';
  if (field === 'goal') {
    const preset = goalPresetOf(draft);
    if (preset.unit) return `←→ 切换模板，直接输入数字（${preset.unit === '%' ? '百分比' : '微秒'}）；切回「自定义」可写任意目标。`;
    return '←→ 选模板：持续优化 / 相对基线提升 % / 延迟上限 us；或直接输入文字目标。';
  }
  if (field === 'acceptancePolicyMode') return '新任务保护全部场景；旧草稿保留旧策略，明确选择后才改变。保存任务会把场景、退化限制和成功目标一起冻结。';
  if (field === 'protectedProfiles') return '填写 all，或逗号分隔场景名（必须包含主场景）；全部场景仍完整测正确性，首轮也对照独立基线。';
  if (field === 'maxRegressionPercent') return '相对同场景独立基线允许的延迟增加百分比；0 禁止退化。缺测、基线不匹配或读数未稳定均不算通过。';
  if (field === 'repository') return '普通 Git 仓库绝对路径；导入独立副本，保留原仓库。';
  if (field === 'execution') return '保存任务会冻结完整配置；Ctrl+S 保留可编辑草稿。仅生成需 Agent，本地迭代需测试后端；云端未部署。';
  if (field === 'language') return '按目标生态选语言：NVIDIA 可选 CUDA / Triton，C500 可选 MXMACA，910B 可选 Ascend C++；PyTorch 仍需目标适配。客户端无需安装目标硬件。';
  if (field === 'target') return '目标配置与当前执行后端独立；选择不代表已通过硬件验证。';
  if (field === 'targetArchitecture') return '←→ 选建议值，也可直接输入；Ctrl+U 清空。已知架构可用于首轮经验检索；留空仍可开发。切换硬件会清空架构。此处是用户声明，不代表实测或后端已支持。';
  if (field === 'baselineFile') return '仓库相对独立 .py 文件，非 run.py/native 文件；导入就绪不等于已测。';
  if (field === 'dependencyFiles') return '仓库相对路径用英文逗号分隔，如 operator.cu, deps/helper.py；不填基线。';
  if (field === 'shapeAdd') return '可选。Enter 添加性能 shape，再逐个维度填数值；在 shape 名称行按 * 标为主场景 ★。每个 shape 都会被测量并冻结；在业务验收策略选择必保护场景和退化限制。';
  if (shapeFieldOf(field)?.part === 'name') return 'shape 名称即性能场景名（字母、数字、_、-）；←→ 选常用名，* 标为主场景 ★，Ctrl+D 删除这个 shape。';
  if (shapeFieldOf(field)) return '直接输入该维度的正整数，←→ 选常用值；基线必须按这些数值生成输入。Ctrl+D 删除这个 shape。';
  if (tensorAddOf(field)) return 'Enter 添加张量；再选维数、逐维填写、选 dtype 和布局。每个张量末尾可直接删除。';
  if (tensorTemplateOf(field)) return 'Enter 按当前算子模板添加张量，然后逐项调整；请确认与独立基线一致。';
  if (tensorFieldOf(field)) {
    const part = tensorFieldOf(field).part;
    if (part === 'delete') return 'Enter 删除此张量；其他张量保留。重新添加可建立新的张量项。';
    if (part === 'shape') return '←→ 选择维数，下面逐维填写；减少维数会移除末尾维度，不兼容的布局需要重新选择。';
    if (part === 'layout') return '形状决定可选布局：零维为标量，四维可选通道后置；连续与任意步长保持同一逻辑 shape。';
    return `${{ name: '填写张量名', dtype: '←→ 选择 dtype', dim: '填尺寸符号或非负整数；英文/下划线开头，区分大小写；不支持 N+1 等表达式' }[part]}；同名尺寸必须相等。`;
  }
  if (boundaryFieldOf(field)) return `维度 ${boundaryFieldOf(field)} 为 0 时的行为：←→ 选择，写入「边界行为」；其余边界规则可在「边界行为」一行直接输入。`;
  if (field === 'semanticConstraints') {
    const template = semanticTemplateOf(draft);
    return `数字键切换：${constraintChoices.map((item, at) => `${at + 1} ${item}`).join(' · ')}；其余直接输入作备注（英文分号分隔）${template ? `；←→ 选 ${template.name} 模板` : '；←→ 选常用写法'}。`;
  }
  if (field.startsWith('semantic')) {
    const template = semanticTemplateOf(draft);
    const how = template ? `←→ 选 ${template.name} 模板` : '←→ 选常用写法（在「算子」选常用名可得完整模板）';
    if (['semanticInputs', 'semanticOutputs'].includes(field)) return `${how}；格式 x:float32[N,K]@contiguous，多个用英文分号分隔。`;
    if (field === 'semanticMath') return template ? `${how}，可再修改；须与独立基线的实际计算一致。` : '填写真实计算公式，例如 y = x * scale + bias；不会自动推断。';
    return `${how}；多条用英文分号分隔，不适用可选「无」。`;
  }
  if (field === 'requiredCategories') return `数字键切换：${categoryDescriptions.map(([category], at) => `${at + 1} ${category}`).join(' · ')}；←→ 选组合，也可直接输入；类别数不能多于正确性数量。`;
  if (tolFieldOf(field)) return `${tolFieldOf(field)} 输出逐个比较：填 atol/rtol，或一个数同时作两者；留空沿用通用容差，不按输入 dtype 选择。`;
  if (field === 'cosineTolerance') return '额外正确性要求：cosDiff 必须严格小于此值；默认 1e-5，与现有测试器一致。';
  if (field === 'measurementTier') return '←→ 选 快速 / 标准 / 严格（写入具体数值并冻结），或「自定义」逐项填写；只影响测量，不改变正确性要求。';
  if (['requiredCategories', 'requiredProfiles'].includes(field)) return '←→ 选常用组合，或直接输入（英文逗号分隔、不重复）；须与独立基线实现一致。';
  if (field === 'primaryProfile') return '主测量指标：←→ 在已填写的性能场景中选择，或直接输入名称。';
  if (field === 'seed') return '←→ 选常用值或直接输入非负整数，允许 0；确定性生成。';
  if (['requestedCases', 'warmup', 'repeats', 'maxSettlements'].includes(field)) return '←→ 选常用值或直接输入正整数；不取整、不自动降低数量。';
  if (['atol', 'rtol'].includes(field)) return '←→ 选常用容差或直接输入；非负数，允许 0 和科学计数法（如 1e-3）。';
  if (field === 'settleTolerance') return '←→ 选常用值或直接输入；测量收敛相对容差，严格在 0 与 1 之间。';
  return draft.inputMode === 'spec-file' ? '空白覆盖项沿用规格；冻结测试由规格提供。' : '逐页填写明确合同；所有语义和测试字段会提交，不需要 JSON。';
};

const absolutePath = (value) => /^(?:[A-Za-z]:[\\/]|\\\\[^\\/]+[\\/][^\\/]+|\/)/u.test(value);
export const validateMissionDraft = (draft) => {
  if (!choices.mode.includes(draft.mode)) return '请选择通用任务或固定示例。';
  if (draft.timeBudget && (!/^\d+$/u.test(draft.timeBudget) || !Number.isSafeInteger(Number(draft.timeBudget)) || Number(draft.timeBudget) <= 0)) return '时间预算必须是正整数毫秒，或留空。';
  if (draft.mode === 'fixed-example') return choices.profileId.includes(draft.profileId) ? null : '请选择有效的固定示例。';
  if (!choices.inputMode.includes(draft.inputMode ?? 'form')) return '请选择交互填写或导入已有规格。';
  if ((draft.inputMode ?? 'form') === 'form') {
    try { missionSpecificationFromForm(draft); return null; } catch (error) { return error.message; }
  }
  const goalPreset = goalPresetOf(draft);
  if (goalPreset.unit && goalValueProblem(goalPreset, draft.goalValue)) return `目标：${goalValueProblem(goalPreset, draft.goalValue)}。`;
  if (!absolutePath(String(draft.specPath || '').trim())) return '规格文件需要绝对路径 (absolute path)。';
  if (draft.repository && !absolutePath(String(draft.repository).trim())) return '源码仓库需要绝对路径 (absolute path)，或留空沿用规格。';
  for (const field of ['language', 'target', 'execution']) {
    if (!choices[field].includes(draft[field]) && !(['language', 'target'].includes(field) && draft[field] === 'from-spec')) return `请选择有效的${labels[field]}。`;
  }
  return null;
};

// Rule messages carry the English field id for the API; the form already shows
// the field, so strip it and phrase common failures as what to type instead.
const friendlyProblem = (message) => {
  const raw = String(message || '');
  if (/必须明确填写|non-empty string/u.test(raw)) return '必填 (required)';
  if (/absolute path/u.test(raw)) return '需要绝对路径 (absolute path)，如 F:/work/my-operator';
  if (/仓库相对路径|inside the repository/u.test(raw)) return '需要仓库内相对路径，如 src/reference.py；不能含 ..、盘符或 .git';
  if (raw.includes('GENERIC_BASELINE_NOT_INDEPENDENT') || /不能是候选允许写入的文件/u.test(raw)) return '独立基线不能是候选可改写的文件（如 run.py）';
  return raw.replace(/^[A-Za-z]+\s+(?=\S)/u, '').replace(/^数值无效；/u, '');
};
const specFileOverrides = new Set(['repository', 'operator', 'goal']);

// Live, per-field feedback for the form. Form mode asks the same rule that
// submission uses (checkMissionFormField); an untouched required field reads as
// "empty", not as an error, until the user tries to submit.
export const missionFieldStatus = (draft = {}, field) => {
  if (field === 'sourceFiles') return { state: draft.importedFiles?.length ? 'ok' : 'optional', problem: null };
  if (field === 'baselineFile' && draft.sourceMode === 'managed' && !draft.baselineFile && draft.execution === 'save') return { state: 'optional', problem: null };
  const value = draft[field];
  const blank = typeof value === 'string' && !value.trim();
  if (field === 'mode') return { state: 'ok', problem: null };
  if (draft.mode === 'fixed-example') {
    if (field === 'timeBudget') {
      if (blank) return { state: 'inherit', problem: null };
      const problem = validateMissionDraft({ ...draft });
      return problem ? { state: 'error', problem } : { state: 'ok', problem: null };
    }
    return { state: 'ok', problem: null };
  }
  if (field === 'goal' && goalPresetOf(draft).unit) {
    // A numeric template was picked explicitly, so a blank number is missing
    // input even when a spec file could otherwise supply the goal.
    const problem = goalValueProblem(goalPresetOf(draft), draft.goalValue);
    if (!problem) return { state: 'ok', problem: null };
    return { state: String(draft.goalValue ?? '').trim() ? 'error' : 'empty', problem };
  }
  if (draft.inputMode === 'spec-file') {
    if (field === 'inputMode' || field === 'execution') return { state: 'ok', problem: null };
    if (field === 'specPath') {
      if (blank) return { state: 'empty', problem: '必填：JSON 规格的绝对路径' };
      return absolutePath(value.trim()) ? { state: 'ok', problem: null } : { state: 'error', problem: '需要绝对路径 (absolute path)，如 F:/work/task.json' };
    }
    if (['language', 'target'].includes(field)) return { state: value ? 'ok' : 'inherit', problem: null };
    if (blank) return { state: 'inherit', problem: null };
    if (field === 'repository' && !absolutePath(value.trim())) return { state: 'error', problem: '需要绝对路径 (absolute path)，或留空沿用规格' };
    if (field === 'timeBudget' && (!/^\d+$/u.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) <= 0)) return { state: 'error', problem: '正整数毫秒，或留空' };
    return { state: specFileOverrides.has(field) || field === 'timeBudget' ? 'ok' : 'inherit', problem: null };
  }
  if (field === 'inputMode') return { state: 'ok', problem: null };
  if (field === 'acceptancePolicyMode' && draft.acceptancePolicyMode == null) return { state: 'inherit', problem: null };
  if (['dependencyFiles', 'timeBudget', 'targetArchitecture'].includes(field) && (blank || value == null)) return { state: 'optional', problem: null };
  if (isShapeField(field)) return shapeFieldStatus(draft, field);
  if (tensorTemplateOf(field)) return { state: 'optional', problem: null };
  if (tensorAddOf(field)) return tensorItemsOf(draft, tensorAddOf(field)).length ? { state: 'ok', problem: null }
    : { state: 'empty', problem: `请添加至少一个${tensorAddOf(field) === 'inputs' ? '输入' : '输出'}张量` };
  if (tensorFieldOf(field)) {
    const problem = tensorPartProblem(draft, field);
    if (!problem) return { state: tensorFieldOf(field).part === 'shape' && !tensorValueOf(draft, field).trim() ? 'optional' : 'ok', problem: null };
    return { state: tensorValueOf(draft, field).trim() ? 'error' : 'empty', problem };
  }
  if (boundaryFieldOf(field)) return { state: boundaryValueOf(draft, boundaryFieldOf(field)) ? 'ok' : 'optional', problem: null };
  if (tolFieldOf(field)) {
    if (!tolValueOf(draft, tolFieldOf(field)).trim()) return { state: 'optional', problem: null };
    try { parseDtypeTolerance(tolValueOf(draft, tolFieldOf(field)), tolFieldOf(field)); return { state: 'ok', problem: null }; } catch (error) { return { state: 'error', problem: friendlyProblem(error.message) }; }
  }
  if (field === 'measurementTier') {
    // The four values carry the requirement; the tier row only reports them.
    if (!tierOf(draft)) return { state: 'optional', problem: null };
    const bad = measurementFields.find((name) => checkMissionFormField(draft, name));
    if (!bad || tierOf(draft).id === 'custom') return { state: 'ok', problem: null };
    return { state: 'error', problem: `${labels[bad].split(' / ')[0]}：${friendlyProblem(checkMissionFormField(draft, bad))}` };
  }
  const message = checkMissionFormField(draft, field);
  if (!message) return { state: 'ok', problem: null };
  if (value === '' || blank) return { state: 'empty', problem: friendlyProblem(message) };
  return { state: 'error', problem: friendlyProblem(message) };
};

// Per-row shape status from the same per-item check submission uses. A blank
// value reads as "empty" (still required), a wrong one as an error.
const shapeFieldStatus = (draft, field) => {
  const problems = benchmarkShapeProblems(draft);
  if (field === 'shapeAdd') {
    if (problems?.general) return { state: 'error', problem: problems.general };
    if (!shapesDeclared(draft)) return { state: 'optional', problem: null };
    // The primary shape is an explicit mark, reported here since its row is gone.
    const primary = String(draft.primaryProfile || '').trim();
    if (!primary) return { state: 'empty', problem: '在一个 shape 名称行按 * 标为主场景' };
    if (!declaredShapeNames(draft).includes(primary)) return { state: 'error', problem: `主场景 ${primary} 不是已添加的 shape；在 shape 名称行按 * 重新标记` };
    return { state: 'ok', problem: null };
  }
  const shape = shapeFieldOf(field);
  const item = problems?.items[shape.index];
  const problem = !item ? null : shape.part === 'name' ? item.nameProblem : own(item.dims, shape.dim) ?? null;
  if (!problem) return { state: 'ok', problem: null };
  return { state: shapeValueOf(draft, field).trim() ? 'error' : 'empty', problem };
};

const profileNames = (draft) => Array.from(new Set(shapesDeclared(draft) ? declaredShapeNames(draft) : String(draft.requiredProfiles || '').split(/[,，]/u).map((item) => item.trim()).filter(Boolean)));

// Choices offered by the form for a field, or null for free-text fields.
// primaryProfile offers the profiles the user already listed; typing still works.
export const missionFieldOptions = (draft = {}, field) => {
  if (field === 'baselineFile' && draft.sourceMode === 'managed') {
    const writable = new Set(normalizeOperatorLanguage({ language: draft.language }).allowedFiles.map((name) => name.toLowerCase()));
    return ['', ...(draft.importedFiles || []).map((file) => file.path).filter((name) => name.endsWith('.py') && !writable.has(name.toLowerCase()))]
      .map((value) => ({ value, label: value || '稍后配置', selected: value === draft.baselineFile }));
  }
  if (field === 'primaryProfile') {
    const names = profileNames(draft);
    return names.length ? names.map((value) => ({ value, label: value, selected: value === draft.primaryProfile })) : null;
  }
  if (tolFieldOf(field)) {
    const current = tolValueOf(draft, tolFieldOf(field)).trim();
    return tolerancePresets(tolFieldOf(field)).map((value) => ({ value, label: value, selected: value === current }));
  }
  if (tensorFieldOf(field)) {
    const part = tensorFieldOf(field).part;
    const current = tensorValueOf(draft, field).trim();
    const tensor = tensorFieldOf(field);
    const item = tensorItemsOf(draft, tensor.side)[tensor.index];
    if (part === 'shape') {
      const dims = tensorDims(item);
      // Common ranks plus the next rank: no device-dependent rank restriction.
      const ranks = [...new Set([0, 1, 2, 3, 4, Math.max(0, dims.length - 1), dims.length, dims.length + 1])].sort((a, b) => a - b);
      return ranks.map((rank) => {
        const values = Array.from({ length: rank }, (_, at) => dims[at] || '?');
        return { value: values.join(','), label: rank ? `${rank} 维 · ${values.map((dim) => dim === '?' ? '待填' : dim).join(' × ')}` : '标量（0 维）', selected: rank === dims.length };
      });
    }
    const values = { dtype: withCurrent(tensorDtypes, current), layout: tensorLayoutOptions(item),
      dim: [...new Set([...tensorDimensionSuggestions, ...tensorDimensions(draft).sort(), '128', '256', '1'])] }[part];
    return values ? values.map((value) => ({ value, label: part === 'layout' ? tensorLayoutLabels[value] : value, selected: value === current })) : null;
  }
  if (boundaryFieldOf(field)) {
    const current = boundaryValueOf(draft, boundaryFieldOf(field));
    return ['', ...zeroBehaviors].map((value) => ({ value, label: value || '未指定', selected: value === current }));
  }
  if (field === 'measurementTier') return measurementTiers.map((tier) => ({ value: tier.id, label: tier.label, selected: tier.id === draft.measurementTier }));
  if (shapeFieldOf(field)) {
    const shape = shapeFieldOf(field);
    const current = shapeValueOf(draft, field).trim();
    const values = shape.part === 'name'
      ? shapeNameSuggestions.filter((name) => name === current || !declaredShapeNames(draft).includes(name))
      : dimensionPresets(draft, shape.dim);
    return values.map((value) => ({ value, label: value, selected: value === current }));
  }
  if (field === 'operator') return operatorSuggestions.map((value) => ({ value, label: value, selected: value === String(draft.operator || '').trim() }));
  if (field === 'goal') {
    const current = goalPresetOf(draft).id;
    return goalPresets.map((preset) => ({ value: preset.id, label: preset.label, selected: preset.id === current }));
  }
  const presets = fieldPresets(draft, field);
  if (presets) return presets.map((preset) => ({ ...preset, selected: preset.value === String(draft[field] || '').trim() }));
  const values = choices[field];
  if (!values) return null;
  return values.filter((value) => value !== '').map((value) => ({
    value,
    label: field === 'profileId' ? tuiOperatorProfiles.find((profile) => profile.id === value)?.title || value
      : typeof value === 'boolean' ? (value ? '开启' : '关闭') : optionLabels[value] || value,
    selected: value === draft[field],
  }));
};

export const missionFieldPlaceholder = (draft = {}, field) => {
  if (draft.mode === 'fixed-example' && field === 'timeBudget') return '留空 = 沿用固定示例预算';
  if (shapeFieldOf(field)) return shapeFieldOf(field).part === 'name' ? 'small' : dimensionPresets(draft, shapeFieldOf(field).dim)[1];
  if (tolFieldOf(field)) return '留空 = 沿用通用 atol/rtol；如 1e-3 或 1e-3/1e-4';
  if (tensorFieldOf(field)) return tensorFieldOf(field).part === 'dim' ? 'B / M / N 或 128' : tensorFieldOf(field).part === 'name' ? 'x' : '';
  if (draft.inputMode === 'spec-file' && field !== 'specPath') return field === 'repository' ? '留空 = 沿用规格；或填写绝对路径覆盖' : '留空 = 沿用规格';
  // With a known operator the dim example shows its template, not the affine one.
  const template = semanticTemplateOf(draft);
  const side = { semanticInputs: 'inputs', semanticOutputs: 'outputs', semanticMath: 'math', semanticConstraints: 'constraints', semanticBoundaries: 'boundaries' }[field];
  if (template && side) return template[side];
  return placeholders[field] || '';
};

// First field that blocks submission, in display order, so the form can move
// focus there. The message stays the authoritative submission error when no
// single field explains it.
export const missionDraftIssue = (draft = {}) => {
  const error = validateMissionDraft(draft);
  const fields = missionFormFields(draft);
  const blocking = fields.map((field, fieldIndex) => ({ field, fieldIndex, ...missionFieldStatus(draft, field) }))
    .filter((entry) => entry.state === 'error' || entry.state === 'empty');
  if (!error && !blocking.length) return null;
  const first = blocking[0];
  if (!first) return { fieldIndex: null, message: error };
  const rest = blocking.length > 1 ? `；另有 ${blocking.length - 1} 项待处理` : '';
  return { fieldIndex: first.fieldIndex, message: `「${fieldLabel(draft, first.field).trim().split(' / ')[0]}」${first.problem}${rest}` };
};

// Full-width punctuation and digits typed with a CJK IME are normalized only in
// structured fields (lists, tensors, numbers). Prose and paths are left alone.
const structuredFields = new Set(['dependencyFiles', 'baselineFile', 'semanticInputs', 'semanticOutputs', 'requiredCategories',
  'requiredProfiles', 'primaryProfile', 'protectedProfiles', 'maxRegressionPercent', 'seed', 'requestedCases', 'atol', 'rtol', 'warmup', 'repeats', 'settleTolerance',
  'maxSettlements', 'timeBudget', 'cosineTolerance']);
const halfWidth = (text) => text.replace(/[\uff01-\uff5e]/gu, (char) => String.fromCharCode(char.charCodeAt(0) - 0xfee0))
  .replace(/\u3000/gu, ' ').replace(/[、]/gu, ',').replace(/[。]/gu, '.');

export const editMissionForm = ({ draft, fieldIndex = 0, input = '', key = {} }) => {
  const fields = missionFormFields(draft);
  const index = Math.max(0, Math.min(fields.length - 1, fieldIndex));
  const result = { draft, fieldIndex: index, submit: false };
  const tensor = tensorFieldOf(fields[index]);
  if (tensor && (key.return && tensor.part === 'delete' || key.ctrl && input === 'd')) {
    const kept = tensorItemsOf(draft, tensor.side).filter((_, at) => at !== tensor.index);
    const removed = { ...draft, [tensorSides[tensor.side]]: tensorText(kept) };
    const nextFields = missionFormFields(removed);
    const landing = nextFields.indexOf(`tensor:${tensor.side}:${tensor.index}:name`);
    return { ...result, draft: removed, fieldIndex: landing >= 0 ? landing : nextFields.indexOf(`tensorAdd:${tensor.side}`) };
  }
  if (key.return && tensorTemplateOf(fields[index])) {
    const side = tensorTemplateOf(fields[index]);
    const added = { ...draft, [tensorSides[side]]: fieldPresets(draft, tensorSides[side])[0].value };
    return { ...result, draft: added, fieldIndex: missionFormFields(added).indexOf(`tensor:${side}:0:name`) };
  }
  if (key.return && fields[index] === 'shapeAdd') {
    // Adds an item with a suggested name; every dimension value is still typed.
    const added = { ...draft, benchmarkShapes: [...shapeItems(draft), { name: nextShapeName(draft), dims: {} }] };
    const nextFields = missionFormFields(added);
    const at = shapeItems(draft).length;
    const firstDim = nextFields.findIndex((name) => name.startsWith(`shape:${at}:dim:`));
    return { ...result, draft: added, fieldIndex: firstDim >= 0 ? firstDim : nextFields.indexOf(`shape:${at}:name`) };
  }
  if (key.return && tensorAddOf(fields[index])) {
    // Adds a tensor with a suggested name; dtype and layout are still picked.
    const side = tensorAddOf(fields[index]);
    const items = tensorItemsOf(draft, side) || [];
    const added = { ...draft, [tensorSides[side]]: tensorText([...items, { name: nextTensorName(draft, side), dtype: '', shape: '?', layout: '' }]) };
    return { ...result, draft: added, fieldIndex: missionFormFields(added).indexOf(`tensor:${side}:${items.length}:dtype`) };
  }
  if (key.return && tensor) return { ...result, fieldIndex: tensor.part === 'layout' ? fields.indexOf(`tensorAdd:${tensor.side}`) : index + 1 };
  if (key.return && fields[index] === 'baselineFile' && draft.sourceMode === 'managed') return { ...result, browseSources: true, browseBaseline: true };
  if (key.return) return fields[index] === 'sourceFiles' ? { ...result, browseSources: true } : { ...result, submit: true };
  const direction = key.upArrow || (key.tab && key.shift) ? -1 : key.downArrow || key.tab ? 1 : 0;
  if (direction) return { ...result, fieldIndex: (index + direction + fields.length) % fields.length };
  const field = fields[index];
  if (field === 'sourceFiles') return input === ' ' ? { ...result, browseSources: true } : result;
  if (field === 'shapeAdd' || tensorAddOf(field) || tensorTemplateOf(field) || tensor?.part === 'delete') return result;
  if (tensor) {
    const options = missionFieldOptions(draft, field);
    if (options && (key.leftArrow || key.rightArrow || (isChoicePseudo(field) && [' ', '[', ']'].includes(input)))) {
      const value = cycle(options, key, input);
      return value === null ? result : { ...result, draft: withTensorValue(draft, field, value) };
    }
    if (isChoicePseudo(field)) return result;
    const current = tensorValueOf(draft, field);
    let value = current;
    if (key.backspace || key.delete) value = Array.from(current).slice(0, -1).join('');
    else if (key.ctrl && input === 'u') value = '';
    else if (input && !key.ctrl && !key.meta) {
      const typed = halfWidth(input);
      if (tensor.part === 'dim' && /[,;\[\]@]/u.test(typed)) return { ...result, issue: '每项只填写一个维度；请在“形状”选择维数，再逐维填写。' };
      if (tensor.part === 'name' && /[:;\[\]@]/u.test(typed)) return { ...result, issue: '张量名不能包含 : ; [ ] @；请只编辑当前名称。' };
      value = `${current}${typed.replace(/[\u0000-\u001f\u007f-\u009f]/gu, '')}`;
    }
    else return result;
    return value === current ? result : { ...result, draft: withTensorValue(draft, field, value) };
  }
  if (boundaryFieldOf(field)) {
    const value = cycle(missionFieldOptions(draft, field), key, input);
    return value === null ? result : { ...result, draft: withBoundary(draft, boundaryFieldOf(field), value) };
  }
  if (field === 'semanticConstraints' && /^[1-4]$/u.test(input) && !key.ctrl && !key.meta && constraintTogglesActive(draft)) {
    return { ...result, draft: { ...draft, semanticConstraints: toggleConstraint(draft, constraintChoices[Number(input) - 1]) } };
  }
  const dtype = tolFieldOf(field);
  if (dtype) {
    const current = tolValueOf(draft, dtype);
    if (key.leftArrow || key.rightArrow) {
      const options = missionFieldOptions(draft, field);
      const at = options.findIndex((option) => option.selected);
      const next = at < 0 ? (key.rightArrow ? 0 : options.length - 1) : (at + (key.rightArrow ? 1 : -1) + options.length) % options.length;
      return { ...result, draft: withTolerance(draft, dtype, options[next].value) };
    }
    let value = current;
    if (key.backspace || key.delete) value = Array.from(current).slice(0, -1).join('');
    else if (key.ctrl && input === 'u') value = '';
    else if (input && !key.ctrl && !key.meta) value = `${current}${halfWidth(input).replace(/[\u0000-\u001f\u007f-\u009f]/gu, '')}`;
    else return result;
    return value === current ? result : { ...result, draft: withTolerance(draft, dtype, value) };
  }
  if (field === 'measurementTier') {
    const step = key.leftArrow || input === '[' ? -1 : key.rightArrow || input === ' ' || input === ']' ? 1 : 0;
    if (!step) return result;
    const at = measurementTiers.findIndex((tier) => tier.id === draft.measurementTier);
    const next = measurementTiers[at < 0 ? (step > 0 ? 0 : measurementTiers.length - 1) : (at + step + measurementTiers.length) % measurementTiers.length];
    // A tier writes its concrete numbers; 自定义 keeps the current ones editable.
    return { ...result, draft: { ...draft, measurementTier: next.id, ...(next.values || {}) } };
  }
  if (field === 'requiredCategories' && /^[1-4]$/u.test(input) && !key.ctrl && !key.meta && categoryTogglesActive(draft)) {
    return { ...result, draft: { ...draft, requiredCategories: toggleCategory(draft, categoryDescriptions[Number(input) - 1][0]) } };
  }
  const shape = shapeFieldOf(field);
  if (shape) {
    if (shape.part === 'name' && input === '*' && !key.ctrl && !key.meta) {
      // Explicit mark of the primary shape; never chosen automatically.
      const name = shapeValueOf(draft, field).trim();
      return name ? { ...result, draft: { ...draft, primaryProfile: name,
        benchmarkShapes: shapeItems(draft).map((item, at) => ({ ...item, primary: at === shape.index })) } } : result;
    }
    if (key.ctrl && input === 'd') {
      const deleted = String(shapeItems(draft)[shape.index]?.name ?? '').trim();
      const removed = { ...draft, ...(shapeItems(draft)[shape.index]?.primary || (deleted && deleted === String(draft.primaryProfile || '').trim()) ? { primaryProfile: '' } : {}),
        benchmarkShapes: shapeItems(draft).filter((_, at) => at !== shape.index) };
      const nextFields = missionFormFields(removed);
      const landing = nextFields.indexOf(`shape:${shape.index}:name`);
      return { ...result, draft: removed, fieldIndex: landing >= 0 ? landing : nextFields.indexOf('shapeAdd') };
    }
    const current = shapeValueOf(draft, field);
    if (key.leftArrow || key.rightArrow) {
      // Explicit pick of a common name or size, written as editable text.
      const options = missionFieldOptions(draft, field);
      if (!options.length) return result;
      const at = options.findIndex((option) => option.selected);
      const next = at < 0 ? (key.rightArrow ? 0 : options.length - 1) : (at + (key.rightArrow ? 1 : -1) + options.length) % options.length;
      return { ...result, draft: withShapeValue(draft, field, options[next].value) };
    }
    let value = current;
    if (key.backspace || key.delete) value = Array.from(current).slice(0, -1).join('');
    else if (key.ctrl && input === 'u') value = '';
    else if (input && !key.ctrl && !key.meta) value = `${current}${halfWidth(input).replace(/[\u0000-\u001f\u007f-\u009f]/gu, '')}`;
    else return result;
    return value === current ? result : { ...result, draft: withShapeValue(draft, field, value) };
  }
  if (field === 'baselineFile' && draft.sourceMode === 'managed') {
    const options = missionFieldOptions(draft, field);
    const step = key.leftArrow ? -1 : key.rightArrow || input === ' ' ? 1 : 0;
    if (!step) return result;
    const next = (Math.max(0, options.findIndex((option) => option.selected)) + step + options.length) % options.length;
    return { ...result, draft: { ...draft, baselineFile: options[next].value } };
  }
  const values = choices[field];
  if (values) {
    const step = key.leftArrow || input === '[' ? -1 : key.rightArrow || input === ' ' || input === ']' ? 1 : 0;
    if (!step) return result;
    const next = (Math.max(0, values.indexOf(draft[field])) + step + values.length) % values.length;
    return { ...result, draft: { ...draft, [field]: values[next], ...(field === 'target' ? { targetArchitecture: '' } : {}) }, fieldIndex: field === 'mode' ? 0 : index };
  }
  if (field === 'operator' && (key.leftArrow || key.rightArrow)) {
    // Explicit pick of a suggested name; typing any other name still works.
    const at = operatorSuggestions.indexOf(String(draft.operator || '').trim());
    const count = operatorSuggestions.length;
    const next = at < 0 ? (key.rightArrow ? 0 : count - 1) : (at + (key.rightArrow ? 1 : -1) + count) % count;
    return { ...result, draft: { ...draft, operator: operatorSuggestions[next] } };
  }
  if (field === 'goal') {
    const preset = goalPresetOf(draft);
    if (key.leftArrow || key.rightArrow) {
      const count = goalPresets.length;
      const next = goalPresets[(goalPresets.indexOf(preset) + (key.rightArrow ? 1 : -1) + count) % count];
      // Free text typed under 「自定义」 is kept aside and restored on return.
      const goalCustom = preset.id === 'custom' ? String(draft.goal || '') : String(draft.goalCustom || '');
      const goal = next.id === 'custom' ? goalCustom : composeGoal(next, '');
      return { ...result, draft: { ...draft, goalPreset: next.id, goalValue: '', goalCustom, goal } };
    }
    if (preset.unit) {
      const value = String(draft.goalValue || '');
      let goalValue = value;
      if (key.backspace || key.delete) goalValue = Array.from(value).slice(0, -1).join('');
      else if (key.ctrl && input === 'u') goalValue = '';
      else if (input && !key.ctrl && !key.meta) goalValue = `${value}${halfWidth(input).replace(/[\u0000-\u001f\u007f-\u009f]/gu, '')}`;
      else return result;
      return { ...result, draft: { ...draft, goalValue, goal: composeGoal(preset, goalValue) } };
    }
    // 持续优化 has no value to type; ←→ back to 自定义 to write free text.
    if (preset.id !== 'custom') return result;
  }
  if (field === 'primaryProfile' && (key.leftArrow || key.rightArrow)) {
    // Explicit pick among the profiles already listed; never auto-selected.
    const names = profileNames(draft);
    if (!names.length) return result;
    const at = names.indexOf(String(draft.primaryProfile || '').trim());
    const next = at < 0 ? (key.rightArrow ? 0 : names.length - 1) : (at + (key.rightArrow ? 1 : -1) + names.length) % names.length;
    return { ...result, draft: { ...draft, primaryProfile: names[next] } };
  }
  const presets = fieldPresets(draft, field);
  if (presets && (key.leftArrow || key.rightArrow)) {
    // Explicit pick of a preset value, written as editable text.
    const at = presets.findIndex((preset) => preset.value === String(draft[field] || '').trim());
    const count = presets.length;
    const next = at < 0 ? (key.rightArrow ? 0 : count - 1) : (at + (key.rightArrow ? 1 : -1) + count) % count;
    return { ...result, draft: { ...draft, [field]: presets[next].value } };
  }
  const current = String(draft[field] || '');
  if (key.backspace || key.delete) return { ...result, draft: { ...draft, [field]: Array.from(current).slice(0, -1).join('') } };
  if (key.ctrl && input === 'u') return { ...result, draft: { ...draft, [field]: '' } };
  if (!input || key.ctrl || key.meta) return result;
  const typed = input.replace(/[\u0000-\u001f\u007f-\u009f]/gu, '');
  const text = structuredFields.has(field) ? halfWidth(typed) : typed;
  return { ...result, draft: { ...draft, [field]: `${current}${text}` } };
};

// Summary under the add row: how many shapes are complete and frozen.
const shapesNote = (draft, statuses) => {
  const pending = Object.keys(statuses).filter((field) => shapeFieldOf(field) && ['empty', 'error'].includes(statuses[field].state)).length;
  const names = declaredShapeNames(draft);
  return pending
    ? { tone: 'warn', text: `${shapeItems(draft).length} 个 shape，还有 ${pending} 项未填好；Enter 再添加一个` }
    : { tone: 'ok', text: `✓ 冻结 ${names.length} 个性能 shape：${names.join(', ')}；基线必须按此生成输入` };
};

export const missionFieldRow = (draft, field) => {
  const status = missionFieldStatus(draft, field);
  const tensorAction = tensorAddOf(field) || tensorTemplateOf(field) || tensorFieldOf(field)?.part === 'delete';
  const raw = shapeFieldOf(field) ? shapeValueOf(draft, field) : tensorFieldOf(field) ? tensorValueOf(draft, field) : tolFieldOf(field) ? tolValueOf(draft, tolFieldOf(field)) : draft[field];
  const label = fieldLabel(draft, field);
  return {
    field, label, shortLabel: label.trim().split(' / ')[0], value: displayMissionField(draft, field),
    selected: false,
    kind: field === 'sourceFiles' || field === 'shapeAdd' || tensorAction ? 'action' : choices[field] || field === 'measurementTier' || isChoicePseudo(field) || field === 'baselineFile' && draft.sourceMode === 'managed' ? 'choice'
      : field === 'goal' && goalPresetOf(draft).id !== 'custom' ? 'preset' : 'text',
    text: field === 'sourceFiles' || field === 'shapeAdd' || tensorAction ? displayMissionField(draft, field) : typeof raw === 'string' ? raw : '',
    ...(field === 'baselineFile' && draft.sourceMode === 'managed' ? { note: { tone: 'muted', text: missionFieldOptions(draft, field).length > 1
      ? '←→ 选择已导入基线 · Enter 导入文件 · Tab 下一项'
      : '尚无可选基线 · Enter 导入独立 .py 文件（不能是 run.py）' } } : {}),
    ...(tensorFieldOf(field) && status.state === 'ok' && missionDimensionNote(draft, field) ? { note: missionDimensionNote(draft, field) } : {}),
    ...(tensorFieldOf(field)?.part === 'layout' && status.state === 'ok' ? { note: { tone: 'muted', text: `当前 ${tensorDims(tensorItemsOf(draft, tensorFieldOf(field).side)[tensorFieldOf(field).index]).length} 维 · ${tensorLayoutLabels[tensorValueOf(draft, field)]}；保持逻辑维度顺序` } } : {}),
    ...(field === 'goal' ? {
      preset: { label: goalPresetOf(draft).label, unit: goalPresetOf(draft).unit || '', value: String(draft.goalValue || '') },
      note: missionGoalNote(draft),
    } : field === 'shapeAdd' && shapesDeclared(draft) && status.state === 'ok' ? { note: shapesNote(draft, Object.fromEntries(missionFormFields(draft).map((name) => [name, missionFieldStatus(draft, name)]))) }
      : field === 'measurementTier' ? { note: tierOf(draft)?.values ? { tone: 'ok', text: `✓ ${tierOf(draft).label}：${tierSummary(draft)}` }
        : tierOf(draft) ? { tone: 'muted', text: '在下面逐项填写四个测量参数' } : { tone: 'muted', text: '选一档写入具体数值，或在下面逐项填写' } }
      : field === 'requiredCategories' && status.state === 'ok' ? { note: categoriesNote(draft) }
      : field === 'semanticConstraints' && status.state === 'ok' ? { note: constraintsNote(draft) }
      : templateNote(draft, field) ? { note: templateNote(draft, field) } : {}),
    placeholder: missionFieldPlaceholder(draft, field),
    options: missionFieldOptions(draft, field),
    ...status,
  };
};

export const deriveMissionForm = (draft = createMissionDraft(), fieldIndex = 0, viewport = {}) => {
  const fields = missionFormFields(draft);
  const index = Math.max(0, Math.min(fields.length - 1, fieldIndex));
  const rows = Number.isFinite(viewport.rows) && viewport.rows > 0 ? Math.floor(viewport.rows) : 30;
  const capacity = Math.max(1, rows - 11);
  const semanticStart = fields.findIndex((field) => field.startsWith('tensor'));
  const groups = draft.mode === 'fixed-example'
    ? [{ title: '固定示例与预算', fields }]
    : draft.inputMode === 'spec-file'
      ? [{ title: '导入任务规格', fields: fields.slice(0, 3) }, { title: '任务覆盖项与提交', fields: fields.slice(3) }]
      : [{ title: '任务与素材', fields: fields.slice(0, semanticStart) },
        { title: '算子语义', fields: fields.slice(semanticStart, fields.indexOf('seed')) },
        { title: '测试要求', fields: fields.slice(fields.indexOf('seed'), fields.indexOf('execution')) },
        { title: '提交与预算', fields: fields.slice(fields.indexOf('execution')) }];
  const groupIndex = groups.findIndex(group => group.fields.includes(fields[index]));
  const group = groups[groupIndex];
  const groupFieldIndex = group.fields.indexOf(fields[index]);
  const start = Math.floor(groupFieldIndex / capacity) * capacity;
  const pagesBefore = groups.slice(0, groupIndex).reduce((total, item) => total + Math.ceil(item.fields.length / capacity), 0);
  const totalPages = groups.reduce((total, item) => total + Math.ceil(item.fields.length / capacity), 0);
  const statuses = Object.fromEntries(fields.map((field) => [field, missionFieldStatus(draft, field)]));
  const pending = (field) => ['empty', 'error'].includes(statuses[field].state);
  const blocking = fields.filter(pending).length;
  return {
    height: Math.max(1, rows - 2),
    group: `${groupIndex + 1}/${groups.length} · ${group.title}`,
    groups: groups.map((item, itemIndex) => ({
      title: item.title, total: item.fields.length, done: item.fields.filter((field) => !pending(field)).length, active: itemIndex === groupIndex,
    })),
    rows: group.fields.slice(start, start + capacity).map((field, offset) => {
      return { ...missionFieldRow(draft, field), selected: start + offset === groupFieldIndex };
    }),
    page: `${pagesBefore + Math.floor(groupFieldIndex / capacity) + 1}/${totalPages}`,
    pageCount: totalPages,
    hint: missionFormHint(draft, fields[index]), submitLabel: missionSubmitLabel(draft),
    blocking, ready: validateMissionDraft(draft) === null,
  };
};
