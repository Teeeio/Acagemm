import { loadProductionState, rootDir, testerHome } from './production-api.mjs';
import { selectEvidenceDecision } from './workflow-summary.mjs';
import { formatExactTokenCount } from '../../client-runtime/token-usage.mjs';
import { normalizeOperatorLanguage } from '../../client-runtime/operator-language.mjs';
import { createMissionDraft, deriveMissionForm } from './mission-form.mjs';
import { inspectRoundBudget } from '../../client-runtime/round-budget-contract.mjs';
import { generationPreparationFailureFor } from '../../client-runtime/generation-preparation.mjs';
import { feedbackText } from './operation-feedback.mjs';
import { resourceReleaseBarrier, pendingMissionResources } from '../../client-runtime/cancellation-contract.mjs';
import { normalizeAcceptancePolicy } from '../../client-runtime/business-acceptance.mjs';

export { rootDir };
export const homeDir = testerHome;

export const loadTuiState = async () => {
  const snapshot = await loadProductionState();
  const activeMissionId = snapshot.state?.activeMissionId || snapshot.mission?.id || null;
  if (!activeMissionId) return { ...snapshot, tasks: [] };
  return {
    ...snapshot,
    tasks: (snapshot.tasks || []).filter((task) => {
      const taskMissionId = task.payload?.missionId || task.missionId || null;
      return taskMissionId === activeMissionId;
    }),
  };
};

const value = (input, fallback = '--') => input == null || input === '' ? fallback : input;
const eventLabel = (event) => `${event.createdAt || event.time || '--'} ${event.type || event.title || 'event'}`;

export const missionTargetLabel = (mission = {}) => {
  const hardware = mission?.hardware;
  return Array.isArray(hardware) ? hardware.join(', ') || '--' : typeof hardware === 'string' && hardware ? hardware : '--';
};

const evidenceReference = (evidence) => evidence && typeof evidence === 'object'
  ? [evidence.missionId && `mission ${evidence.missionId}`, evidence.candidateId && `candidate ${evidence.candidateId}`,
    (evidence.patchDigest || evidence.candidateDigest) && `digest ${evidence.patchDigest || evidence.candidateDigest}`, evidence.runId && `run ${evidence.runId}`,
    evidence.taskId && `task ${evidence.taskId}`, evidence.operation && `operation ${evidence.operation}`].filter(Boolean).join(' · ') || '未记录证据身份'
  : '未记录证据身份';

// Selection is an application-produced audit, not a second retrieval policy.
// Never display an earlier Mission/round's selected records as this round's input.
const feedbackExperienceLines = (iteration, mission, recovery) => {
  if (recovery?.status === 'blocked' && recovery.missionId === mission.id
    && recovery.failure?.details?.type === 'settle-pending-candidate') {
    return [`测试经验：反馈写入待核实 · ${recovery.failure.details.cause || recovery.failure.code || '恢复被阻止'}`];
  }
  const feedback = iteration.pendingFeedback || iteration.lastPendingContinuation;
  if (!feedback || feedback.missionId !== mission.id) return [];
  const collection = feedback.experienceCollection;
  const binding = collection?.binding;
  const keys = ['manifestDigest', 'candidateId', 'patchDigest', 'sourceRunId', 'roundId', 'taskId', 'testRunId'];
  if (collection?.source !== 'pending-feedback' || binding?.missionId !== mission.id || binding.projectId !== mission.projectId
    || keys.some(key => !feedback[key] || binding[key] !== feedback[key])) return ['测试经验：未记录可核对的写入结果'];
  if (collection.status === 'skipped') return [`测试经验：未入库 · ${collection.code || '原因未记录'}`];
  if (collection.status !== 'recorded') return ['测试经验：写入结果未知'];
  return [`测试经验：新增 ${collection.recorded ?? '--'} · 已有 ${collection.existing ?? '--'} · test ${binding.testRunId}`,
    ...(collection.records || []).filter(record => record.id).map(record => `  ${record.id} v${record.version ?? '--'} · ${record.status}`)];
};

export const roundExperienceLines = ({ state = {}, mission = null } = {}) => {
  const active = mission || {};
  const iteration = state.iterationStats || active.iterationStats || {};
  const selection = iteration.roundExperienceSelection;
  const context = iteration.roundExperience;
  const projectId = active.projectId || state.activeProjectId;
  const currentMission = active.id && projectId && (!state.activeMissionId || state.activeMissionId === active.id);
  const collectionLines = currentMission ? feedbackExperienceLines(iteration, active, state.workflowRecovery?.commandRecovery) : [];
  const status = iteration.roundExperienceStatus;
  const preparationFailure = generationPreparationFailureFor(state);
  const boundStatus = currentMission && status?.missionId === active.id && status.projectId === projectId && status.roundId
    && ((preparationFailure?.roundBudget.roundId === status.roundId && status.status === 'failed')
      || (iteration.roundBudget?.roundId ? iteration.roundBudget.roundId === status.roundId : !context || context.roundId === status.roundId));
  if (boundStatus && status.status === 'failed') return [
    `本轮经验 (Round experience): 读取失败 · ${status.error?.code || '原因未记录'}`,
    status.error?.message || '读取失败已阻止依赖该经验的新一轮生成。', ...collectionLines,
  ];
  if (boundStatus && status.status === 'preparing') return ['本轮经验 (Round experience): 正在读取', ...collectionLines];
  if (!selection || selection.schemaVersion !== 'operator-studio.experience-selection/v1'
    || !active.id || (state.activeMissionId && state.activeMissionId !== active.id)
    || selection.missionId !== active.id || !projectId || selection.projectId !== projectId
    || !selection.roundId || !Array.isArray(selection.selected)
    || (iteration.roundBudget?.roundId && iteration.roundBudget.roundId !== selection.roundId)
    || (context && (context.missionId !== active.id || context.projectId !== projectId
      || context.roundId !== selection.roundId || context.contextId !== selection.contextId))) return ['本轮经验 (Round experience): 尚无本轮读取记录', ...collectionLines];
  const attribution = selection.targetAttribution || (boundStatus ? status : null);
  const targetUnknown = attribution?.reasonCode === 'ROUND_EXPERIENCE_TARGET_UNRESOLVED'
    || (context?.scope && !context.scope.architecture?.length);
  const targetLines = attribution?.targetBasis === 'configured'
    ? [`检索目标：${attribution.target.hardware.join(', ')} / ${attribution.target.architecture.join(', ')} · 用户声明，未经实测确认`,
      `目标配置版本：${attribution.targetProfile?.schemaVersion || '未记录'}`]
    : attribution?.targetBasis === 'observed' ? [`检索目标：本 Mission 实测 · ${(attribution.target?.hardware || []).join(', ')} / ${(attribution.target?.architecture || []).join(', ') || '架构未知'}`]
      : attribution?.targetBasis === 'explicit-scope' ? ['检索目标：显式查询范围，未经实测确认']
        : attribution?.targetBasis === 'declared' ? ['检索目标：任务声明值；尚无实际硬件观察'] : [];
  if (targetUnknown) targetLines.push('目标架构未知：架构专属经验暂不匹配；仍可开发，通用经验按原规则检索。');
  if (attribution?.capabilityCatalog) targetLines.push(`能力目录版本：${attribution.capabilityCatalog.revision} · 静态登记，不代表后端已连接`);
  const condition = selection.experienceCondition;
  const empty = context && selection.repositoryRevision === 0 && context.repositoryRevision === 0;
  const summary = condition === 'facts-only' ? '仅使用必要反馈 · 可选经验已关闭'
    : selection.selected.length ? `已选 ${selection.selected.length} 条`
      : empty ? '读取正常 · 经验库为空'
        : targetUnknown ? '读取正常 · 目标架构未知 · 未选中经验'
          : selection.exclusionReasonsRecorded === true ? '读取正常 · 没有适用经验'
          : '未选中经验 · 原因未记录';
  return [
    `本轮经验 (Round experience): ${summary}`,
    ...collectionLines,
    ...targetLines,
    `${selection.selected.length} selected · round ${selection.roundId} · context ${selection.contextId || '--'} · 库版本 ${selection.repositoryRevision ?? '--'}`,
    ...selection.selected.flatMap((item) => {
      const record = context?.items?.find((record) => record.id === item.id && record.version === item.version);
      return [
        `${item.id} v${item.version ?? '--'} · source ${item.source || '--'} · use ${item.useAs || '--'} · reason ${item.reason || '未记录'}`,
        `  evidence: ${evidenceReference(record?.evidence)}`,
      ];
    }),
    ...(selection.exclusionReasonsRecorded === true && Array.isArray(selection.excluded)
      ? selection.excluded.map((item) => `excluded ${item.id || '--'} · reason ${item.reason || '未记录'}`)
      : ['排除原因未记录 (Exclusion reasons not recorded)']),
  ];
};

export const projectExperienceLines = (result = {}) => {
  const records = Array.isArray(result?.experiences) ? result.experiences : [];
  return records.length ? records.flatMap((record) => [
    `${record.id || '--'} v${record.version ?? '--'} · ${record.title || '--'}`,
    `  source ${record.source || '--'} · verification ${record.verification?.status || 'unknown'}`,
    `  evidence: ${evidenceReference(record.evidence)}`,
    `  ${record.content || '--'}`,
  ]) : ['暂无项目经验 (No project experiences)'];
};

const EXECUTION_KIND_LABELS = Object.freeze({ live: 'live', simulation: 'simulation', cpu: 'cpu', unknown: 'unknown' });

// Read-only view of the versioned evidence decision. Publication/adoption are
// never inferred from `publishable` or `liveHardware`; a missing decision stays
// unknown. `legacyKind` only reads explicit provenance strings for historical
// reports that predate the decision contract.
const legacyExecutionKind = (environments = []) => {
  const sources = environments
    .filter(Boolean)
    .map((environment) => String(environment.source || environment.executionMode || '').toLowerCase())
    .filter(Boolean);
  if (sources.some((source) => source.includes('simulat') || source.includes('mock') || source.includes('fixture'))) return 'simulation';
  if (sources.some((source) => source.includes('cpu-e2e') || source === 'cpu' || source.includes('-cpu'))) return 'cpu';
  const declared = sources.filter((source) => !['unknown', 'unavailable', 'none', 'null', 'n/a', 'na', 'undefined'].includes(source));
  return declared.length ? 'live' : null;
};

const evidenceProjection = ({ state = {}, mission = null, benchmark = {}, best = {}, tasks = [] }) => {
  const review = state.decisionReview || mission?.decisionReview || {};
  const benchmarkCandidate = benchmark.candidate || {};
  const benchmarkCandidateId = benchmarkCandidate.id || state.appliedCandidateId || null;
  const candidateEvaluations = Array.isArray(state.candidateEvaluations) ? state.candidateEvaluations : [];
  const appliedCandidate = candidateEvaluations.find((candidate) => candidate.id === benchmarkCandidateId) || {};
  const currentIdentity = {
    candidateId: benchmarkCandidateId,
    candidateDigest: benchmarkCandidate.digest || appliedCandidate.patchDigest || null,
    runId: benchmark.runId || null,
  };
  const bestIdentity = {
    candidateId: best.candidateId || null,
    candidateDigest: best.candidateDigest || best.digest || null,
    runId: best.evidenceRunId || best.runId || null,
  };
  // Only a decision bound to this benchmark candidate/run, or to this
  // currentBest candidate, is projected; nothing is defaulted across
  // candidates and a missing decision stays unknown.
  const current = selectEvidenceDecision(
    currentIdentity,
    benchmark.evidenceDecision,
    review.gate?.decision,
    appliedCandidate.acceptGate?.decision,
  );
  const bestDecision = selectEvidenceDecision(bestIdentity, best.evidenceDecision, best.acceptGate?.decision)
    || (bestIdentity.candidateId ? selectEvidenceDecision(bestIdentity, current) : null);
  return {
    current,
    best: bestDecision,
    legacyKind: legacyExecutionKind([benchmark.result?.environment, ...tasks.map((task) => task?.result?.environment)]),
  };
};

const publicationNote = (publication = {}) => publication.status === 'allowed'
  ? '可发布'
  : publication.status === 'waiting_external_verification'
    ? '待外部验证'
    : '不可发布';

const executionEvidenceText = (evidence = {}) => {
  const decision = evidence.current || evidence.best || null;
  if (decision) {
    const parts = [EXECUTION_KIND_LABELS[decision.execution.kind] || decision.execution.kind];
    if (decision.execution.source) parts.push(`source ${decision.execution.source}`);
    if (decision.publication.status !== 'allowed') parts.push(publicationNote(decision.publication));
    return parts.join(' · ');
  }
  if (evidence.legacyKind) return evidence.legacyKind;
  return 'unknown（无版本化决策）';
};

const statusWithReasons = (status = 'unknown', reasons = []) => `${status}${reasons.length ? ` · ${reasons.join(', ')}` : ''}`;

const hardTerminalStatuses = new Set(['completed', 'published', 'archived', 'failed', 'cancelled']);
const completedTaskStatuses = new Set(['completed', 'failed', 'cancelled']);

const taskPurpose = (task = {}) => task.payload?.purpose || task.request?.purpose || task.purpose || null;
const taskCandidate = (task = {}) => task.payload?.candidate || task.request?.candidate || task.candidate || {};
const taskMeasurement = (task = {}) => task.result?.benchmark?.[0] || null;
const candidateNumber = (id, fallback = 0) => Number(String(id || '').match(/(\d+)(?!.*\d)/)?.[1] || fallback);
const candidateTaskIdentity = (task, index) => {
  const candidate = taskCandidate(task);
  return candidate.id || candidate.digest || task.taskId || task.id || `candidate-task-${index}`;
};
const logicalCandidateTasks = (tasks = []) => {
  const latestByCandidate = new Map();
  tasks.forEach((task, index) => {
    if (taskPurpose(task) !== 'candidate') return;
    const identity = candidateTaskIdentity(task, index);
    const previous = latestByCandidate.get(identity);
    const attempts = [...(previous?.attempts || []), task];
    latestByCandidate.set(identity, { task, identity, attempts });
  });
  return [...latestByCandidate.values()]
    .sort((left, right) => String(left.task.submittedAt || '').localeCompare(String(right.task.submittedAt || '')))
    .map(({ task, attempts }) => ({ ...task, tuiAttemptCount: attempts.length, tuiAttempts: attempts }));
};
const normalizedStatus = (status, fallback = 'pending') => {
  const input = String(status || '').toLowerCase();
  if (['complete', 'completed', 'published', 'adopted', 'eligible'].includes(input)) return 'completed';
  if (['running', 'executing', 'awaiting_action', 'waiting', 'queued', 'cancel_requested'].includes(input)) return 'running';
  if (['failed', 'timed_out', 'cancelled', 'needs_human'].includes(input)) return 'failed';
  if (['reference', 'rejected'].includes(input)) return 'rejected';
  return fallback;
};

const node = (id, title, owner, status = 'pending', detail = '') => ({ id, title, owner, status, detail });

const elapsedLabel = (startedAt) => {
  const started = startedAt ? new Date(startedAt).getTime() : NaN;
  if (!Number.isFinite(started)) return '--';
  const seconds = Math.max(0, Math.floor((Date.now() - started) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${seconds % 60}s`;
};

const latestAgentActivity = (agent = {}) => {
  const statusLabel = (status) => ({ running: '运行中', waiting: '等待中', completed: '已完成', failed: '失败', warning: '需注意' })[status] || status || '运行中';
  if (agent.status === 'running' && agent.activity?.summary) {
    return `${statusLabel(agent.activity.status)} · ${agent.activity.name || '智能体'} · ${agent.activity.summary}`;
  }
  const tools = agent.toolCalls || [];
  const tool = [...tools].reverse().find((item) => ['running', 'waiting'].includes(item.status)) || tools.at(-1);
  if (tool) return `${statusLabel(tool.status)} · ${tool.name || tool.toolId || '工具'} · ${tool.summary || '处理中'}`;
  const message = (agent.messages || []).at(-1);
  const launchOnly = message && /(?:Mission|Session).*(?:已启动|started)/i.test(message.title || '') && /\bRun\s+\S+/i.test(message.detail || '');
  if (agent.status === 'running' && launchOnly) return agent.phase || '智能体正在分析，尚未调用工具';
  if (message) return `${message.title || message.phase || '消息'} · ${message.detail || message.status || '已接收'}`;
  return agent.phase || 'waiting for first runtime event';
};

const queueLine = (task = {}) => {
  const candidate = taskCandidate(task);
  const identity = candidate.id || (taskPurpose(task) === 'baseline' ? 'baseline' : '--');
  const cache = taskMeasurement(task)?.correctness?.referenceCache || task.error?.correctness?.referenceCache;
  const cacheDetail = cache?.enabled ? ` · ref-cache ${cache.hits}/${cache.hits + cache.misses} hit` : '';
  const error = task.error?.correctness?.failedCaseName
    ? ` · FAIL ${task.error.correctness.failedCaseName}`
    : task.error?.message ? ` · ${task.error.message}` : '';
  return `${task.taskId || task.id || '--'} · ${taskPurpose(task) || '--'} / ${identity} · ${task.status || 'waiting'} ${Number(task.progress || 0)}%${cacheDetail}${error}`;
};

const queueEntries = (tasks = []) => [...tasks]
  .sort((left, right) => {
    const leftActive = completedTaskStatuses.has(left.status) ? 1 : 0;
    const rightActive = completedTaskStatuses.has(right.status) ? 1 : 0;
    return leftActive - rightActive || String(right.submittedAt || '').localeCompare(String(left.submittedAt || ''));
  })
  .slice(0, 4)
  .map((task) => {
    const cache = taskMeasurement(task)?.correctness?.referenceCache || task.error?.correctness?.referenceCache;
    const note = task.error?.correctness?.failedCaseName ? `FAIL ${task.error.correctness.failedCaseName}` : task.error?.message || '';
    return {
      key: task.taskId || task.id,
      line: queueLine(task),
      status: task.status,
      // Structured fields for column rendering; `line` stays the text contract.
      purpose: taskPurpose(task),
      identity: taskCandidate(task).id || (taskPurpose(task) === 'baseline' ? 'baseline' : task.taskId || task.id || '--'),
      progress: Number(task.progress || 0),
      cache: cache?.enabled ? `${cache.hits}/${cache.hits + cache.misses}` : '',
      note,
    };
  });

export const deriveSemanticAlignment = ({ state = {}, mission = null } = {}) => {
  const active = mission || {};
  const snapshot = active.semanticSnapshot || state.semanticSnapshot || null;
  const testSpec = snapshot?.testSpec || active.testMatrix?.testSpec || state.testMatrix?.testSpec || {};
  const correctness = testSpec.correctness || {};
  const benchmark = testSpec.benchmark || {};
  const conflicts = Array.isArray(snapshot?.conflicts) ? snapshot.conflicts : [];
  const unknowns = Array.isArray(snapshot?.unknowns) ? snapshot.unknowns : [];
  const uncovered = Array.isArray(snapshot?.correctnessContract?.uncovered) ? snapshot.correctnessContract.uncovered : [];
  const unresolvedConflicts = conflicts.filter((item) => item?.resolved !== true && item?.status !== 'resolved' && item?.blocking !== false && String(item?.severity || 'blocking') !== 'warning');
  const unresolvedUnknowns = unknowns.filter((item) => item?.resolved !== true && item?.accepted !== true && item?.status !== 'accepted' && item?.blocking !== false);
  const blockers = [...unresolvedConflicts.map((item) => `conflict:${item.field || 'unknown'}`), ...unresolvedUnknowns.map((item) => `unknown:${item.field || item.value || 'unknown'}`), ...uncovered.map((item) => `uncovered:${item}`)];
  const status = snapshot?.status || 'missing';
  const frozen = status === 'frozen';
  const ready = blockers.length === 0 && Boolean(snapshot?.semanticContract?.operator || active.operator || active.title);
  return {
    status,
    statusLabel: frozen ? 'FROZEN' : ready ? 'READY TO FREEZE' : snapshot ? 'ALIGNMENT REQUIRED' : 'NO SNAPSHOT',
    snapshotId: snapshot?.snapshotId || '--',
    digest: snapshot?.digest || '--',
    digestShort: snapshot?.digest ? String(snapshot.digest).replace(/^sha256:/, '').slice(0, 12) : '--',
    operator: snapshot?.semanticContract?.operator || active.operator || active.title || '--',
    correctnessCases: Number(correctness.requestedCases || active.testMatrix?.correctnessCases || 0),
    correctnessCategories: Array.isArray(correctness.requiredCategories) ? correctness.requiredCategories : [],
    benchmarkProfiles: Array.isArray(benchmark.requiredProfiles) ? benchmark.requiredProfiles : [],
    primaryProfile: benchmark.primaryProfile || '--',
    blockers,
    frozen,
    ready,
  };
};

// Read frozen policy through the existing public normalizer. This formats
// configuration only; it does not evaluate a candidate or change a Gate.
export const missionAcceptanceSummary = mission => {
  const spec = mission?.testMatrix?.testSpec, benchmark = spec?.benchmark;
  if (!benchmark?.primaryProfile || !Array.isArray(benchmark.requiredProfiles) || !benchmark.requiredProfiles.includes(benchmark.primaryProfile)) return {
    mode: 'unknown', shortText: '验收策略未知', lines: ['冻结验收策略未知；不能把必测场景视为保护场景。'],
  };
  let policy;
  try { policy = normalizeAcceptancePolicy(spec.acceptancePolicy, benchmark); }
  catch { return { mode: 'unknown', shortText: '验收策略未知', lines: ['冻结验收策略无效或版本未知；不能宣称已启用回退保护。'] }; }
  const requiredProfiles = [...(benchmark.requiredProfiles || [])], primaryProfile = benchmark.primaryProfile;
  if (!policy) return { mode: 'primary-only', primaryProfile, requiredProfiles,
    shortText: 'primary-only · 未启用回退保护', lines: [
      '冻结验收：primary-only · 主场景 ' + primaryProfile,
      '回退保护：未启用；必测场景不等于保护场景。',
      '必测场景：' + requiredProfiles.join('、'),
      '其他场景退化不会自动阻止采用；采用不代表所有 shape 提速。',
    ] };
  const percent = Number((policy.maxRegressionFraction * 100).toFixed(6));
  return { mode: 'protected', primaryProfile, requiredProfiles, protectedProfiles: policy.protectedProfiles,
    maxRegressionPercent: percent, shortText: '已启用回退保护 · 允许退化 ' + percent + '%', lines: [
      '冻结验收：保护场景策略 · 主场景 ' + primaryProfile,
      '必测场景：' + requiredProfiles.join('、'),
      '保护场景：' + policy.protectedProfiles.join('、') + ' · 允许延迟退化 ≤ ' + percent + '%',
      '策略来自本 Mission 的冻结配置；采用与目标是否达到仍读取原判定。',
    ] };
};

export const generationOutcome = ({ state = {}, mission = null, tasks = [] } = {}) => {
  const agent = state.agent || mission?.agent || {};
  const noCandidate = Boolean(mission?.id && (!state.activeMissionId || state.activeMissionId === mission.id)
    && (!agent.missionId || agent.missionId === mission.id) && agent.runId && agent.status === 'completed'
    && !agent.error && agent.candidateValidation?.classification === 'no_candidate_generated'
    && agent.candidateValidation?.passed !== false);
  const runs = new Set([...(state.runHistory || mission?.runHistory || [])
    .filter(run => !run.missionId || run.missionId === mission?.id).map(run => run.runId),
    !agent.missionId || agent.missionId === mission?.id ? agent.runId : null].filter(Boolean));
  const measured = tasks.filter(task => (task.payload?.missionId || task.missionId) === mission?.id
    && taskPurpose(task) === 'candidate' && task.status === 'completed' && Number.isFinite(taskMeasurement(task)?.value));
  const latest = [...measured].sort((a, b) => String(b.completedAt || b.submittedAt || '').localeCompare(String(a.completedAt || a.submittedAt || '')))[0];
  const baseline = state.baseline || mission?.baseline || {};
  const baselineTask = tasks.find(task => taskPurpose(task) === 'baseline' && task.payload?.missionId === mission?.id
    && task.payload?.requestId === baseline.evidence?.runId);
  const candidate = taskCandidate(latest);
  const bound = Boolean(latest?.payload?.requestId && candidate.id && candidate.digest
    && latest.result?.environment?.candidateDigest === candidate.digest);
  const baselineCandidate = taskCandidate(baselineTask);
  const baselineBound = baselineTask?.status === 'completed' && baselineCandidate.id && baselineCandidate.digest
    && baselineTask.result?.environment?.candidateDigest === baselineCandidate.digest
    && Number.isFinite(baseline.evidence?.value) && taskMeasurement(baselineTask)?.value === baseline.evidence.value
    && taskMeasurement(baselineTask)?.unit === taskMeasurement(latest)?.unit;
  const sameSemantics = Boolean(bound && baselineBound && baselineTask?.payload?.semanticBinding?.semanticDigest
    && baselineTask.payload.semanticBinding.semanticDigest === latest.payload?.semanticBinding?.semanticDigest);
  return { noCandidate, runId: agent.runId || null, recordedGenerations: runs.size, measuredCandidates: measured.length,
    summary: noCandidate ? feedbackText(agent.result?.summary || '') : '',
    latestMeasurement: bound ? { candidateId: candidate.id, candidateDigest: candidate.digest, runId: latest.payload.requestId,
      value: taskMeasurement(latest).value, unit: taskMeasurement(latest).unit || '未知',
      baselineValue: sameSemantics ? baseline.evidence?.value ?? null : null,
      baselineRunId: sameSemantics ? baseline.evidence?.runId || null : null } : null };
};

export const operationalDetailLines = view => {
  const outcome = view?.generationOutcome, release = view?.resourceRelease, budget = view?.roundClock;
  return [
    ...(view?.hasMission ? view.acceptanceSummary?.lines || [] : []),
    ...(outcome?.noCandidate ? ['本次生成正常结束，未提出新候选；未新增候选测试。',
      '已记录生成 ' + outcome.recordedGenerations + ' 次 · 候选已测 ' + outcome.measuredCandidates + ' 次（不含基线）',
      '生成运行 ' + outcome.runId,
      ...(outcome.latestMeasurement ? ['最近实测 ' + outcome.latestMeasurement.candidateId + ' · ' + outcome.latestMeasurement.value + ' ' + outcome.latestMeasurement.unit,
        '测试运行 ' + outcome.latestMeasurement.runId,
        outcome.latestMeasurement.baselineRunId ? '同任务基线 ' + outcome.latestMeasurement.baselineValue + ' ' + outcome.latestMeasurement.unit + ' · ' + outcome.latestMeasurement.baselineRunId : '基线比较绑定未知；完整判定见 I 场景性能。'] : []),
      ...(outcome.summary ? ['模型解释（未验证，不代表性能上限）：', outcome.summary] : []),
      '本次没有新增 accepted best；查看 I 的原测量和判定，不会自动重跑或续预算。'] : []),
    ...(view?.paused ? ['暂停只停止后续推进；已经开始的工作未被此操作取消。', '原轮次和 Mission 时钟仍继续；恢复不会续期。'] : []),
    ...(budget?.tracked ? ['原轮次截止 ' + budget.deadlineAt,
      budget.expired ? '原轮次已到期；不能通过恢复或重试延长。' : '原轮次剩余 ' + Math.ceil(budget.remainingMs / 1000) + ' 秒'] : []),
    ...(view?.missionDeadline ? ['原 Mission 截止 ' + view.missionDeadline] : []),
    '资源状态：' + (view?.resourceState === 'confirmed' ? '已确认释放' : view?.resourceState === 'active' ? '仍有在途执行资源' : view?.resourceState === 'pending' ? '释放未确认，操作受阻' : view?.resourceState === 'historical_unconfirmed' ? '历史退出仍未确认；当前没有执行资源屏障' : '未知，不能宣称已释放'),
    ...(release?.nextAction ? ['资源下一步：' + feedbackText(release.nextAction)] : []),
    ...(release?.resources || []).map(resource => '资源 ' + (resource.kind || '未知') + ' / ' + (resource.id || '未知') + ' · ' + (resource.status || '未知') + (resource.reason ? ' · ' + feedbackText(resource.reason) : '')),
    ...Object.entries(view?.actionBlocks || {}).map(([action, reason]) => (action === 'resume' ? '恢复' : '从候选另建任务') + '不可用：' + reason),
    'S 通过原 API 请求停止并核对释放；队列 0 项运行中不等于全部执行资源退出。',
  ];
};

export const deriveWorkflowTopology = ({ state = {}, mission = null, tasks = [] } = {}) => {
  const active = mission || {};
  const events = state.runtimeEvents || [];
  const baseline = state.baseline || {};
  const research = state.researchAgent || {};
  const materializer = baseline.materializer || {};
  const candidateTasks = logicalCandidateTasks(tasks);
  const baselineTask = tasks.find((task) => taskPurpose(task) === 'baseline');
  const baselineMeasurement = taskMeasurement(baselineTask);
  const baselineValue = Number(baseline.evidence?.value ?? baselineMeasurement?.value);
  const rollbackEvents = events.filter((event) => event.type === 'workflow.round_rolled_back');
  const rollbackIds = new Set(rollbackEvents.map((event) => event.payload?.candidateId).filter(Boolean));
  const gateEvents = events.filter((event) => event.type === 'accept_gate.evaluated');
  const adoptedId = state.currentBest?.candidateId || null;

  const candidates = candidateTasks.map((task, index) => {
    const candidate = taskCandidate(task);
    const id = candidate.id || `candidate-${String(index + 1).padStart(2, '0')}`;
    const measurement = taskMeasurement(task);
    const numericValue = Number(measurement?.value);
    const improvement = Number.isFinite(baselineValue) && baselineValue !== 0 && Number.isFinite(numericValue)
      ? ((baselineValue - numericValue) / baselineValue) * 100
      : null;
    const gate = gateEvents.find((event) => (event.payload?.candidate || event.payload?.candidateId) === id)?.payload
      || gateEvents[index]?.payload
      || null;
    const rolledBack = rollbackIds.has(id);
    const adopted = adoptedId === id;
    const candidateDecision = selectEvidenceDecision(
      { candidateId: candidate.id || null, candidateDigest: candidate.digest || null, runId: task.payload?.requestId || null },
      gate?.decision,
      candidate.acceptGate?.decision,
    );
    let gateStatus = 'pending';
    let disposition = task.status === 'running' ? 'testing' : task.status || 'pending';
    if (rolledBack) {
      gateStatus = 'rejected';
      disposition = 'rollback complete';
    } else if (candidateDecision) {
      // Versioned decision wins over the flat Gate booleans.
      if (candidateDecision.adoption.status === 'allowed') {
        gateStatus = 'passed';
        disposition = 'adopted';
      } else if (candidateDecision.adoption.status === 'reference') {
        gateStatus = 'rejected';
        disposition = 'reference';
      } else if (candidateDecision.adoption.status === 'waiting_external_verification') {
        gateStatus = 'pending';
        disposition = 'waiting external verification';
      } else {
        gateStatus = 'rejected';
        disposition = 'blocked';
      }
    } else if (adopted) {
      gateStatus = 'passed';
      disposition = 'adopted';
    } else if (gate?.passed === true || gate?.result === 'eligible') {
      gateStatus = 'passed';
      disposition = 'eligible';
    } else if (gate?.passed === false || gate?.result === 'reference') {
      gateStatus = 'rejected';
      disposition = 'reference';
    } else if (['failed', 'cancelled'].includes(task.status)) {
      gateStatus = 'hard failure';
      disposition = task.status;
    }
    return {
      key: candidateTaskIdentity(task, index),
      taskId: task.taskId || task.id || null,
      round: candidateNumber(id, index + 1),
      id,
      digest: candidate.digest || null,
      taskStatus: task.status || 'pending',
      progress: Number(task.progress || 0),
      attempt: Number(task.tuiAttemptCount || 1),
      value: Number.isFinite(numericValue) ? `${numericValue} ${measurement?.unit || 'us'}` : '--',
      improvement: improvement == null ? '--' : `${improvement >= 0 ? '+' : ''}${improvement.toFixed(0)}%`,
      gate: gateStatus,
      disposition,
      rolledBack,
      adopted,
    };
  });

  const pendingValidation = state.iterationStats?.pendingValidation || active.iterationStats?.pendingValidation;
  const waitingCandidate = pendingValidation?.missionId === active.id && pendingValidation?.status === 'awaiting_backend' ? pendingValidation : null;
  const pendingTest = waitingCandidate && state.iterationStats?.pendingTest?.manifestDigest === waitingCandidate.manifestDigest ? state.iterationStats.pendingTest : null;
  const generationOnly = active.executionMode === 'generate-only';
  const agentWorking = ['running'].includes(state.agent?.status);
  const diffReady = state.agent?.status === 'awaiting_action';
  const agentActive = agentWorking || diffReady;
  const baselineReady = baseline.status === 'complete' || baselineTask?.status === 'completed';
  const latestTask = candidateTasks.at(-1) || null;
  const latestTaskTerminal = latestTask && completedTaskStatuses.has(latestTask.status);
  const latestCandidateRound = candidates.reduce((maximum, candidate) => Math.max(maximum, Number(candidate.round || 0)), 0);
  const nextRound = Math.max(latestCandidateRound, Number(state.iterationStats?.round || 0) + 1, 1);
  if (!waitingCandidate && agentActive && (baselineReady || generationOnly) && (!latestTask || latestTaskTerminal) && !['completed', 'published'].includes(active.status)) {
    const activeCandidate = {
      key: `generating-${nextRound}`,
      taskId: null,
      round: nextRound,
      id: `candidate-${String(nextRound).padStart(2, '0')}`,
      digest: null,
      taskStatus: diffReady ? 'diff_ready' : 'generating',
      progress: Number(state.agent?.progress || 0),
      attempt: Math.max(1, Number(state.iterationStats?.currentRoundCorrectnessAttempts || 0) + 1),
      value: '--',
      improvement: '--',
      gate: 'pending',
      disposition: diffReady ? 'Diff ready' : Number(state.iterationStats?.currentRoundCorrectnessAttempts || 0) > 0 ? 'correctness repair' : 'Agent working',
      rolledBack: false,
      adopted: false,
    };
    const existingIndex = candidates.findIndex((item) => item.round === nextRound);
    if (existingIndex >= 0) candidates[existingIndex] = { ...candidates[existingIndex], ...activeCandidate, key: candidates[existingIndex].key };
    else candidates.push(activeCandidate);
  }

  if (waitingCandidate && pendingTest?.status !== 'settled') {
    const existingIndex = candidates.findIndex(item => item.id === waitingCandidate.candidateId && item.digest === waitingCandidate.patchDigest);
    const frozenRow = { ...(existingIndex >= 0 ? candidates[existingIndex] : {}), key: waitingCandidate.candidateId, id: waitingCandidate.candidateId,
      taskId: pendingTest?.candidate?.taskId || null, round: Number(state.iterationStats?.round || 0) + 1,
      digest: waitingCandidate.patchDigest, taskStatus: pendingTest?.status || 'awaiting_backend', progress: null,
      attempt: 1, value: existingIndex >= 0 ? candidates[existingIndex].value : '--', improvement: '--',
      gate: pendingTest?.candidate ? 'feedback_pending' : 'untested',
      disposition: pendingTest?.status || 'awaiting_backend', rolledBack: false, adopted: false };
    if (existingIndex >= 0) candidates[existingIndex] = frozenRow;
    else candidates.push(frozenRow);
  }

  const sourceVerified = Boolean(baseline.source?.repository && baseline.source?.commit && baseline.source?.path);
  const sourceVerifyDetail = sourceVerified
    ? baseline.source?.transportMode === 'mirror'
      ? `mirror pin ${String(baseline.source.commit).slice(0, 8)} / tree ${String(baseline.source.tree || '').slice(0, 8)}`
      : `canonical ${String(baseline.source.commit).slice(0, 8)}`
    : 'pending';
  const setup = [
    node('research', 'SOURCE RESEARCH', 'Agent', normalizedStatus(research.status), research.status === 'completed' ? 'source found' : research.phase || 'waiting'),
    node('verify', 'SOURCE VERIFY', 'Fixed', sourceVerified ? 'completed' : research.status === 'completed' ? 'running' : 'pending', sourceVerifyDetail),
    node('materializer', 'MATERIALIZER', 'Agent', normalizedStatus(materializer.status), materializer.status === 'completed' ? 'run.py ready' : materializer.phase || 'pending'),
    node('baseline', 'BASELINE TEST', 'Fixed', normalizedStatus(baselineTask?.status || (baseline.status === 'complete' ? 'completed' : baseline.status)), baselineMeasurement ? `${baselineMeasurement.value} ${baselineMeasurement.unit || 'us'}` : baseline.status || 'pending'),
  ];

  const current = candidates.at(-1) || null;
  const currentTask = current ? candidateTasks.find((task) => (task.taskId || task.id) === current.taskId)
    || candidateTasks.find((task) => taskCandidate(task).id === current.id)
    : null;
  const testStatus = normalizedStatus(currentTask?.status);
  const candidateStatus = current?.taskStatus === 'generating' ? 'running' : ['diff_ready', 'awaiting_backend'].includes(current?.taskStatus) ? 'completed' : currentTask ? 'completed' : 'pending';
  const gateStatus = current?.gate === 'passed' ? 'completed' : current?.gate === 'rejected' || current?.gate === 'hard failure' ? 'rejected' : 'pending';
  const iterationNodes = {
    candidate: node('candidate', current ? `CANDIDATE ${current.round}` : 'CANDIDATE', 'Agent', candidateStatus, current?.digest ? current.digest.replace('sha256:', '').slice(0, 10) : latestAgentActivity(state.agent)),
    test: node('test', 'TEST', 'Fixed', testStatus, currentTask?.status === 'running' ? `queue ${currentTask.progress || 0}%` : current?.value || 'pending'),
    gate: node('gate', 'ACCEPT GATE', 'Fixed', gateStatus, current?.gate || 'target pending'),
    adopt: node('adopt', 'ADOPT', 'Fixed', current?.adopted ? 'completed' : 'pending', current?.adopted ? 'patch committed' : 'pending'),
    rollback: node('rollback', 'ROLLBACK', 'Fixed', current?.rolledBack ? 'completed' : 'pending', current?.rolledBack ? 'workspace clean' : `Candidate ${Number(current?.round || 0) + 1}`),
  };

  let currentNode = { title: 'WAITING', owner: 'Fixed', status: 'pending', progress: 0, detail: 'Publish a Mission to start', meta: '' };
  const researchBlocksMain = ['running', 'cancel_requested'].includes(research.status)
    && (research.synchronous === true || (research.synchronous !== false && baseline.status !== 'complete'));
  if (researchBlocksMain) currentNode = { title: 'SOURCE RESEARCH', owner: 'Agent', status: normalizedStatus(research.status), progress: Number(research.progress || 0), detail: research.phase || 'discovering source', meta: research.runPhase || '' };
  else if (materializer.status && materializer.status !== 'completed') currentNode = { title: 'BASELINE MATERIALIZER', owner: 'Agent', status: normalizedStatus(materializer.status), progress: Number(materializer.progress || 0), detail: materializer.phase || 'building run.py', meta: materializer.runId || '' };
  else if (baselineTask && !completedTaskStatuses.has(baselineTask.status)) currentNode = { title: 'BASELINE TEST', owner: 'Fixed', status: normalizedStatus(baselineTask.status), progress: Number(baselineTask.progress || 0), detail: baselineTask.status, meta: baselineTask.taskId || '' };
  else if (current?.taskStatus === 'generating') currentNode = { title: `AGENT RUN · CANDIDATE ${current.round}`, owner: 'Agent', status: 'running', progress: null, progressMode: 'activity', detail: latestAgentActivity(state.agent), meta: `${state.agent?.runId || 'run pending'} · events ${Number(state.agent?.eventCount || 0)} · elapsed ${elapsedLabel(state.agent?.startedAt)}` };
  else if (current?.taskStatus === 'diff_ready') currentNode = { title: `DIFF READY · CANDIDATE ${current.round}`, owner: 'Fixed', status: 'completed', progress: 100, detail: state.agent?.candidateValidation?.passed === false ? 'Diff rejected' : 'Diff verified; waiting for patch apply', meta: state.agent?.runId || '' };
  else if (currentTask && !completedTaskStatuses.has(currentTask.status)) currentNode = { title: 'CANDIDATE TEST', owner: 'Fixed', status: testStatus, progress: Number(currentTask.progress || 0), detail: currentTask.status, meta: currentTask.taskId || '' };
  else if (current?.adopted) currentNode = { title: 'ADOPT', owner: 'Fixed', status: 'completed', progress: 100, detail: `${current.id} adopted`, meta: current.value };
  else if (state.iterationStats?.loopStatus === 'needs_human') currentNode = { title: 'ACTION REQUIRED', owner: 'Fixed', status: 'failed', progress: 100, detail: state.iterationStats.loopStatusReason || 'human input required', meta: '' };
  else if (current?.rolledBack) currentNode = { title: 'ROLLBACK', owner: 'Fixed', status: 'completed', progress: 100, detail: `${current.id} restored`, meta: 'workspace clean' };
  else if (currentTask?.status === 'completed') currentNode = { title: 'ACCEPT GATE', owner: 'Fixed', status: gateStatus === 'pending' ? 'running' : gateStatus, progress: 100, detail: current?.gate || 'evaluating', meta: current?.value || '' };
  const generation = generationOutcome({ state, mission: active, tasks });
  if (generation.noCandidate) currentNode = { title: 'NO NEW CANDIDATE', owner: 'Agent', status: 'completed', progress: null,
    detail: '生成正常结束；未新增候选测试', meta: generation.runId };
  if (waitingCandidate) currentNode = { title: 'WAITING FOR TEST BACKEND', owner: 'Fixed', status: 'pending', progress: null, progressMode: 'activity',
    detail: '候选已冻结，尚未测试；按 T 提交测试，按 E 导出源码包',
    meta: `${waitingCandidate.candidateId} · ${String(waitingCandidate.manifestDigest || '').slice(0, 18)}` };
  if (pendingTest) currentNode = { ...currentNode,
    title: pendingTest.status === 'baseline_running' ? 'BASELINE TEST' : pendingTest.status === 'candidate_running' ? 'TEST' : 'FROZEN TEST RESULT',
    status: /_running$/.test(pendingTest.status) ? 'running' : ['failed', 'blocked', 'cancelled'].includes(pendingTest.status) ? 'failed' : 'pending',
    detail: pendingTest.status === 'settled' ? '评价已记录；继续生成前会重新核对工作区与剩余预算'
      : pendingTest.error?.message || (pendingTest.status === 'results_ready' ? '结果已保存，等待反馈处理；工作区后续编辑不影响本次测试' : '基线与候选按冻结副本串行测试，可切换或保存其他任务'),
    meta: pendingTest.status, progress: null, progressMode: 'activity' };

  return {
    setup,
    candidates,
    recentCandidates: candidates.slice(-5),
    earlierCount: Math.max(0, candidates.length - 5),
    currentRound: current?.round || 0,
    currentNode,
    iterationNodes,
  };
};

const topologyIcon = (status) => ({ completed: '✓', running: '●', rejected: '×', failed: '×', pending: '·' }[status] || '·');
const fit = (input, width) => String(input ?? '').length > width ? `${String(input).slice(0, Math.max(0, width - 1))}…` : String(input ?? '').padEnd(width);

export const renderWorkflowTopologySnapshot = (snapshot = {}) => {
  const topology = deriveWorkflowTopology(snapshot);
  const setup = topology.setup.map((item) => `${topologyIcon(item.status)} ${item.title} [${item.owner === 'Agent' ? 'A' : 'F'}] (${item.detail || item.status})`).join(' -> ');
  const rows = topology.recentCandidates.map((candidate) => [
    String(candidate.round).padStart(5),
    fit(candidate.id, 16),
    String(candidate.attempt || 1).padStart(3),
    fit(candidate.value, 10),
    fit(candidate.improvement, 12),
    fit(candidate.gate, 14),
    candidate.disposition,
  ].join('  '));
  const flowNode = (item) => `${topologyIcon(item.status)} ${item.title} [${item.owner === 'Agent' ? 'A' : 'F'}]`;
  const flow = `${flowNode(topology.iterationNodes.candidate)} -> ${flowNode(topology.iterationNodes.test)} -> ${flowNode(topology.iterationNodes.gate)} -> { ${flowNode(topology.iterationNodes.adopt)} | ${flowNode(topology.iterationNodes.rollback)} }`;
  const progress = Math.max(0, Math.min(100, Number(topology.currentNode.progress || 0)));
  const filled = Math.round(progress / 5);
  return [
    `Workflow Topology · Round ${topology.currentRound || '--'}`,
    `  ${setup}`,
    '',
    'Recent Candidates',
    'Round  Candidate         Try  Result      Improvement   Gate            Disposition',
    ...(topology.earlierCount ? [`  ...  ${topology.earlierCount} earlier candidates`] : []),
    ...(rows.length ? rows : ['    --  No candidate generated']),
    '',
    `Current  ${topologyIcon(topology.currentNode.status)} ${topology.currentNode.title} [${topology.currentNode.owner === 'Agent' ? 'A' : 'F'}]${topology.currentNode.progressMode === 'activity' ? '' : `  ${progress}%`}`,
    topology.currentNode.progressMode === 'activity'
      ? `         ${topology.currentNode.detail} · ${topology.currentNode.meta}`
      : `         ${'█'.repeat(filled)}${'░'.repeat(20 - filled)}  ${topology.currentNode.detail}`,
    `Flow     ${flow}`,
  ].join('\n');
};

export const deriveTuiViewModel = ({ state = {}, mission = null, tasks = [] } = {}) => {
  const active = mission || {};
  const iteration = state.iterationStats || active.iterationStats || {};
  const benchmark = state.benchmark || active.benchmark || {};
  const benchmarkTask = benchmark.testTaskId ? tasks.find((task) => (task.taskId || task.id) === benchmark.testTaskId) : null;
  const workflowFailure = state.workflowFailure || active.workflowFailure || null;
  const materializer = state.baseline?.materializer || active.baseline?.materializer || {};
  const research = state.researchAgent || active.researchAgent || {};
  // Retain the last diagnostic in state, but do not present an old run as the current blocker.
  const currentWorkflowFailure = workflowFailure?.phase !== 'baseline.materializer'
    || (iteration.loopStatus === 'needs_human' && iteration.loopStatusReason === 'baseline_materializer_failed'
      && Boolean(workflowFailure.details?.runId)
      && workflowFailure.details?.missionId === (state.activeMissionId || active.id || null)
      && workflowFailure.details?.runId === (materializer.runId || null)
      && workflowFailure.details?.startedAt === (materializer.startedAt || null)
      && workflowFailure.details?.materializerStatus === materializer.status)
    ? workflowFailure : null;
  // A recorded baseline.source failure stays persisted for diagnostics, but only
  // the current unresolved research run may be displayed as the active blocker.
  const currentSourceFailure = workflowFailure?.phase !== 'baseline.source'
    || (iteration.loopStatus === 'needs_human' && iteration.loopStatusReason === 'baseline_source_unresolved'
      && Boolean(workflowFailure.details?.runId)
      && workflowFailure.details?.missionId === (state.activeMissionId || active.id || null)
      && (!research.missionId || research.missionId === (state.activeMissionId || active.id || null))
      && workflowFailure.details?.runId === (research.runId || null)
      && workflowFailure.details?.startedAt === (research.startedAt || null)
      && workflowFailure.details?.researchStatus === (research.status || null)
      && workflowFailure.details?.runPhase === (research.runPhase || null));
  const visibleWorkflowFailure = currentWorkflowFailure && currentSourceFailure ? currentWorkflowFailure : null;
  const failure = benchmark.lastServiceError
    || benchmarkTask?.error
    || state.baseline?.error
    || visibleWorkflowFailure
    || null;
  const failureMessage = failure?.message ? String(failure.message) : '';
  const failureCode = failure?.code ? String(failure.code) : '';
  const best = state.currentBest || active.currentBest || {};
  const loopStatus = iteration.loopStatus || null;
  const missionStatus = active.status || 'idle';
  const hasMission = Boolean(active.id);
  const pendingValidation = iteration.pendingValidation?.missionId === active.id && iteration.pendingValidation?.status === 'awaiting_backend' ? iteration.pendingValidation : null;
  const pendingTest = pendingValidation && iteration.pendingTest?.manifestDigest === pendingValidation.manifestDigest ? iteration.pendingTest : null;
  const pendingFeedback = pendingValidation && iteration.pendingFeedback?.manifestDigest === pendingValidation.manifestDigest ? iteration.pendingFeedback : null;
  const generationAlreadyStarted = active.executionMode === 'generate-only'
    && Boolean(state.agent?.runId || active.agent?.runId || state.runHistory?.length || active.runHistory?.length);
  const paused = state.missionPaused === true || loopStatus === 'paused_budget' || loopStatus === 'stopped';
  const needsHuman = loopStatus === 'needs_human' || missionStatus === 'needs_human';
  const terminal = hardTerminalStatuses.has(missionStatus) || ['completed', 'failed', 'cancelled'].includes(loopStatus);
  const candidateTasks = logicalCandidateTasks(tasks);
  const hasCandidateActivity = candidateTasks.length > 0
    || Boolean(best.candidateId)
    || Boolean(benchmark.candidate?.id)
    || Number(iteration.round || 0) > 0;
  const activeCandidateRound = ['running', 'awaiting_action'].includes(state.agent?.status)
    || candidateTasks.some((task) => !completedTaskStatuses.has(task.status))
    || (state.stage === 'validation' && benchmark.status === 'running' && state.baseline?.status === 'complete');
  const latestCandidateOrdinal = candidateTasks.reduce((maximum, task, index) => Math.max(maximum, candidateNumber(taskCandidate(task).id, index + 1)), 0);
  const displayedRounds = Math.max(latestCandidateOrdinal, Number(iteration.round || 0) + (activeCandidateRound ? 1 : 0));
  const activeTasks = tasks.filter((task) => !completedTaskStatuses.has(task.status)).length;
  const queue = queueEntries(tasks);
  const currentActivity = latestAgentActivity(state.agent || {});
  const evidence = evidenceProjection({ state, mission: active, benchmark, best, tasks });
  const activeDecision = evidence.current || evidence.best || null;
  const business = activeDecision?.businessAcceptance;
  const businessCandidateId = activeDecision?.binding?.candidateId;
  const businessOutcome = business ? {
    candidateId: businessCandidateId, correctUsable: business.correctUsable === true,
    protectedProfilesPassed: business.protectedProfilesPassed === true, targetReached: business.targetReached === true,
    retainedAsBest: Boolean(businessCandidateId && best.candidateId === businessCandidateId),
    adopted: Boolean(businessCandidateId && best.candidateId === businessCandidateId && best.retainedAs === 'accepted'),
  } : null;
  const executionKind = activeDecision?.execution.kind || evidence.legacyKind || 'unknown';
  const simulation = executionKind === 'simulation';

  let statusLabel = missionStatus;
  if (needsHuman) statusLabel = 'needs_human';
  else if (loopStatus === 'stopped') statusLabel = 'stopped';
  else if (state.missionPaused === true || loopStatus === 'paused_budget') statusLabel = 'paused';
  else if (loopStatus === 'failed' || loopStatus === 'cancelled') statusLabel = loopStatus;
  else if (loopStatus === 'completed') statusLabel = 'completed';
  if (pendingValidation && loopStatus !== 'stopped') statusLabel = pendingTest?.status || 'awaiting_backend';

  let banner = 'READY / create or import a Mission';
  if (needsHuman) banner = `ACTION REQUIRED / ${iteration.loopStatusReason || 'human input required'}${failureCode ? ` · ${failureCode}` : ''}`;
  else if (paused) banner = `PAUSED / ${iteration.loopStatusReason || 'operator pause'}`;
  else if (terminal) banner = `${missionStatus === 'failed' || loopStatus === 'failed' ? 'FAILED' : 'COMPLETED'}${executionKind === 'simulation' ? ' / simulation only' : executionKind === 'cpu' ? ' / cpu only' : ''}`;
  else if (benchmark.status === 'running') banner = `TESTING / ${benchmark.progress ?? 0}%`;
  else if (['running', 'executing', 'awaiting_action'].includes(state.agent?.status)) banner = `AGENT / ${state.agent?.phase || 'working'}`;
  else if (hasMission) banner = `ACTIVE / ${state.stage || active.stage || missionStatus}`;
  if (pendingValidation && loopStatus !== 'stopped') banner = `WAITING FOR TEST BACKEND / 候选已冻结 · 未测试${['round_budget', 'total_budget', 'round_budget_invalid'].includes(iteration.loopStatusReason) ? ' · 原预算已阻塞，不会自动续期' : ''}`;
  if (pendingTest && loopStatus !== 'stopped') {
    const pendingLabels = { baseline_running: '基线测试中', baseline_complete: '基线已完成，准备候选测试',
      candidate_running: '候选测试中', results_ready: '测试结果已保存，等待反馈处理', failed: '测试失败，候选已保留',
      cancelled: '测试已取消，候选已保留', blocked: '测试推进受阻，候选已保留',
      settled: pendingFeedback?.status === 'ready' ? '评价已记录，可继续下一轮生成' : `评价已记录，当前不能继续：${pendingFeedback?.reason || '请查看结果'}` };
    banner = `FROZEN CANDIDATE / ${pendingLabels[pendingTest.status] || pendingTest.status}${pendingTest.error?.message ? ` · ${pendingTest.error.message}` : ''}`;
  }
  const freshAttempt = active.attemptOrigin && paused && !generationAlreadyStarted && !pendingValidation;
  if (freshAttempt) banner = `已保存 / 从 ${active.attemptOrigin.missionId} 的冻结候选建立 · 按 Space 开始生成`;
  const generation = generationOutcome({ state, mission: active, tasks });
  if (generation.noCandidate && !needsHuman && !pendingValidation) banner = '未提出新候选 / 本次生成已结束，未新增测试';
  else if (paused && !needsHuman && !pendingValidation) banner += ' · 原时钟仍计时';
  const releaseBarrier = resourceReleaseBarrier(state);
  const pendingResources = pendingMissionResources(state);
  const release = releaseBarrier || state.workflowRecovery?.resourceRelease || null;
  const resourceState = releaseBarrier ? 'pending' : pendingResources.length ? 'active' : release?.confirmed === true ? 'confirmed' : release?.confirmed === false ? 'historical_unconfirmed' : 'unknown';
  const originalRound = inspectRoundBudget(state);
  const missionExpired = Number.isFinite(state.missionBudgetMs) && state.missionBudgetMs > 0
    && Date.now() >= Date.parse(state.missionBudgetStartedAt) + state.missionBudgetMs;

  const actions = {
    publish: true,
    pause: hasMission && !terminal && !needsHuman && !paused,
    resume: hasMission && !terminal && !pendingValidation && !generationAlreadyStarted && !releaseBarrier && (paused || needsHuman),
    feedback: hasMission && !terminal && !pendingValidation && active.executionMode !== 'generate-only',
    doctor: true,
    experiences: Boolean(active.projectId || state.activeProjectId),
    history: hasMission,
    details: hasMission,
    stop: hasMission && !terminal && loopStatus !== 'stopped',
    export: hasMission,
    exportBest: hasMission,
    submitTest: Boolean(pendingValidation && !pendingTest && !terminal && !needsHuman && !['stopped', 'paused_budget'].includes(loopStatus)),
    settleTest: Boolean(pendingTest?.candidate && ['results_ready', 'failed', 'cancelled'].includes(pendingTest.status) && !pendingFeedback),
    continueGeneration: Boolean(pendingFeedback?.status === 'ready' && !needsHuman && !terminal && loopStatus !== 'stopped'),
    newAttempt: Boolean(pendingValidation && !activeTasks && !pendingMissionResources(state).length && !resourceReleaseBarrier(state)
      && state.workflowRecovery?.commandRecovery?.status !== 'blocked'
      && originalRound.status !== 'invalid' && (originalRound.expired || missionExpired)),
    quit: true,
  };
  const actionBlocks = {};
  if (hasMission && releaseBarrier) actionBlocks.resume = releaseBarrier.reason || '等待执行资源确认释放';
  if (pendingValidation && !actions.newAttempt) actionBlocks.newAttempt = releaseBarrier || pendingResources.length || activeTasks
    ? '先等待原执行资源释放；队列空不等于 Agent 已退出'
    : state.workflowRecovery?.commandRecovery?.status === 'blocked' ? '命令恢复尚受阻'
      : originalRound.status === 'invalid' || !originalRound.tracked ? '原轮次时钟缺失或无效，需核对' : '原预算尚未到期；保留当前冻结候选';
  const missionStarted = Date.parse(state.missionBudgetStartedAt);
  const missionDeadline = Number.isFinite(missionStarted) && Number.isFinite(state.missionBudgetMs) && state.missionBudgetMs > 0
    ? new Date(missionStarted + state.missionBudgetMs).toISOString() : null;
  const hotkeys = [
    '[M] Missions',
    actions.details && '[H] 状态说明',
    actions.exportBest && '[B] 最佳源码',
    actions.publish && '[P] Create',
    actions.pause && '[Space] Pause',
    actions.resume && (freshAttempt ? '[Space] 开始生成' : '[Space] Resume'),
    actions.submitTest && '[T] Submit test',
    actions.settleTest && '[F] Receive results',
    actions.continueGeneration && '[R] Next generation',
    actions.newAttempt && '[A] 从候选另建任务',
    actions.feedback && '[N] Feedback',
    actions.doctor && '[D] Doctor',
    actions.experiences && '[K] Experiences',
    actions.history && '[I] 轨迹评价',
    actions.stop && '[S] Stop',
    actions.export && '[E] Export',
    '[Q] Quit',
  ].filter(Boolean);

  return { actions, activeTasks, actionBlocks, banner, businessOutcome, acceptanceSummary: missionAcceptanceSummary(mission), generationOutcome: generation, resourceRelease: release, resourceState, roundClock: originalRound, missionDeadline, currentActivity, displayedRounds, evidence: { ...evidence, executionKind, source: evidence.current ? 'benchmark.evidenceDecision' : evidence.best ? 'currentBest.evidenceDecision' : evidence.legacyKind ? 'legacy-explicit-source' : 'none' }, failure: failure ? { code: failureCode || 'TASK_FAILED', message: failureMessage || '任务执行失败' } : null, hasMission, hotkeys, needsHuman, paused, queue, simulation, statusLabel, terminal };
};

export const resolveDashboardCommand = ({ input = '', key = {}, viewModel, busy = false } = {}) => {
  const actions = viewModel?.actions || {};
  if (key.escape || input === 'q') return 'quit';
  if (busy) return null;
  if (input === 'm') return 'missions';
  if (input === 'p' && actions.publish) return 'publish';
  if (input === 'd' && actions.doctor) return 'doctor';
  if (input === 'k' && actions.experiences) return 'experiences';
  if (input === 'i' && actions.history) return 'history';
  if (input === 'h' && actions.details) return 'details';
  if (input === 'n' && actions.feedback) return 'feedback';
  if (input === 's' && actions.stop) return 'stop';
  if (input === 'e' && actions.export) return 'export';
  if (input === 'b' && actions.exportBest) return 'exportBest';
  if (input === 't' && actions.submitTest) return 'submitTest';
  if (input === 'f' && actions.settleTest) return 'settleTest';
  if (input === 'r' && actions.continueGeneration) return 'continueGeneration';
  if (input === 'a' && actions.newAttempt) return 'newAttempt';
  if (input === ' ' && actions.resume) return 'resume';
  if (input === ' ' && actions.pause) return 'pause';
  return null;
};

export const businessOutcomeText = outcome => outcome
  ? ['正确 ' + (outcome.correctUsable ? '可用' : '未确认'),
    '保留最佳 ' + (outcome.retainedAsBest ? '是' : '否'),
    '采纳 ' + (outcome.adopted ? '是' : '否'),
    '目标 ' + (outcome.targetReached ? '达到' : '未达')].join(' · ') : '';

export const renderDashboardSnapshot = ({ state = {}, mission = null, health = {}, tasks = [] }) => {
  const active = mission || {};
  const best = state.currentBest || active.currentBest || {};
  const benchmark = state.benchmark || active.benchmark || {};
  const iteration = state.iterationStats || active.iterationStats || {};
  const events = (state.runtimeEvents || []).slice(-6).reverse();
  const view = deriveTuiViewModel({ state, mission, tasks });
  const tokenUsage = state.tokenUsage || active.tokenUsage || {};
  const tokens = formatExactTokenCount(tokenUsage.totalTokens || 0);
  const tokenCoverage = tokenUsage.coverage || '0/0 runs exact';
  const implementation = normalizeOperatorLanguage(active.implementation);
  const semantic = deriveSemanticAlignment({ state, mission: active });
  const displayDecision = view.evidence?.current || view.evidence?.best || null;
  const bestDecision = view.evidence?.best || null;
  return [
    'Operator Studio',
    `  backend     ${health.testBackend?.kind || '--'}${health.testBackend?.mock ? ' (simulation)' : ''}`,
    `  target      ${missionTargetLabel(active)}`,
    '  cloud       not deployed / 云端测试未部署',
    `  api         ${health.__bridge?.apiUrl || '--'}`,
    `  workflow    ${view.banner}`,
    `  tokens      ${tokens} · ${tokenCoverage}`,
    '',
    'Current Mission',
    `  id          ${active.id || '--'}`,
    `  title       ${active.title || 'No mission published'}`,
    `  goal        ${active.goal || '--'}`,
    `  status      ${view.statusLabel}`,
    `  stage       ${state.stage || active.stage || '--'}`,
    `  agent       ${state.agent?.status || '--'} / ${state.agent?.phase || '--'}`,
    `  loop        ${iteration.loopStatus || '--'}${iteration.loopStatusReason ? ` / ${iteration.loopStatusReason}` : ''}`,
    `  rounds      ${view.displayedRounds}`,
    `  language    ${implementation.label}`,
    `  test spec   ${active.testMatrix?.testSpec?.schemaVersion || '--'}`,
    `  semantics   ${semantic.statusLabel} · ${semantic.operator} · digest ${semantic.digestShort}`,
    `  test map    correctness ${semantic.correctnessCases || '--'} [${semantic.correctnessCategories.join(', ') || '--'}] · benchmark ${semantic.primaryProfile}`,
    ...(semantic.blockers.length ? [`  blockers    ${semantic.blockers.join(', ')}`] : []),
    '',
    renderWorkflowTopologySnapshot({ state, mission, tasks }),
    '',
    'Evidence',
    `  baseline    ${state.baseline?.status || '--'} / ${state.baseline?.kind || '--'}`,
    `  benchmark   ${benchmark.status || '--'}${benchmark.progress != null ? ` ${benchmark.progress}%` : ''}`,
    `  decision    ${displayDecision ? `${displayDecision.schemaVersion}${displayDecision.policyVersion ? ` · ${displayDecision.policyVersion}` : ''} · ${view.evidence.source}` : 'unknown · 无版本化决策'}`,
    `  execution   ${executionEvidenceText(view.evidence)}`,
    ...(view.businessOutcome ? [`  business    ${businessOutcomeText(view.businessOutcome)} · ${view.businessOutcome.candidateId}`] : []),
    // Compatibility projection for pre-decision records only; it is never used
    // when a versioned decision exists and never authorizes publication.
    ...(displayDecision ? [] : [`  live device ${benchmark.result?.environment?.liveHardware === true ? 'yes' : benchmark.result?.environment?.source === 'simulation' ? 'simulation' : '--'}`]),
    `  correctness ${displayDecision ? (displayDecision.correctness.passed ? 'passed' : 'failed') : 'unknown（无版本化决策）'}`,
    `  bench valid ${displayDecision ? (displayDecision.benchmark.valid ? 'valid' : 'invalid') : 'unknown（无版本化决策）'}`,
    `  adoption    ${displayDecision ? statusWithReasons(displayDecision.adoption.status, displayDecision.adoption.reasons) : 'unknown（无版本化决策）'}`,
    `  publication ${displayDecision ? statusWithReasons(displayDecision.publication.status, displayDecision.publication.reasons) : 'unknown · 不可发布（无版本化决策）'}`,
    ...(view.failure ? [`  error       ${view.failure.code}: ${view.failure.message}`] : []),
    `  task        ${benchmark.testTaskId || '--'}`,
    `  queue       ${view.activeTasks} active / ${tasks.length} total`,
    ...view.queue.map((entry) => `  queue item  ${entry.line}`),
    '',
    'Current Best',
    `  candidate   ${best.candidateId || '--'}`,
    `  value       ${value(best.value)}`,
    `  improvement ${value(best.improvement)}`,
    `  adoption    ${bestDecision ? statusWithReasons(bestDecision.adoption.status, bestDecision.adoption.reasons) : 'unknown（无版本化决策）'}`,
    `  publication ${bestDecision ? statusWithReasons(bestDecision.publication.status, bestDecision.publication.reasons) : 'unknown · 不可发布（无版本化决策）'}`,
    '',
    ...roundExperienceLines({ state, mission }),
    '',
    'Events',
    ...(events.length ? events.map((event) => `  ${eventLabel(event)}`) : ['  --']),
    '',
    view.hotkeys.join('  '),
  ].join('\n');
};

export const renderPublishSnapshot = (draft = createMissionDraft(), fieldIndex = 0, viewport = {}) => {
  const view = deriveMissionForm(draft, fieldIndex, viewport);
  return [
    'Operator Studio · 创建任务 (Create Mission)',
    '本地测试 / Local · 云端测试未部署 / Cloud not deployed',
    ...view.rows.map((row) => `${row.selected ? '>' : ' '} ${row.label}: ${row.value}`),
    `字段页 (Page) ${view.page}`, view.hint,
    `[Enter] ${view.submitLabel}  [Tab] Next field  [Esc] Cancel`,
  ].join('\n');
};
