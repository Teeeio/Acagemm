import { addAuditEvent, isInfrastructureTestFailure, isMaximizeMission } from './state-store.mjs';
import { appendRuntimeEvent } from './agent-runtime.mjs';

// 研究员子 Agent 的循环策略：停滞检测、价值闸、调研简报、单轮预算、自动流转。
// 纯函数可单测；advanceIteration 通过 deps 注入 agentRuntime 能力，避免模块反向耦合。

export const STAGNATION_WINDOW = 3;            // 尺子 B：连续 N 轮无被采纳候选 → 停滞
export const RESEARCH_BUDGET_MS = 20 * 60 * 1000; // 研究员时长预算（仅上限，不强制调研）
export const ROUND_BUDGET_MS = 15 * 60 * 1000;   // 单轮时长预算（预留，Slice 1 不自动取消主线程）
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

// 价值闸：对照过往经验/知识判断调研笔记是否有采用价值。
// 命中已知失败方向 → addresses_failure（注入）；与已验证结论重叠 → duplicate（不注入）；全新方向 → novel（注入）。
export const evaluateResearchValue = ({ research = {}, knowledge = {} }) => {
  const text = `${research.summary || ''} ${(research.findings || []).join(' ')} ${(research.suggestedDirections || []).join(' ')} ${(research.sources || []).map((source) => source.title || source.url).join(' ')}`;
  const researchWords = new Set(tokenize(text));
  const matches = [];

  for (const record of knowledge.failureRecords || []) {
    const subject = `${record.title || ''} ${record.failure?.code || ''} ${record.decisionReason || ''}`;
    const score = countOverlap(researchWords, subject);
    if (score >= 2) matches.push({ kind: 'addresses_failure', targetId: record.id, score });
  }

  const assets = [...(knowledge.publishedAssets || []), ...(knowledge.knowledgeDrafts || [])];
  for (const asset of assets) {
    const subject = `${asset.title || ''} ${asset.conclusion || ''} ${asset.trigger || ''}`;
    const score = countOverlap(researchWords, subject);
    if (score >= 3) matches.push({ kind: 'duplicate', targetId: asset.id, score });
  }

  const referencedIds = new Set((knowledge.knowledgeReferences || []).map((ref) => ref.assetId));
  if ((knowledge.publishedAssets || []).some((asset) => referencedIds.has(asset.id))) {
    matches.push({ kind: 'covered', targetId: 'knowledgeReferences' });
  }

  const addressesFailure = matches.some((match) => match.kind === 'addresses_failure');
  const duplicates = matches.filter((match) => match.kind === 'duplicate').length;
  const novel = !addressesFailure && matches.length === 0 && researchWords.size >= 5;

  const inject = addressesFailure || novel;
  const value = addressesFailure ? 'high' : novel ? 'medium' : matches.length ? 'low' : 'none';
  const reason = addressesFailure
    ? '命中已知失败方向，针对性补充'
    : novel
      ? '包含新的建议方向，值得尝试'
      : matches.length
        ? '与已验证经验重叠，无需注入'
        : '缺少可追溯内容';
  return { value, inject, reason, matches: matches.slice(0, 10) };
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
  max_research: '研究员已多次升级仍未产生被采纳候选，停止研究员升级但主循环继续',
};

const activeMissionBudgetMs = (state = {}) => {
  const direct = Number(state.missionBudgetMs || 0);
  if (direct > 0) return direct;
  const mission = (state.missions || []).find((item) => item.id === state.activeMissionId);
  const missionBudget = Number(mission?.missionBudgetMs || 0);
  return missionBudget > 0 ? missionBudget : null;
};

// 全局兜底：任一上限命中返回原因码；未命中返回 null。命中后循环停止自动流转，但手动操作不受阻。
export const detectLoopGuard = (state) => {
  const stats = state?.iterationStats || {};
  if (stats.loopStatus === 'needs_human') return stats.loopStatusReason || 'needs_human';
  const missionBudgetMs = activeMissionBudgetMs(state);
  const budgetStartedAt = state?.missionBudgetStartedAt || stats.loopStartedAt;
  const totalElapsedMs = budgetStartedAt ? Date.now() - new Date(budgetStartedAt).getTime() : 0;
  if (missionBudgetMs) return totalElapsedMs >= missionBudgetMs ? 'total_budget' : null;
  if ((stats.round || 0) >= MAX_ROUNDS) return 'max_rounds';
  if (totalElapsedMs >= TOTAL_BUDGET_MS) return 'total_budget';
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
  state.agent = {
    ...(state.agent || {}),
    status: 'completed',
    phase: reason === 'total_budget' ? 'Mission budget 已到，保留 current best' : 'Mission 平台期完成，保留 current best',
    progress: 100,
    currentAction: null,
  };
  addAuditEvent(state, reason === 'total_budget' ? 'Mission budget 已到' : 'Mission 平台期完成', `Current best: ${state.currentBest?.value || '—'}`, reason === 'total_budget' ? 'warning' : 'blue', 'Timer');
  appendRuntimeEvent(state, eventType, { reason, currentBest: state.currentBest || null }, { kind: 'policy', mode: 'client' });
  return state;
};

// 循环编排器（决策表，按序短路）。在 loadRuntimeState 内单飞调用；依赖注入避免反向耦合。
// deps: { startResearch, cancelResearch, startMainRound, researchDirForMission }
export async function advanceIteration(state, deps = {}) {
  if (process.env.NO_AUTO_LOOP === '1') return { state, action: 'disabled' };
  if (state.missionPaused) return { state, action: 'paused' };
  if (state.stage === 'published' && state.knowledgeMaintenance?.status === 'completed') return { state, action: 'completed' };

  const guardReason = detectLoopGuard(state);
  if (guardReason) {
    const mission = state.missions?.find((item) => item.id === state.activeMissionId) || {};
    const maximizeObjective = isMaximizeMission({ ...mission, objective: state.objective || mission.objective, goal: state.agent?.goal || mission.goal });
    if (guardReason === 'total_budget' && maximizeObjective) {
      completeMaximizeMission(state, guardReason, 'loop.budget_completed');
      return { state, action: 'completed_budget' };
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
  const resolvedEvidenceRound = isResolvedEvidenceRound(state);
  const diagnosticNoCandidateRound = state.stage === 'diagnosis'
    && state.agent?.status === 'completed'
    && state.agent?.runId
    && !state.candidateEvaluations?.length
    && state.baseline?.status === 'complete';
  const diagnosticFailedCandidateRound = state.stage === 'diagnosis'
    && state.agent?.status === 'completed'
    && state.agent?.runId
    && state.baseline?.status === 'complete'
    && !isInfrastructureTestFailure({ error: state.benchmark?.lastServiceError, logs: state.benchmark?.logs })
    && (state.benchmark?.status === 'failed' || state.decisionReview?.resolution?.outcome === 'reject');
  const researchExhausted = isResearchExhausted(state);

  // 研究员预算执行：按阶段终止——采集（停滞/事件/资料停滞/墙钟），综合（短墙钟保证笔记写完）。
  if (researchAgent.runId && researchAgent.status === 'running') {
    const now = Date.now();
    const elapsed = researchAgent.startedAt ? now - new Date(researchAgent.startedAt).getTime() : 0;
    const stalled = researchAgent.lastEventAt ? (now - researchAgent.lastEventAt >= RESEARCH_STALL_MS) : false;
    const eventBudgetHit = (researchAgent.eventCount || 0) >= RESEARCH_EVENT_BUDGET;
    const timeBudgetHit = elapsed >= (researchAgent.budgetMs || RESEARCH_BUDGET_MS);
    const fixedWorkflowAcquisition = researchAgent.runPhase === 'acquire'
      && (mission.sourcePolicy?.mode === 'agent-research-only' || mission.sourcePolicy?.strictZeroSource === true);
    // 采集阶段：sources/ 资料数量不再增长 → 视为已搜集够，可转综合（事件在涨不代表资料在涨）
    let materialCount = researchAgent.materialCount || 0;
    let materialLastGrownAt = researchAgent.materialLastGrownAt || null;
    if (researchAgent.runPhase === 'acquire' && !fixedWorkflowAcquisition && deps.countSources) {
      const counted = await deps.countSources({ state, mission });
      const current = counted?.count ?? 0;
      if (current > materialCount) { materialCount = current; materialLastGrownAt = now; }
      else if (current > 0 && !materialLastGrownAt) materialLastGrownAt = now;
    }
    const materialGrownAt = materialLastGrownAt ? new Date(materialLastGrownAt).getTime() : null;
    const materialStall = materialCount > 0 && materialGrownAt && (now - materialGrownAt >= RESEARCH_MATERIAL_STALL_MS);
    if (materialCount !== (researchAgent.materialCount || 0) || materialLastGrownAt !== researchAgent.materialLastGrownAt) {
      state.researchAgent = { ...researchAgent, materialCount, materialLastGrownAt };
    }
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
    // 综合阶段短预算：取消后由 projectState 收敛产笔记
    if (researchAgent.runPhase === 'synthesize' && timeBudgetHit && deps.cancelResearch) {
      const cancelled = await deps.cancelResearch({ state, runId: researchAgent.runId });
      if (cancelled?.state) addAuditEvent(cancelled.state, '研究员笔记超时', `Run ${researchAgent.runId} 已请求取消`, 'warning', 'Timer');
      return { state: cancelled?.state || state, action: 'research_timeout' };
    }
    // 同步研究（停滞升级）→ 主循环串行等待；异步研究（操作员触发）→ 放行，主循环不阻塞
    if (researchAgent.synchronous) return { state, action: 'wait_research' };
  }

  // 采集阶段终态 → 注册已拉资料 + 启动综合阶段（写笔记），保证笔记总能产出（仅当配置了 sourceRoot）
  if (researchAgent.runId && researchAgent.runPhase === 'acquire' && researchAgent.sourceRoot && !researchAgent.acquireHandled
      && ['completed', 'failed', 'cancelled', 'timed_out'].includes(researchAgent.status)) {
    state.researchAgent = { ...researchAgent, acquireHandled: true };
    if (researchAgent.status !== 'completed') {
      addAuditEvent(state, '研究员采集失败', `Run ${researchAgent.runId} 未完成，禁止进入综合阶段`, 'warning', 'Search');
      return { state, action: 'research_no_material' };
    }
    const registered = deps.registerSources ? await deps.registerSources({ state, mission }) : { count: 0 };
    const materialCount = registered?.count ?? 0;
    if (materialCount > 0 && deps.startResearch) {
      const nextState = await deps.startResearch({
        state, mission,
        direction: selectResearchDirection(state),
        workspace: researchAgent.researchDir,
        synchronous: Boolean(researchAgent.synchronous),
        runPhase: 'synthesize',
      });
      if (nextState.researchAgent?.synthesizeRunId) {
        addAuditEvent(nextState, '研究员进入综合阶段', `已采集 ${materialCount} 项资料，开始整理笔记`, 'blue', 'Search');
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

  // 研究员终态 → 价值闸 → 注入准备（只处理一次）
  const latestNote = Array.isArray(state.researchNotes) ? state.researchNotes[0] : null;
  if (latestNote && stats.lastResearchRunId !== latestNote.runId) {
    if (['completed', 'failed', 'timed_out', 'cancelled'].includes(researchAgent.status)) {
      const evaluation = evaluateResearchValue({ research: latestNote, knowledge: knowledgeFromState(state) });
      latestNote.value = evaluation.value;
      const briefing = buildResearchBriefing({ mission, researchNotes: state.researchNotes, failureRecords: state.failureRecords, currentBest: state.currentBest, knowledgeReferences: state.knowledgeReferences });
      state.iterationStats = {
        ...stats,
        lastResearchRunId: latestNote.runId,
        researchRounds: (stats.researchRounds || 0) + 1,
        researchExhausted: ((stats.researchRounds || 0) + 1) >= MAX_RESEARCH_ESCALATIONS,
        pendingInjection: evaluation.inject ? { noteId: latestNote.id, direction: latestNote.direction, briefing, value: evaluation.value } : null,
        consecutiveNoAdopt: 0, // 研究视为一次重新起步尝试，避免研究被连续触发
      };
      state.researchAgent = { ...researchAgent, injected: evaluation.inject };
      if (evaluation.inject) addAuditEvent(state, '调研简报已注入', `${latestNote.direction || ''} · ${evaluation.value}`, 'green', 'Search');
      appendRuntimeEvent(state, 'research.value_gated', { noteId: latestNote.id, inject: evaluation.inject, value: evaluation.value }, { kind: 'research', mode: 'policy' });
      return { state, action: evaluation.inject ? 'research_injected' : 'research_noted' };
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
    const nextState = await deps.startMainRound({ state, goal });
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
  if (latestRound?.runId && stats.lastCountedRunId !== latestRound.runId) {
    const adopted = isRoundAdopted(latestRound);
    state.iterationStats = {
      ...stats,
      lastCountedRunId: latestRound.runId,
      round: (stats.round || 0) + 1,
      lastRoundOutcome: adopted ? 'adopted' : latestRound.stage || 'no_adopt',
      consecutiveNoAdopt: adopted ? 0 : (stats.consecutiveNoAdopt || 0) + 1,
      loopStartedAt: stats.loopStartedAt || new Date().toISOString(),
    };
    return { state, action: 'round_counted' };
  }

  // 调研注入后的自动续跑：直接进入下一主轮，操作员无需手动继续
  if (stats.pendingInjection && deps.startMainRound) {
    const briefing = stats.pendingInjection.briefing;
    const goal = `${mission.goal || ''}\n【调研注入】${briefing}`;
    state.iterationStats = { ...state.iterationStats, pendingInjection: null };
    const nextState = await deps.startMainRound({ state, goal });
    addAuditEvent(nextState, '自动进入下一轮', '已注入调研简报并启动主线程', 'blue', 'RefreshCw');
    return { state: nextState, action: 'resumed_agent' };
  }

  // 升级决策：停滞（连续 N 轮无采纳）或隧道视野（同一方向重复无进展失败）。
  // 停滞 → 同步研究（下一轮依赖调研结果，串行等待）；隧道视野 → 异步研究（主线程继续，研究员并行审查，不误伤需要耐心的方向）。
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
    const direction = selectResearchDirection(state);
    const researchDir = deps.researchDirForMission
      ? deps.researchDirForMission(state.activeMissionId, mission.repository, mission.projectRoot)
      : null;
    const synchronous = vision.tunnelVision ? false : true;
    const nextState = await deps.startResearch({ state, mission, direction, workspace: researchDir, synchronous });
    if (nextState.researchAgent?.runId) {
      addAuditEvent(nextState, vision.tunnelVision ? '方向审视触发调研' : '停滞检测触发调研', `${vision.tunnelVision ? vision.reason : `连续 ${consecutiveNoAdopt} 轮无采纳`} · 研究员已${synchronous ? '串行' : '并行'}启动`, 'warning', 'Search');
      return { state: nextState, action: 'research_escalated' };
    }
    return { state: nextState, action: 'none' };
  }

  // 普通无采纳轮次后的自动续跑：未达到停滞窗口时继续让主线程生成下一候选。
  // 停滞达到窗口时，上面的升级决策会优先启动研究员。
  if ((resolvedEvidenceRound || diagnosticNoCandidateRound || diagnosticFailedCandidateRound) && deps.startMainRound && stats.lastCountedRunId === state.agent?.runId) {
    const goal = diagnosticNoCandidateRound || diagnosticFailedCandidateRound
      ? `${mission.goal || state.agent?.goal || ''}\n【系统恢复】上一轮${diagnosticFailedCandidateRound ? `候选测试失败：${state.failureRecords?.[0]?.decisionReason || state.benchmark?.logs?.at(-1)?.message || 'runner correctness failed'}` : '未生成候选'}。baseline 已完成，请换一个有界方向生成单文件 run.py 候选。`
      : `${mission.goal || state.agent?.goal || ''}\n【上一轮证据】${state.appliedCandidateId || 'candidate'} 的实测值为 ${state.benchmark?.result?.benchmark?.[0]?.value ?? 'unknown'}${state.benchmark?.result?.benchmark?.[0]?.unit || ''}，Accept Gate 未达到相对 baseline 目标。系统会先恢复轮前稳定工作区；请换一个有界优化方向并生成内容不同的单文件 run.py 候选。`;
    const nextState = await deps.startMainRound({ state, goal });
    addAuditEvent(nextState, '自动进入下一轮', diagnosticFailedCandidateRound ? '上一候选测试失败，继续生成下一候选' : diagnosticNoCandidateRound ? '上一轮未生成候选，继续生成候选' : '上一候选未采纳，继续生成下一候选', 'blue', 'RefreshCw');
    return { state: nextState, action: 'resumed_agent' };
  }

  return { state, action: 'none' };
}
