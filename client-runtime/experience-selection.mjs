// Phase 3 A: deterministic optimization-hypothesis selection (TEAM_HANDOFF §6 方案 D,
// PHASE3_WIKI_CONTRACT.md "A: metadata and selector API").
//
// This module is pure: no imports, no clock, no storage, no provider, no model. It must
// NOT import experience-contract.mjs — the contract imports this module, so importing back
// would create a cycle and violate the state-domain boundary. Selection metadata is
// provenance and relevance signal only; it is never evidence and never grants access.

export const WIKI_SELECTION_POLICY_VERSION = 'operator-studio.optimization-hypothesis-selection/v1';

const LIMITS = Object.freeze({
  entries: 32,
  entryLength: 160,
  features: 8,
  featuresPerKind: 2,
  value: 160,
  basis: 1000,
  preferredIds: 20,
  repeatedAttempts: 20,
  attemptKey: 160,
  identifier: 160,
  sourcePath: 240,
});

const METADATA_FIELDS = ['source', 'sourceCommit', 'sourcePath', 'pageId', 'sourceDigest', 'unitDigest', 'type', 'topics', 'symptoms', 'candidateTechniques', 'architectures', 'applicability'];
const APPLICABILITY_FIELDS = ['mode', 'reviewId', 'hardware', 'architectures', 'requiredCapabilities', 'software'];
const APPLICABILITY_MODES = ['unreviewed', 'architecture-specific', 'reviewed-transfer'];
const FEATURE_KINDS = ['structure', 'failure', 'symptom', 'technique'];
const OPTION_FIELDS = ['features', 'target', 'preferredIds', 'repeatedAttempts'];
const TARGET_FIELDS = ['hardware', 'architecture', 'capabilities', 'software'];
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9_.:@-]*$/u;
const WIKI_PATH = /^wiki\/(?:[A-Za-z0-9._-]+\/)*[A-Za-z0-9._-]+\.md$/u;

const hasControl = (value) => {
  for (const character of value) {
    const code = character.codePointAt(0);
    if (code <= 8 || (code >= 11 && code <= 12) || (code >= 14 && code <= 31) || code === 127) return true;
  }
  return false;
};
const invalid = (message) => { throw Object.assign(new Error(message), { code: 'EXPERIENCE_SELECTION_INVALID', status: 400 }); };
const plain = (value, allowed, label) => {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) invalid(`${label} must be a plain object`);
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (typeof key !== 'string' || ['__proto__', 'constructor', 'prototype'].includes(key) || !descriptor.enumerable || !('value' in descriptor) || (allowed && !allowed.includes(key))) invalid(`${label} contains an unsupported field`);
  }
  return value;
};
const bounded = (value, label, max) => {
  if (typeof value !== 'string' || !value.trim() || value.length > max || hasControl(value)) invalid(`${label} must be a bounded nonempty string`);
  return value.trim();
};
const digest = (value, label) => {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/u.test(value)) invalid(`${label} must be a 64 character lowercase SHA-256 digest`);
  return value;
};
const identifier = (value, label) => {
  const result = bounded(value, label, LIMITS.identifier);
  if (!IDENTIFIER.test(result) || result.includes('..')) invalid(`${label} is not a safe identifier`);
  return result;
};
const positiveInteger = (value, label) => {
  if (!Number.isSafeInteger(value) || value < 1) invalid(`${label} must be a positive integer`);
  return value;
};
const choice = (value, allowed, label) => {
  if (!allowed.includes(value)) invalid(`${label} must be one of ${allowed.join(', ')}`);
  return value;
};
const array = (value, label, max, normalize) => {
  if (!Array.isArray(value) || value.length > max) invalid(`${label} must be a bounded array`);
  for (const key of Reflect.ownKeys(value)) {
    if (key !== 'length' && (typeof key !== 'string' || !/^(0|[1-9][0-9]*)$/u.test(key) || !('value' in Object.getOwnPropertyDescriptor(value, key)))) invalid(`${label} contains unsupported array properties`);
  }
  const result = [];
  for (let index = 0; index < value.length; index++) {
    if (!Object.hasOwn(value, index)) invalid(`${label} cannot contain holes`);
    const item = normalize(value[index]);
    if (!result.includes(item)) result.push(item);
  }
  return result;
};
const strings = (value, label, { max = LIMITS.entries, itemMax = LIMITS.entryLength, lowercase = false } = {}) => array(value, label, max, (item) => {
  const result = bounded(item, label, itemMax);
  return lowercase ? result.toLowerCase() : result;
});

// Metadata is a bounded canonical object. Applicability dimensions are machine facing and
// are lowercased like scope; raw topics/symptoms/techniques/architectures stay as provenance.
function normalizeApplicability(value) {
  plain(value, APPLICABILITY_FIELDS, 'selectionMetadata.applicability');
  const mode = choice(value.mode, APPLICABILITY_MODES, 'selectionMetadata.applicability.mode');
  const reviewId = mode === 'unreviewed'
    ? (value.reviewId === undefined || value.reviewId === null ? null : invalid('selectionMetadata.applicability.reviewId must be null for unreviewed'))
    : identifier(value.reviewId, 'selectionMetadata.applicability.reviewId');
  const architectures = strings(value.architectures ?? [], 'selectionMetadata.applicability.architectures', { lowercase: true });
  // 两个经审查模式都必须在规范化阶段就声明非空的目标架构列表：空列表只能表示「未声明」，
  // 而未经声明的架构绝不允许被当成跨硬件通用（历史/原始页仍可保留空 architectures，
  // 但它们只能是 unreviewed，永不自动注入）。
  if (mode !== 'unreviewed' && !architectures.length) invalid('selectionMetadata.applicability.architectures must be a nonempty reviewed architecture list for ' + mode);
  return {
    mode,
    reviewId,
    hardware: strings(value.hardware ?? [], 'selectionMetadata.applicability.hardware', { lowercase: true }),
    architectures,
    requiredCapabilities: strings(value.requiredCapabilities ?? [], 'selectionMetadata.applicability.requiredCapabilities', { lowercase: true }),
    software: strings(value.software ?? [], 'selectionMetadata.applicability.software', { lowercase: true }),
  };
}

export function normalizeSelectionMetadata(value) {
  plain(value, METADATA_FIELDS, 'selectionMetadata');
  if (value.source !== 'kernel-wiki') invalid('selectionMetadata.source must be kernel-wiki');
  if (typeof value.sourceCommit !== 'string' || !/^[a-f0-9]{40}$/u.test(value.sourceCommit)) invalid('selectionMetadata.sourceCommit must be 40 lowercase hex characters');
  if (typeof value.sourcePath !== 'string' || value.sourcePath.length > LIMITS.sourcePath || !WIKI_PATH.test(value.sourcePath) || value.sourcePath.split('/').includes('..')) invalid('selectionMetadata.sourcePath must be a safe relative wiki/*.md path');
  return {
    source: 'kernel-wiki',
    sourceCommit: value.sourceCommit,
    sourcePath: value.sourcePath,
    pageId: identifier(value.pageId, 'selectionMetadata.pageId'),
    sourceDigest: digest(value.sourceDigest, 'selectionMetadata.sourceDigest'),
    unitDigest: digest(value.unitDigest, 'selectionMetadata.unitDigest'),
    type: bounded(value.type, 'selectionMetadata.type', LIMITS.entryLength),
    topics: strings(value.topics ?? [], 'selectionMetadata.topics'),
    symptoms: strings(value.symptoms ?? [], 'selectionMetadata.symptoms'),
    candidateTechniques: strings(value.candidateTechniques ?? [], 'selectionMetadata.candidateTechniques'),
    architectures: strings(value.architectures ?? [], 'selectionMetadata.architectures'),
    applicability: normalizeApplicability(value.applicability),
  };
}

function normalizeFeatures(value) {
  if (!Array.isArray(value) || value.length > LIMITS.features) invalid('features must be an array of at most 8 entries');
  const counts = Object.fromEntries(FEATURE_KINDS.map((kind) => [kind, 0]));
  return value.map((entry) => {
    plain(entry, ['kind', 'value', 'basis'], 'feature');
    const kind = choice(entry.kind, FEATURE_KINDS, 'feature.kind');
    counts[kind] += 1;
    if (counts[kind] > LIMITS.featuresPerKind) invalid('features allow at most two entries per kind');
    return { kind, value: bounded(entry.value, 'feature.value', LIMITS.value), basis: bounded(entry.basis, 'feature.basis', LIMITS.basis) };
  });
}

function normalizeTarget(value) {
  plain(value, TARGET_FIELDS, 'target');
  return {
    hardware: strings(value.hardware ?? [], 'target.hardware', { lowercase: true }),
    architecture: strings(value.architecture ?? [], 'target.architecture', { lowercase: true }),
    capabilities: strings(value.capabilities ?? [], 'target.capabilities', { lowercase: true }),
    software: strings(value.software ?? [], 'target.software', { lowercase: true }),
  };
}

const normalizeIds = (value, label) => value === undefined ? [] : array(value, label, LIMITS.preferredIds, (item) => identifier(item, label));

const normalizeRepeated = (value) => value === undefined ? [] : array(value, 'repeatedAttempts', LIMITS.repeatedAttempts, (entry) => {
  plain(entry, ['id', 'version', 'attemptKey'], 'repeatedAttempt');
  return { id: identifier(entry.id, 'repeatedAttempt.id'), version: positiveInteger(entry.version, 'repeatedAttempt.version'), attemptKey: bounded(entry.attemptKey, 'repeatedAttempt.attemptKey', LIMITS.attemptKey) };
});

const intersects = (left, right) => left.some((item) => right.includes(item));
const subsetOf = (left, right) => left.every((item) => right.includes(item));

// Cross-dimension AND; hardware/architecture OR inside the dimension; capabilities/software subset.
// Missing target dimensions fail: nothing is inferred from device names, sm80 or model labels.
function appliesTo(metadata, target) {
  const applicability = metadata.applicability;
  if (applicability.mode === 'unreviewed') return { ok: false, reason: 'unreviewed' };
  if (!applicability.architectures.length) return { ok: false, reason: 'applicability-architecture-undeclared' };
  if (!target.architecture.length) return { ok: false, reason: 'applicability-target-architecture-missing' };
  if (!intersects(applicability.architectures, target.architecture)) return { ok: false, reason: 'applicability-architecture' };
  if (applicability.hardware.length && (!target.hardware.length || !intersects(applicability.hardware, target.hardware))) return { ok: false, reason: 'applicability-hardware' };
  if (!subsetOf(applicability.requiredCapabilities, target.capabilities)) return { ok: false, reason: 'applicability-capabilities' };
  if (!subsetOf(applicability.software, target.software)) return { ok: false, reason: 'applicability-software' };
  return { ok: true };
}

// Topical match over tokens, never a numeric score. Symptoms remain hypotheses, so matching
// is a relevance hint only; the selector never claims a measured bottleneck.
const tokens = (value) => value.toLowerCase().split(/[^a-z0-9]+/u).filter(Boolean);
const topical = (needle, values) => {
  const lower = needle.toLowerCase();
  const wanted = tokens(needle).filter((token) => token.length >= 3);
  return values.some((value) => {
    if (value.toLowerCase() === lower) return true;
    if (!wanted.length) return false;
    const have = tokens(value);
    return wanted.some((token) => have.includes(token));
  });
};
const matchesAny = (features, ...groups) => features.some((feature) => topical(feature.value, groups.flat()));

// KernelWiki 的 type=pattern 就是症状页（TEAM_HANDOFF §8.3）：症状 → 可能原因 → 候选手法。
// 它必须进 symptom 桶（≤2 配额、参与一跳展开），不能落到 guidance 兜底。
const SYMPTOM_TYPES = Object.freeze(['symptom', 'pattern']);
const TECHNIQUE_TYPES = Object.freeze(['technique']);
const GUIDANCE_TYPES = Object.freeze(['guidance']);
const typeKey = (type) => type.trim().toLowerCase();
const bucketFor = (type) => SYMPTOM_TYPES.includes(typeKey(type)) ? 'symptom' : TECHNIQUE_TYPES.includes(typeKey(type)) ? 'technique' : 'guidance';
// 兜底指导必须是被明确声明为指导的单元：项目审查产出的可迁移单元（reviewed-transfer），
// 或页面自身类型就是 guidance。普通 kernel/hardware/language/migration 页面即使被审查过，
// 只要没有主题命中就排除，不靠类型名去填 ≤1 的兜底名额。
const reviewedGuidance = (metadata) => metadata.applicability.mode === 'reviewed-transfer' || GUIDANCE_TYPES.includes(typeKey(metadata.type));
const BUCKET_ORDER = { symptom: 0, technique: 1, guidance: 2 };
const RANK_REASONS = ['failure-match', 'structure-match', 'symptom-match', 'technique-match', 'guidance-fallback'];
const identity = (entry) => `${entry.id}@${entry.version}`;

// 本地条件的取值面：保留算子、dtype、shape、环境与测试绑定（scope 全量 + 执行证据的实际条件）。
const localValues = (record) => {
  const scope = record.scope ?? {};
  const evidence = record.evidence ?? {};
  return [
    record.title, scope.operator, ...(scope.tags ?? []), ...(scope.dtype ?? []), ...(scope.hardware ?? []), ...(scope.architecture ?? []),
    evidence.operation, evidence.outcome, evidence.hardware, evidence.architecture,
  ].filter((value) => typeof value === 'string');
};

// 「当前失败观察」= 与本轮特征或显式 preferred 相关的失败记录。不相关的旧失败只是本地
// 历史：它不能恒定压过当前的 preferred/相关失败，因此退回 last 的 local-guidance 组。
const localReason = (entry, features, preferredIds) => {
  const record = entry.record;
  const preferred = preferredIds.includes(entry.id);
  const failure = record.source === 'execution' && record.evidence && record.evidence.outcome === 'failed';
  const relevant = preferred || matchesAny(features, localValues(record));
  if (failure && relevant) return 'local-failure-observation';
  if (preferred) return 'preferred';
  return relevant ? 'feature-match' : 'local-guidance';
};
const LOCAL_ORDER = { 'local-failure-observation': 0, preferred: 1, 'feature-match': 2, 'local-guidance': 3 };

export function rankExperienceCandidates(records, options) {
  plain(options, OPTION_FIELDS, 'selection options');
  if (!Array.isArray(records)) invalid('records must be an array');
  const features = normalizeFeatures(options.features);
  const target = normalizeTarget(options.target);
  const preferredIds = normalizeIds(options.preferredIds, 'preferredIds');
  const repeatedAttempts = normalizeRepeated(options.repeatedAttempts);

  const prepared = records.map((record) => {
    plain(record, null, 'experience candidate');
    return {
      record,
      id: identifier(record.id, 'candidate.id'),
      version: positiveInteger(record.version, 'candidate.version'),
      metadata: record.selectionMetadata === undefined ? null : normalizeSelectionMetadata(record.selectionMetadata),
    };
  });
  const excluded = new Map();
  const exclude = (entry, reason) => {
    const key = identity(entry);
    if (!excluded.has(key)) excluded.set(key, { id: entry.id, version: entry.version, reason });
  };

  // 只对精确给出的 ID+version 降权（不封禁方法类别）；本地与 Wiki 用同一套降权规则。
  const repeated = new Set(repeatedAttempts.map((attempt) => `${attempt.id}@${attempt.version}`));
  const demoted = (entry) => (repeated.has(identity(entry)) ? 1 : 0);

  // Local execution records and current-project guidance stay first: current failure
  // observations, explicit preferred IDs, matching features, then recent local guidance with
  // full scope retained. Exact repeated attempts are demoted inside their own group.
  const localEntries = prepared.filter((entry) => !entry.metadata).map((entry) => ({ entry, reason: localReason(entry, features, preferredIds) }));
  localEntries.sort((left, right) => LOCAL_ORDER[left.reason] - LOCAL_ORDER[right.reason]
    || demoted(left.entry) - demoted(right.entry)
    || (left.reason === 'local-guidance' ? String(right.entry.record.updatedAt ?? '').localeCompare(String(left.entry.record.updatedAt ?? '')) : 0)
    || left.entry.id.localeCompare(right.entry.id)
    || right.entry.version - left.entry.version);

  // Applicability is re-applied before ranking; unreviewed wiki units are never auto-injected.
  const applicable = [];
  for (const entry of prepared) {
    if (!entry.metadata) continue;
    const verdict = appliesTo(entry.metadata, target);
    if (!verdict.ok) { exclude(entry, verdict.reason); continue; }
    applicable.push(entry);
  }

  const wiki = new Map();
  const noMatch = [];
  for (const entry of applicable) {
    // 主题命中只看内容线索（topics/symptoms/candidateTechniques/architectures）。type 只决定
    // bucket，不作为内容参与匹配，否则「hardware/kernel」这类类别名会无意命中大批页面。
    const direct = matchesAny(features.filter((feature) => feature.kind === 'failure'), entry.metadata.symptoms, entry.metadata.topics) ? 0
      : matchesAny(features.filter((feature) => feature.kind === 'structure'), entry.metadata.topics, entry.metadata.architectures) ? 1
        : matchesAny(features.filter((feature) => feature.kind === 'symptom'), entry.metadata.symptoms) ? 2
          : matchesAny(features.filter((feature) => feature.kind === 'technique'), entry.metadata.candidateTechniques, entry.metadata.topics) ? 3
            : null;
    const bucket = bucketFor(entry.metadata.type);
    // 只有被明确声明为指导的已审查单元才允许兜底；普通页无主题命中即排除，不补名额
    //（一跳展开仍可能认领它们，且同一条目不会同时出现在 ordered 与 excluded）。
    if (direct === null && !(bucket === 'guidance' && reviewedGuidance(entry.metadata))) { noMatch.push(entry); continue; }
    const rank = direct === null ? 4 : direct;
    wiki.set(identity(entry), { entry, rank, reason: RANK_REASONS[rank], bucket });
  }

  // One hop only: matching symptom/pattern pages expand their candidateTechniques by an EXACT
  // reference — the entry must equal the target unit's pageId or one of the target's topics after
  // trim+lowercase. Token/substring similarity is deliberately NOT used here: it made
  // 'tech-hop' and 'tech-deep' one edge through the shared token 'tech'. The target's own
  // candidateTechniques are outgoing edges, not identity, so they are never matched either.
  // The target of an expansion must itself be a technique unit; expanding into another symptom
  // page and then walking further would be indirect recursion. Applicability was already
  // re-applied (only `applicable` candidates are considered) and `related` is never followed.
  for (const entry of applicable) {
    if (bucketFor(entry.metadata.type) !== 'symptom' || !wiki.has(identity(entry))) continue;
    for (const technique of entry.metadata.candidateTechniques) {
      const reference = technique.trim().toLowerCase();
      for (const candidate of applicable) {
        if (candidate === entry || wiki.has(identity(candidate))) continue;
        const metadata = candidate.metadata;
        if (bucketFor(metadata.type) !== 'technique') continue;
        const byPageId = metadata.pageId.trim().toLowerCase() === reference;
        const byTopic = metadata.topics.some((topic) => topic.trim().toLowerCase() === reference);
        if (!byPageId && !byTopic) continue;
        wiki.set(identity(candidate), { entry: candidate, rank: 3, reason: 'technique-one-hop', bucket: 'technique' });
      }
    }
  }

  for (const entry of noMatch) if (!wiki.has(identity(entry))) exclude(entry, 'no-topic-match');

  const wikiEntries = [...wiki.values()].sort((left, right) => left.rank - right.rank
    || demoted(left.entry) - demoted(right.entry)
    || BUCKET_ORDER[left.bucket] - BUCKET_ORDER[right.bucket]
    || left.entry.id.localeCompare(right.entry.id)
    || right.entry.version - left.entry.version);

  const ordered = [];
  const seen = new Set();
  const accept = (entry, reason, bucket) => {
    // Deduplicate content and unit identity; only the exact supplied ID/version is demoted,
    // a technique category is never banned.
    const keys = [entry.metadata ? `unit:${entry.metadata.unitDigest}` : null,
      typeof entry.record.content === 'string' ? `content:${entry.record.content}` : null].filter(Boolean);
    if (!entry.metadata) keys.push(`record:${identity(entry)}`);
    if (keys.some((key) => seen.has(key))) { exclude(entry, 'duplicate-unit'); return; }
    keys.forEach((key) => seen.add(key));
    ordered.push({ id: entry.id, version: entry.version, reason: repeated.has(identity(entry)) ? 'repeated-attempt' : reason, bucket });
  };
  for (const item of localEntries) accept(item.entry, item.reason, 'local');
  for (const item of wikiEntries) accept(item.entry, item.reason, item.bucket);

  return {
    ordered,
    excluded: [...excluded.values()].sort((left, right) => left.id.localeCompare(right.id) || right.version - left.version),
  };
}
