import { createHash } from 'node:crypto';
import { appendExperience, emptyExperienceStore, experienceError, formatExperienceContext, validateExperienceContext, EXPERIENCE_CONDITIONS, EXPERIENCE_LIMITS, EXPERIENCE_SELECTION_POLICY_VERSION, EXPERIENCE_SELECTION_SCHEMA_VERSION } from '../experience-contract.mjs';
import { isBackendTargetName, isInfrastructureTestFailure } from '../operator-test-evidence.mjs';
// 方案 D 的冻结策略版本来自纯选择模块：静态导入保证未组合/缺失时直接失败，
// 依赖该轮知识的新 Agent 不会被静默放行（不设按需加载或空知识回退）。
import { WIKI_SELECTION_POLICY_VERSION } from '../experience-selection.mjs';

const requiredEvidence = ['missionId', 'candidateId', 'runId', 'patchDigest', 'packageDigest', 'environmentDigest', 'acceptanceDigest', 'hardware', 'executionMode', 'outcome'];
const preparingRounds = new WeakMap();
const fail = (code, message, details = {}) => Object.assign(experienceError(code, message, 409), { retryable: false, ...details });
const safeId = (value) => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:@-]{0,159}$/u.test(value) && !value.includes('..');
const timeoutValue = (value) => {
  if (!Number.isFinite(value) || value <= 0 || value > 120000) throw new TypeError('timeoutMs must be positive, finite, and no greater than 120000');
  return value;
};
const targetValues = (value) => {
  const items = Array.isArray(value) ? value : value == null ? [] : [value];
  const result = [];
  for (const item of items) {
    if (typeof item !== 'string') continue;
    const normalized = item.trim().toLowerCase();
    if (!normalized || result.includes(normalized)) continue;
    result.push(normalized);
    if (result.length >= 16) break;
  }
  return result;
};
const declaredValues = (value, label) => {
  if (value == null) return [];
  if (!Array.isArray(value) || value.length > 16 || value.some((item) => typeof item !== 'string' || !item.trim() || item.trim().length > 8000)) {
    throw experienceError('EXPERIENCE_INVALID', `${label} must be a bounded array of non-empty strings`, 400);
  }
  return targetValues(value);
};
const sameValues = (left, right) => left.length === right.length && left.every((item) => right.includes(item));
// Mission 只固定 operator/tags；hardware 与 architecture 是「本轮实际执行目标」，必须来自同 Mission
// 的 resolvedTarget（执行结果投影），不能拿 backend 名冒充，也不能拿声明值覆盖实际值。
const missionScope = (mission) => ({
  ...((mission.operatorProfile?.operator || mission.operator) ? { operator: mission.operatorProfile?.operator || mission.operator } : {}),
  tags: mission.tags ?? [],
});
const boundTargetFor = (state, mission) => {
  const target = state?.iterationStats?.resolvedTarget;
  if (!target || typeof target !== 'object' || Array.isArray(target) || target.missionId !== mission.id) return null;
  const hardware = targetValues(target.hardware);
  const architecture = targetValues(target.architecture);
  if (!hardware.length || hardware.some(isBackendTargetName) || architecture.some(isBackendTargetName)) {
    throw fail('ROUND_EXPERIENCE_TARGET_INVALID', 'The Mission-bound execution target has no valid hardware identity');
  }
  return { hardware, architecture };
};
const rejectBackend = (values, where) => {
  const backend = values.find((item) => isBackendTargetName(item));
  if (backend) throw fail('ROUND_EXPERIENCE_TARGET_INVALID', `Execution backend "${backend}" cannot be used as ${where}; it must not be retrieved as hardware`);
};
// 默认/显式 scope 都不得绕过 Mission 已绑定的执行目标：无解析目标才回退 Mission 明确 hardware
// （backend 名必须显式报错，不能悄悄退化成正常零命中）；显式 scope 与绑定目标冲突同样拒绝。
const queryScope = (state, mission, scope) => {
  const base = missionScope(mission);
  const bound = boundTargetFor(state, mission);
  if (scope === undefined) {
    if (bound) return { ...base, hardware: bound.hardware, ...(bound.architecture.length ? { architecture: bound.architecture } : {}) };
    rejectBackend(targetValues(mission.hardware), 'a hardware target');
    const declared = declaredValues(mission.hardware, 'mission.hardware');
    rejectBackend(declared, 'a hardware target');
    return { ...base, hardware: declared };
  }
  if (!scope || typeof scope !== 'object' || Array.isArray(scope)) throw fail('ROUND_EXPERIENCE_TARGET_INVALID', 'Explicit experience scope must be a plain object');
  const merged = { ...base, ...scope };
  rejectBackend(targetValues(merged.hardware), 'a hardware target');
  rejectBackend(targetValues(merged.architecture), 'an architecture target');
  const explicitHardware = declaredValues(merged.hardware, 'scope.hardware');
  const explicitArchitecture = declaredValues(merged.architecture, 'scope.architecture');
  if (bound) {
    if (explicitHardware.length && !sameValues(explicitHardware, bound.hardware)) throw fail('ROUND_EXPERIENCE_TARGET_INVALID', 'Explicit scope hardware conflicts with the Mission-bound execution target');
    if (explicitArchitecture.length && !sameValues(explicitArchitecture, bound.architecture)) throw fail('ROUND_EXPERIENCE_TARGET_INVALID', 'Explicit scope architecture conflicts with the Mission-bound execution target');
    merged.hardware = bound.hardware;
    if (bound.architecture.length) merged.architecture = bound.architecture;
  }
  return merged;
};
// 执行记录始终保存「实际执行目标」，绝不因查询目标而改写证据。
const recordScope = (mission, evidence) => ({
  ...missionScope(mission),
  hardware: [evidence.hardware],
  ...(evidence.architecture !== undefined ? { architecture: [evidence.architecture] } : {}),
});
const targetMismatch = (bound, evidence) => {
  const issues = [];
  if (bound.hardware.length && !bound.hardware.includes(evidence.hardware)) issues.push({ field: 'hardware', expected: bound.hardware, actual: evidence.hardware });
  if (bound.architecture.length && !bound.architecture.includes(evidence.architecture)) {
    issues.push({ field: 'architecture', expected: bound.architecture, actual: evidence.architecture ?? null });
  }
  return issues.length ? issues : null;
};
const canonicalEvidence = (evidence) => appendExperience(emptyExperienceStore(), {
  projectId: 'validation', title: 'Execution evidence', content: 'Validation only.', author: 'validator', evidence,
}, { id: 'validation', now: '1970-01-01T00:00:00.000Z', source: 'execution' }).result.experience.evidence;

// 选择清单 sidecar 只做审计，不参与 context 校验，也不得改变注入集合。字节一律按
// UTF-8 实测（Buffer.byteLength），不用字符数估算。
const utf8Bytes = (value) => Buffer.byteLength(value, 'utf8');
const selectionEvidence = (context, { projectId, missionId, roundId }) => ({
  schemaVersion: EXPERIENCE_SELECTION_SCHEMA_VERSION,
  policyVersion: EXPERIENCE_SELECTION_POLICY_VERSION,
  projectId, missionId, roundId,
  repositoryRevision: context.repositoryRevision,
  contextId: context.contextId,
  scopeDigest: context.scopeDigest,
  itemLimit: EXPERIENCE_LIMITS.contextItems,
  byteLimit: EXPERIENCE_LIMITS.contextBytes,
  contextBytes: utf8Bytes(JSON.stringify(context)),
  renderedBytes: utf8Bytes(formatExperienceContext(context, { projectId, missionId, roundId })),
});
// 只有 retrieve 端口（旧 retrieve-only 注入）时如实标注"未记录排除原因"，绝不编造。
const contextDerivedSelection = (context, identity) => ({
  ...selectionEvidence(context, identity),
  selected: context.items.map((record) => ({ id: record.id, version: record.version, source: record.source, useAs: record.useAs, reason: 'frozen-context' })),
  excluded: [],
  excludedUnauthorized: 0,
  excludedOmitted: 0,
  exclusionReasonsRecorded: false,
  auditSource: 'context-derived',
});
// 内容与选择必须来自同一次读取，包含 asOf 的 contextId 必须完全一致。
const auditSelection = (raw, context, identity) => {
  if (raw == null) return contextDerivedSelection(context, identity);
  const aligned = raw && raw.schemaVersion === EXPERIENCE_SELECTION_SCHEMA_VERSION
    && raw.projectId === identity.projectId && raw.missionId === identity.missionId && raw.roundId === identity.roundId
    && raw.contextId === context.contextId && raw.repositoryRevision === context.repositoryRevision && raw.scopeDigest === context.scopeDigest
    && Array.isArray(raw.selected) && raw.selected.length === context.items.length
    && raw.selected.every((item, index) => item?.id === context.items[index].id && item?.version === context.items[index].version
      && item?.source === context.items[index].source && item?.useAs === context.items[index].useAs);
  if (!aligned) throw fail('ROUND_EXPERIENCE_SELECTION_CONFLICT', 'Experience selection does not match its frozen context');
  if (raw.auditSource === 'context-derived') return { ...structuredClone(raw), ...selectionEvidence(context, identity) };
  // 审计保留检索端口实际使用的策略版本：D 选择不得被旧 retrieve-only 版本号覆盖。
  const policyVersion = typeof raw.policyVersion === 'string' && raw.policyVersion ? raw.policyVersion : EXPERIENCE_SELECTION_POLICY_VERSION;
  return { ...structuredClone(raw), ...selectionEvidence(context, identity), policyVersion, requestedLimit: raw.requestedLimit, exclusionReasonsRecorded: true, auditSource: 'retrieve-with-selection' };
};

// ---------------------------------------------------------------------------
// prepare 的选择输入派生（方案 D）
//
// 只读既有、已提交的同 Mission 事实（roundFacts / runHistory / benchmark / 冻结
// context），缺失的维度保持空。绝不把自由文本变成硬件能力，不猜测量瓶颈，不为
// 未知字段编造 ID/版本绑定；派生的症状/技术词表是固定且可审计的假设。
// ---------------------------------------------------------------------------
const SELECTION_FEATURE_LIMIT = 8;
const SELECTION_FEATURE_PER_KIND = 2;
const SELECTION_FEATURE_VALUE = 160;
const SELECTION_FEATURE_BASIS = 1000;
const SELECTION_PREFERRED_LIMIT = 20;
const SELECTION_REPEATED_LIMIT = 20;
const SELECTION_TARGET_LIMIT = 16;
const SELECTION_FACTS_LIMIT = 20;
// 已提交（终态）benchmark 沿用既有生产状态集合（同 collect 与 operator-test-evidence）：
// running/idle/queued 的执行可能已缓存 experienceEvidence，但尚未结算，不能当事实或重复证据。
const TERMINAL_BENCHMARK_STATUSES = ['complete', 'failed', 'cancelled'];

const selectionText = (value, max) => (typeof value === 'string' ? value.trim().slice(0, max) : '');
const selectionRecord = (value) => (value && typeof value === 'object' && !Array.isArray(value) ? value : null);
// 稳定 JSON（递归键排序）保证同一尝试身份不因对象构造顺序不同而得到不同摘要。
const stableSelectionValue = (value) => JSON.stringify(value, (_key, item) => (item && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.keys(item).sort().map((key) => [key, item[key]]))
  : item));
const selectionDigest = (value) => createHash('sha256').update(stableSelectionValue(value)).digest('hex');
const selectionList = (value, max = SELECTION_TARGET_LIMIT) => {
  const items = Array.isArray(value) ? value : value == null ? [] : [value];
  const result = [];
  for (const item of items) {
    const text = selectionText(item, SELECTION_FEATURE_VALUE).toLowerCase();
    if (!text || result.includes(text)) continue;
    result.push(text);
    if (result.length >= max) break;
  }
  return result;
};
// 固定词表：只把 Mission 自己写明的词映射为可匹配 wiki topic 的假设标签，不带数值
// 置信度，不推断瓶颈。候选文件名/产物路径不是结构证据，指标名或耗时数值也不是症状
// ——它们只是测量名，不能当作已观测瓶颈。
const SYMPTOM_HYPOTHESES = [
  { pattern: /tail|尾块|余数|partial\s+block/iu, value: 'tail/partial-block handling' },
  { pattern: /unalign|misalign|非对齐|不对齐/iu, value: 'unaligned access' },
  { pattern: /small[-\s]?batch|小\s*batch|小批量/iu, value: 'small-batch workload' },
  { pattern: /memory[-\s]?bound|访存|带宽受限/iu, value: 'memory-bound workload' },
];
const TECHNIQUE_HYPOTHESES = [
  { pattern: /vectoriz|向量化/iu, value: 'vectorization' },
  { pattern: /fusion|fuse|融合/iu, value: 'operator fusion' },
  { pattern: /tiling|tile|分块/iu, value: 'tiling' },
  { pattern: /pipelin|流水线/iu, value: 'software pipelining' },
];
// 失败词表同样固定：把已提交失败记录映射为可匹配 wiki topic 的算子级类型，不猜根因。
const FAILURE_LESSONS = [
  { pattern: /compil|nvcc|toolchain|编译/iu, value: 'compiler/toolchain failure' },
  { pattern: /correct|accuracy|mismatch|assert|数值|精度|正确性/iu, value: 'correctness failure' },
  { pattern: /operator|kernel|launch|算子/iu, value: 'operator/kernel failure' },
];
const featureCollector = () => {
  const features = [];
  const counts = new Map();
  return {
    add(kind, value, basis) {
      const text = selectionText(value, SELECTION_FEATURE_VALUE);
      const why = selectionText(basis, SELECTION_FEATURE_BASIS);
      if (!text || !why || features.length >= SELECTION_FEATURE_LIMIT) return;
      if ((counts.get(kind) || 0) >= SELECTION_FEATURE_PER_KIND) return;
      if (features.some((item) => item.kind === kind && item.value === text)) return;
      counts.set(kind, (counts.get(kind) || 0) + 1);
      features.push({ kind, value: text, basis: why });
    },
    values: () => features,
  };
};
// 已提交的同 Mission/同 Project 轮次事实：归档 runHistory（新→旧）与
// iterationStats.roundFacts 一起按各自 recordedAt 排序，旧快照不得遮蔽更新的归档事实。
// 只有带真实 run 身份、Mission/Project 都一致的事实才参与派生；未提交对象、别 Mission
// 或别 Project 的 benchmark 一律不造事实。
const factsRecency = (facts) => selectionText(facts?.recordedAt, 40);
const committedFacts = (state, mission) => {
  const projectId = selectionText(mission?.projectId, 160);
  const missionId = selectionText(mission?.id, 160);
  // 归属未知就连事实都读不出来：绝不按「另一方一致」互补所有权，也不拿别 Project 的
  // 事实凑数（missing owner 与矛盾同样排除）。
  if (!projectId || !missionId) return [];
  const seen = new Set();
  const collected = [];
  const push = (value) => {
    const facts = selectionRecord(value);
    if (!facts) return;
    // 只有当投递目标与来源 run 都明确属于同一 Mission 时才是本轮可用的事实。
    if (selectionText(facts.previous?.missionId, 160) !== missionId) return;
    if (selectionText(facts.target?.missionId, 160) !== missionId) return;
    // 两个项目归属字段都必须已知且都等于本 Mission 的 Project；任一缺失或矛盾即排除。
    const previousProject = selectionText(facts.previous?.projectId, 160);
    const targetProject = selectionText(facts.target?.projectId, 160);
    if (!previousProject || !targetProject || previousProject !== projectId || targetProject !== projectId) return;
    const sourceRunId = selectionText(facts.previous?.runId, 160);
    if (!sourceRunId) return;
    const identity = `${factsRecency(facts)}|${sourceRunId}`;
    if (seen.has(identity)) return;
    seen.add(identity);
    collected.push(facts);
  };
  const history = Array.isArray(state?.runHistory) ? state.runHistory.slice(0, SELECTION_FACTS_LIMIT) : [];
  for (const round of history) push(round?.roundFacts);
  push(state?.iterationStats?.roundFacts);
  collected.sort((left, right) => factsRecency(right).localeCompare(factsRecency(left)));
  return collected;
};
// 冻结 context 是本轮之前已提交的投影；其中执行记录带完整 evidence，可逐条重算尝试身份。
const frozenExecutionItems = (state) => {
  const items = selectionRecord(state?.iterationStats?.roundExperience)?.items;
  return (Array.isArray(items) ? items : []).filter((item) => item?.source === 'execution'
    && selectionText(item?.id, 160) && Number.isInteger(item?.version) && item.version >= 1);
};
const goalSelectionText = (mission) => [mission.goal, mission.title].filter((item) => typeof item === 'string' && item.trim()).join('\n');
const vocabularyMatches = (collector, text, kind, vocabulary, basisFor) => {
  for (const entry of vocabulary) if (entry.pattern.test(text)) collector.add(kind, entry.value, basisFor(entry));
};
// 已提交事实里的失败类型：infrastructure/provider 失败必须先被识别，绝不能变成算子优化
// 线索；正确性/编译/算子失败才映射为有据的失败特征。
const failureFeatures = (collector, facts, describe) => {
  const failure = selectionRecord(facts?.failure);
  const correctness = selectionRecord(facts?.correctness);
  const failed = correctness?.status === 'failed';
  if (!failure && !failed) return;
  // isInfrastructureTestFailure 只接受对象，缺记录时保持「不是基础设施失败」的保守判断。
  const infrastructure = failure?.classification === 'infrastructure'
    || (failure ? isInfrastructureTestFailure(failure) : false)
    || (correctness ? isInfrastructureTestFailure(correctness) : false);
  if (infrastructure) return;
  const detail = failed ? selectionText(correctness.failedCaseCategory || correctness.failedCaseName || correctness.failedCase || correctness.error, 160) : '';
  // classification 只是粗粒度归类（operator/infrastructure），本身不是症状词，不参与词表匹配。
  const text = [
    selectionText(failure?.code, 160),
    selectionText(failure?.message, 240),
    selectionText(failure?.source, 80),
    detail,
  ].filter(Boolean).join(' ');
  if (!text) return;
  const code = selectionText(failure?.code, 120) || detail || 'correctness';
  const matched = FAILURE_LESSONS.filter((entry) => entry.pattern.test(text));
  if (matched.length) {
    for (const entry of matched) collector.add('failure', entry.value, describe(code));
    return;
  }
  const fallback = selectionText(failure?.code || detail, SELECTION_FEATURE_VALUE);
  if (fallback) collector.add('failure', fallback, describe(code));
};
const selectionFeatures = (state, mission) => {
  const collector = featureCollector();
  // 结构线索只有 Mission 显式声明的算子身份：候选文件名/产物路径不是结构证据。
  const operator = selectionText(mission.operatorProfile?.operator || mission.operator, SELECTION_FEATURE_VALUE);
  if (operator) collector.add('structure', operator, 'explicit Mission operator identity (never inferred from file names, metrics or backend names)');
  // 症状/技术线索只来自 Mission 明确写下的目标语义，经固定词表映射成可匹配 wiki topic 的假设。
  const goal = goalSelectionText(mission);
  if (goal) {
    vocabularyMatches(collector, goal, 'symptom', SYMPTOM_HYPOTHESES,
      (entry) => `Mission goal/title states "${entry.value}" as a symptom hypothesis, never as a measured bottleneck`);
    vocabularyMatches(collector, goal, 'technique', TECHNIQUE_HYPOTHESES,
      (entry) => `Mission goal/title names "${entry.value}" as an intended technique`);
  }
  // 已提交的同 Mission 事实（最新在前）补充失败类型与上一轮实际尝试过的改动方向。
  const factsList = committedFacts(state, mission);
  for (const [index, facts] of factsList.entries()) {
    const age = index === 0 ? 'latest committed round' : `committed round #${index + 1}`;
    failureFeatures(collector, facts, (code) => `${age} facts report failure "${code}" as a correctness/compiler/operator failure (infrastructure failures are excluded)`);
    const attempted = [facts.candidate?.title, facts.candidate?.direction].filter((item) => typeof item === 'string' && item.trim()).join('\n');
    if (attempted) vocabularyMatches(collector, attempted, 'technique', TECHNIQUE_HYPOTHESES,
      (entry) => `${age} facts describe "${entry.value}" as the already attempted change`);
  }
  return collector.values();
};
// capabilities/software 只在 resolvedTarget 显式为同一 Mission 提供时读取；否则保持空数组。
const selectionTarget = (state, mission, scope) => {
  const bound = selectionRecord(state?.iterationStats?.resolvedTarget);
  const sameMission = bound && selectionText(bound.missionId, 160) === mission.id;
  return {
    hardware: selectionList(scope?.hardware),
    architecture: selectionList(scope?.architecture),
    capabilities: sameMission ? selectionList(bound.capabilities) : [],
    software: sameMission ? selectionList(bound.software) : [],
  };
};
// 尝试身份 = 修改内容（patch/package 摘要）+ 参数与环境（environment 摘要）+ 验收条件
// （acceptance 摘要）+ 实际执行条件（hardware/architecture/executionMode/operation）。
// 刻意不含 candidateId/runId：同一修改在全新 candidate 身份下重提也必须能判定为重复；
// 但完整来源身份（mission/run/candidate）必须存在，否则不构成可归属的尝试。缺任一必需
// 摘要、执行条件或来源身份即不声明重复（保留 unknown），绝不用猜测补齐。
const ATTEMPT_DIGEST_KEYS = ['patchDigest', 'packageDigest', 'environmentDigest', 'acceptanceDigest'];
const attemptBinding = (value) => {
  const evidence = selectionRecord(value);
  if (!evidence) return null;
  const missionId = selectionText(evidence.missionId, 160);
  const runId = selectionText(evidence.runId, 160);
  const candidateId = selectionText(evidence.candidateId, 160);
  if (!missionId || !runId || !candidateId) return null;
  const digests = ATTEMPT_DIGEST_KEYS.map((key) => {
    const digest = selectionText(evidence[key], 80).toLowerCase().replace(/^sha256:/u, '');
    return /^[a-f0-9]{64}$/u.test(digest) ? digest : '';
  });
  const hardware = selectionText(evidence.hardware, SELECTION_FEATURE_VALUE).toLowerCase();
  const executionMode = selectionText(evidence.executionMode, SELECTION_FEATURE_VALUE).toLowerCase();
  const operation = selectionText(evidence.operation, SELECTION_FEATURE_VALUE).toLowerCase();
  if (digests.some((item) => !item) || !hardware || !executionMode || !operation) return null;
  const identity = {
    patchDigest: digests[0],
    packageDigest: digests[1],
    environmentDigest: digests[2],
    acceptanceDigest: digests[3],
    hardware,
    architecture: selectionText(evidence.architecture, SELECTION_FEATURE_VALUE).toLowerCase(),
    executionMode,
    operation,
  };
  return { key: 'attempt_' + selectionDigest(identity), missionId, runId, candidateId, identity };
};
// 当前尝试只认绑定本 Mission 且已结算（终态）的执行证据：running/idle/queued 的
// benchmark 可能已缓存 experienceEvidence，但尚未提交，不得据此声明重复。
const currentAttempt = (state, mission) => {
  const benchmark = selectionRecord(state?.benchmark);
  if (!benchmark || !TERMINAL_BENCHMARK_STATUSES.includes(benchmark.status)) return null;
  const binding = attemptBinding(selectionRecord(benchmark.result)?.experienceEvidence);
  return binding && binding.missionId === mission.id ? binding : null;
};
// 归档尝试同样只看终态 benchmark：归档里的 running 条目只是未结算快照。
const archivedAttempts = (state, mission) => {
  const history = Array.isArray(state?.runHistory) ? state.runHistory.slice(0, SELECTION_FACTS_LIMIT) : [];
  const projectId = selectionText(mission?.projectId, 160);
  const bindings = [];
  for (const round of history) {
    const benchmark = selectionRecord(round?.benchmark);
    if (!benchmark || !TERMINAL_BENCHMARK_STATUSES.includes(benchmark.status)) continue;
    const binding = attemptBinding(selectionRecord(benchmark.result)?.experienceEvidence);
    if (!binding || binding.missionId !== mission.id) continue;
    // 归档事实已给出项目归属且与本 Mission 矛盾时排除；归属缺失不据此造事实。
    const owner = selectionText(round?.roundFacts?.previous?.projectId, 160);
    if (owner && projectId && owner !== projectId) continue;
    bindings.push(binding);
  }
  return bindings;
};
// 只有同一「修改+参数+条件」在另一个 run 上真实发生过才算重复；本轮自己的归档条目不算。
const repeatedAttempt = (state, mission) => {
  const current = currentAttempt(state, mission);
  if (!current) return null;
  return archivedAttempts(state, mission).some((item) => item.key === current.key && item.runId !== current.runId) ? current : null;
};
// 只有能由完整证据逐条重算、确认是同一「修改+条件」且归属同一 Mission/Project 的经验
// 记录才降权：别 Mission/别 Project 的同 digest 记录不能被降权。只有 id/version 的收集
// 摘要不足以判定，一律不声明重复；绝不把同一个 key 套给所有收集记录，也不因一次重复
// 封禁整类技术。
const repeatedAttemptsFor = (state, mission, current) => {
  if (!current) return [];
  const projectId = selectionText(mission?.projectId, 160);
  const attempts = [];
  for (const item of frozenExecutionItems(state)) {
    if (selectionText(item.evidence?.missionId, 160) !== mission.id) continue;
    if (selectionText(item.projectId, 160) !== projectId) continue;
    const binding = attemptBinding(item.evidence);
    if (!binding || binding.key !== current.key) continue;
    attempts.push({ id: item.id, version: item.version, attemptKey: current.key });
    if (attempts.length >= SELECTION_REPEATED_LIMIT) break;
  }
  return attempts;
};
// preferred 只认能被既有证据绑定到本轮目标候选（上一失败候选/当前最佳/本轮执行候选）且
// 归属同一 Mission/Project 的执行记录；真实候选身份取已提交事实的 candidate.id，历史兼容的
// previous.candidateId 只在其缺失时回退（previous 未必是候选身份）。绑定不上就整体省略，
// 不给全部收集记录套上同一个偏好。
const preferredIdsFor = (state, mission, current, excluded) => {
  const facts = committedFacts(state, mission)[0] || null;
  const projectId = selectionText(mission?.projectId, 160);
  const factsCandidateId = selectionText(facts?.candidate?.id, 160) || selectionText(facts?.previous?.candidateId, 160);
  const best = selectionRecord(state?.currentBest);
  const bound = new Set([
    factsCandidateId,
    selectionText(best?.candidateId, 160),
    selectionText(current?.candidateId, 160),
  ].filter(Boolean));
  if (!bound.size) return [];
  const preferred = [];
  for (const item of frozenExecutionItems(state)) {
    if (excluded.has(item.id) || preferred.includes(item.id)) continue;
    if (selectionText(item.evidence?.missionId, 160) !== mission.id) continue;
    if (selectionText(item.projectId, 160) !== projectId) continue;
    if (!bound.has(selectionText(item.evidence?.candidateId, 160))) continue;
    preferred.push(item.id);
    if (preferred.length >= SELECTION_PREFERRED_LIMIT) break;
  }
  return preferred;
};
const selectionQueryFor = (state, mission, scope) => {
  const repeat = repeatedAttempt(state, mission);
  const repeatedAttempts = repeatedAttemptsFor(state, mission, repeat);
  const preferredIds = preferredIdsFor(state, mission, repeat, new Set(repeatedAttempts.map((item) => item.id)));
  return {
    policyVersion: WIKI_SELECTION_POLICY_VERSION,
    features: selectionFeatures(state, mission),
    target: selectionTarget(state, mission, scope),
    ...(preferredIds.length ? { preferredIds } : {}),
    ...(repeatedAttempts.length ? { repeatedAttempts } : {}),
  };
};

// 显式经验条件是构造期配置，不是每轮参数：一旦确定就不能在轮内切换，也不能静默回退。
// 未知/空/null/非字符串值必须在任何有副作用操作之前同步失败。
const invalidCondition = (message) => { throw Object.assign(new TypeError(message), { code: 'EXPERIENCE_INVALID', status: 400 }); };

export const createRoundExperienceService = ({ experienceService, resolveAccess, verifyObservationEvidence, timers, timeoutMs = 3000, experienceCondition } = {}) => {
  if (typeof experienceService?.retrieve !== 'function' || typeof experienceService?.recordObservation !== 'function') throw new TypeError('experienceService.retrieve and recordObservation are required');
  if (typeof resolveAccess !== 'function') throw new TypeError('resolveAccess is a required trusted synchronous authority port');
  if (typeof verifyObservationEvidence !== 'function') throw new TypeError('verifyObservationEvidence is a required trusted evidence port');
  if (typeof timers?.setTimeout !== 'function' || typeof timers?.clearTimeout !== 'function') throw new TypeError('timers.setTimeout and timers.clearTimeout are required');
  timeoutValue(timeoutMs);
  if (experienceCondition !== undefined && !EXPERIENCE_CONDITIONS.includes(experienceCondition)) {
    invalidCondition(`experienceCondition must be one of ${EXPERIENCE_CONDITIONS.join(', ')} when it is provided`);
  }
  // 显式条件必须由真正的方案 D 端口承载：旧 retrieve-only 注入无法表达条件，必须显式失败，
  // 绝不静默搜出一份看起来正常、实际未按条件过滤的经验。
  if (experienceCondition !== undefined && typeof experienceService?.retrieveWithSelection !== 'function') {
    invalidCondition('experienceService.retrieveWithSelection is required when experienceCondition is explicit');
  }
  const condition = experienceCondition;
  const pending = preparingRounds;
  const accessFor = ({ state, mission }) => {
    if (!state || !mission || !safeId(mission.id) || !safeId(mission.projectId) || state.activeMissionId !== mission.id) throw fail('ROUND_EXPERIENCE_ACCESS_INVALID', 'Experience use requires the active Mission and its owning Project');
    const access = resolveAccess({ state, mission });
    if (!access || typeof access.then === 'function' || access.projectId !== mission.projectId || !Array.isArray(access.allowedProjectIds) || access.allowedProjectIds.length > 100 || access.allowedProjectIds.some((id) => !safeId(id))) throw fail('ROUND_EXPERIENCE_ACCESS_INVALID', 'Trusted project authorization is missing or does not match the Mission');
    return { projectId: access.projectId, allowedProjectIds: [...new Set(access.allowedProjectIds)] };
  };
  const bounded = async (stage, operation, limit, effectUnknown = false, parentSignal) => {
    timeoutValue(limit);
    const controller = new AbortController();
    let timer;
    let rejectDeadline;
    const abort = (error) => { if (!controller.signal.aborted) { controller.abort(error); rejectDeadline(error); } };
    const onParentAbort = () => abort(parentSignal.reason || fail('ROUND_EXPERIENCE_ABORTED', 'Round experience operation was cancelled'));
    const deadline = new Promise((_, reject) => {
      rejectDeadline = reject;
      timer = timers.setTimeout(() => {
        const error = Object.assign(fail('ROUND_EXPERIENCE_TIMEOUT', `Round experience ${stage} exceeded its deadline`, { stage, effectUnknown }), { status: 504 });
        abort(error);
      }, limit);
    });
    if (parentSignal?.aborted) onParentAbort();
    else parentSignal?.addEventListener('abort', onParentAbort, { once: true });
    try {
      return await Promise.race([Promise.resolve().then(() => {
        if (controller.signal.aborted) throw controller.signal.reason;
        return operation(controller.signal);
      }), deadline]);
    } finally { timers.clearTimeout(timer); parentSignal?.removeEventListener('abort', onParentAbort); }
  };
  const prepare = async ({ state, mission, roundId, scope, timeoutMs: limit = timeoutMs }) => {
    const access = accessFor({ state, mission });
    if (!safeId(roundId)) throw fail('ROUND_EXPERIENCE_CONTEXT_CONFLICT', 'An explicit admitted roundId is required');
    if (state.iterationStats?.roundBudget && state.iterationStats.roundBudget.roundId !== roundId) throw fail('ROUND_EXPERIENCE_CONTEXT_CONFLICT', 'Experience roundId must match the admitted round budget');
    const resolvedScope = queryScope(state, mission, scope);
    const expected = { ...access, missionId: mission.id, roundId, scope: resolvedScope };
    const identity = { projectId: access.projectId, missionId: mission.id, roundId };
    const existing = state.iterationStats?.roundExperience;
    if (existing?.roundId === roundId) {
      if (existing.projectId !== access.projectId || existing.missionId !== mission.id) throw fail('ROUND_EXPERIENCE_CONTEXT_CONFLICT', 'A round context cannot change owning Project or Mission');
      const frozen = validateExperienceContext(existing, expected);
      const existingSelection = state.iterationStats?.roundExperienceSelection;
      const frozenSelection = existingSelection && existingSelection.roundId === roundId && existingSelection.missionId === mission.id
        && existingSelection.projectId === access.projectId && existingSelection.contextId === frozen.contextId ? existingSelection : null;
      // 同轮冻结同时冻结条件：配置的显式条件必须与冻结审计里记录的条件完全一致。冻结审计缺条件
      // （旧清单、context-derived 清单或已被换掉的清单）与条件不同一样是冲突，绝不静默重选、
      // 也不给旧清单补写一个它从未使用过的条件。
      if (frozenSelection?.experienceCondition !== condition) throw fail('ROUND_EXPERIENCE_CONTEXT_CONFLICT', 'A frozen round experience condition cannot be added, changed or dropped within the same round');
      if (!frozenSelection) {
        state.iterationStats = { ...state.iterationStats, roundExperienceSelection: contextDerivedSelection(frozen, identity) };
      } else {
        auditSelection(frozenSelection, frozen, identity);
      }
      return frozen;
    }
    const inflight = pending.get(state);
    if (inflight) {
      if (inflight.roundId !== roundId) throw fail('ROUND_EXPERIENCE_CONTEXT_CONFLICT', 'Another round is still retrieving its experience context');
      // 模块级 pending 按 state 共享，可能被不同条件的 service 实例共用：同轮去重只对同一冻结
      // 条件成立，复用前必须严格比对，否则会把另一条件的冻结 context 静默当成本轮结果。
      if (inflight.condition !== condition) throw fail('ROUND_EXPERIENCE_CONTEXT_CONFLICT', 'A concurrent retrieval of this round uses a different experience condition');
      return validateExperienceContext(await inflight.promise, expected);
    }
    state.iterationStats = { ...(state.iterationStats || {}), roundExperienceStatus: { status: 'preparing', projectId: access.projectId, missionId: mission.id, roundId } };
    const claim = { roundId, condition, promise: null };
    const operation = (async () => {
      try {
        const query = { ...access, missionId: mission.id, roundId, scope: resolvedScope };
        // 真实 retrieveWithSelection 端口带方案 D 选择输入；旧 retrieve-only 注入
        // 不传任何新参数，保持既有顺序与行为。
        if (typeof experienceService.retrieveWithSelection === 'function') {
          query.selection = selectionQueryFor(state, mission, resolvedScope);
          // 只有显式配置条件时才加这个键；省略模式的选择输入与旧 schema 完全一致。
          if (condition !== undefined) query.selection.experienceCondition = condition;
        }
        // 一次仓库读取同时取得冻结内容和选注清单；旧 retrieve-only 注入按原端口运行。
        const retrieved = await bounded('retrieve', async (signal) => {
          if (typeof experienceService.retrieveWithSelection === 'function') {
            const audited = await experienceService.retrieveWithSelection(query, { signal });
            if (!audited?.selection) throw fail('ROUND_EXPERIENCE_SELECTION_CONFLICT', 'Audited retrieval returned no selection');
            return { context: audited.context, rawSelection: audited.selection };
          }
          return { context: await experienceService.retrieve(query, { signal }), rawSelection: null };
        }, limit);
        const context = retrieved.context;
        validateExperienceContext(context, expected);
        if (state.activeMissionId !== mission.id || (state.iterationStats.roundBudget && state.iterationStats.roundBudget.roundId !== roundId)) throw fail('ROUND_EXPERIENCE_CONTEXT_CONFLICT', 'Mission or round changed while experience retrieval was pending');
        const selection = auditSelection(retrieved.rawSelection, context, identity);
        // fresh 检索与同轮复用一样冻结条件：返回审计里的条件必须严格等于构造期配置。清单漏条件
        // 或条件不同，都在写 ready/context 之前拒绝，绝不落盘一份与配置不符、看起来正常的冻结
        // 上下文。省略模式（undefined）保持兼容：清单本来就不带该字段时严格相等成立。
        if (selection.experienceCondition !== condition) throw fail('ROUND_EXPERIENCE_SELECTION_CONFLICT', 'Audited retrieval did not apply the configured experience condition');
        state.iterationStats = {
          ...state.iterationStats,
          roundExperience: context,
          roundExperienceSelection: selection,
          roundExperienceStatus: { status: 'ready', projectId: access.projectId, missionId: mission.id, roundId, contextId: context.contextId, repositoryRevision: context.repositoryRevision },
        };
        return context;
      } catch (error) {
        if (state.activeMissionId === mission.id && state.iterationStats?.roundExperienceStatus?.roundId === roundId) {
          const failedStats = { ...(state.iterationStats || {}) };
          if (failedStats.roundExperienceSelection?.roundId === roundId) delete failedStats.roundExperienceSelection;
          failedStats.roundExperienceStatus = { status: 'failed', projectId: access.projectId, missionId: mission.id, roundId, error: { code: error.code || 'ROUND_EXPERIENCE_FAILED', message: error.message } };
          state.iterationStats = failedStats;
        }
        throw error;
      } finally { if (pending.get(state) === claim) pending.delete(state); }
    })();
    claim.promise = operation;
    pending.set(state, claim);
    return operation;
  };
  const record = async ({ state, mission, observation, timeoutMs: limit = timeoutMs, signal: parentSignal }) => {
    const access = accessFor({ state, mission });
    const raw = observation?.evidence;
    const missing = requiredEvidence.filter((key) => raw?.[key] == null || raw[key] === '');
    if (missing.length) return { status: 'skipped', code: 'EXPERIENCE_BINDING_MISSING', missing };
    const evidence = canonicalEvidence(raw);
    if (evidence.missionId !== mission.id) throw fail('ROUND_EXPERIENCE_EVIDENCE_CONFLICT', 'Execution evidence belongs to a different Mission');
    return bounded('record', async (signal) => {
      const proof = await verifyObservationEvidence({ state, mission, observation: { evidence, evidenceRefs: observation.evidenceRefs ?? [] }, signal });
      if (proof?.verified !== true) return { status: 'skipped', code: typeof proof?.code === 'string' ? proof.code : 'EXPERIENCE_EVIDENCE_UNVERIFIED' };
      if (signal.aborted) throw signal.reason;
      const verifiedEvidence = canonicalEvidence(proof.evidence);
      if (JSON.stringify(verifiedEvidence) !== JSON.stringify(evidence)) throw fail('ROUND_EXPERIENCE_EVIDENCE_CONFLICT', 'Verification receipt does not match the complete execution binding');
      if (proof.summary != null && typeof proof.summary !== 'string') throw fail('ROUND_EXPERIENCE_EVIDENCE_CONFLICT', 'Verified observation summary must be text');
      const content = [
        `Bound execution ${evidence.operation}: ${evidence.outcome}; hardware=${evidence.hardware}; mode=${evidence.executionMode}.`,
        `Mission=${evidence.missionId}; Candidate=${evidence.candidateId}; run=${evidence.runId}.`,
        proof.summary || '',
      ].filter(Boolean).join('\n');
      // 查询目标与实际执行目标冲突时保留实际证据并留下可审计 mismatch，绝不把证据改成预期值。
      const declaredArchitecture = targetValues(mission.architecture);
      const declaredHardware = targetValues(mission.hardware).filter((item) => !isBackendTargetName(item));
      const bound = boundTargetFor(state, mission) || (declaredHardware.length || declaredArchitecture.length ? { hardware: declaredHardware, architecture: declaredArchitecture } : null);
      const mismatch = bound ? targetMismatch(bound, evidence) : null;
      if (mismatch) {
        state.iterationStats = {
          ...(state.iterationStats || {}),
          resolvedTargetMismatch: {
            missionId: mission.id, operation: evidence.operation, runId: evidence.runId,
            detectedAt: state.benchmark?.completedAt || new Date().toISOString(), issues: mismatch,
          },
        };
      }
      const result = await experienceService.recordObservation({
        projectId: access.projectId, visibility: 'project', title: `${evidence.operation}: ${evidence.outcome}`,
        content, author: 'Operator Studio execution verifier', confidence: 'medium',
        scope: recordScope(mission, evidence), evidence: verifiedEvidence, evidenceRefs: observation.evidenceRefs ?? [],
      }, { signal });
      if (signal.aborted) throw signal.reason;
      if (!result?.experience || result.experience.verification?.publishable !== false) throw fail('ROUND_EXPERIENCE_EVIDENCE_CONFLICT', 'Experience repository returned an invalid or publishable observation');
      return { status: result.created ? 'recorded' : 'existing', ...result, ...(mismatch ? { targetMismatch: { missionId: mission.id, runId: evidence.runId, issues: mismatch } } : {}) };
    }, limit, true, parentSignal);
  };
  const collect = async ({ state, mission, observations, timeoutMs: limit = timeoutMs }) => {
    accessFor({ state, mission });
    if (observations === undefined) {
      observations = ['complete', 'failed', 'cancelled'].includes(state.benchmark?.status)
        ? [{ evidence: state.benchmark.result?.experienceEvidence, evidenceRefs: state.benchmark.result?.experienceEvidenceRefs ?? [] }]
        : [];
    }
    if (!Array.isArray(observations) || observations.length > 20) throw fail('ROUND_EXPERIENCE_LIMIT_EXCEEDED', 'One collection may inspect at most 20 observations');
    const result = { status: 'skipped', recorded: 0, existing: 0, skipped: 0, records: [] };
    try {
      // One deadline bounds the whole batch, not a fresh budget for each record.
      await bounded('collect', async (signal) => {
        for (const observation of observations) {
          if (signal.aborted) throw signal.reason;
          const outcome = await record({ state, mission, observation, timeoutMs: limit, signal });
          if (signal.aborted) throw signal.reason;
          result.records.push(outcome); result[outcome.status]++;
        }
      }, limit, true);
      result.status = result.recorded || result.existing ? (result.skipped ? 'mixed' : 'recorded') : 'skipped';
      state.iterationStats = { ...(state.iterationStats || {}), experienceCollection: {
        status: result.status, recorded: result.recorded, existing: result.existing, skipped: result.skipped,
        records: result.records.map((item) => ({ status: item.status, ...(item.code ? { code: item.code } : {}), ...(item.missing ? { missing: item.missing } : {}), ...(item.experience ? { id: item.experience.id, version: item.experience.version, evidenceKey: item.experience.evidenceKey } : {}) })),
      } };
      return result;
    } catch (error) {
      state.iterationStats = { ...(state.iterationStats || {}), experienceCollection: { status: 'failed', recorded: result.recorded, existing: result.existing, skipped: result.skipped, error: { code: error.code || 'ROUND_EXPERIENCE_FAILED', message: error.message, effectUnknown: Boolean(error.effectUnknown) } } };
      throw error;
    }
  };
  return Object.freeze({ prepare, collect, record });
};
