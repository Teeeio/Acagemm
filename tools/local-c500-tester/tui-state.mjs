import { loadProductionState, rootDir, testerHome } from './production-api.mjs';
import { formatExactTokenCount } from '../../client-runtime/token-usage.mjs';
import { normalizeOperatorLanguage } from '../../client-runtime/operator-language.mjs';

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
  .map((task) => ({ key: task.taskId || task.id, line: queueLine(task), status: task.status }));

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
    let gateStatus = 'pending';
    let disposition = task.status === 'running' ? 'testing' : task.status || 'pending';
    if (rolledBack) {
      gateStatus = 'rejected';
      disposition = 'rollback complete';
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

  const agentWorking = ['running'].includes(state.agent?.status);
  const diffReady = state.agent?.status === 'awaiting_action';
  const agentActive = agentWorking || diffReady;
  const baselineReady = baseline.status === 'complete' || baselineTask?.status === 'completed';
  const latestTask = candidateTasks.at(-1) || null;
  const latestTaskTerminal = latestTask && completedTaskStatuses.has(latestTask.status);
  const latestCandidateRound = candidates.reduce((maximum, candidate) => Math.max(maximum, Number(candidate.round || 0)), 0);
  const nextRound = Math.max(latestCandidateRound, Number(state.iterationStats?.round || 0) + 1, 1);
  if (agentActive && baselineReady && (!latestTask || latestTaskTerminal) && !['completed', 'published'].includes(active.status)) {
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
  const candidateStatus = current?.taskStatus === 'generating' ? 'running' : current?.taskStatus === 'diff_ready' ? 'completed' : currentTask ? 'completed' : 'pending';
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
  const failure = benchmark.lastServiceError
    || benchmarkTask?.error
    || state.baseline?.error
    || state.workflowFailure
    || active.workflowFailure
    || null;
  const failureMessage = failure?.message ? String(failure.message) : '';
  const failureCode = failure?.code ? String(failure.code) : '';
  const best = state.currentBest || active.currentBest || {};
  const loopStatus = iteration.loopStatus || null;
  const missionStatus = active.status || 'idle';
  const hasMission = Boolean(active.id);
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
  const simulation = benchmark.result?.environment?.source === 'simulation'
    || tasks.some((task) => task.result?.environment?.source === 'simulation');

  let statusLabel = missionStatus;
  if (needsHuman) statusLabel = 'needs_human';
  else if (loopStatus === 'stopped') statusLabel = 'stopped';
  else if (state.missionPaused === true || loopStatus === 'paused_budget') statusLabel = 'paused';
  else if (loopStatus === 'failed' || loopStatus === 'cancelled') statusLabel = loopStatus;
  else if (loopStatus === 'completed') statusLabel = 'completed';

  let banner = 'READY / publish a Mission to begin';
  if (needsHuman) banner = `ACTION REQUIRED / ${iteration.loopStatusReason || 'human input required'}${failureCode ? ` · ${failureCode}` : ''}`;
  else if (paused) banner = `PAUSED / ${iteration.loopStatusReason || 'operator pause'}`;
  else if (terminal) banner = `${missionStatus === 'failed' || loopStatus === 'failed' ? 'FAILED' : 'COMPLETED'}${simulation ? ' / simulation only' : ''}`;
  else if (benchmark.status === 'running') banner = `TESTING / ${benchmark.progress ?? 0}%`;
  else if (['running', 'executing', 'awaiting_action'].includes(state.agent?.status)) banner = `AGENT / ${state.agent?.phase || 'working'}`;
  else if (hasMission) banner = `ACTIVE / ${state.stage || active.stage || missionStatus}`;

  const actions = {
    publish: true,
    pause: hasMission && !terminal && !needsHuman && !paused,
    resume: hasMission && !terminal && (paused || needsHuman),
    feedback: hasMission && !terminal,
    doctor: true,
    stop: hasMission && !terminal && loopStatus !== 'stopped',
    export: hasMission,
    quit: true,
  };
  const hotkeys = [
    actions.publish && '[P] Publish',
    actions.pause && '[Space] Pause',
    actions.resume && '[Space] Resume',
    actions.feedback && '[N] Feedback',
    actions.doctor && '[D] Doctor',
    actions.stop && '[S] Stop',
    actions.export && '[E] Export',
    '[Q] Quit',
  ].filter(Boolean);

  return { actions, activeTasks, banner, currentActivity, displayedRounds, failure: failure ? { code: failureCode || 'TASK_FAILED', message: failureMessage || '任务执行失败' } : null, hasMission, hotkeys, needsHuman, paused, queue, simulation, statusLabel, terminal };
};

export const resolveDashboardCommand = ({ input = '', key = {}, viewModel, busy = false } = {}) => {
  const actions = viewModel?.actions || {};
  if (key.escape || input === 'q') return 'quit';
  if (busy) return null;
  if (input === 'p' && actions.publish) return 'publish';
  if (input === 'd' && actions.doctor) return 'doctor';
  if (input === 'n' && actions.feedback) return 'feedback';
  if (input === 's' && actions.stop) return 'stop';
  if (input === 'e' && actions.export) return 'export';
  if (input === ' ' && actions.resume) return 'resume';
  if (input === ' ' && actions.pause) return 'pause';
  return null;
};

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
  return [
    'C500 Production Workflow Tester',
    `  backend     ${health.testBackend?.kind || '--'}${health.testBackend?.mock ? ' (simulation)' : ''}`,
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
    ...(view.failure ? [`  error       ${view.failure.code}: ${view.failure.message}`] : []),
    `  task        ${benchmark.testTaskId || '--'}`,
    `  queue       ${view.activeTasks} active / ${tasks.length} total`,
    ...view.queue.map((entry) => `  queue item  ${entry.line}`),
    `  live C500   ${benchmark.result?.environment?.liveHardware === true ? 'yes' : benchmark.result?.environment?.source === 'simulation' ? 'simulation' : '--'}`,
    '',
    'Current Best',
    `  candidate   ${best.candidateId || '--'}`,
    `  value       ${value(best.value)}`,
    `  improvement ${value(best.improvement)}`,
    '',
    'Events',
    ...(events.length ? events.map((event) => `  ${eventLabel(event)}`) : ['  --']),
    '',
    view.hotkeys.join('  '),
  ].join('\n');
};

export const renderPublishSnapshot = () => [
  'C500 Production Workflow Tester',
  '',
  'Publish Mission',
  '  Goal          Run local C500 validation',
  '  Title         optional',
  '  Project       local-c500-project',
  '  Metric        latency p50',
  '  Language      Triton (Left/Right to select)',
  '  Time budget   unlimited (milliseconds)',
  '',
  '[Enter] Publish and start  [Tab] Next field  [Esc] Cancel',
].join('\n');
