// Read-only presentation of the canonical API evaluation export. No new verdicts.
import { selectEvidenceDecision } from './workflow-summary.mjs';
const value = item => item == null || item === '' ? '未知' : String(item).replace(/[\r\n\x00-\x1f\x7f]/g, ' ');
const list = items => Array.isArray(items) ? items : [];
const pairs = record => Object.entries(record || {}).map(([key, count]) => `${value(key)} ${value(count)}`).join(' · ') || '暂无记录';
export const historySections = Object.freeze(['总览', '迭代轨迹', '场景性能', '经验审计', '故障记录']);
export const historyCapacity = viewport => Math.max(1, (viewport?.rows || 30) - 9);

export function assertMissionHistory(document, missionId) {
  if (!missionId || document?.schemaVersion !== 'operator-studio.iteration-evaluation-export/v1'
    || document.report?.schemaVersion !== 'operator-studio.iteration-evaluation/v1'
    || document.report?.missionId !== missionId || !Array.isArray(document.records)
    || document.records.some(record => record?.missionId !== missionId)
    || typeof document.markdown !== 'string') {
    throw Object.assign(new Error('轨迹回执与当前 Mission 不一致，请重新读取。'), { code: 'MISSION_HISTORY_IDENTITY_MISMATCH' });
  }
  return document;
}

export function missionHistoryLines(document, section = 0) {
  const report = document?.report;
  if (!report) return ['尚未读取轨迹'];
  const reliability = report.reliability || {};
  const efficiency = report.efficiency || {};
  const mission = list(document.records).find(record => record.kind === 'mission')?.data;
  const best = mission?.currentBest;
  const bestDecision = selectEvidenceDecision({ missionId: report.missionId, candidateId: best?.candidateId,
    candidateDigest: best?.candidateDigest, runId: best?.evidenceRunId }, best?.evidenceDecision);
  if (section === 0) return [
    `记录覆盖：${value(report.source?.coverage?.status)} · 先前历史：${value(report.source?.coverage?.priorHistory)}`,
    `生成 ${value(reliability.generationRuns)} 次 · 测试终态 ${value(reliability.tests?.terminal)} / ${value(reliability.tests?.total)}`,
    `测试状态：${pairs(reliability.tests?.byStatus)}`,
    `已观测进步：${pairs(efficiency.observedGateProgress)}`,
    `采用资格：${pairs(efficiency.adoptionEligibility)}`,
    bestDecision ? `当前最佳 ${value(best.candidateId)} · 测试 ${value(best.evidenceRunId)} · 主场景 ${value(best.value)}` : '当前最佳：暂无绑定证据，不能宣称最优',
    '主场景最优不代表所有 shape 都更快；各场景见性能页。',
    `Token：${value(efficiency.tokenUsage?.totalTokens)} · 费用：${value(efficiency.tokenUsage?.cost?.value)}`,
    `Token 已观测 ${value(efficiency.tokenUsage?.observedRuns)} 次 · 未知 ${value(efficiency.tokenUsage?.unknownRuns)} 次`,
    ...Object.entries(efficiency.timing || {}).map(([stage, timing]) => `${value(stage)}：已测 ${value(timing.observed)} / 未知 ${value(timing.unknown)} · 合计 ${value(timing.sumObservedMs)} ms`),
    '阶段耗时可能重叠；测试完成不等于正确或有收益。',
    '本报告不授予发布资格。原始事实随 JSON 导出。',
  ];
  if (section === 1) {
    const records = list(document.records).filter(record => ['agent-run', 'candidate', 'round', 'test', 'decision'].includes(record.kind));
    const labels = { 'agent-run': '生成', candidate: '候选', round: '轮次', test: '测试', decision: '决策' };
    const ordered = [...records].sort((a, b) => String(a.data?.startedAt || a.data?.timestamp || a.data?.createdAt || '').localeCompare(String(b.data?.startedAt || b.data?.timestamp || b.data?.createdAt || '')));
    return ordered.length ? ordered.flatMap(record => {
      const data = record.data || {};
      return [
        `${labels[record.kind]} · ${value(record.id)} · ${value(data.status || data.resolution?.outcome)}`,
        `  轮次 ${value(data.roundId)} · 候选 ${value(data.candidateId || data.candidate?.id)} · 用途 ${value(data.purpose)}`,
        `  开始 ${value(data.startedAt)} · 结束 ${value(data.completedAt || data.finishedAt)}`,
        ...(record.kind === 'agent-run' && data.status === 'completed' && !data.error
          && data.candidateValidation?.classification === 'no_candidate_generated' && data.candidateValidation?.passed !== false ? [
          '  正常结束，未提出新候选；没有新增候选测试。',
          '  分类 ' + value(data.candidateValidation.classification),
          ...(data.summary ? ['  模型解释（未验证）：' + value(data.summary)] : []),
        ] : []),
        ...(record.kind === 'candidate' ? [
          `  生成 ${value(data.sourceRunId)} · 代码摘要 ${value(data.patchDigest)}`,
          `  改动 ${value(data.change || data.files)} · 假设 ${value(data.hypothesis)}`,
          `  决定 ${value(data.decision)} · ${value(data.decisionReason)}`,
        ] : []),
        ...(data.resolution ? [`  决策 ${value(data.resolution.outcome)} · ${value(data.resolution.reason || data.resolution.summary)}`] : []),
      ];
    }) : ['暂无生成、轮次、测试或决策记录'];
  }
  if (section === 2) return list(report.performance).length ? report.performance.flatMap(test => [
    `测试 ${value(test.runId)} · ${value(test.status)} · 基线 ${value(test.baselineRunId)}`,
    ...list(test.profiles).flatMap(profile => [
      `  ${value(profile.profile)}：候选 ${value(profile.value)} / 基线 ${value(profile.baselineValue)} ${value(profile.unit)}`,
      `  加速比 ${value(profile.speedup)} · ${list(profile.reasons).length ? profile.reasons.map(value).join('；') : '比较条件见导出'}`,
      `  候选波动：采样 ${value(profile.variation?.samples)} · p95 ${value(profile.variation?.p95)} · 标准差 ${value(profile.variation?.standardDeviation)}`,
      `  基线波动：采样 ${value(profile.baselineVariation?.samples)} · p95 ${value(profile.baselineVariation?.p95)} · 标准差 ${value(profile.baselineVariation?.standardDeviation)}`,
    ]),
  ]) : ['暂无候选性能测量；未运行不记为零耗时或零收益'];
  if (section === 3) {
    const memory = report.memory || {};
    return [
      `经验模式 ${value(memory.mode)} · 条件 ${value(memory.condition)}`,
      `发送前审计：一致 ${value(memory.preparedConsistentRuns)} / 未知 ${value(memory.unknownRuns)} / 冲突 ${value(memory.conflictingRuns)}`,
      `初始快照 ${value(memory.binding?.initialSnapshotDigest)}`,
      `实验清单 ${value(memory.binding?.manifestDigest)}`,
      `积累链 ${value(memory.chainId)}`,
      '审计一致不代表模型已使用经验，也不证明优化收益。',
      ...list(memory.runs).flatMap(run => [
        `运行 ${value(run.runId)} · ${value(run.status)}`,
        `  ${value(run.memoryUse?.condition)} · 库版本 ${value(run.memoryUse?.repositoryRevision)} · 选择 ${Array.isArray(run.memoryUse?.selected) ? run.memoryUse.selected.map(item => `${value(item.id)} v${value(item.version)}`).join(', ') || '无可选记录' : '未知'}`,
        `  必要反馈：${run.memoryUse?.roundFacts ? run.memoryUse.roundFacts.required ? run.memoryUse.roundFacts.present ? '已准备' : '缺失' : '首轮不需要' : '未知'} · ${list(run.reasons).map(value).join('；') || '审计原因见导出'}`,
      ]),
    ];
  }
  const failures = [
    ...list(reliability.generationFailures).flatMap(item => [
      `生成 ${value(item.runId)} · ${item.timedOut ? '生成超时' : value(item.error?.code || item.status)} · ${value(item.error?.message || item.error?.detail || item.candidateValidation?.reason)}`,
      ...(item.providerRetries ? [`  通道重试 ${value(item.providerRetries.count)} 次 · 最近 HTTP ${value(item.providerRetries.lastStatusCode)}`] : []),
    ]),
    ...list(reliability.failures).map(item => `测试 ${value(item.runId)} · ${value(item.failureClass)} · ${value(item.error?.code || item.status)} · ${value(item.error?.message)}`),
    ...list(reliability.budgetExhaustions).map(item => `预算 ${value(item.timestamp)} · ${value(item.type)}`),
    ...list(reliability.assistanceRequests).map(item => `待人工处理 ${value(item.timestamp)} · ${value(item.payload?.reason)}`),
    ...(reliability.workflowFailure ? [`流程 ${value(reliability.workflowFailure.code)} · ${value(reliability.workflowFailure.message)}`] : []),
  ];
  return [`测试资源未确认释放：${value(reliability.tests?.releaseUnconfirmed)}`, ...failures.length ? failures : ['已记录范围内无故障；历史覆盖范围见总览']];
}
