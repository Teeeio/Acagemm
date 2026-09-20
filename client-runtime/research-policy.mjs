// 研究策略单一裁决点（§3.1）。
//
// 目标：不再让固定 profile、通用停滞升级、恢复执行等分支各自决定「要不要研究、研究哪个阶段」。
// 本模块是纯函数叶子模块，不 import 任何运行时实现，供 iteration-loop、agent-runtime 与
// application/* 服务共用。
//
// 语义边界（必须与文档保持一致）：
//  - researchEnabled:false 关闭的是【自动在线研究】的全部入口（建议型研究、经验研究、来源采集、
//    综合阶段）。它不关闭本地经验与已审查 Wiki 的检索（那条路径属于 round-experience-service，
//    与本开关无关）。
//  - 关闭研究不等于放宽来源门禁。缺必要来源时返回显式状态（blocked + 原因），
//    绝不隐式开启研究，也绝不放宽来源约束或启用 semantic fallback。
//  - 显式手动研究（POST /api/missions/:id/research）不受 researchEnabled 约束，它是操作员的
//    主动指令；由 researchPolicy.manualEnabled（默认 true）单独控制，并且仍然遵守同一总预算。

// 已知研究阶段。任何自动入口都必须显式选择其中之一，不再依赖容易混淆的默认值。
export const RESEARCH_PHASES = Object.freeze(['advisory', 'experience', 'acquire', 'synthesize']);
// 建议型研究的初始试验预算（§7.1：60–120 秒量级）。这是默认值而不是硬上限，
// 可由 mission.sourcePolicy.researchBudgetMs 覆盖。
export const RESEARCH_ADVISORY_BUDGET_MS = 90_000;
// 必要 baseline 来源采集的独立策略：仍然有总 deadline、有限重试与取消传播。
export const RESEARCH_ACQUISITION_BUDGET_MS = 10 * 60 * 1000;
// 采集 + 综合共享同一个 session 总预算，避免每进入一个子阶段就重置一份完整预算。
export const RESEARCH_SESSION_BUDGET_MS = 12 * 60 * 1000;
// 综合阶段没有 session deadline 时的兜底预算（它要真正写出笔记，不能按建议型研究的短预算给）。
export const RESEARCH_SYNTHESIZE_BUDGET_MS = 5 * 60 * 1000;
export const RESEARCH_BUDGET_BOUNDS = Object.freeze({ min: 30_000, max: 30 * 60 * 1000 });

// 触发来源 → 研究阶段。自动「是否值得研究」的判断复用已有上游决策与确定性故障分类，
// 不额外增加一次独立模型调用。
export const RESEARCH_TRIGGERS = Object.freeze({
  // 优化阶段的建议型研究：停滞 / 方向审视。只找建议，不找 baseline，不 clone 仓库。
  STAGNATION: 'stagnation',
  TUNNEL_VISION: 'tunnel_vision',
  // 固定 profile 的经验研究：同样只找建议，旁路不阻塞主循环。
  EXPERIENCE: 'experience',
  // 必要来源解析：来自 baseline 来源门禁或 materializer 拒绝后的改选。
  BASELINE_SOURCE: 'baseline_source',
  MATERIALIZER_REDIRECT: 'materializer_redirect',
  // 操作员显式请求。
  MANUAL: 'manual',
});

const ADVISORY_TRIGGERS = new Set([
  RESEARCH_TRIGGERS.STAGNATION,
  RESEARCH_TRIGGERS.TUNNEL_VISION,
  RESEARCH_TRIGGERS.EXPERIENCE,
]);
const ACQUISITION_TRIGGERS = new Set([
  RESEARCH_TRIGGERS.BASELINE_SOURCE,
  RESEARCH_TRIGGERS.MATERIALIZER_REDIRECT,
]);

const isObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const boundedBudget = (value, fallback) => {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return fallback;
  return Math.min(RESEARCH_BUDGET_BOUNDS.max, Math.max(RESEARCH_BUDGET_BOUNDS.min, Math.floor(numeric)));
};

// 研究配置：优先读 mission.sourcePolicy，其次 mission.researchPolicy（迁移期兼容）。
// 只表达必要语义，不新增模式；缺省即保持既有可用行为。
export const resolveResearchConfig = (mission = {}) => {
  const sourcePolicy = isObject(mission?.sourcePolicy) ? mission.sourcePolicy : {};
  const researchPolicy = isObject(mission?.researchPolicy) ? mission.researchPolicy : {};
  const enabledValue = sourcePolicy.researchEnabled ?? researchPolicy.enabled;
  return {
    // 只有显式 false 才关闭；undefined 保持既有「默认开启」行为。
    automaticEnabled: enabledValue !== false,
    // 手动研究默认可用，只有显式 false 才关闭。
    manualEnabled: researchPolicy.manualEnabled !== false && sourcePolicy.manualResearchEnabled !== false,
    advisoryBudgetMs: boundedBudget(sourcePolicy.researchBudgetMs ?? researchPolicy.budgetMs, RESEARCH_ADVISORY_BUDGET_MS),
    acquisitionBudgetMs: boundedBudget(sourcePolicy.acquisitionBudgetMs, RESEARCH_ACQUISITION_BUDGET_MS),
    sessionBudgetMs: boundedBudget(sourcePolicy.researchSessionBudgetMs, RESEARCH_SESSION_BUDGET_MS),
    synthesizeBudgetMs: boundedBudget(sourcePolicy.synthesizeBudgetMs, RESEARCH_SYNTHESIZE_BUDGET_MS),
    // 来源策略本身决定必要来源解析是否可能；研究开关不能放宽它。
    requiresVerifiableSource: sourcePolicy.mode === 'agent-research-only' || sourcePolicy.strictZeroSource === true,
    allowSemanticFallback: sourcePolicy.allowSemanticFallback === true,
  };
};

export const phaseForTrigger = (trigger) => {
  if (ADVISORY_TRIGGERS.has(trigger)) return trigger === RESEARCH_TRIGGERS.EXPERIENCE ? 'experience' : 'advisory';
  if (ACQUISITION_TRIGGERS.has(trigger)) return 'acquire';
  if (trigger === RESEARCH_TRIGGERS.MANUAL) return 'acquire';
  return null;
};

// 自动研究的统一裁决。返回明确结论，调用方不得再自行推断。
export const resolveAutomaticResearch = ({ mission = {}, trigger }) => {
  const config = resolveResearchConfig(mission);
  const phase = phaseForTrigger(trigger);
  if (!phase) {
    return { allowed: false, phase: null, reasonCode: 'RESEARCH_TRIGGER_UNKNOWN', reason: `未知的研究触发来源：${String(trigger)}`, config };
  }
  if (!config.automaticEnabled) {
    // 不区分触发来源：关闭自动研究就必须覆盖所有自动入口，不能从别的分支悄悄启动采集或综合。
    return {
      allowed: false,
      phase,
      reasonCode: 'RESEARCH_DISABLED_BY_POLICY',
      reason: 'Mission 已关闭自动在线研究（sourcePolicy.researchEnabled=false）。',
      config,
    };
  }
  const budgetMs = phase === 'acquire' ? config.acquisitionBudgetMs : config.advisoryBudgetMs;
  return { allowed: true, phase, budgetMs, sessionBudgetMs: config.sessionBudgetMs, reasonCode: null, reason: null, config };
};

// 显式手动研究的裁决：不受 researchEnabled 约束，只受 manualEnabled 约束。
export const resolveManualResearch = ({ mission = {}, phase = 'acquire' }) => {
  const config = resolveResearchConfig(mission);
  if (!config.manualEnabled) {
    return { allowed: false, phase, reasonCode: 'RESEARCH_MANUAL_DISABLED', reason: 'Mission 已关闭显式手动研究（researchPolicy.manualEnabled=false）。', config };
  }
  if (!RESEARCH_PHASES.includes(phase)) {
    return { allowed: false, phase, reasonCode: 'RESEARCH_PHASE_UNKNOWN', reason: `未知的研究阶段：${String(phase)}`, config };
  }
  const budgetMs = phase === 'acquire' ? config.acquisitionBudgetMs : config.advisoryBudgetMs;
  return { allowed: true, phase, budgetMs, sessionBudgetMs: config.sessionBudgetMs, reasonCode: null, reason: null, config };
};

// 研究 session 总预算：采集与综合共享同一 deadline，子阶段不再各拿一份完整预算。
export const sessionDeadlineFor = ({ startedAtMs, sessionBudgetMs }) => (
  Number.isFinite(startedAtMs) && Number.isFinite(sessionBudgetMs)
    ? new Date(startedAtMs + sessionBudgetMs).toISOString()
    : null
);

export const remainingSessionBudgetMs = ({ sessionDeadlineAt, nowMs = Date.now() }) => {
  const deadlineMs = Date.parse(sessionDeadlineAt || '');
  return Number.isFinite(deadlineMs) ? Math.max(0, deadlineMs - nowMs) : null;
};

// 连续失败先诊断，不直接升级为重研究（§3.3）。分类只复用已有确定性信号：
// 运行故障（格式/解析/权限/认证/网络）→ 修复或等待，不研究；
// 已有明确错误但实现反复失败 → 上游路线调整；
// 缺知识 / 多路线已验证无效 → 建议型研究。
export const RESEARCH_FAULT_CLASSES = Object.freeze({
  RUNTIME_FAULT: 'runtime_fault',
  IMPLEMENTATION_FAILURE: 'implementation_failure',
  KNOWLEDGE_GAP: 'knowledge_gap',
  ROUTES_EXHAUSTED: 'routes_exhausted',
  LOCAL_ANSWERABLE: 'local_answerable',
  UNKNOWN: 'unknown',
});

const RUNTIME_FAULT_CODES = new Set([
  'RESEARCH_SOURCE_SELECTION_INVALID', 'RESEARCH_RESULT_NOT_FOUND', 'RESEARCH_JSON_EXTRACT_FAILED',
  'RESEARCH_SCHEMA_MISMATCH', 'RESEARCH_RESULT_AMBIGUOUS', 'RESEARCH_RUN_MISMATCH',
  'RESEARCH_BUDGET_EXHAUSTED', 'RESEARCH_RUNTIME_UNSUPPORTED', 'RESEARCH_PROVIDER_UNAVAILABLE',
  'RESEARCH_SERIAL_BUSY', 'RESEARCH_RUN_ACTIVE', 'RESEARCH_WORKSPACE_REQUIRED',
  'RESEARCH_SOURCE_POLICY_REJECTED', 'RESEARCH_SOURCE_FETCH_FAILED',
  'CODEX_AUTH_REQUIRED', 'CODEX_NOT_LOGGED_IN', 'CLAUDE_AUTH_REQUIRED', 'AGENT_AUTH_REQUIRED',
]);
const RUNTIME_FAULT_PATTERNS = [
  /ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|ECONNRESET|EPIPE/iu,
  /\b(?:401|403|407|429)\b/u,
  /unauthori[sz]ed|forbidden|authentication|credential|not logged in|认证失败|未登录|无权限/iu,
  /network|socket hang up|timeout|timed out|超时|连接拒绝|网络不可用/iu,
];

// 判定「这批失败记录里是否只有运行故障」。只有当全部记录都是运行故障时才返回 true，
// 避免把「真实的实现失败 + 一条网络错误」误判成纯粹运行故障。
export const classifyResearchFaults = ({ failureRecords = [] } = {}) => {
  const records = (Array.isArray(failureRecords) ? failureRecords : []).slice(0, 5);
  if (!records.length) return { faultClass: RESEARCH_FAULT_CLASSES.KNOWLEDGE_GAP, runtimeFaultOnly: false, evidence: [] };
  const kinds = records.map((record) => {
    const code = String(record?.failure?.code || '').trim();
    const text = [code, record?.decisionReason, record?.failure?.message].filter(Boolean).join(' ');
    if (RUNTIME_FAULT_CODES.has(code) || RUNTIME_FAULT_PATTERNS.some((pattern) => pattern.test(text))) return RESEARCH_FAULT_CLASSES.RUNTIME_FAULT;
    return RESEARCH_FAULT_CLASSES.IMPLEMENTATION_FAILURE;
  });
  const runtimeFaultOnly = kinds.every((kind) => kind === RESEARCH_FAULT_CLASSES.RUNTIME_FAULT);
  return {
    faultClass: runtimeFaultOnly ? RESEARCH_FAULT_CLASSES.RUNTIME_FAULT : RESEARCH_FAULT_CLASSES.IMPLEMENTATION_FAILURE,
    runtimeFaultOnly,
    evidence: records.map((record) => record?.failure?.code || record?.id || null).filter(Boolean),
  };
};

// 在线研究触发前的门槛：必须先能说清「当前具体问题、为什么现有证据不足、
// 支持哪项决策、预期最小产物、预算与停止条件」。这里只做确定性判断，不调用模型。
export const describeResearchRequest = ({ mission = {}, trigger, direction, fault = null, reason = null }) => {
  const resolution = resolveAutomaticResearch({ mission, trigger });
  const config = resolution.config;
  return {
    trigger,
    phase: resolution.phase,
    reason: reason || resolution.reason,
    reasonCode: resolution.reasonCode,
    problem: direction || null,
    whyExistingEvidenceInsufficient: trigger === RESEARCH_TRIGGERS.STAGNATION || trigger === RESEARCH_TRIGGERS.TUNNEL_VISION
      ? '连续多轮未产生被采纳候选，已有本地经验与证据未能打开新的有界方向'
      : null,
    decisionSupported: '下一轮候选优化方向的选择',
    expectedMinimalArtifact: resolution.phase === 'acquire' ? '1-3 个可验证的上游来源快照' : '1 张建议卡片（问题 / 适用范围 / 假设 / 下一轮最小改动）',
    faultClass: fault?.faultClass || null,
    budgetMs: resolution.budgetMs ?? null,
    stopConditions: [
      `总预算 ${resolution.budgetMs ?? config.advisoryBudgetMs} ms 用尽`,
      '产出可用建议材料',
      '研究员判定无有效建议并正常结束',
    ],
  };
};
