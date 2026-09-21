import { isResourceReleaseQuarantined, resourceReleaseBarrier } from './cancellation-contract.mjs';
import { inspectRoundBudget, ensureRoundBudgetStarted, completeRoundBudget, expireRoundBudget } from './round-budget-contract.mjs';
export { ROUND_BUDGET_MS } from './round-budget-contract.mjs';
import { addAuditEvent, appendRuntimeEvent } from './runtime-events.mjs';
import { isInfrastructureTestFailure } from './operator-test-evidence.mjs';
import { isMaximizeMission } from './mission-objective.mjs';
import { isTransportFailureText } from './agent-result.mjs';
import { ADVISORY_SCHEMA_VERSION, normalizeAdvisoryEnvelope, withAdvisoryDigest } from './experience-contract.mjs';
import { RESEARCH_TRIGGERS, classifyResearchFaults, describeResearchRequest, resolveAutomaticResearch } from './research-policy.mjs';

// 研究员子 Agent 的循环策略：停滞检测、价值闸、调研简报、单轮预算、自动流转。
// 纯函数可单测；advanceIteration 通过 deps 注入 agentRuntime 能力，避免模块反向耦合。

export const STAGNATION_WINDOW = 3;            // 尺子 B：连续 N 轮无被采纳候选 → 停滞
export const RESEARCH_BUDGET_MS = 20 * 60 * 1000; // 研究员时长预算（仅上限，不强制调研）
// ROUND_BUDGET_MS is shared by the persisted round clock and startup admission.
// 两阶段研究员预算：采集（联网，停滞/事件/资料停滞终止，放宽墙钟）；综合（本地，短墙钟保证笔记写完）
export const RESEARCH_STALL_MS = 90_000;          // 采集阶段：事件 90s 无新增 → 停滞终止
export const RESEARCH_EVENT_BUDGET = 200;         // 采集阶段：事件数上限，防无限增长
export const RESEARCH_MATERIAL_STALL_MS = 120_000; // 采集阶段：sources/ 资料 120s 不再增长 → 视为已搜集够，转综合
// 全局兜底（防无休止兜圈）：任一命中 → 循环标记需要人工介入，但不禁用手动操作。
export const MAX_ROUNDS = 20;                          // 最大轮数
export const TOTAL_BUDGET_MS = 2 * 60 * 60 * 1000;     // 累计时长预算（自首轮起算 wall-clock）
export const MAX_RESEARCH_ESCALATIONS = 3;             // 研究员升级次数上限
export const PLATEAU_NO_IMPROVE_ROUNDS = 5;            // maximize：研究耗尽后连续 N 轮无 current best 提升 → 平台期

const AGENT_ACTIVE_STATUS = ['running', 'executing', 'awaiting_action', 'cancel_requested', 'awaiting_approval'];
const WORKFLOW_STAGES = ['candidate', 'validation', 'evidence', 'curation'];
const TERMINAL_EVIDENCE_RECOMMENDATIONS = new Set(['adopt', 'reference', 'reject']);
const TERMINAL_EVIDENCE_OUTCOMES = new Set(['adopt', 'reference', 'reject', 'supplement']);

export const isRoundAdopted = (round = {}) => {
  const outcome = round?.decisionReview?.resolution?.outcome;
  return outcome === 'adopt' || round?.stage === 'published';
};

export const isResolvedEvidenceRound = (state = {}) => {
  const decision = state?.decisionReview || {};
  const outcome = decision?.resolution?.outcome;
  return state?.stage === 'evidence'
    && state?.agent?.status === 'completed'
    && state?.benchmark?.status === 'complete'
    && decision?.status === 'resolved'
    && (TERMINAL_EVIDENCE_RECOMMENDATIONS.has(decision?.recommendation) || TERMINAL_EVIDENCE_OUTCOMES.has(outcome));
};

const candidateKeyForRound = (round = {}) => (
  round.candidateDigest
  || round.benchmark?.candidate?.digest
  || round.candidateId
  || round.decisionReview?.candidateId
  || null
);

// 停滞判定（尺子 B：采纳尺）。优先用 iterationStats 计数，未计过数时从 runHistory 兜底推导。
export const detectStagnation = (state, { window = STAGNATION_WINDOW } = {}) => {
  const stats = state?.iterationStats || {};
  let consecutiveNoAdopt = stats.consecutiveNoAdopt || 0;
  let repeatedCandidateKey = null;
  if (!stats.lastCountedRunId && Array.isArray(state?.runHistory)) {
    consecutiveNoAdopt = state.runHistory.slice(0, window).filter((round) => !isRoundAdopted(round)).length;
  }
  if (Array.isArray(state?.runHistory)) {
    const recentNoAdopt = state.runHistory
      .filter((round) => !isRoundAdopted(round))
      .slice(0, window);
    const keys = recentNoAdopt.map(candidateKeyForRound).filter(Boolean);
    if (keys.length >= window && new Set(keys).size === 1) repeatedCandidateKey = keys[0];
  }
  return { stagnated: consecutiveNoAdopt >= window || Boolean(repeatedCandidateKey), consecutiveNoAdopt, window, repeatedCandidateKey };
};

// 升级决策：停滞即拉研究员。操作员主动调研走独立 POST /api/missions/:id/research 路由，不经过这里。
export const decideResearchTrigger = (state) => {
  const { stagnated, consecutiveNoAdopt, repeatedCandidateKey } = detectStagnation(state);
  if (!stagnated) return { trigger: false, reason: null, direction: null };
  return {
    trigger: true,
    reason: repeatedCandidateKey
      ? `连续重复同一候选 ${String(repeatedCandidateKey).slice(0, 16)} 且未被采纳`
      : `连续 ${consecutiveNoAdopt} 轮未产生被采纳候选`,
    direction: selectResearchDirection(state),
  };
};

// 调研方向：从任务卡点（goal + failedRules + failureRecords + currentBest + 已试方向）生成针对性方向，
// 并要求研究员从算子优化全局角度评估"继续还是换方向"与 ROI 排序，不泛泛而谈。
export const selectResearchDirection = (state) => {
  const mission = state?.missions?.find((item) => item.id === state?.activeMissionId) || {};
  const parts = [];
  parts.push(`目标：${mission.goal || '未定义'}`);
  if (mission.hardware?.length) parts.push(`目标硬件：${mission.hardware.join(', ')}`);
  if (mission.metric) parts.push(`指标：${mission.metric}`);
  if (state?.currentBest?.value && state?.currentBest?.value !== '—') parts.push(`当前最佳：${state.currentBest.value}`);
  const gate = state?.candidateEvaluations?.find((candidate) => candidate?.acceptGate?.failedRules?.length)?.acceptGate;
  if (gate?.failedRules?.length) parts.push(`Accept Gate 未通过规则：${gate.failedRules.join(', ')}`);
  const tried = (state?.candidateEvaluations || []).filter((candidate) => candidate.classification !== 'accepted').slice(-4);
  if (tried.length) parts.push(`已尝试方向及结果：${tried.map((candidate) => `${candidate.title || candidate.label || '候选'}（${candidate.decisionReason || candidate.change || '结果待查'}）`).join('；')}`);
  const failure = (state?.failureRecords || [])[0];
  if (failure) parts.push(`失败原因：${failure.title || failure.label || '未知'}（${failure.failure?.code || ''}）`);
  parts.push('请从算子优化全局角度评估：当前方向是否值得继续投入（失败是在收敛还是重复无进展），以及各方向的预期收益/成本/风险。');
  parts.push('① 最容易获取收益的优化方向（即使尚未尝试，优先给出）');
  parts.push('② 应停止投入的低 ROI 死磕陷阱（与已尝试方向同族、收益边际的方向）');
  parts.push('请明确回答：继续当前方向，还是换方向？给出理由。');
  return parts.join('\n');
};

// ---------------------------------------------------------------------------
// 研究材料的交付阶段（§6）
//
// 「通过价值筛选」不等于「已注入」。这里把可证明的交付阶段显式化，避免旧实现里
// 价值闸一过就写 researchAgent.injected = true、而材料其实从未进入任何轮次 prompt 的情况。
// 只复用既有持久化（iterationStats.pendingInjection + agent.runId），不新建状态系统。
// ---------------------------------------------------------------------------
export const RESEARCH_DELIVERY_STAGES = Object.freeze({
  AVAILABLE: 'available',   // 材料可用（已通过价值筛选），尚未被任何轮次选择
  SELECTED: 'selected',     // 已被某个轮次选择
  PREPARED: 'prepared',     // 已进入该轮次冻结后的 prompt
  SUBMITTED: 'submitted',   // 已提交执行端（真实 run 已启动）
  UNCERTAIN: 'uncertain',   // 提交结果不确定：必须先核对既有运行记录
  DISCARDED: 'discarded',   // 过期或不适用：保留原因，不静默丢失
});

// 同一份材料最多重新提交的次数：避免反复撞同一个失败，也保留有限恢复能力。
export const MAX_INJECTION_ATTEMPTS = 3;

// 只有材料确实绑定到当前 Mission 才能进入交付；异步研究不能污染别的 Mission。
export const noteBelongsToMission = (note, missionId) => {
  if (!note) return false;
  const noteMission = typeof note.missionId === 'string' && note.missionId ? note.missionId : null;
  // 历史笔记没有 missionId：按「当前 Mission 自己的笔记」处理以保持兼容，
  // 但绝不因此放宽任何来源或契约约束。
  if (!noteMission) return true;
  return !missionId || noteMission === missionId;
};

// 交付状态裁决：以「执行端真实 run 已绑定该 material digest」为唯一提交证据，
// 而不是以 pendingInjection 自身的 stage 字段自证。
export const resolveInjectionDelivery = ({ state = {}, injection = null } = {}) => {
  if (!injection) return { status: 'none' };
  const agent = state.agent || {};
  const bound = agent.researchAdvisory;
  const digest = injection.digest || null;
  if (agent.runId && bound && digest && bound.digest === digest) {
    return { status: RESEARCH_DELIVERY_STAGES.SUBMITTED, runId: agent.runId, roundId: agent.roundId || null, evidence: 'agent-run-binding' };
  }
  if (injection.stage === RESEARCH_DELIVERY_STAGES.SUBMITTED && injection.delivery?.runId) {
    return { status: RESEARCH_DELIVERY_STAGES.SUBMITTED, runId: injection.delivery.runId, roundId: injection.delivery.roundId || null, evidence: 'persisted-delivery' };
  }
  if (injection.stage === RESEARCH_DELIVERY_STAGES.UNCERTAIN) return { status: RESEARCH_DELIVERY_STAGES.UNCERTAIN, attempt: injection.delivery || null };
  if (injection.stage === RESEARCH_DELIVERY_STAGES.DISCARDED) return { status: RESEARCH_DELIVERY_STAGES.DISCARDED, reason: injection.discardReason || null };
  if (injection.stage === RESEARCH_DELIVERY_STAGES.SELECTED || injection.stage === RESEARCH_DELIVERY_STAGES.PREPARED) {
    return { status: injection.stage };
  }
  return { status: RESEARCH_DELIVERY_STAGES.AVAILABLE };
};

// 研究建议封装（复用 experience-contract 的不可信上下文契约）。
// 建议条目优先取结构化 advisory；没有时从 findings/suggestedDirections 派生一张最小卡片。
export const buildAdvisoryEnvelope = ({ note = {}, mission = {}, roundId = null, trigger = null, value = 'medium', reasonCode = null } = {}) => {
  const advisory = note.advisory && typeof note.advisory === 'object' ? note.advisory : null;
  const direction = typeof note.direction === 'string' ? note.direction.trim() : '';
  const item = advisory ? {
    problem: advisory.problem || direction || note.summary || null,
    scope: advisory.scope || note.scope || null,
    evidence: advisory.evidence || [],
    hypothesis: advisory.hypothesis || null,
    nextChange: advisory.nextChange || null,
    verification: advisory.verification || null,
    stopCondition: advisory.stopCondition || null,
  } : {
    problem: note.summary || direction || null,
    scope: note.scope || null,
    evidence: Array.isArray(note.findings) ? note.findings.slice(0, 16) : [],
    hypothesis: note.summary || null,
    nextChange: Array.isArray(note.suggestedDirections) && note.suggestedDirections.length ? note.suggestedDirections[0] : (direction || null),
    verification: null,
    stopCondition: null,
  };
  const items = [item].filter((entry) => entry.problem || entry.hypothesis || entry.nextChange);
  if (!items.length) return null;
  const researchRunId = note.researchRunId || note.runId;
  const noteId = note.id;
  if (typeof researchRunId !== 'string' || !researchRunId || typeof noteId !== 'string' || !noteId) return null;
  const missionId = note.missionId || mission.id;
  const envelope = {
    schemaVersion: ADVISORY_SCHEMA_VERSION,
    advisoryId: `adv.${noteId}`,
    noteId,
    researchRunId,
    missionId,
    roundId: roundId || null,
    trigger: trigger || null,
    phase: note.runPhase || 'advisory',
    value,
    reasonCode,
    provenance: 'machine-research',
    verified: false,
    items,
  };
  // 先规范化再算摘要：校验方用同一份规范化结果复核，身份声明不能自证。
  return withAdvisoryDigest(normalizeAdvisoryEnvelope(envelope));
};
// 调研简报：既用于注入下一轮 goal，也是研究方向的素材。
export const buildResearchBriefing = ({ mission, researchNotes, failureRecords = [], currentBest = null, knowledgeReferences = [] }) => {
  const note = Array.isArray(researchNotes) ? researchNotes[0] : null;
  const lines = ['研究员调研简报（自动注入，仅作上下文参考，不是候选指令）'];
  if (note) {
    if (note.direction) lines.push(`研究方向：${note.direction}`);
    if (note.summary) lines.push(`摘要：${note.summary}`);
    if (note.findings?.length) lines.push(`发现：${note.findings.map((item) => `- ${item}`).join('\n')}`);
    if (note.suggestedDirections?.length) lines.push(`建议方向：${note.suggestedDirections.map((item) => `- ${item}`).join('\n')}`);
    if (note.sources?.length) lines.push(`来源：${note.sources.map((source) => source.title || source.url).filter(Boolean).join('；')}`);
  }
  if (currentBest?.value && currentBest?.value !== '—') lines.push(`当前最佳：${currentBest.value}`);
  const failure = failureRecords[0];
  if (failure) lines.push(`已知失败（避免重复）：${failure.title || failure.label}`);
  if (knowledgeReferences?.length) lines.push(`已引用知识资产：${knowledgeReferences.length} 条`);
  return lines.join('\n');
};

// 分词：拉丁词（长度>1，剔除停用词）+ CJK 感知（单字 + 重叠双字 bigram，剔除功能字/词）。
// 中文没有空格，连续 CJK 文本若按整个 token 处理会变成无信息的长串，
// 导致 evaluateResearchValue 的 novel 判定（≥5 token）与 detectTunnelVision 的方向族
// overlap 对中文失效。单字+bigram 双通道：bigram 保证语义匹配，单字补召回（短句只共享 1-2 个
// 领域字时仍能命中）。停用词过滤避免"无关内容共享泛词"造成误判（B3 收紧）。
const CJK_CHAR = /[一-鿿㐀-䶿豈-﫿]/;
// 中文功能单字（虚词/句法词），无领域信息，分词时剔除
const CJK_STOP_CHARS = new Set('的了一是在有和与为将对到从及或等个中上下不一之而但并且也都很要会把好可这那它着得地出以还于被就才再又其各最正已只少须能');
// 通用停用词：剔除泛词避免无关内容误匹配
const STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'from', 'this', 'that', 'these', 'those', 'into', 'when', 'should', 'must', 'not', 'is', 'are', 'was', 'were', 'be', 'will', 'would', 'can', 'could', 'have', 'has', 'had', 'their', 'its', 'our', 'your', 'any', 'all', 'each', 'some', 'more', 'most', 'other', 'also', 'only', 'than', 'then', 'there', 'here', 'how', 'what', 'which', 'while', 'about', 'after', 'before', 'because', 'been', 'being', 'between', 'both', 'but', 'does', 'doing', 'done', 'get', 'got', 'may', 'might', 'much', 'one', 'two', 'use', 'used', 'using', 'well', 'yet',
  '我们', '你们', '他们', '这个', '那个', '这些', '那些', '这里', '那里', '因为', '所以', '如果', '可以', '需要', '进行', '以及', '或者', '并且', '已经', '现在', '当前', '之后', '之前',
]);

const tokenize = (text) => {
  const raw = String(text || '').toLowerCase();
  const tokens = [];
  // 按分隔符切段；混合段再按 CJK / 非 CJK 连续串拆开
  for (const segment of raw.split(/[\s,，。；;:：()（）\[\]{}、/\\|._\-+'"“”‘’？?！!《》<>]+/).filter(Boolean)) {
    if (!CJK_CHAR.test(segment)) {
      if (segment.length > 1 && !STOPWORDS.has(segment)) tokens.push(segment);
      continue;
    }
    for (const run of segment.split(/([一-鿿㐀-䶿豈-﫿]+)/).filter(Boolean)) {
      if (CJK_CHAR.test(run)) {
        const chars = [...run];
        for (let i = 0; i < chars.length; i += 1) {
          const ch = chars[i];
          if (!CJK_STOP_CHARS.has(ch)) tokens.push(ch);
          if (i + 1 < chars.length) {
            const bigram = ch + chars[i + 1];
            if (!STOPWORDS.has(bigram)) tokens.push(bigram);
          }
        }
      } else if (run.length > 1 && !STOPWORDS.has(run)) {
        tokens.push(run);
      }
    }
  }
  return tokens;
};

const countOverlap = (researchWords, subject) => {
  const words = tokenize(subject);
  return words.filter((word) => researchWords.has(word)).length;
};

const knowledgeFromState = (state) => ({
  publishedAssets: state.publishedAssets || [],
  failureRecords: state.failureRecords || [],
  knowledgeDrafts: state.knowledgeDrafts || [],
  knowledgeReferences: state.knowledgeReferences || [],
});

// 价值闸（§5）。判定顺序固定为：先判断「有没有材料」，再判断「值不值得注入」，
// 最后才比对既有知识是否已经覆盖。这个顺序本身就是修复：旧实现先比对知识，
// 于是任一被引用的知识资产都会把新建议压成 low。
export const RESEARCH_VALUE_REASONS = Object.freeze({
  NO_MATERIAL: 'no_material',
  TRANSPORT_FAILURE_ONLY: 'transport_failure_only',
  UNTRACEABLE: 'untraceable',
  SCOPE_INCOMPATIBLE: 'scope_incompatible',
  DUPLICATE: 'duplicate',
  ADDRESSES_FAILURE: 'addresses_failure',
  NOVEL: 'novel',
});

// 有效建议的可追溯性：要么有可追溯的 sources，要么有结构化的 advisory（问题 + 下一轮最小改动）。
const hasTraceableClaim = (research) => (
  (Array.isArray(research.sources) && research.sources.length > 0)
  || (Array.isArray(research.advisory?.evidence) && research.advisory.evidence.length > 0)
);

// 空泛结论的固定词表：只拦「说了一句等于没说的话」，不猜内容质量。
// 短摘要命中这些模式才算空泛——长的实质性摘要即使开头是「建议继续」，也不会被误杀。
const EMPTY_SUGGESTION_PATTERNS = [
  /^(?:请)?(?:建议|可以|应当|应该|需要)?(?:继续|进一步|深入|持续)(?:研究|调研|探索|分析|观察|优化|跟进)/u,
  /^(?:本次)?(?:研究)?(?:未|没有|无法)(?:能)?(?:发现|找到|获得|给出|提供)(?:新的)?(?:可行)?(?:优化)?(?:方向|建议|结论|信息|材料)/u,
  /^(?:(?:当前|现有)?(?:信息|资料|证据))(?:不足|不够)/u,
  /^\s*(?:no|not enough|none)(?: new| useful| actionable)?\s*(?:direction|suggestion|finding|result)/iu,
  /^\s*(?:need|requires?)\s+more\s+(?:information|research|investigation)/iu,
];
const EMPTY_SUGGESTION_MAX_CHARS = 80;
const isEmptySuggestionSummary = (value) => {
  const text = String(value || '').trim();
  if (!text) return true;
  if (text.length > EMPTY_SUGGESTION_MAX_CHARS) return false;
  return EMPTY_SUGGESTION_PATTERNS.some((pattern) => pattern.test(text));
};

// 材料存在性：协议失败（无结构化结果 / schema 不符 / 冲突候选）不是「没有价值」，
// 而是本次研究没有产出材料，属于正常结束，不通过重试去修。
// addressesFailure 作为外部输入：一份直接命中已知失败判断的摘要即使没有 findings，
// 也是「与当前任务相关的判断」，不属于空泛文字。
const materialAbsenceReason = (research, { addressesFailure = false } = {}) => {
  if (research.failureOnly === true) return RESEARCH_VALUE_REASONS.TRANSPORT_FAILURE_ONLY;
  const outcome = research.outcome;
  if (outcome === 'no_result' || outcome === 'schema_mismatch' || outcome === 'ambiguous' || outcome === 'run_mismatch') {
    return RESEARCH_VALUE_REASONS.NO_MATERIAL;
  }
  const findings = Array.isArray(research.findings) ? research.findings : [];
  const directions = Array.isArray(research.suggestedDirections) ? research.suggestedDirections : [];
  const advisory = research.advisory && typeof research.advisory === 'object' ? research.advisory : null;
  const advisoryActionable = Boolean(advisory && (advisory.nextChange || advisory.hypothesis || advisory.problem));
  const corpus = [research.summary, ...findings, ...directions].filter(Boolean).join(' ');
  // 只有网络超时、连接拒绝或认证失败的文字，即使格式上是结构化结果，也不是可注入成果。
  if (isTransportFailureText(corpus) && !hasTraceableClaim(research) && !advisoryActionable) {
    return RESEARCH_VALUE_REASONS.TRANSPORT_FAILURE_ONLY;
  }
  const summaryIsSubstantive = !isEmptySuggestionSummary(research.summary);
  if (!findings.length && !directions.length && !advisoryActionable
      && !(addressesFailure || summaryIsSubstantive)) {
    return RESEARCH_VALUE_REASONS.NO_MATERIAL;
  }
  return null;
};

// 适用范围相容性：只在双方都显式声明同一维度时才判定冲突，不猜测、不推断。
const scopeValueSet = (value) => new Set((Array.isArray(value) ? value : []).map((item) => String(item || '').trim().toLowerCase()).filter(Boolean));
const scopesConflict = (declared, task) => {
  if (!declared || !task) return false;
  for (const dimension of ['hardware', 'dtype']) {
    const left = scopeValueSet(declared[dimension]);
    const right = scopeValueSet(task[dimension]);
    if (left.size && right.size && ![...left].some((item) => right.has(item))) return dimension;
  }
  return false;
};
// 覆盖判定的范围依据：只有当双方在硬件/dtype 上显式声明了不相交的取值时，才否定「同范围」。
// 未声明的维度不参与判定——不能因为「都是空的」就认定范围一致，也不能因未声明就否定。
const researchScopeFor = (research, declaredScope) => (
  declaredScope && typeof declaredScope === 'object' ? declaredScope : (research?.scope && typeof research.scope === 'object' ? research.scope : null)
);
// 覆盖的文本依据：不只是「有重叠」，而是「新材料几乎没有说出资产之外的内容」。
const DUPLICATE_MIN_OVERLAP = 3;
const DUPLICATE_CONTAINMENT = 0.6;
const claimContainment = (researchWords, subject) => {
  const subjectWords = new Set(tokenize(subject));
  const overlap = [...researchWords].filter((word) => subjectWords.has(word)).length;
  return { overlap, ratio: researchWords.size ? overlap / researchWords.size : 0 };
};

// 价值闸：对照过往经验/知识判断调研笔记是否有采用价值。
//  命中已知失败方向 → addresses_failure（注入）
//  同范围、同主张且未提供新证据/新实验路径 → duplicate（不注入）
//  其余有材料且范围相容 → novel（注入）
export const evaluateResearchValue = ({ research = {}, knowledge = {}, mission = {} } = {}) => {
  const matches = [];
  const text = `${research.summary || ''} ${(research.findings || []).join(' ')} ${(research.suggestedDirections || []).join(' ')} ${(research.sources || []).map((source) => source.title || source.url).join(' ')}`;
  const researchWords = new Set(tokenize(text));

  for (const record of knowledge.failureRecords || []) {
    const subject = `${record.title || ''} ${record.failure?.code || ''} ${record.decisionReason || ''}`;
    const score = countOverlap(researchWords, subject);
    if (score >= 2) matches.push({ kind: 'addresses_failure', targetId: record.id, score });
  }
  const addressesFailure = matches.some((match) => match.kind === 'addresses_failure');

  // 先判断有没有材料，再判断值不值得注入。
  const absence = materialAbsenceReason(research, { addressesFailure });
  if (absence) {
    return {
      value: 'none', inject: false, reasonCode: absence,
      reason: absence === RESEARCH_VALUE_REASONS.TRANSPORT_FAILURE_ONLY
        ? '本次研究只得到网络/认证失败信息，未获得有效建议'
        : absence === RESEARCH_VALUE_REASONS.UNTRACEABLE
          ? '建议缺少可追溯的来源或观察依据'
          : '本次研究未形成有效建议（协议失败或没有可行动结论）',
      matches: [],
    };
  }
  const taskScope = mission?.scope && typeof mission.scope === 'object' ? mission.scope : null;
  const declaredScope = research.advisory?.scope && typeof research.advisory.scope === 'object' ? research.advisory.scope : null;
  // 适用范围不相容比「有没有材料」更根本：材料再具体，也不该进一个用不上的轮次。
  const conflict = scopesConflict(declaredScope, taskScope);
  if (conflict) {
    return {
      value: 'none', inject: false, reasonCode: RESEARCH_VALUE_REASONS.SCOPE_INCOMPATIBLE,
      reason: `建议的 ${conflict} 适用范围与当前冻结任务契约不相容`,
      matches: [],
    };
  }
  // 无法追溯的事实断言不注入：具体的断言必须能追到来源或观察依据。
  const declaredAdvisory = research.advisory && typeof research.advisory === 'object' ? research.advisory : null;
  const actionable = Boolean(declaredAdvisory && (declaredAdvisory.nextChange || declaredAdvisory.hypothesis || declaredAdvisory.problem));
  if (actionable && !hasTraceableClaim(research)) {
    const claims = [declaredAdvisory.problem, declaredAdvisory.hypothesis, declaredAdvisory.nextChange].filter(Boolean);
    if (claims.length && !declaredAdvisory.evidence?.length) {
      return {
        value: 'none', inject: false, reasonCode: RESEARCH_VALUE_REASONS.UNTRACEABLE,
        reason: '建议缺少可追溯的来源或观察依据',
        matches: [],
      };
    }
  }

  // 覆盖判定只看已验证资产（publishedAssets）。未验证草稿（knowledgeDrafts）不能凭词面
  // 重叠把新材料压成「已覆盖」；「知识库里存在任意被引用资产」更不是覆盖证据。
  // 新材料只要提供了新的约束、证据或实验路径，就不算重复。
  const advisory = research.advisory && typeof research.advisory === 'object' ? research.advisory : null;
  const addsNewContent = Boolean(
    advisory?.nextChange || advisory?.verification || advisory?.stopCondition
    || (Array.isArray(advisory?.evidence) && advisory.evidence.length > 0),
  );
  if (!addsNewContent) {
    for (const asset of knowledge.publishedAssets || []) {
      const subject = `${asset.title || ''} ${asset.conclusion || ''} ${asset.trigger || ''}`;
      const { overlap, ratio } = claimContainment(researchWords, subject);
      if (overlap < DUPLICATE_MIN_OVERLAP || ratio < DUPLICATE_CONTAINMENT) continue;
      // 同范围才可能重复：范围冲突时不抑制；未声明的维度不参与判定。
      if (scopesConflict(researchScopeFor(research, declaredScope), asset.scope)) continue;
      matches.push({ kind: 'duplicate', targetId: asset.id, score: overlap });
    }
  }

  const duplicates = matches.filter((match) => match.kind === 'duplicate');
  const novel = !addressesFailure && !duplicates.length && researchWords.size >= 5;

  const inject = addressesFailure || novel;
  const value = addressesFailure ? 'high' : novel ? 'medium' : duplicates.length ? 'low' : 'none';
  const reasonCode = addressesFailure
    ? RESEARCH_VALUE_REASONS.ADDRESSES_FAILURE
    : novel
      ? RESEARCH_VALUE_REASONS.NOVEL
      : duplicates.length ? RESEARCH_VALUE_REASONS.DUPLICATE : RESEARCH_VALUE_REASONS.NO_MATERIAL;
  const reason = addressesFailure
    ? '命中已知失败方向，针对性补充'
    : novel
      ? '包含新的建议方向，值得尝试'
      : duplicates.length
        ? '与同范围的已验证结论重叠，且未提供新的证据或实验路径'
        : '缺少可追溯内容';
  return { value, inject, reason, reasonCode, matches: matches.slice(0, 10) };
};


const directionFamily = (text) => new Set(tokenize(`${text || ''}`));

const overlapCount = (a, b) => [...a].filter((word) => b.has(word)).length;

// shape 特化的领域线索（与 failureRecords 的 CORRECTNESS_BOUNDARY_MISMATCH 对齐）
const SHAPE_SPECIALIZATION_TERMS = ['shape', 'batch', 'seq', 'tile', 'head_dim', 'block', '长尾', '分块', '特化'];

// 方向视野检测（死磕识别）：主 agent 是否在同一方向上重复无进展地失败。
// 收敛守卫：只标"重复同一失败"（同错误码或强症状重合），不标"有信息地演进"（错误码在变）——
// 后者说明方向值得继续试，不应误伤需要耐心的方向。
export const detectTunnelVision = (state, { window = 3, overlapThreshold = 2 } = {}) => {
  const recent = (state.failureRecords || []).slice(0, window);
  if (recent.length < 2) return { tunnelVision: false, reason: null, directionFamily: null };
  const families = recent.map((record) => directionFamily(`${record.title || ''} ${record.decisionReason || ''} ${record.failure?.code || ''}`));
  const sameFamily = families.every((family, index) => index === 0 || overlapCount(families[index - 1], family) >= overlapThreshold);
  if (!sameFamily) return { tunnelVision: false, reason: null, directionFamily: null };
  const codes = recent.map((record) => record.failure?.code || '').filter(Boolean);
  const sameCode = codes.length >= 2 && new Set(codes).size === 1;
  const strongSymptomOverlap = families.every((family, index) => index === 0 || overlapCount(families[index - 1], family) >= overlapThreshold + 1);
  const repetitive = sameCode || (codes.length < 2 && strongSymptomOverlap);
  if (!repetitive) return { tunnelVision: false, reason: null, directionFamily: null }; // 在收敛，值得继续试
  const shapeRabbitHole = recent.every((record) => SHAPE_SPECIALIZATION_TERMS.some((term) => new RegExp(term, 'i').test(`${record.title || ''} ${record.failure?.code || ''}`)));
  return {
    tunnelVision: true,
    reason: shapeRabbitHole ? '低 ROI shape 特化死磕（重复同一失败）' : '连续失败停留在同一方向族（重复无进展）',
    directionFamily: recent.map((record) => record.id).join(','),
  };
};

const LOOP_GUARD_TEXT = {
  max_rounds: '已迭代到最大轮数上限，仍未完成采纳，请人工介入',
  total_budget: '累计迭代时长超出预算上限，请人工介入',
  round_budget: '当前完整轮次已达到 15 分钟墙钟上限，保留 current best 并等待人工处理；重试或恢复不会刷新同轮预算',
  round_budget_invalid: '当前轮次预算记录无效，请检查持久化起点与轮次归属后再启动工作',
  max_research: '研究员已多次升级仍未产生被采纳候选，停止研究员升级但主循环继续',
  candidate_generation_failed: '当前轮次的候选生成连续失败，已停止自动重试，请检查 Agent 后端或调整指令后恢复',
  correctness_failed: '固定精度测试在允许的修复轮次内仍未通过',
  external_verification: '当前候选缺少必需的真实诊断证据，保留候选与工作区等待外部验证；恢复后重试同一候选。',
};

// 决策中的等待状态是唯一真相，不能从 live 布尔或 publishable 反推。判定按当前
// mission/candidate/run 身份限定，绝不读取 currentBest 或其他 run 的旧等待决策；
// 同一候选重试已排队/执行中时旧等待不得重新触发。
const EXTERNAL_VERIFICATION_REASON = 'external_verification';
const isPlainObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

const retestInFlight = (state = {}) => ['queued', 'running'].includes(String(state?.benchmark?.status || '').toLowerCase());

const decisionMatchesCurrentRun = (state, decision) => {
  if (!isPlainObject(decision) || !isPlainObject(decision.binding)) return false;
  const binding = decision.binding;
  const candidateId = state?.appliedCandidateId || state?.benchmark?.candidate?.id || null;
  const runId = state?.benchmark?.runId || null;
  let matched = false;
  if (candidateId) { if (binding.candidateId !== candidateId) return false; matched = true; }
  if (runId) { if (binding.runId !== runId) return false; matched = true; }
  return matched;
};

const externalVerificationAcknowledged = (state, candidateId, runId) => {
  const acknowledged = state?.iterationStats?.externalVerificationAcknowledged;
  if (!isPlainObject(acknowledged)) return false;
  if (!acknowledged.candidateId && !acknowledged.runId) return false;
  if (candidateId && acknowledged.candidateId && acknowledged.candidateId !== candidateId) return false;
  if (runId && acknowledged.runId && acknowledged.runId !== runId) return false;
  return true;
};

export const isExternalVerificationPending = (state = {}) => {
  if (retestInFlight(state)) return false;
  const benchmark = state?.benchmark || {};
  const candidateId = state?.appliedCandidateId || benchmark.candidate?.id || null;
  const runId = benchmark.runId || null;
  if (externalVerificationAcknowledged(state, candidateId, runId)) return false;
  const decisions = [benchmark.evidenceDecision, state?.decisionReview?.gate?.decision, state?.decisionReview?.evidenceDecision];
  if (decisions.some((item) => decisionMatchesCurrentRun(state, item) && item?.adoption?.status === 'waiting_external_verification')) return true;
  const review = state?.decisionReview;
  if (review?.status === 'waiting_external_verification' && candidateId && review.candidateId === candidateId) {
    const gateDecision = review?.gate?.decision;
    return !isPlainObject(gateDecision) || decisionMatchesCurrentRun(state, gateDecision);
  }
  return false;
};

const activeMissionBudgetMs = (state = {}) => {
  const direct = Number(state.missionBudgetMs || 0);
  if (direct > 0) return direct;
  const mission = (state.missions || []).find((item) => item.id === state.activeMissionId);
  const missionBudget = Number(mission?.missionBudgetMs || 0);
  return missionBudget > 0 ? missionBudget : null;
};

// The same wall clock used by detectLoopGuard, exposed for bounded preflight I/O.
export const remainingMissionBudgetMs = (state = {}, { nowMs = Date.now() } = {}) => {
  const startedAt = state.missionBudgetStartedAt || state.iterationStats?.loopStartedAt;
  const elapsed = startedAt ? Math.max(0, nowMs - new Date(startedAt).getTime()) : 0;
  return Math.max(0, (activeMissionBudgetMs(state) || TOTAL_BUDGET_MS) - elapsed);
};

const phasedIterationPolicy = (mission = {}) => mission?.testScenario?.iterationPolicy || mission?.operatorProfile?.iterationPolicy || null;

export const settleGenerationAttemptBeforeStart = (state = {}, mission = {}, { retryMode = 'generation' } = {}) => {
  // A correctness repair reuses the active round. Starting that Agent must
  // never consume the independent candidate-generation budget.
  if (retryMode === 'correctness') return { state, blocked: false, counted: false, attempt: 0, limit: null };
  const iterationPolicy = phasedIterationPolicy(mission);
  const previousRunId = state.agent?.runId || null;
  const generationFailed = Boolean(iterationPolicy)
    && previousRunId
    && state.stage === 'diagnosis'
    && ['completed', 'failed', 'cancelled'].includes(state.agent?.status)
    && !state.candidateEvaluations?.length
    && state.baseline?.status === 'complete';
  if (!generationFailed) return { state, blocked: false, counted: false, attempt: 0, limit: null };

  const stats = state.iterationStats || {};
  const alreadyCounted = stats.lastGenerationAttemptRunId === previousRunId;
  const attempt = Number(stats.currentRoundGenerationAttempts || 0) + (alreadyCounted ? 0 : 1);
  const limit = Math.max(1, Number(iterationPolicy.maxGenerationAttempts || 1));
  state.iterationStats = {
    ...stats,
    generationAttempts: Number(stats.generationAttempts || 0) + (alreadyCounted ? 0 : 1),
    currentRoundGenerationAttempts: attempt,
    lastGenerationAttemptRunId: previousRunId,
    lastRoundOutcome: 'candidate_generation_failed',
    loopStartedAt: stats.loopStartedAt || new Date().toISOString(),
  };
  if (!alreadyCounted) {
    appendRuntimeEvent(state, 'candidate.generation_attempt_failed', {
      round: Number(stats.round || 0) + 1,
      attempt,
      limit,
      runId: previousRunId,
      // 只做标注诚实化：把根因码透传给消费者，不改变重试策略本身。
      classification: state.agent?.candidateValidation?.classification || null,
      candidateValidationCode: state.agent?.candidateValidation?.code || null,
    }, { kind: 'iteration', mode: 'policy' });
  }
  const blocked = attempt >= limit;
  if (blocked) {
    state.iterationStats = { ...state.iterationStats, loopStatus: 'needs_human', loopStatusReason: 'candidate_generation_failed' };
    state.agent = { ...state.agent, status: 'completed', phase: '候选生成重试已耗尽，需要人工调整 Agent 后端或指令', progress: 100, currentAction: null };
    mission.status = 'needs_human';
    if (!state.runtimeEvents?.some((event) => event.type === 'loop.needs_human' && event.payload?.reason === 'candidate_generation_failed')) {
      appendRuntimeEvent(state, 'loop.needs_human', { reason: 'candidate_generation_failed', attempt, limit, classification: state.agent?.candidateValidation?.classification || null }, { kind: 'policy', mode: 'client' });
    }
  }
  return { state, blocked, counted: !alreadyCounted, attempt, limit };
};

const roundCorrectnessPassed = (round = {}) => {
  const measurements = round?.benchmark?.result?.benchmark;
  return round?.benchmark?.status === 'complete'
    && Array.isArray(measurements)
    && measurements.length > 0
    && measurements.every((measurement) => measurement.correctness?.passed === true);
};

// 全局兜底：任一上限命中返回原因码；未命中返回 null。命中后循环停止自动流转，但手动操作不受阻。
export const detectLoopGuard = (state, { nowMs = Date.now() } = {}) => {
  const roundBudget = inspectRoundBudget(state, { nowMs });
  if (roundBudget.status === 'invalid') return 'round_budget_invalid';
  if (roundBudget.expired) return 'round_budget';
  const stats = state?.iterationStats || {};
  const mission = (state?.missions || []).find((item) => item.id === state?.activeMissionId) || {};
  // 外部验证等待是一等阻塞状态：优先于轮次/候选自动续跑，绝不因为本地可选诊断或
  // 预算而启动新 Agent 去“补工具”。恢复走既有 resume + 重试同一候选；重试已排队/
  // 执行中时旧等待不再触发。
  if (isExternalVerificationPending(state)) return EXTERNAL_VERIFICATION_REASON;
  if (stats.loopStatus === 'blocked') {
    if (stats.loopStatusReason === EXTERNAL_VERIFICATION_REASON) {
      if (!retestInFlight(state)) return EXTERNAL_VERIFICATION_REASON;
    } else {
      return stats.loopStatusReason || 'blocked';
    }
  }
  const phasedPolicy = phasedIterationPolicy(mission);
  if (phasedPolicy) {
    const maxGenerationAttempts = Math.max(1, Number(phasedPolicy.maxGenerationAttempts || 1));
    const maxCorrectnessAttempts = Math.max(1, Number(phasedPolicy.maxCorrectnessAttempts || 1));
    const performanceRounds = Math.max(1, Number(phasedPolicy.performanceRounds || 1));
    if (Number(stats.currentRoundGenerationAttempts || 0) >= maxGenerationAttempts) return 'candidate_generation_failed';
    if (Number(stats.currentRoundCorrectnessAttempts || 0) >= maxCorrectnessAttempts) return 'correctness_failed';
    if (Number(stats.performanceRounds || 0) >= performanceRounds) return 'fixed_rounds_complete';
  }
  const fixedRounds = Number(mission?.testScenario?.fixedRounds || 0);
  if (fixedRounds > 0 && (stats.round || 0) >= fixedRounds) return 'fixed_rounds_complete';
  // A persisted needs_human marker from an older run must not interrupt a test
  // that is already queued/running. The active queue operation is authoritative.
  if (stats.loopStatus === 'needs_human') {
    const benchmark = state?.benchmark || {};
    if (!['queued', 'running'].includes(benchmark.status)) return stats.loopStatusReason || 'needs_human';
    // Existing execution may continue, but it still obeys the total deadline.
  }
  const missionBudgetMs = activeMissionBudgetMs(state);
  const remainingMs = remainingMissionBudgetMs(state, { nowMs });
  if (missionBudgetMs) return remainingMs <= 0 ? 'total_budget' : null;
  if ((stats.round || 0) >= MAX_ROUNDS) return 'max_rounds';
  if (remainingMs <= 0) return 'total_budget';
  return null;
};

export const isResearchExhausted = (state = {}) => Boolean(state?.iterationStats?.researchExhausted)
  || (state?.iterationStats?.researchRounds || 0) >= MAX_RESEARCH_ESCALATIONS;

export const detectPlateau = (state = {}, { window = PLATEAU_NO_IMPROVE_ROUNDS } = {}) => {
  const mission = state.missions?.find((item) => item.id === state.activeMissionId) || {};
  if (!isMaximizeMission({ ...mission, objective: state.objective || mission.objective, goal: state.agent?.goal || mission.goal })) return { plateau: false, reason: null, noImproveRounds: 0, window };
  if (!isResearchExhausted(state)) return { plateau: false, reason: null, noImproveRounds: state.iterationStats?.consecutiveNoAdopt || 0, window };
  const noImproveRounds = state.iterationStats?.consecutiveNoAdopt || 0;
  if (noImproveRounds < window) return { plateau: false, reason: null, noImproveRounds, window };
  return { plateau: true, reason: `研究员已耗尽且连续 ${noImproveRounds} 轮无 current best 提升`, noImproveRounds, window };
};

const needsBaselineFirst = (state = {}) => {
  const baseline = state.baseline || state.missions?.find((item) => item.id === state.activeMissionId)?.baseline || {};
  if (baseline.required === false || baseline.status === 'complete' || baseline.status === 'running') return false;
  const text = [
    state.agent?.result?.summary,
    state.agent?.result?.diagnosis?.summary,
    state.agent?.result?.nextAction?.type,
    state.agent?.result?.nextAction?.title,
    state.agent?.result?.nextAction?.reason,
    state.agent?.result?.nextAction?.expectedOutput,
    state.agent?.currentAction?.type,
    state.agent?.currentAction?.title,
    state.agent?.currentAction?.reason,
  ].filter(Boolean).join(' ').toLowerCase();
  return /baseline|基线|reference|权威|物化|单文件/.test(text);
};

const completeMaximizeMission = (state, reason, eventType = 'loop.maximize_completed') => {
  const completedAt = new Date().toISOString();
  state.stage = 'published';
  state.iterationStats = { ...(state.iterationStats || {}), loopStatus: 'completed', loopStatusReason: reason, completedAt };
  state.knowledgeMaintenance = {
    ...(state.knowledgeMaintenance || {}),
    status: 'completed',
    completedAt: state.knowledgeMaintenance?.completedAt || completedAt,
  };
  const mission = state.missions?.find((item) => item.id === state.activeMissionId) || {};
  const phasedPolicy = phasedIterationPolicy(mission);
  const completionLabel = reason === 'fixed_rounds_complete' && phasedPolicy ? '三轮性能优化完成' : reason === 'fixed_rounds_complete' ? '固定三轮完成' : 'Mission 平台期完成';
  state.agent = {
    ...(state.agent || {}),
    status: 'completed',
    phase: reason === 'total_budget' ? 'Mission budget 已到，保留 current best' : reason === 'fixed_rounds_complete' ? (phasedPolicy ? '三轮性能优化完成，保留 current best' : '固定三轮完成，保留 current best') : 'Mission 平台期完成，保留 current best',
    progress: 100,
    currentAction: null,
  };
  addAuditEvent(state, reason === 'total_budget' ? 'Mission budget 已到' : completionLabel, `Current best: ${state.currentBest?.value || '—'}`, reason === 'total_budget' ? 'warning' : 'blue', 'Timer');
  appendRuntimeEvent(state, eventType, { reason, currentBest: state.currentBest || null }, { kind: 'policy', mode: 'client' });
  return state;
};

// 循环编排器（决策表，按序短路）。在 loadRuntimeState 内单飞调用；依赖注入避免反向耦合。
// deps: { startResearch, cancelResearch, startMainRound, researchDirForMission }
export async function advanceIteration(state, deps = {}) {
  if (process.env.NO_AUTO_LOOP === '1') return { state, action: 'disabled' };
  const releaseBarrier = resourceReleaseBarrier(state);
  if (releaseBarrier) {
    // A quarantined/blocked release is already a finite human-intervention
    // outcome. Keep the fail-closed barrier, but do not report it as an
    // endlessly pending transition to callers/pollers.
    if (isResourceReleaseQuarantined(releaseBarrier) || state.agent?.status === 'needs_human') {
      const stopped = state.missionPaused === true && state.iterationStats?.loopStatus === 'stopped';
      const reason = state.iterationStats?.loopStatusReason || 'resource_release_unconfirmed';
      const wasBlocked = state.iterationStats?.loopStatus === 'needs_human' && state.iterationStats?.loopStatusReason === reason;
      if (!stopped) {
        state.iterationStats = {
          ...(state.iterationStats || {}),
          loopStatus: 'needs_human',
          loopStatusReason: reason,
          resourceReleaseBlockedAt: state.iterationStats?.resourceReleaseBlockedAt || new Date().toISOString(),
        };
        const mission = state.missions?.find((item) => item.id === state.activeMissionId);
        if (mission && mission.status !== 'stopped') mission.status = 'needs_human';
        if (state.agent && state.agent.status !== 'needs_human') {
          state.agent = {
            ...state.agent,
            status: 'needs_human',
            phase: '执行资源释放未确认，Mission 已隔离',
            currentAction: null,
          };
        }
        if (!state.runtimeEvents?.some((event) => event.type === 'loop.resource_release_quarantined')) {
          addAuditEvent(state, '执行资源释放未确认', '原 Agent 资源未能在有限窗口内确认退出，Mission 已隔离；禁止自动恢复、重试或工作区写入。', 'warning', 'ShieldAlert');
          appendRuntimeEvent(state, 'loop.resource_release_quarantined', {
            reason,
            primaryFailure: state.agent?.primaryFailure || releaseBarrier.primaryFailure || null,
            resources: releaseBarrier.resources || [],
          }, { kind: 'policy', mode: 'client' });
        }
      }
      return { state, action: 'needs_human', reason, changed: !wasBlocked && !stopped };
    }
    return { state, action: 'resource_release_pending' };
  }
  const clockNow = () => Number(typeof deps.now === 'function' ? deps.now() : Date.now());
  const nowMs = clockNow();
  const guardReason = detectLoopGuard(state, { nowMs });
  if (state.missionPaused && !['round_budget', 'round_budget_invalid', 'total_budget'].includes(guardReason)) return { state, action: 'paused' };
  if (state.stage === 'published' && state.knowledgeMaintenance?.status === 'completed') {
    const completed = completeRoundBudget(state, { nowMs });
    return { state, action: 'completed', changed: completed.changed };
  }
  const startBudgetedMainRound = async (input, { completedRoundId = null } = {}) => {
    ensureRoundBudgetStarted(input.state, { nowMs: clockNow(), completedRoundId });
    return deps.startMainRound(input);
  };
  if (guardReason) {
    const mission = state.missions?.find((item) => item.id === state.activeMissionId) || {};
    if (guardReason === EXTERNAL_VERIFICATION_REASON) {
      const candidateId = state.appliedCandidateId || state.decisionReview?.candidateId || null;
      const runId = state.benchmark?.runId || null;
      // 已处于（或 resume 后已确认的）等待编排状态：重复 tick 只保持阻塞，
      // 不重复暂停、不产生新事件/时间戳。resume 已解除 missionPaused 等待重试。
      if (state.iterationStats?.loopStatus === 'blocked'
        && state.iterationStats?.loopStatusReason === EXTERNAL_VERIFICATION_REASON) {
        return { state, action: EXTERNAL_VERIFICATION_REASON, changed: false };
      }
      // 保留候选、工作区与当前 Agent 身份，只进入可恢复等待；不生成新候选、不改代码。
      state.missionPaused = true;
      state.iterationStats = { ...(state.iterationStats || {}), loopStatus: 'blocked', loopStatusReason: EXTERNAL_VERIFICATION_REASON };
      state.agent = {
        ...(state.agent || {}),
        status: 'awaiting_action',
        phase: '等待外部诊断验证',
        currentAction: state.agent?.currentAction || {
          id: 'action.external-verification',
          type: 'test.plan',
          title: '恢复后重试同一候选',
          reason: LOOP_GUARD_TEXT.external_verification,
          expectedOutput: '真实 mcTracer / mcProfiler 证据 · Accept Gate 重评',
          risk: 'low',
          approvalRequired: false,
        },
      };
      if (mission && !['completed', 'published', 'archived'].includes(mission.status)) mission.status = 'blocked';
      // 事件幂等按 mission/candidate/run 身份，而不是同类型全局永久抑制。
      const alreadyEvented = (state.runtimeEvents || []).some((event) => event.type === 'loop.external_verification_pending'
        && (event.payload?.candidateId || null) === candidateId
        && (event.payload?.runId || null) === runId);
      if (!alreadyEvented) {
        addAuditEvent(state, '等待外部诊断验证', LOOP_GUARD_TEXT.external_verification, 'warning', 'Clock');
        appendRuntimeEvent(state, 'loop.external_verification_pending', {
          reason: EXTERNAL_VERIFICATION_REASON,
          candidateId,
          runId,
        }, { kind: 'policy', mode: 'client' });
      }
      return { state, action: EXTERNAL_VERIFICATION_REASON, changed: true };
    }
    if (guardReason === 'round_budget') {
      const expired = expireRoundBudget(state, { nowMs });
      state.iterationStats = { ...(state.iterationStats || {}), loopStatus: 'needs_human', loopStatusReason: guardReason };
      mission.status = 'needs_human';
      state.agent = { ...(state.agent || {}), phase: '完整轮次预算已到，保留 current best', currentAction: null };
      if (!state.runtimeEvents?.some(event => event.type === 'loop.round_budget_exceeded' && event.payload?.roundId === expired.roundBudget?.roundId)) {
        addAuditEvent(state, '完整轮次预算已到', LOOP_GUARD_TEXT.round_budget, 'warning', 'Timer');
        appendRuntimeEvent(state, 'loop.round_budget_exceeded', { ...expired.roundBudget, reason: guardReason, currentBest: state.currentBest || null }, { kind: 'policy', mode: 'client' });
      }
      return { state, action: 'needs_human' };
    }
    if (guardReason === 'correctness_failed') {
      state.iterationStats = { ...(state.iterationStats || {}), loopStatus: 'failed', loopStatusReason: guardReason, completedAt: new Date().toISOString() };
      state.agent = { ...(state.agent || {}), status: 'failed', phase: 'Correctness Failed', progress: 100, currentAction: null };
      mission.status = 'failed';
      if (!state.runtimeEvents?.some((event) => event.type === 'loop.correctness_failed')) {
        addAuditEvent(state, 'Correctness Failed', '初始实现及允许的修复轮次均未通过固定精度用例。', 'warning', 'ShieldAlert');
        appendRuntimeEvent(state, 'loop.correctness_failed', {
          round: Number(state.iterationStats.round || 0) + 1,
          attempts: state.iterationStats.currentRoundCorrectnessAttempts || 0,
          totalAttempts: state.iterationStats.totalCorrectnessAttempts || 0,
        }, { kind: 'policy', mode: 'client' });
      }
      return { state, action: 'failed_correctness' };
    }
    const maximizeObjective = isMaximizeMission({ ...mission, objective: state.objective || mission.objective, goal: state.agent?.goal || mission.goal });
    if ((guardReason === 'total_budget' || guardReason === 'fixed_rounds_complete') && maximizeObjective) {
      completeMaximizeMission(state, guardReason, 'loop.budget_completed');
      return { state, action: guardReason === 'fixed_rounds_complete' ? 'completed_fixed_rounds' : 'completed_budget' };
    }
    state.iterationStats = { ...(state.iterationStats || {}), loopStatus: 'needs_human', loopStatusReason: guardReason };
    if (!state.runtimeEvents?.some((event) => event.type === 'loop.needs_human' && event.payload?.reason === guardReason)) {
      addAuditEvent(state, '循环需要人工介入', LOOP_GUARD_TEXT[guardReason] || guardReason, 'warning', 'UserRound');
      appendRuntimeEvent(state, 'loop.needs_human', { reason: guardReason }, { kind: 'policy', mode: 'client' });
    }
    return { state, action: 'needs_human' };
  }

  const researchAgent = state.researchAgent || {};
  const stats = state.iterationStats || {};
  const mission = state.missions?.find((item) => item.id === state.activeMissionId) || {};
  const phasedPolicy = phasedIterationPolicy(mission);
  const correctnessRepairInProgress = Boolean(phasedPolicy)
    && !stats.correctnessEstablished
    && Number(stats.currentRoundCorrectnessAttempts || 0) > 0;
  const resolvedEvidenceRound = isResolvedEvidenceRound(state);
  const diagnosticNoCandidateRound = state.stage === 'diagnosis'
    && (state.agent?.status === 'completed' || (state.agent?.status === 'failed' && state.agent?.candidateValidation?.passed === false))
    && state.agent?.runId
    && !state.candidateEvaluations?.length
    && state.baseline?.status === 'complete';
  const diagnosticFailedCandidateRound = state.stage === 'diagnosis'
    && state.agent?.status === 'completed'
    && state.agent?.runId
    && state.baseline?.status === 'complete'
    && !isInfrastructureTestFailure({ error: state.benchmark?.lastServiceError, logs: state.benchmark?.logs })
    && (state.benchmark?.status === 'failed' || state.decisionReview?.resolution?.outcome === 'reject');
  const diagnosticCorrectnessRepairRound = diagnosticNoCandidateRound && correctnessRepairInProgress;
  const researchExhausted = isResearchExhausted(state);

  // 研究员预算执行：按阶段终止——采集（停滞/事件/资料停滞/墙钟），综合（短墙钟保证笔记写完）。
  if (researchAgent.runId && researchAgent.status === 'running') {
    const now = Date.now();
    const elapsed = researchAgent.startedAt ? now - new Date(researchAgent.startedAt).getTime() : 0;
    const stalled = researchAgent.lastEventAt ? (now - researchAgent.lastEventAt >= RESEARCH_STALL_MS) : false;
    const eventBudgetHit = (researchAgent.eventCount || 0) >= RESEARCH_EVENT_BUDGET;
    // 阶段预算与 session 总 deadline 双重约束：session deadline 覆盖模型执行、格式修复、
    // 来源读取与重试；任一命中都终止本阶段，子阶段不会各自重置为一份完整预算。
    const sessionExpired = Number.isFinite(Date.parse(researchAgent.sessionDeadlineAt || ''))
      && Date.now() >= Date.parse(researchAgent.sessionDeadlineAt);
    const timeBudgetHit = elapsed >= (researchAgent.budgetMs || RESEARCH_BUDGET_MS) || sessionExpired;
    const fixedWorkflowAcquisition = researchAgent.runPhase === 'acquire'
      && (mission.sourcePolicy?.mode === 'agent-research-only' || mission.sourcePolicy?.strictZeroSource === true);
    // 采集阶段的「资料」计数只统计本次 researchRun 实际获取并验证的来源，
    // 不混入 Source Registry 的历史目录数（历史规模不是本次研究收获）。
    let materialCount = Number(researchAgent.acquisition?.sourceCount ?? researchAgent.materialCount ?? 0);
    let materialLastGrownAt = researchAgent.materialLastGrownAt || null;
    if (researchAgent.runPhase === 'acquire' && deps.countRunSources) {
      const counted = await deps.countRunSources({ state, mission });
      const current = counted?.count ?? 0;
      if (current > materialCount) { materialCount = current; materialLastGrownAt = now; }
    }
    const materialGrownAt = materialLastGrownAt ? new Date(materialLastGrownAt).getTime() : null;
    const materialStall = materialCount > 0 && materialGrownAt && (now - materialGrownAt >= RESEARCH_MATERIAL_STALL_MS);
    // 采集终止（资料停滞/事件预算/停滞/墙钟）：取消进程后，用已搜集资料【直接】转综合或结束——
    // 不等 cancel_requested 收敛（codex 进程可能不立即死透，导致转移永不触发）
    if (researchAgent.runPhase === 'acquire' && !fixedWorkflowAcquisition && (materialStall || eventBudgetHit || timeBudgetHit || stalled)) {
      if (deps.cancelResearch) { try { await deps.cancelResearch({ state, runId: researchAgent.runId }); } catch { /* 后台收敛 */ } }
      state.researchAgent = { ...researchAgent, status: 'cancelled', acquireHandled: true, materialCount, materialLastGrownAt };
      if (materialCount > 0 && deps.startResearch) {
        const nextState = await deps.startResearch({ state, mission, direction: selectResearchDirection(state), workspace: researchAgent.researchDir, synchronous: Boolean(researchAgent.synchronous), runPhase: 'synthesize' });
        if (nextState.researchAgent?.synthesizeRunId) {
          addAuditEvent(nextState, '研究员进入综合阶段', `已采集 ${materialCount} 项资料，开始整理笔记`, 'blue', 'Search');
          return { state: nextState, action: 'research_synthesizing' };
        }
        return { state: nextState, action: 'none' };
      }
      addAuditEvent(state, '研究员采集停止', materialStall ? '资料不再增长' : '采集停滞/超时', 'warning', 'Timer');
      return { state, action: 'research_no_material' };
    }
    // 建议阶段：短预算 + 停滞/事件预算终止。取消后由 projectState 收敛，产出「无有效建议」也是正常结束。
    if (researchAgent.runPhase === 'advisory' && (timeBudgetHit || stalled || eventBudgetHit) && deps.cancelResearch) {
      const cancelled = await deps.cancelResearch({ state, runId: researchAgent.runId });
      if (cancelled?.state) {
        addAuditEvent(cancelled.state, '研究员建议检索结束', timeBudgetHit ? '总预算用尽' : '事件停滞或达到事件预算', 'warning', 'Timer');
        appendRuntimeEvent(cancelled.state, 'research.advisory_budget_stop', { runId: researchAgent.runId, elapsedMs: elapsed, budgetMs: researchAgent.budgetMs || null, reason: timeBudgetHit ? 'budget_exhausted' : 'stalled' }, { kind: 'research', mode: 'policy' });
      }
      return { state: cancelled?.state || state, action: 'research_timeout' };
    }
    // 综合阶段短预算：取消后由 projectState 收敛产笔记
    // 综合阶段短预算：取消后由 projectState 收敛产笔记
    if (researchAgent.runPhase === 'synthesize' && timeBudgetHit && deps.cancelResearch) {
      const cancelled = await deps.cancelResearch({ state, runId: researchAgent.runId });
      if (cancelled?.state) addAuditEvent(cancelled.state, '研究员笔记超时', `Run ${researchAgent.runId} 已请求取消`, 'warning', 'Timer');
      return { state: cancelled?.state || state, action: 'research_timeout' };
    }
    // 同步研究（停滞升级）→ 主循环串行等待；异步研究（操作员触发）→ 放行，主循环不阻塞
    if (researchAgent.synchronous) return { state, action: 'wait_research' };
  }

  // 采集阶段终态 → 执行来源获取 → 启动综合阶段（写笔记），保证笔记总能产出（仅当配置了 sourceRoot）。
  // 来源获取（clone/fetch）由本路径的 deps.acquireSources 端口执行，不在状态投影里做；
  // 获取结果按本次 researchRun 记账，不用整个 Source Registry 的历史目录数充当成果。
  if (researchAgent.runId && researchAgent.runPhase === 'acquire' && researchAgent.sourceRoot && !researchAgent.acquireHandled
      && ['completed', 'failed', 'cancelled', 'timed_out'].includes(researchAgent.status)) {
    state.researchAgent = { ...researchAgent, acquireHandled: true };
    const allowSemanticFallback = mission.sourcePolicy?.allowSemanticFallback === true;
    if (researchAgent.status !== 'completed' && !allowSemanticFallback) {
      addAuditEvent(state, '研究员采集失败', `Run ${researchAgent.runId} 未完成，禁止进入综合阶段`, 'warning', 'Search');
      return { state, action: 'research_no_material' };
    }
    let acquired = Array.isArray(researchAgent.acquiredSources) ? researchAgent.acquiredSources : null;
    // 端口缺失不允许被静默当成「没有材料」：那会让任何一个还没接新端口的组合根
    // 永远拿不到材料且毫无诊断。这里显式标注走的是兼容路径，并发出可定位事件。
    if (acquired === null && !deps.acquireSources) {
      appendRuntimeEvent(state, 'research.acquisition_port_missing', {
        runId: researchAgent.runId,
        fallback: deps.registerSources ? 'legacy-registry-count' : 'none',
        note: '组合根未注入 acquireSources；本次材料计数退回兼容口径，不代表本次运行真的没有来源。',
      }, { kind: 'research', mode: 'policy' });
    }
    if (acquired === null && deps.acquireSources) {
      // deps.acquireSources 返回本次 run 实际获取并验证的来源清单；失败时返回 failures。
      const acquisition = await deps.acquireSources({ state, mission, runId: researchAgent.runId });
      acquired = Array.isArray(acquisition?.sources) ? acquisition.sources : [];
      state.researchAgent = {
        ...state.researchAgent,
        acquisitionStatus: acquisition?.failed ? 'failed' : 'completed',
        acquisition: {
          runId: researchAgent.runId,
          sourceCount: acquired.length,
          failureCount: Array.isArray(acquisition?.failures) ? acquisition.failures.length : 0,
          failures: (acquisition?.failures || []).slice(0, 5),
          reasonCode: acquisition?.reasonCode || null,
          completedAt: new Date().toISOString(),
        },
      };
      appendRuntimeEvent(state, 'research.acquisition_settled', {
        runId: researchAgent.runId,
        sourcesAcquired: acquired.length,
        failures: acquired.length ? 0 : (acquisition?.failures || []).length,
        reasonCode: acquisition?.reasonCode || null,
        elapsedMs: acquisition?.elapsedMs ?? null,
      }, { kind: 'research', mode: 'policy' });
    } else if (acquired === null && deps.registerSources) {
      // 兼容路径：组合根还没接 acquireSources 时退回旧的注册表计数口径，并如实标注，
      // 不把它伪装成本次运行的真实收获。
      const registered = await deps.registerSources({ state, mission });
      const legacyCount = Number(registered?.count) || 0;
      acquired = Array.from({ length: legacyCount }, (_value, index) => ({ name: `registry-entry-${index}`, legacyRegistryCount: true }));
      state.researchAgent = {
        ...state.researchAgent,
        acquisitionStatus: 'legacy',
        acquisition: {
          runId: researchAgent.runId,
          sourceCount: legacyCount,
          failureCount: 0,
          failures: [],
          reasonCode: 'RESEARCH_ACQUISITION_PORT_MISSING',
          completedAt: new Date().toISOString(),
        },
      };
      appendRuntimeEvent(state, 'research.acquisition_settled', {
        runId: researchAgent.runId,
        sourcesAcquired: legacyCount,
        failures: 0,
        reasonCode: 'RESEARCH_ACQUISITION_PORT_MISSING',
        elapsedMs: null,
      }, { kind: 'research', mode: 'policy' });
    }
    // 材料基线闸门：来源根被改动（未提交变更，或 HEAD tree 偏离登记的 tree pin）后，它就不再是
    // 固定引用，以它为基线的自动流转必须停下等人裁决。这里问的是来源本身，不是引用——
    // 判定层只认来源级错误码（见 source-registry-integrity.mjs）。
    if (deps.inspectSourceIntegrity) {
      // 问的是采集这一步用的那个根，不是 mission 上另配的根。
      const integrity = await deps.inspectSourceIntegrity({ state, mission, sourceRoot: researchAgent.sourceRoot || mission.sourceRoot });
      if (!integrity.valid) {
        addAuditEvent(integrity.state, '来源根完整性校验未通过',
          integrity.verdict === 'modified' ? '来源内容已被改动，固定引用失效，已停自动流转' : '来源无法核验，已停自动流转',
          'warning', 'Search');
        return { state: integrity.state, action: 'needs_human' };
      }
    }
    // 来源数量与有效材料数量分开显示：这里只报告本次 run 获取到几个来源。
    const materialCount = Array.isArray(acquired) ? acquired.length : 0;
    if ((materialCount > 0 || allowSemanticFallback) && deps.startResearch) {
      const nextState = await deps.startResearch({
        state, mission,
        direction: selectResearchDirection(state),
        workspace: researchAgent.researchDir,
        synchronous: Boolean(researchAgent.synchronous),
        runPhase: 'synthesize',
      });
      if (nextState.researchAgent?.synthesizeRunId) {
        addAuditEvent(nextState, '研究员进入综合阶段', materialCount > 0 ? `本次运行已获取 ${materialCount} 个来源，开始整理笔记` : '未获得可用源码，开始整理 Mission 语义 baseline', 'blue', 'Search');
        return { state: nextState, action: 'research_synthesizing' };
      }
      return { state: nextState, action: 'none' };
    }
    addAuditEvent(state, '研究员采集无资料', '未拉取到参考资料，研究结束', 'warning', 'Search');
    return { state, action: 'research_no_material' };
  }

  if (researchAgent.runId
      && researchAgent.runPhase === 'acquire'
      && researchAgent.acquireHandled
      && !state.researchNotes?.some((note) => note.runId === researchAgent.runId)
      && ['completed', 'failed', 'cancelled', 'timed_out'].includes(researchAgent.status)
      && stats.lastResearchRunId !== researchAgent.runId) {
    state.iterationStats = {
      ...stats,
      lastResearchRunId: researchAgent.runId,
      researchRounds: (stats.researchRounds || 0) + 1,
      researchExhausted: ((stats.researchRounds || 0) + 1) >= MAX_RESEARCH_ESCALATIONS,
      pendingInjection: null,
      consecutiveNoAdopt: 0,
    };
    state.researchAgent = { ...researchAgent, status: 'completed', phase: '研究员采集无资料', progress: 100 };
    addAuditEvent(state, '研究员无资料可注入', '本轮研究未产出可注入笔记，继续主候选循环', 'warning', 'Search');
    appendRuntimeEvent(state, 'research.no_material_recorded', { runId: researchAgent.runId, researchRounds: state.iterationStats.researchRounds }, { kind: 'research', mode: 'policy' });
    return { state, action: 'research_noted' };
  }

  // 研究员终态 → 价值闸 → 材料可用（只处理一次）
  // 注意：这里只到「材料可用」为止。researchAgent.injected 不再在这里置位——
  // 通过价值筛选不等于已经注入，只有真正提交到执行端才记录 submitted。
  const latestNote = (Array.isArray(state.researchNotes) ? state.researchNotes : [])
    .find((note) => noteBelongsToMission(note, mission.id)) || null;
  if (latestNote && stats.lastResearchRunId !== latestNote.runId) {
    if (['completed', 'failed', 'timed_out', 'cancelled'].includes(researchAgent.status)) {
      const evaluation = evaluateResearchValue({ research: latestNote, knowledge: knowledgeFromState(state), mission });
      latestNote.value = evaluation.value;
      const briefing = buildResearchBriefing({ mission, researchNotes: [latestNote], failureRecords: state.failureRecords, currentBest: state.currentBest, knowledgeReferences: state.knowledgeReferences });
      // 建议封装是可选的上下文，不是门禁：它失败只能降级为「本轮无材料可用」。
      // 抛出去还有第二个后果——lastResearchRunId 在下面才落盘，一旦在这里抛出，
      // 同一条笔记会在每个 tick 上被重新处理并再次抛出，整个迭代循环永远停在这一行。
      // 一次封装越界就能把运行时彻底卡死，所以这里必须接住。
      let advisory = null;
      let advisoryRejection = null;
      if (evaluation.inject) {
        try {
          advisory = buildAdvisoryEnvelope({ note: latestNote, mission, roundId: null, trigger: researchAgent.trigger || null, value: evaluation.value, reasonCode: evaluation.reasonCode });
        } catch (error) {
          advisoryRejection = { code: error.code || 'ADVISORY_ENVELOPE_FAILED', message: error.message };
        }
      }
      const pendingInjection = advisory ? {
        // 材料身份：Mission、Round、researchRunId/noteId 与 digest 一起绑定，
        // 供后续选择、冻结 prompt、提交三个阶段核对是不是同一份材料。
        noteId: latestNote.id,
        researchRunId: latestNote.researchRunId || latestNote.runId,
        missionId: latestNote.missionId || mission.id || null,
        digest: advisory.digest,
        direction: latestNote.direction,
        briefing,
        advisory,
        value: evaluation.value,
        reasonCode: evaluation.reasonCode,
        stage: RESEARCH_DELIVERY_STAGES.AVAILABLE,
        availableAt: new Date().toISOString(),
        selectedAt: null,
        submittedAt: null,
        delivery: null,
      } : null;
      state.iterationStats = {
        ...stats,
        lastResearchRunId: latestNote.runId,
        researchRounds: (stats.researchRounds || 0) + 1,
        researchExhausted: ((stats.researchRounds || 0) + 1) >= MAX_RESEARCH_ESCALATIONS,
        pendingInjection,
        consecutiveNoAdopt: 0, // 研究视为一次重新起步尝试，避免研究被连续触发
      };
      state.researchAgent = {
        ...researchAgent,
        injection: {
          // 这里只声明「材料是否可用」，不声明「已注入」。
          status: pendingInjection ? RESEARCH_DELIVERY_STAGES.AVAILABLE : RESEARCH_DELIVERY_STAGES.DISCARDED,
          noteId: latestNote.id,
          digest: pendingInjection?.digest || null,
          reasonCode: evaluation.reasonCode,
        },
      };
      if (pendingInjection) addAuditEvent(state, '调研材料可用（尚未注入）', `${latestNote.direction || ''} · ${evaluation.value} · ${evaluation.reasonCode}`, 'blue', 'Search');
      else if (advisoryRejection) addAuditEvent(state, '调研材料封装被拒，本轮不注入', `${advisoryRejection.code} · ${latestNote.id}`, 'warning', 'Search');
      else if (evaluation.value === 'none') addAuditEvent(state, '本次研究未产出有效建议', evaluation.reason, 'warning', 'Search');
      appendRuntimeEvent(state, 'research.value_gated', {
        noteId: latestNote.id,
        inject: evaluation.inject,
        value: evaluation.value,
        reasonCode: evaluation.reasonCode,
        reason: evaluation.reason,
        availableMaterial: pendingInjection ? 1 : 0,
        advisoryRejected: advisoryRejection?.code || null,
      }, { kind: 'research', mode: 'policy' });
      // 封装被拒时 inject 虽为 true，但本轮确实没有可用材料，所以只能是 research_noted。
      return { state, action: evaluation.inject && !advisoryRejection ? 'research_available' : 'research_noted' };
    }
    return { state, action: 'wait_research' };
  }

  // A strict cold-start Mission establishes and measures its Agent-generated
  // baseline before the general candidate loop may consume a research brief.
  // Source acquisition/synthesis above still progresses through this loop.
  const strictColdStart = mission.sourcePolicy?.mode === 'strict-zero-source'
    || mission.sourcePolicy?.strictZeroSource === true;
  if (strictColdStart && state.baseline?.status !== 'complete') {
    return { state, action: 'wait_baseline' };
  }

  if (state.stage === 'validation'
      && state.benchmark?.status === 'failed'
      && state.benchmark?.purpose === 'candidate'
      && !isInfrastructureTestFailure({ error: state.benchmark?.lastServiceError, logs: state.benchmark?.logs })
      && state.agent?.status === 'awaiting_action'
      && state.baseline?.status === 'complete') {
    const candidateId = state.appliedCandidateId || state.benchmark?.candidate?.id || null;
    const message = state.benchmark?.logs?.at(-1)?.message || state.benchmark?.lastServiceError?.message || 'candidate test failed';
    state.stage = 'diagnosis';
    state.decisionReview = {
      ...(state.decisionReview || {}),
      status: 'resolved',
      candidateId,
      recommendation: 'reject',
      requiresApproval: false,
      resolution: { outcome: 'reject', source: 'operator_test', note: message, resolvedAt: state.benchmark.completedAt || new Date().toISOString() },
      resolvedAt: state.benchmark.completedAt || new Date().toISOString(),
    };
    if (!state.failureRecords?.some((record) => record.candidateId === candidateId && record.decisionReason === message)) {
      state.failureRecords = [{
        id: `fail.${Date.now()}`,
        title: `候选测试失败：${candidateId || 'candidate'}`,
        candidateId,
        failure: { code: 'OPERATOR_TEST_FAILED', message },
        decisionReason: message,
        extractedExperience: { status: 'extracted', summary: message },
        createdAt: state.benchmark.completedAt || new Date().toISOString(),
      }, ...(state.failureRecords || [])].slice(0, 20);
    }
    state.agent = { ...(state.agent || {}), status: 'completed', phase: '候选测试失败，继续优化', currentAction: null };
    addAuditEvent(state, '候选失败已转入下一轮', message, 'warning', 'RefreshCw');
    appendRuntimeEvent(state, 'candidate.failed_recorded', { candidateId, message }, { kind: 'operator-test-service', mode: 'client' });
    return { state, action: 'failed_candidate_recorded' };
  }

  // 主线程活跃 → 等待（候选/验证/证据/沉淀期间不自动开新轮）
  const workflowActive = WORKFLOW_STAGES.includes(state.stage) && !resolvedEvidenceRound;
  const mainActive = AGENT_ACTIVE_STATUS.includes(state.agent?.status)
    || workflowActive
    || state.benchmark?.status === 'running';
  if (mainActive) return { state, action: 'wait_main' };

  const plateau = detectPlateau(state);
  if (plateau.plateau) {
    completeMaximizeMission(state, 'plateau', 'loop.plateau_completed');
    addAuditEvent(state, '研究员耗尽后进入平台期', plateau.reason, 'warning', 'TrendingUp');
    return { state, action: 'completed_plateau' };
  }

  if (needsBaselineFirst(state) && deps.startBaseline) {
    const nextState = await deps.startBaseline({ state, mission, reason: state.agent?.result?.nextAction?.reason || state.agent?.result?.summary || '' });
    if (nextState !== state || nextState.benchmark?.status === 'running' || nextState.baseline?.status === 'running') {
      addAuditEvent(nextState, '自动进入 baseline 验证', 'Agent 已识别硬基线缺失，客户端自动提交同 runner / 同 shape baseline。', 'blue', 'Baseline');
      appendRuntimeEvent(nextState, 'baseline.auto_started', { reason: state.agent?.result?.nextAction?.reason || null }, { kind: 'baseline', mode: 'client' });
      return { state: nextState, action: 'baseline_started' };
    }
  }

  if (state.stage === 'diagnosis'
      && state.baseline?.status === 'complete'
      && state.agent?.status === 'completed'
      && !state.candidateEvaluations?.length
      && needsBaselineFirst({ ...state, baseline: { ...state.baseline, status: 'missing' } })
      && deps.startMainRound) {
    const goal = `${mission.goal || state.agent?.goal || ''}\n【系统恢复】同 runner / 同 shape baseline 已完成（${state.baseline.evidence?.environment || 'runner'} ${state.baseline.evidence?.value ?? ''}${state.baseline.evidence?.unit || ''}），请直接生成单文件 run.py 优化候选，不要再次阻塞在 baseline 缺失。`;
    state.agent = { ...(state.agent || {}), runId: null, runtimeKind: null, result: null };
    const nextState = await startBudgetedMainRound({ state, goal });
    addAuditEvent(nextState, 'Baseline 后自动恢复候选生成', '检测到旧 baseline 诊断已被真实 baseline 结果满足，继续主 Agent 生成候选。', 'blue', 'RefreshCw');
    appendRuntimeEvent(nextState, 'baseline.resume_candidate_generation', { baseline: state.baseline?.evidence || null }, { kind: 'baseline', mode: 'client' });
    return { state: nextState, action: 'resumed_after_baseline' };
  }

  // 轮次结算：优先结算当前已完成 evidence 轮；否则用 resetMissionRunState 推入的 runHistory[0] 兜底。
  // 这样 reference/reject 结论不会卡在 evidence，自动循环可继续推进下一候选。
  const currentRound = resolvedEvidenceRound && state.agent?.runId
    ? {
        runId: state.agent.runId,
        stage: state.stage,
        benchmark: structuredClone(state.benchmark),
        decisionReview: structuredClone(state.decisionReview),
        currentBest: structuredClone(state.currentBest),
        completedAt: state.benchmark?.completedAt || state.decisionReview?.resolvedAt || null,
      }
    : null;
  const diagnosticRound = (diagnosticNoCandidateRound || diagnosticFailedCandidateRound)
    ? {
        runId: state.agent.runId,
        stage: 'diagnosis',
        decisionReview: { resolution: { outcome: diagnosticFailedCandidateRound ? 'reject' : 'no_candidate' } },
        completedAt: new Date().toISOString(),
      }
    : null;
  const latestRound = currentRound || diagnosticRound || state.runHistory?.[0];
  const phasedAttemptAlreadyRecorded = Boolean(phasedIterationPolicy(mission)) && (
    (diagnosticFailedCandidateRound && stats.lastCorrectnessAttemptRunId === latestRound?.runId)
    || (diagnosticCorrectnessRepairRound && stats.lastCorrectnessAttemptRunId === latestRound?.runId)
    || (diagnosticNoCandidateRound && !diagnosticCorrectnessRepairRound && stats.lastGenerationAttemptRunId === latestRound?.runId)
  );
  if (latestRound?.runId && stats.lastCountedRunId !== latestRound.runId && !phasedAttemptAlreadyRecorded) {
    const adopted = isRoundAdopted(latestRound);
    const phasedPolicy = phasedIterationPolicy(mission);
    const correctnessPassed = roundCorrectnessPassed(latestRound);

    // Fixed-profile rounds are evidence rounds, not Agent invocations. A
    // correctness failure consumes a bounded repair attempt inside the active
    // round; a no-candidate result only consumes a generation attempt.
    if (phasedPolicy && (diagnosticFailedCandidateRound || diagnosticCorrectnessRepairRound)) {
      if (stats.lastCorrectnessAttemptRunId === latestRound.runId) return { state, action: 'none' };
      const attempt = Number(stats.currentRoundCorrectnessAttempts || 0) + 1;
      state.iterationStats = {
        ...stats,
        correctnessAttempts: Number(stats.correctnessAttempts || 0) + 1,
        currentRoundCorrectnessAttempts: attempt,
        totalCorrectnessAttempts: Number(stats.totalCorrectnessAttempts || 0) + 1,
        lastCorrectnessAttemptRunId: latestRound.runId,
        lastRoundOutcome: 'correctness_failed',
        loopStartedAt: stats.loopStartedAt || new Date().toISOString(),
      };
      appendRuntimeEvent(state, 'correctness.attempt_failed', {
        round: Number(stats.round || 0) + 1,
        candidateId: state.appliedCandidateId || `candidate-${String(Number(stats.round || 0) + 1).padStart(2, '0')}`,
        attempt,
        limit: Math.max(1, Number(phasedPolicy.maxCorrectnessAttempts || 1)),
        runId: latestRound.runId,
        error: state.benchmark?.lastServiceError || null,
      }, { kind: 'iteration', mode: 'policy' });
      return { state, action: 'correctness_attempt_counted' };
    }

    if (phasedPolicy && diagnosticNoCandidateRound) {
      if (stats.lastGenerationAttemptRunId === latestRound.runId) return { state, action: 'none' };
      const attempt = Number(stats.currentRoundGenerationAttempts || 0) + 1;
      state.iterationStats = {
        ...stats,
        generationAttempts: Number(stats.generationAttempts || 0) + 1,
        currentRoundGenerationAttempts: attempt,
        lastGenerationAttemptRunId: latestRound.runId,
        lastRoundOutcome: 'candidate_generation_failed',
        loopStartedAt: stats.loopStartedAt || new Date().toISOString(),
      };
      appendRuntimeEvent(state, 'candidate.generation_attempt_failed', {
        round: Number(stats.round || 0) + 1,
        attempt,
        limit: Math.max(1, Number(phasedPolicy.maxGenerationAttempts || 1)),
        runId: latestRound.runId,
        // 只做标注诚实化：把根因码透传给消费者，不改变重试策略本身。
        classification: state.agent?.candidateValidation?.classification || null,
        candidateValidationCode: state.agent?.candidateValidation?.code || null,
      }, { kind: 'iteration', mode: 'policy' });
      return { state, action: 'generation_attempt_counted' };
    }

    if (phasedPolicy && (!resolvedEvidenceRound || !correctnessPassed)) return { state, action: 'none' };
    const nextStats = {
      ...stats,
      lastCountedRunId: latestRound.runId,
      round: (stats.round || 0) + 1,
      lastRoundOutcome: adopted ? 'adopted' : latestRound.stage || 'no_adopt',
      consecutiveNoAdopt: adopted ? 0 : (stats.consecutiveNoAdopt || 0) + 1,
      loopStartedAt: stats.loopStartedAt || new Date().toISOString(),
    };
    if (phasedPolicy) {
      nextStats.correctnessEstablished = true;
      nextStats.correctnessEstablishedRunId ||= latestRound.runId;
      nextStats.performanceRounds = Number(stats.performanceRounds || 0) + 1;
      nextStats.currentRoundGenerationAttempts = 0;
      nextStats.lastGenerationAttemptRunId = null;
      nextStats.currentRoundCorrectnessAttempts = 0;
      nextStats.lastCorrectnessAttemptRunId = null;
    }
    state.iterationStats = nextStats;
    // Generic legacy failure counters still advance, but diagnostic retries
    // must share the original complete-round clock until real evidence settles.
    if (correctnessPassed) completeRoundBudget(state, { nowMs: clockNow() });
    return { state, action: 'round_counted' };
  }

  // Only a counted, correctness-passed evidence round admits a fresh clock.
  // Its budget ordinal can be ahead of evidence counters after a manual rerun.
  const completedRoundId = resolvedEvidenceRound && roundCorrectnessPassed(state)
    && stats.lastCountedRunId === state.agent?.runId && stats.roundBudget?.status === 'completed'
    ? stats.roundBudget.roundId : null;

  // 研究材料的交付三阶段：选择 → 冻结进 prompt → 提交执行端（§6.1）。
  // 只有执行端真实 run 绑定到该 material digest 才算 submitted；
  // 启动未成功或结果不确定时，材料一律保留，绝不提前永久消费。
  if (stats.pendingInjection && deps.startMainRound) {
    const injection = stats.pendingInjection;
    // 提交落账：只有拿到证据时才清除待交付材料，并记录可核验的轮次身份。
    const commitSubmission = (target, { roundId = null, runId = null, evidence = null } = {}) => {
      target.iterationStats = {
        ...(target.iterationStats || {}),
        pendingInjection: null,
        researchInjection: {
          noteId: injection.noteId, digest: injection.digest ?? null, missionId: injection.missionId ?? null,
          researchRunId: injection.researchRunId ?? null, roundId, runId,
          status: RESEARCH_DELIVERY_STAGES.SUBMITTED, evidence, submittedAt: new Date().toISOString(),
        },
      };
      target.researchAgent = {
        ...(target.researchAgent || {}),
        injection: {
          status: RESEARCH_DELIVERY_STAGES.SUBMITTED, digest: injection.digest ?? null, noteId: injection.noteId,
          roundId, runId,
        },
      };
      appendRuntimeEvent(target, 'research.advisory_submitted', {
        noteId: injection.noteId, digest: injection.digest ?? null, roundId, runId, evidence,
      }, { kind: 'research', mode: 'policy' });
    };
    const delivery = resolveInjectionDelivery({ state, injection });
    if (delivery.status === RESEARCH_DELIVERY_STAGES.SUBMITTED) {
      commitSubmission(state, { roundId: delivery.roundId || null, runId: delivery.runId || null, evidence: delivery.evidence });
      return { state, action: 'research_submitted', changed: true };
    }
    if (injection.stage === RESEARCH_DELIVERY_STAGES.UNCERTAIN || injection.stage === RESEARCH_DELIVERY_STAGES.SELECTED || injection.stage === RESEARCH_DELIVERY_STAGES.PREPARED) {
      // 提交结果不确定：先核对既有运行记录，不盲目再启动一轮。
      const attempt = injection.delivery || {};
      const agent = state.agent || {};
      if (attempt.roundId && agent.roundId === attempt.roundId && agent.runId) {
        // 该轮已有运行但未绑定本材料：视为已消费，同一轮不重复提交，也不重复拼接材料。
        state.iterationStats = {
          ...state.iterationStats,
          pendingInjection: {
            ...injection, stage: RESEARCH_DELIVERY_STAGES.DISCARDED,
            discardReason: 'same_round_already_started', discardedAt: new Date().toISOString(),
          },
        };
        appendRuntimeEvent(state, 'research.advisory_discarded', {
          noteId: injection.noteId, reason: 'same_round_already_started', roundId: attempt.roundId,
        }, { kind: 'research', mode: 'policy' });
        return { state, action: 'research_delivery_uncertain', changed: true };
      }
      // 提交抛错已经用掉 MAX_INJECTION_ATTEMPTS 次：停止自动重投，但材料保留且原因可见，
      // 人工仍可手动交付。反复重投同一个硬失败只会浪费轮次预算。
      const attempts = Number(injection.submitAttempts || 0);
      if (attempts >= MAX_INJECTION_ATTEMPTS) {
        state.iterationStats = {
          ...state.iterationStats,
          pendingInjection: {
            ...injection,
            stage: RESEARCH_DELIVERY_STAGES.UNCERTAIN,
            delivery: { ...(injection.delivery || {}), attemptsExhausted: true, at: new Date().toISOString() },
          },
        };
        if (!state.runtimeEvents?.some((event) => event.type === 'research.advisory_submit_exhausted' && event.payload?.noteId === injection.noteId)) {
          appendRuntimeEvent(state, 'research.advisory_submit_exhausted', {
            noteId: injection.noteId, attempts,
            errorCode: injection.delivery?.errorCode || null,
          }, { kind: 'research', mode: 'policy' });
        }
        return { state, action: 'research_delivery_uncertain', changed: true };
      }
      state.iterationStats = { ...state.iterationStats, pendingInjection: { ...injection, stage: RESEARCH_DELIVERY_STAGES.UNCERTAIN } };
    }
    const selected = {
      ...injection,
      stage: RESEARCH_DELIVERY_STAGES.SELECTED,
      selectedAt: injection.selectedAt || new Date().toISOString(),
      roundOrdinal: Number(stats.round || 0) + 1,
    };
    state.iterationStats = { ...state.iterationStats, pendingInjection: selected };
    // goal 只带可核验身份，不再把研究文本拼进目标：内容经不可信上下文边界进入 prompt。
    // 只有封装过 advisory 的材料才走不可信边界；历史/人工意见等无封装材料保持既有文本路径。
    const advisoryLabel = selected.advisory && selected.digest
      ? `【研究建议】${selected.noteId} · ${selected.digest}`
      : `【调研注入】${selected.briefing || ''}`;
    const goal = [mission.goal || '', advisoryLabel].filter(Boolean).join('\n');
    let nextState;
    try {
      nextState = await startBudgetedMainRound(
        { state, goal, injection: selected, advisory: selected.advisory || null },
        { completedRoundId },
      );
    } catch (error) {
      // 启动抛错：先把材料标记为 uncertain（保留身份与失败原因，状态与材料都可恢复），
      // 再让错误按既有语义向上抛出——预算/准入一类的不变量错误绝不能被交付逻辑吞掉。
      state.iterationStats = {
        ...state.iterationStats,
        pendingInjection: {
          ...selected,
          stage: RESEARCH_DELIVERY_STAGES.UNCERTAIN,
          submitAttempts: Number(selected.submitAttempts || 0) + 1,
          delivery: {
            errorCode: error.code || 'ROUND_START_FAILED',
            message: String(error.message || '').slice(0, 400),
            at: new Date().toISOString(),
          },
        },
      };
      appendRuntimeEvent(state, 'research.advisory_delivery_failed', {
        noteId: selected.noteId, errorCode: error.code || 'ROUND_START_FAILED',
      }, { kind: 'research', mode: 'policy' });
      throw error;
    }
    const submitted = resolveInjectionDelivery({ state: nextState, injection: selected });
    // 无 advisory 封装的材料（历史记录 / 人工意见）没有 digest 可绑定：此时以「本轮真实
    // 启动了新的执行端 run」作为提交证据，而不是凭 pendingInjection 自证。
    const legacySubmitted = !selected.advisory && Boolean(nextState.agent?.runId);
    if (submitted.status === RESEARCH_DELIVERY_STAGES.SUBMITTED || legacySubmitted) {
      commitSubmission(nextState, {
        roundId: submitted.roundId || nextState.agent?.roundId || null,
        runId: submitted.runId || nextState.agent?.runId || null,
        evidence: submitted.evidence || 'legacy-round-started',
      });
      addAuditEvent(nextState, '研究建议已进入目标轮次', `${selected.noteId} · ${submitted.roundId || nextState.agent?.roundId || 'round pending'}`, 'green', 'Search');
      return { state: nextState, action: 'resumed_agent' };
    }
    // preflight 阻止启动或执行端未接受：不显示已提交，材料保留并标记原因。
    const notSubmitted = nextState.agent?.runId ? 'round_start_unobserved' : 'preflight_blocked';
    nextState.iterationStats = {
      ...(nextState.iterationStats || {}),
      pendingInjection: {
        ...selected,
        stage: RESEARCH_DELIVERY_STAGES.UNCERTAIN,
        delivery: { reason: notSubmitted, at: new Date().toISOString() },
      },
    };
    appendRuntimeEvent(nextState, 'research.advisory_not_submitted', {
      noteId: selected.noteId, reason: notSubmitted,
    }, { kind: 'research', mode: 'policy' });
    return { state: nextState, action: 'research_delivery_deferred' };
  }

  // 升级决策：停滞（连续 N 轮无采纳）或隧道视野（同一方向重复无进展失败）。
  // 统一走 research-policy 裁决：显式阶段、显式预算、webResearchEnabled 未显式开启即覆盖所有自动入口。
  // 停滞 → 同步研究（下一轮依赖调研结果，串行等待）；隧道视野 → 异步研究（主线程继续，研究员并行审查）。
  const { stagnated, consecutiveNoAdopt } = detectStagnation(state);
  const vision = detectTunnelVision(state);
  const shouldEscalate = stagnated || vision.tunnelVision;
  if (shouldEscalate && researchExhausted) {
    if (!stats.researchExhaustedNotified) {
      state.iterationStats = { ...(state.iterationStats || {}), researchExhausted: true, researchExhaustedNotified: true };
      addAuditEvent(state, '研究员升级已耗尽', `已达到 ${MAX_RESEARCH_ESCALATIONS} 次，后续只继续主候选循环`, 'warning', 'Search');
      appendRuntimeEvent(state, 'research.exhausted', { researchRounds: stats.researchRounds || 0, max: MAX_RESEARCH_ESCALATIONS }, { kind: 'research', mode: 'policy' });
    }
  } else if (shouldEscalate && deps.startResearch) {
    const trigger = vision.tunnelVision ? RESEARCH_TRIGGERS.TUNNEL_VISION : RESEARCH_TRIGGERS.STAGNATION;
    // 连续失败先诊断，不直接升级为重研究：纯运行故障（网络/认证/格式/权限）走修复，
    // 不触发完整领域研究。分类复用已有确定性信号，不额外调用模型。
    const fault = classifyResearchFaults({ failureRecords: state.failureRecords });
    const resolution = resolveAutomaticResearch({ mission, trigger });
    if (!resolution.allowed) {
      // 关闭自动研究时给出显式状态，既不隐式开启研究，也不放宽任何来源门禁。
      if (!state.runtimeEvents?.some((event) => event.type === 'research.skipped_disabled' && event.payload?.trigger === trigger)) {
        addAuditEvent(state, '自动研究已关闭', resolution.reason, 'warning', 'Search');
        appendRuntimeEvent(state, 'research.skipped_disabled', { trigger, phase: resolution.phase, reasonCode: resolution.reasonCode, reason: resolution.reason }, { kind: 'research', mode: 'policy' });
      }
    } else if (fault.runtimeFaultOnly) {
      // 只记录一次；这类失败应由上游修复（网络/认证/格式），重发研究只会再烧一次预算。
      if (!state.runtimeEvents?.some((event) => event.type === 'research.skipped_runtime_fault' && event.payload?.faultClass === fault.faultClass)) {
        addAuditEvent(state, '运行故障，不触发完整研究', `已识别为运行故障：${fault.evidence.join(', ') || 'unknown'}`, 'warning', 'Search');
        appendRuntimeEvent(state, 'research.skipped_runtime_fault', {
          trigger, faultClass: fault.faultClass, evidence: fault.evidence,
        }, { kind: 'research', mode: 'policy' });
      }
    } else {
      const direction = selectResearchDirection(state);
      const researchDir = deps.researchDirForMission
        ? deps.researchDirForMission(state.activeMissionId, mission.repository, mission.projectRoot)
        : null;
      const synchronous = vision.tunnelVision ? false : true;
      const request = describeResearchRequest({ mission, trigger, direction, fault, reason: vision.tunnelVision ? vision.reason : `连续 ${consecutiveNoAdopt} 轮无采纳` });
      const nextState = await deps.startResearch({
        state, mission, direction, workspace: researchDir, synchronous,
        runPhase: resolution.phase,
        budgetMs: resolution.budgetMs,
        trigger,
      });
      if (nextState.researchAgent?.runId) {
        addAuditEvent(nextState, vision.tunnelVision ? '方向审视触发调研' : '停滞检测触发调研', `${request.reason} · ${resolution.phase} · 研究员已${synchronous ? '串行' : '并行'}启动（预算 ${Math.round(resolution.budgetMs / 1000)}s）`, 'warning', 'Search');
        appendRuntimeEvent(nextState, 'research.requested', {
          trigger, phase: resolution.phase, reason: request.reason, budgetMs: resolution.budgetMs,
          problem: request.problem, expectedMinimalArtifact: request.expectedMinimalArtifact,
          stopConditions: request.stopConditions, faultClass: fault.faultClass,
        }, { kind: 'research', mode: 'policy' });
        return { state: nextState, action: 'research_escalated' };
      }
      return { state: nextState, action: 'none' };
    }
  }

  // 普通无采纳轮次后的自动续跑：未达到停滞窗口时继续让主线程生成下一候选。
  // 停滞达到窗口时，上面的升级决策会优先启动研究员。
  const settledForResume = phasedPolicy
    ? (resolvedEvidenceRound && stats.lastCountedRunId === state.agent?.runId)
      || (diagnosticFailedCandidateRound && stats.lastCorrectnessAttemptRunId === state.agent?.runId)
      || (diagnosticCorrectnessRepairRound && stats.lastCorrectnessAttemptRunId === state.agent?.runId)
      || (diagnosticNoCandidateRound && !diagnosticCorrectnessRepairRound && stats.lastGenerationAttemptRunId === state.agent?.runId)
    : (resolvedEvidenceRound || diagnosticNoCandidateRound || diagnosticFailedCandidateRound) && stats.lastCountedRunId === state.agent?.runId;
  if (settledForResume && deps.startMainRound) {
    const activeRound = Number(stats.round || 0) + 1;
    const correctnessAttempt = Number(stats.currentRoundCorrectnessAttempts || 0);
    const correctnessFailure = diagnosticFailedCandidateRound || diagnosticCorrectnessRepairRound;
    const goal = diagnosticNoCandidateRound || diagnosticFailedCandidateRound
      ? `${mission.goal || state.agent?.goal || ''}\n【系统恢复】Candidate ${activeRound} ${correctnessFailure ? `第 ${correctnessAttempt} 次 correctness 未通过：${state.failureRecords?.[0]?.decisionReason || state.benchmark?.lastServiceError?.message || state.benchmark?.logs?.at(-1)?.message || 'runner correctness failed'}。请保持固定 Oracle、shape 和判据，修复实现后重跑全部 correctness；通过后才进入 benchmark。本次仍属于 Round ${activeRound}，不得降低测试标准。` : '本次未生成有效 Diff。请在相同 Round 内生成一个有真实工作区 Diff 的 run.py 候选。'}`
      : `${mission.goal || state.agent?.goal || ''}\n【上一轮证据】${state.appliedCandidateId || 'candidate'} 的实测值为 ${state.benchmark?.result?.benchmark?.[0]?.value ?? 'unknown'}${state.benchmark?.result?.benchmark?.[0]?.unit || ''}，Accept Gate 未达到相对 baseline 目标。系统会先恢复轮前稳定工作区；请换一个有界优化方向并生成内容不同的单文件 run.py 候选。`;
    const retryMode = correctnessFailure ? 'correctness' : 'generation';
    const nextState = await startBudgetedMainRound({ state, goal, retryMode }, { completedRoundId });
    addAuditEvent(nextState, correctnessFailure ? 'Correctness 修复重试' : diagnosticNoCandidateRound ? '候选生成重试' : '自动进入下一轮', correctnessFailure ? `Round ${activeRound} · attempt ${correctnessAttempt + 1}` : diagnosticNoCandidateRound ? `Round ${activeRound} · Candidate 编号保持不变` : '上一候选未采纳，继续生成下一候选', 'blue', 'RefreshCw');
    return { state: nextState, action: 'resumed_agent' };
  }

  return { state, action: 'none' };
}
