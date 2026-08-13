import { addAuditEvent } from './state-store.mjs';
import { appendRuntimeEvent } from './agent-runtime.mjs';

// 研究员子 Agent 的循环策略：停滞检测、价值闸、调研简报、单轮预算、自动流转。
// 纯函数可单测；advanceIteration 通过 deps 注入 agentRuntime 能力，避免模块反向耦合。

export const STAGNATION_WINDOW = 3;            // 尺子 B：连续 N 轮无被采纳候选 → 停滞
export const RESEARCH_BUDGET_MS = 20 * 60 * 1000; // 研究员时长预算（仅上限，不强制调研）
export const ROUND_BUDGET_MS = 15 * 60 * 1000;   // 单轮时长预算（预留，Slice 1 不自动取消主线程）

const AGENT_ACTIVE_STATUS = ['running', 'executing', 'awaiting_action', 'cancel_requested', 'awaiting_approval'];
const WORKFLOW_STAGES = ['candidate', 'validation', 'evidence', 'curation'];

export const isRoundAdopted = (round = {}) => {
  const outcome = round?.decisionReview?.resolution?.outcome;
  return outcome === 'adopt' || round?.stage === 'published';
};

// 停滞判定（尺子 B：采纳尺）。优先用 iterationStats 计数，未计过数时从 runHistory 兜底推导。
export const detectStagnation = (state, { window = STAGNATION_WINDOW } = {}) => {
  const stats = state?.iterationStats || {};
  let consecutiveNoAdopt = stats.consecutiveNoAdopt || 0;
  if (!stats.lastCountedRunId && Array.isArray(state?.runHistory)) {
    consecutiveNoAdopt = state.runHistory.slice(0, window).filter((round) => !isRoundAdopted(round)).length;
  }
  return { stagnated: consecutiveNoAdopt >= window, consecutiveNoAdopt, window };
};

// 升级决策：停滞即拉研究员。操作员主动调研走独立 POST /api/missions/:id/research 路由，不经过这里。
export const decideResearchTrigger = (state) => {
  const { stagnated, consecutiveNoAdopt } = detectStagnation(state);
  if (!stagnated) return { trigger: false, reason: null, direction: null };
  return {
    trigger: true,
    reason: `连续 ${consecutiveNoAdopt} 轮未产生被采纳候选`,
    direction: selectResearchDirection(state),
  };
};

// 调研方向：从任务卡点（goal + failedRules + failureRecords + currentBest）生成针对性方向，不泛泛而谈。
export const selectResearchDirection = (state) => {
  const mission = state?.missions?.find((item) => item.id === state?.activeMissionId) || {};
  const parts = [];
  parts.push(`目标：${mission.goal || '未定义'}`);
  if (mission.hardware?.length) parts.push(`目标硬件：${mission.hardware.join(', ')}`);
  if (mission.metric) parts.push(`指标：${mission.metric}`);
  if (state?.currentBest?.value && state?.currentBest?.value !== '—') parts.push(`当前最佳：${state.currentBest.value}`);
  const gate = state?.candidateEvaluations?.find((candidate) => candidate?.acceptGate?.failedRules?.length)?.acceptGate;
  if (gate?.failedRules?.length) parts.push(`Accept Gate 未通过规则：${gate.failedRules.join(', ')}`);
  const failure = (state?.failureRecords || [])[0];
  if (failure) parts.push(`最近失败：${failure.title || failure.label || '未知'}（${failure.failure?.code || ''}）`);
  parts.push('请调研上述卡点相关的已知优化做法、最新论文与开源实现，给出针对性方向，不要泛泛而谈。');
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

const tokenize = (text) => String(text || '').toLowerCase().split(/[\s,，。；;:：()（）\[\]{}、/\\|._-]+/).filter((word) => word.length > 1);

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

// 循环编排器（决策表，按序短路）。在 loadRuntimeState 内单飞调用；依赖注入避免反向耦合。
// deps: { startResearch, cancelResearch, startMainRound, researchDirForMission }
export async function advanceIteration(state, deps = {}) {
  if (process.env.NO_AUTO_LOOP === '1') return { state, action: 'disabled' };
  if (state.missionPaused) return { state, action: 'paused' };
  if (state.stage === 'published' && state.knowledgeMaintenance?.status === 'completed') return { state, action: 'completed' };

  const researchAgent = state.researchAgent || {};
  const stats = state.iterationStats || {};
  const mission = state.missions?.find((item) => item.id === state.activeMissionId) || {};

  // 研究员预算执行：running 超预算 → 请求取消（下一 tick 由 projectState 收敛为 timed_out）
  if (researchAgent.runId && researchAgent.status === 'running') {
    const budgetMs = researchAgent.budgetMs || RESEARCH_BUDGET_MS;
    const elapsed = researchAgent.startedAt ? Date.now() - new Date(researchAgent.startedAt).getTime() : 0;
    if (elapsed >= budgetMs && deps.cancelResearch) {
      const cancelled = await deps.cancelResearch({ state, runId: researchAgent.runId });
      addAuditEvent(cancelled.state, '研究员预算耗尽', `Run ${researchAgent.runId} 已请求取消`, 'warning', 'Timer');
      return { state: cancelled.state, action: 'research_timeout' };
    }
    return { state, action: 'wait_research' };
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

  // 主线程活跃 → 等待（候选/验证/证据/沉淀期间不自动开新轮）
  const mainActive = AGENT_ACTIVE_STATUS.includes(state.agent?.status)
    || WORKFLOW_STAGES.includes(state.stage)
    || state.benchmark?.status === 'running';
  if (mainActive) return { state, action: 'wait_main' };

  // 轮次结算：runHistory[0] 是刚结束的上一轮（resetMissionRunState 推入），幂等计数一次
  const latestRound = state.runHistory?.[0];
  if (latestRound?.runId && stats.lastCountedRunId !== latestRound.runId) {
    const adopted = isRoundAdopted(latestRound);
    state.iterationStats = {
      ...stats,
      lastCountedRunId: latestRound.runId,
      round: (stats.round || 0) + 1,
      lastRoundOutcome: adopted ? 'adopted' : latestRound.stage || 'no_adopt',
      consecutiveNoAdopt: adopted ? 0 : (stats.consecutiveNoAdopt || 0) + 1,
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

  // 停滞升级：连续 N 轮无采纳 → 自动拉起研究员（仅当研究员实际启动成功）
  const { stagnated, consecutiveNoAdopt } = detectStagnation(state);
  if (stagnated && deps.startResearch) {
    const direction = selectResearchDirection(state);
    const researchDir = deps.researchDirForMission
      ? deps.researchDirForMission(state.activeMissionId, mission.repository, mission.projectRoot)
      : null;
    const nextState = await deps.startResearch({ state, mission, direction, workspace: researchDir });
    if (nextState.researchAgent?.runId) {
      addAuditEvent(nextState, '停滞检测触发调研', `连续 ${consecutiveNoAdopt} 轮无采纳 · 研究员已启动`, 'warning', 'Search');
      return { state: nextState, action: 'research_escalated' };
    }
    return { state: nextState, action: 'none' };
  }

  return { state, action: 'none' };
}
