import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rename, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  addAuditEvent,
  applyOperatorTestSnapshot,
  applyCandidatePatch,
  createCurrentBestState,
  createDecisionReviewState,
  createWorkflowRecoveryState,
  createMission,
  createProject,
  createWorkspaceCheckpoint,
  ensureMissionWorkspace,
  ensureProjectLayout,
  artifactDirForMission,
  ensureStorage,
  buildBenchmarkLogsForMatrix,
  loadState,
  resetDemoData,
  rebuildMissionWorkspaceFromRepository,
  resetMissionWorkspace,
  restoreWorkspaceCheckpoint,
  runAutomaticAdoption,
  markCandidateAccepted,
  resetMissionRunState,
  runKnowledgeMaintenance,
  deleteProject,
  saveState,
  selectMission,
  selectProject,
  startAgentRun,
  updateProject,
  runtimeDir,
  workspaceDirForMission,
  workspaceFiles,
  researchDirForMission,
  createResearchAgentState,
} from './state-store.mjs';
import { agentRuntime, appendRuntimeEvent } from './agent-runtime.mjs';
import { advanceIteration, selectResearchDirection } from './iteration-loop.mjs';
import { testServiceClient } from './test-service-client.mjs';
import { createOperatorTestQueue } from './operator-test-queue.mjs';
import { workspaceManager } from './workspace-manager.mjs';
import { assertMissionIntent } from './mission-intent.mjs';
import { nativeDirectoryPicker } from './native-directory-picker.mjs';

const serverDir = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(serverDir, '..');
const distDir = path.join(rootDir, 'dist');
const serverPidPath = path.join(runtimeDir, 'operator-studio.pid');
const port = Number(process.env.API_PORT || process.env.PORT || 4173);
const serveWeb = process.env.SERVE_WEB !== 'false';
const operatorTestQueue = createOperatorTestQueue({ serviceClient: testServiceClient });

const buildRuntimePreflight = async (mission) => {
  const workspace = await ensureMissionWorkspace(mission.id, mission.repository);
  const [workspaceCheck, agentCheck] = await Promise.all([
    workspaceManager.inspect(workspace),
    agentRuntime.preflight({ workspace }),
  ]);
  if (workspaceCheck.ready && workspaceCheck.baselineEmpty) {
    workspaceCheck.ready = false;
    workspaceCheck.code = 'WORKSPACE_BASELINE_EMPTY';
    workspaceCheck.detail = 'Iteration Repository 基线为空，Mission 工作区没有可供 Agent 检查的源码或测试文件。请先把项目文件放入 repository，或重新选择包含代码的 Git 仓库。';
  }
  return {
    ready: workspaceCheck.ready && agentCheck.ready,
    missionId: mission.id,
    workspace,
    layers: {
      repository: mission.repository,
      sources: mission.sourceRoot || null,
      snapshot: workspace,
      artifacts: artifactDirForMission(mission.id, mission.repository, mission.projectRoot),
    },
    workspaceCheck,
    agentCheck,
    checkedAt: new Date().toISOString(),
  };
};

const json = (response, status, payload) => {
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  response.end(JSON.stringify(payload));
};

const directoryExists = async (target) => {
  try { return (await stat(target)).isDirectory(); } catch { return false; }
};

const resetLinkedMissionsAfterRepositoryBootstrap = async (state, project, bootstrap) => {
  const linkedMissions = state.missions.filter((mission) => mission.projectId === project.id || mission.repository === project.repository);
  project.repositoryBootstrap = bootstrap;
  project.updatedAt = new Date().toISOString();
  for (const mission of linkedMissions) {
    mission.repository = project.repository;
    mission.projectRoot = project.root;
    mission.sourceRoot = project.sourceRoot;
    mission.stage = 'diagnosis';
    mission.status = 'ready';
    mission.patchApplied = false;
    mission.candidateEvaluations = [];
    mission.benchmark = { ...(mission.benchmark || {}), status: 'idle', progress: 0, runId: null, startedAt: null, logs: [] };
    mission.workflowRecovery = createWorkflowRecoveryState(mission.id, project.repository, project.root);
    mission.agent = { ...(mission.agent || {}), status: 'idle', phase: '等待启动', progress: 0, runId: null, threadId: null, startedAt: null, currentAction: null, toolCalls: [], messages: [], artifacts: [], result: null, candidateValidation: null };
  }
  const activeMission = linkedMissions.find((mission) => mission.id === state.activeMissionId);
  if (activeMission) {
    state.stage = 'diagnosis';
    state.patchApplied = false;
    state.candidateEvaluations = [];
    state.benchmark = structuredClone(activeMission.benchmark);
    state.workflowRecovery = structuredClone(activeMission.workflowRecovery);
    state.agent = structuredClone(activeMission.agent);
  }
  addAuditEvent(state, 'Iteration Repository 基线已补齐', `${project.name} · ${bootstrap.origin || bootstrap.repository} @ ${bootstrap.head}`, 'green', 'GitBranch');
  const saved = await saveState(state);
  for (const mission of linkedMissions) await rebuildMissionWorkspaceFromRepository(mission);
  return { state: saved, linkedMissionCount: linkedMissions.length };
};

const readDirectoryListing = async (requestedPath) => {
  const target = path.resolve(requestedPath || os.homedir());
  if (!await directoryExists(target)) {
    const error = new Error('目录不存在或当前用户无权访问。');
    error.status = 404;
    throw error;
  }
  const entries = await readdir(target, { withFileTypes: true });
  return {
    path: target,
    parent: path.dirname(target) === target ? null : path.dirname(target),
    entries: entries.filter((entry) => entry.isDirectory()).map((entry) => ({ name: entry.name, path: path.join(target, entry.name) })).sort((left, right) => left.name.localeCompare(right.name, 'zh-CN')),
  };
};

const sse = (response, event, payload) => {
  if (response.destroyed || response.writableEnded) return false;
  response.write(`event: ${event}\n`);
  response.write(`data: ${JSON.stringify(payload)}\n\n`);
  return true;
};

const streamMissionEvents = async (request, response, missionId, after = 0) => {
  response.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-store, must-revalidate',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  response.flushHeaders?.();
  let closed = false;
  let busy = false;
  let nextSequence = Number.isFinite(after) ? after : 0;
  let lastRevision = '';
  let timer;

  const close = () => {
    if (closed) return;
    closed = true;
    if (timer) clearInterval(timer);
  };
  request.on('close', close);
  response.on('close', close);

  const tick = async () => {
    if (closed || busy) return;
    busy = true;
    try {
      const state = await loadRuntimeState();
      const events = (state.runtimeEvents || []).filter((event) => event.missionId === missionId && event.sequence > nextSequence);
      for (const event of events) {
        if (!sse(response, 'runtime', event)) return close();
        nextSequence = Math.max(nextSequence, event.sequence || nextSequence);
      }
      const revision = state.updatedAt || `${state.agent?.runId || ''}:${state.benchmark?.status || ''}:${state.benchmark?.progress || 0}`;
      if (revision !== lastRevision) {
        lastRevision = revision;
        if (!sse(response, 'state', { missionId, state })) return close();
      }
    } catch (error) {
      if (!closed) sse(response, 'error', { code: error.code || 'RUNTIME_STREAM_ERROR', message: error.message });
    } finally {
      busy = false;
    }
  };

  sse(response, 'ready', { missionId, nextSequence });
  await tick();
  if (!closed) timer = setInterval(tick, 500);
};

const readJson = async (request) => {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 1_000_000) {
      const error = new Error('Request body exceeds the 1 MB limit.');
      error.status = 413;
      error.code = 'REQUEST_BODY_TOO_LARGE';
      throw error;
    }
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
};

const guardMutation = (state) => {
  if (state.missionPaused) {
    const error = new Error('Mission 已暂停，请先恢复任务。');
    error.status = 409;
    throw error;
  }
};

const guardSupportedRuntimeAction = async (action) => {
  const runtime = await agentRuntime.describe();
  if (runtime.mode === 'reference-fixture') return runtime;
  // Codex owns reasoning and workspace changes; all workflow decisions remain
  // client-owned so the local harness can inspect, pause, adopt, redirect, and
  // roll back a verified candidate without asking the Agent adapter to mutate state.
  if (runtime.mode === 'codex-cli') return runtime;
  const error = new Error(`${runtime.label || 'Agent Runtime'} 尚未实现 ${action} 动作桥；已拒绝生成本地参考结果。`);
  error.status = 409;
  error.code = 'RUNTIME_ACTION_UNAVAILABLE';
  throw error;
};

const knowledgeDraftWritableFields = new Set([
  'title', 'conclusion', 'scope', 'hardware', 'operator', 'dtype', 'layout', 'shape', 'runtime',
  'trigger', 'procedure', 'expectedGain', 'validation', 'constraints', 'contraindications',
  'failedAttempts', 'evidenceLevel', 'confidence', 'evidenceRefs', 'sourceMission',
  'sourceCandidate', 'sourceCommit', 'owner',
]);

const guardWorkflowTransition = (state, { stages, actionType, label }) => {
  const stageAllowed = stages.includes(state.stage);
  const actionAllowed = !actionType || state.agent?.currentAction?.type === actionType;
  if (stageAllowed && actionAllowed) return;
  const error = new Error(`${label} 与当前 Mission 状态不一致，操作已拒绝。`);
  error.status = 409;
  error.code = 'INVALID_WORKFLOW_TRANSITION';
  throw error;
};

const interventionOutcomeMeta = {
  adopt: { label: '允许采用', expectedOutput: '确认采用并更新 current best' },
  supplement: { label: '补充验证', expectedOutput: '补充验证并重新形成证据' },
  redirect: { label: '调整优化方向', expectedOutput: '恢复候选工作区并生成新的 Candidate Plan' },
};

const adoptCandidateState = (state, note, source = 'policy') => {
  const candidateId = state.appliedCandidateId || state.decisionReview?.candidateId;
  const candidate = (state.candidateEvaluations || []).find((item) => item.id === candidateId);
  const resolvedAt = markCandidateAccepted(state, note, source);
  state.stage = 'curation';
  state.decisionReview = {
    ...(state.decisionReview || createDecisionReviewState('resolved')),
    status: 'resolved',
    recommendation: 'adopt',
    requiresApproval: false,
    resolution: { outcome: 'adopt', source, note, resolvedAt },
    resolvedAt,
  };
  const primaryMeasurement = state.benchmark?.result?.benchmark?.[0];
  state.currentBest = candidateId
    ? { candidateId, version: candidate?.version || 'agent.1', value: primaryMeasurement ? `${primaryMeasurement.value} ${primaryMeasurement.unit}` : '--', improvement: candidate?.delta || 'new', status: 'active', evidenceSource: candidate?.acceptGate?.evidenceSource || 'unknown', verified: candidate?.acceptGate?.publishable === true }
    : createCurrentBestState('candidate-02');
  state.workflowRecovery = {
    ...(state.workflowRecovery || {}),
    worktree: { ...(state.workflowRecovery?.worktree || {}), status: 'adopted', adoptedAt: resolvedAt },
    lastRecovery: null,
  };
  state.agent = { ...state.agent, status: 'executing', phase: '知识自动维护', currentAction: null };
  appendRuntimeEvent(state, 'decision.adopted', { candidate: candidateId, note, source }, { kind: 'policy', mode: 'client' });
  addAuditEvent(state, source === 'human_review' ? `审批意见已处理并采用 ${candidateId}` : `策略建议已执行并采用 ${candidateId}`, `Level 3 · ${note}`, 'green', 'CheckCircle2');
  state.knowledgeMaintenance = { ...(state.knowledgeMaintenance || {}), status: 'ready' };
  return state;
};

// 循环驱动依赖：advanceIteration 编排器通过 deps 拿到 agentRuntime 能力与目录函数。
const iterationDeps = {
  startResearch: async ({ state, mission, direction, workspace }) => {
    // 非 codex-cli 模式不支持研究员：返回 state 不变，避免循环崩溃（如 reference-fixture）。
    if (agentRuntime.mode !== 'codex-cli') return state;
    await mkdir(workspace, { recursive: true });
    const started = await agentRuntime.startResearch({ state, mission, direction, workspace });
    return started.state;
  },
  cancelResearch: async ({ state, runId }) => agentRuntime.cancelRun({ state, runId }),
  startMainRound: async ({ state, goal }) => {
    const runtimeDescriptor = await agentRuntime.describe();
    const mission = state.missions.find((item) => item.id === state.activeMissionId) || {};
    const preflight = await buildRuntimePreflight(mission);
    if (!preflight.ready) return state;
    const workspace = preflight.workspace;
    resetMissionRunState(state, goal, { referenceFixture: runtimeDescriptor.mode === 'reference-fixture' });
    if (runtimeDescriptor.mode === 'reference-fixture') await resetMissionWorkspace(state.activeMissionId);
    if (runtimeDescriptor.mode === 'codex-cli') {
      const baselineCheckpoint = await createWorkspaceCheckpoint(state.activeMissionId, 'agent-run-baseline');
      state.workflowRecovery = { ...(state.workflowRecovery || {}), checkpoints: [...(state.workflowRecovery?.checkpoints || []), baselineCheckpoint].slice(-5) };
    }
    const runtimeRun = await agentRuntime.startRun({ state, mission, goal, resumeThreadId: null, workspace });
    if (!runtimeRun.handled) {
      startAgentRun(state, goal, { reset: false });
      appendRuntimeEvent(state, 'mission.run_started', { runId: state.agent.runId, goal }, { kind: 'adapter', mode: 'reference-fixture' });
    }
    return runtimeRun.state || state;
  },
  researchDirForMission,
};

let runtimeStateInFlight = null;
const loadRuntimeState = async () => {
  if (runtimeStateInFlight) return structuredClone(await runtimeStateInFlight);
  runtimeStateInFlight = (async () => {
  const runtime = await agentRuntime.describe();
  const state = await loadState({ runtimeMode: runtime.mode });
  const projection = await agentRuntime.projectState({ ...state, runtime });
  let changed = projection.changed;
  if (projection.state.benchmark?.status === 'running' && projection.state.benchmark?.testTaskId) {
    try {
      const before = JSON.stringify(projection.state.benchmark);
      let snapshot;
      try {
        snapshot = await operatorTestQueue.get(projection.state.benchmark.testTaskId);
      } catch (error) {
        if (error.code !== 'OPERATOR_TEST_QUEUE_NOT_FOUND') throw error;
        snapshot = await testServiceClient.get(projection.state.benchmark.testTaskId);
      }
      applyOperatorTestSnapshot(projection.state, snapshot);
      if (projection.state.benchmark?.status === 'complete' && projection.state.benchmark?.result) {
        const mission = projection.state.missions.find((item) => item.id === projection.state.activeMissionId) || {};
        const artifactDir = artifactDirForMission(projection.state.activeMissionId, mission.repository, mission.projectRoot);
        await mkdir(artifactDir, { recursive: true });
        const result = projection.state.benchmark.result;
        await Promise.all([
          writeFile(path.join(artifactDir, 'benchmark.json'), `${JSON.stringify(result.benchmark || [], null, 2)}\n`, 'utf8'),
          writeFile(path.join(artifactDir, 'tracer.json'), `${JSON.stringify(result.tracer || {}, null, 2)}\n`, 'utf8'),
          writeFile(path.join(artifactDir, 'profiler.json'), `${JSON.stringify(result.profiler || {}, null, 2)}\n`, 'utf8'),
          writeFile(path.join(artifactDir, 'test-result.json'), `${JSON.stringify({ taskId: snapshot.taskId, candidate: projection.state.benchmark.candidate, result, completedAt: snapshot.completedAt }, null, 2)}\n`, 'utf8'),
        ]);
        projection.state.benchmark.artifacts = {
          root: artifactDir,
          benchmark: path.join(artifactDir, 'benchmark.json'),
          tracer: path.join(artifactDir, 'tracer.json'),
          profiler: path.join(artifactDir, 'profiler.json'),
        };
      }
      changed ||= before !== JSON.stringify(projection.state.benchmark);
    } catch (error) {
      const serviceError = { code: error.code || 'OPERATOR_TEST_SERVICE_ERROR', message: error.message, observedAt: new Date().toISOString() };
      if (projection.state.benchmark.lastServiceError?.code !== serviceError.code) {
        projection.state.benchmark.lastServiceError = serviceError;
        changed = true;
      }
    }
  }
  const mission = projection.state.missions?.find((item) => item.id === projection.state.activeMissionId);
  const candidateId = projection.state.appliedCandidateId || projection.state.decisionReview?.candidateId;
  const candidate = (projection.state.candidateEvaluations || []).find((item) => item.id === candidateId);
  const shouldAdoptThreeLayer = projection.state.agent?.runtimeKind === 'codex-cli'
    && mission?.projectRoot
    && projection.state.stage === 'evidence'
    && projection.state.benchmark?.status === 'complete'
    && projection.state.decisionReview?.status === 'auto_ready'
    && projection.state.decisionReview?.gate?.passed === true
    && candidate?.artifacts?.patch
    && !projection.state.workflowRecovery?.repositoryAdoption?.commit;
  if (shouldAdoptThreeLayer) {
    try {
      const adoption = await workspaceManager.adoptPatch({ repository: mission.repository, patchPath: candidate.artifacts.patch, candidateId });
      projection.state.workflowRecovery = { ...(projection.state.workflowRecovery || {}), repositoryAdoption: { status: 'completed', ...adoption } };
      runAutomaticAdoption(projection.state, `Accept Gate 已通过，${candidateId} 已提交到 Iteration Repository。`);
      runKnowledgeMaintenance(projection.state);
      changed = true;
    } catch (error) {
      projection.state.workflowRecovery = { ...(projection.state.workflowRecovery || {}), repositoryAdoption: { status: 'blocked', code: error.code || 'ITERATION_REPOSITORY_ADOPTION_FAILED', detail: error.message, blockedAt: new Date().toISOString() } };
      projection.state.agent = { ...projection.state.agent, status: 'failed', phase: 'Iteration Repository 采用失败', currentAction: null, messages: [...(projection.state.agent?.messages || []), { id: `repository-adoption-${Date.now()}`, phase: 'decision', status: 'waiting', title: '无法写回 Iteration Repository', detail: error.message, time: '刚刚', errorCode: error.code }] };
      appendRuntimeEvent(projection.state, 'repository.adoption_blocked', { candidate: candidateId, code: error.code, detail: error.message }, { kind: 'repository', mode: 'client' });
      changed = true;
    }
  }
  const looped = await advanceIteration(projection.state, iterationDeps);
  if (['research_timeout', 'research_injected', 'research_noted', 'round_counted', 'resumed_agent', 'research_escalated'].includes(looped.action)) changed = true;
  return changed ? saveState(projection.state) : projection.state;
  })().finally(() => { runtimeStateInFlight = null; });
  return structuredClone(await runtimeStateInFlight);
};

async function handleApi(request, response, url) {
  if (request.method === 'OPTIONS') {
    response.writeHead(204, { Allow: 'GET,POST,PATCH,DELETE,OPTIONS' });
    response.end();
    return;
  }

  if (request.method === 'GET' && url.pathname === '/api/health') {
    json(response, 200, { status: 'ok', service: 'operator-studio-client-runtime', persistence: 'local-disk', runtime: await agentRuntime.describe(), time: new Date().toISOString() });
    return;
  }
  if (request.method === 'GET' && url.pathname === '/api/runtime') {
    json(response, 200, { runtime: await agentRuntime.describe() });
    return;
  }
  if (request.method === 'GET' && url.pathname === '/api/runtime/preflight') {
    const state = await loadRuntimeState();
    const missionId = url.searchParams.get('missionId') || state.activeMissionId;
    const mission = state.missions.find((item) => item.id === missionId);
    if (!mission) {
      json(response, 404, { error: 'Mission 不存在。', code: 'MISSION_NOT_FOUND' });
      return;
    }
    const preflight = await buildRuntimePreflight(mission);
    json(response, 200, { preflight });
    return;
  }
  if (request.method === 'GET' && url.pathname === '/api/state') {
    json(response, 200, { state: await loadRuntimeState() });
    return;
  }
  if (request.method === 'GET' && url.pathname === '/api/workspace') {
    const state = await loadRuntimeState();
    const mission = state.missions.find((item) => item.id === state.activeMissionId);
    const activeWorkspace = await ensureMissionWorkspace(state.activeMissionId, mission?.repository);
    const hasDeclaredPatch = (state.candidateEvaluations || []).some((candidate) => String(candidate.files || '').trim());
    json(response, 200, { patchApplied: state.patchApplied, workspace: path.relative(rootDir, activeWorkspace).replaceAll('\\', '/'), files: hasDeclaredPatch ? workspaceFiles : [] });
    return;
  }
  if (request.method === 'GET' && url.pathname === '/api/missions') {
    const state = await loadRuntimeState();
    json(response, 200, { missions: state.missions, activeMissionId: state.activeMissionId });
    return;
  }
  if (request.method === 'GET' && url.pathname === '/api/projects') {
    const state = await loadRuntimeState();
    const projects = state.projects.map((project) => ({
      ...project,
      missionCount: state.missions.filter((mission) => mission.projectId === project.id).length,
      runningMissionCount: state.missions.filter((mission) => mission.projectId === project.id && mission.status === 'running').length,
    }));
    json(response, 200, { projects, activeProjectId: state.activeProjectId });
    return;
  }
  if (request.method === 'GET' && url.pathname === '/api/filesystem/directories') {
    json(response, 200, { directory: await readDirectoryListing(url.searchParams.get('path') || '') });
    return;
  }
  if (request.method === 'POST' && url.pathname === '/api/filesystem/select-directory') {
    const body = await readJson(request);
    json(response, 200, await nativeDirectoryPicker.select(String(body.initialPath || '')));
    return;
  }
  if (request.method === 'POST' && url.pathname === '/api/filesystem/directories') {
    const body = await readJson(request);
    const parent = path.resolve(String(body.parent || os.homedir()));
    const name = String(body.name || '').trim();
    if (!name || name === '.' || name === '..' || /[\\/:*?"<>|]/.test(name)) {
      json(response, 400, { error: '文件夹名称不能为空，且不能包含路径分隔符或系统保留字符。' });
      return;
    }
    if (!await directoryExists(parent)) {
      json(response, 404, { error: '父目录不存在或当前用户无权访问。' });
      return;
    }
    const target = path.join(parent, name);
    await mkdir(target);
    json(response, 201, { directory: await readDirectoryListing(target) });
    return;
  }
  if (request.method === 'POST' && url.pathname === '/api/projects') {
    const state = await loadRuntimeState();
    guardMutation(state);
    const body = await readJson(request);
    const requestedPath = String(body.root || '').trim();
    if (!path.isAbsolute(requestedPath)) {
      json(response, 400, { error: '项目根目录必须是本机绝对路径。' });
      return;
    }
    if (!await directoryExists(requestedPath)) {
      if (body.initializeGit !== true) {
        json(response, 404, { error: '目录不存在。请选择“创建项目结构并初始化 Git”后重试。' });
        return;
      }
      await mkdir(requestedPath, { recursive: true });
    }
    const projectRoot = requestedPath;
    const repository = path.join(projectRoot, 'repository');
    const sourceRoot = path.join(projectRoot, 'sources');
    const layout = await ensureProjectLayout({ root: projectRoot, repository, sourceRoot });
    if (!await directoryExists(repository)) await mkdir(repository, { recursive: true });
    let inspection = await workspaceManager.inspect(repository, { refresh: true });
    if (!inspection.ready && body.initializeGit === true) {
      await workspaceManager.git(['init'], repository);
      await workspaceManager.git(['config', 'user.name', 'Operator Studio'], repository);
      await workspaceManager.git(['config', 'user.email', 'operator-studio@local.invalid'], repository);
      await workspaceManager.git(['add', '-A'], repository);
      await workspaceManager.git(['commit', '--allow-empty', '-m', 'Operator Studio iteration baseline'], repository);
      inspection = await workspaceManager.inspect(repository, { refresh: true });
    }
    let bootstrap = null;
    if (String(body.gitUrl || '').trim()) {
      bootstrap = await workspaceManager.bootstrapRepository({ target: repository, source: body.gitUrl, ref: body.gitRef || body.defaultBranch || 'HEAD' });
      inspection = await workspaceManager.inspect(repository, { refresh: true });
    }
    if (!inspection.ready) {
      json(response, 400, { error: `无法登记仓库：${inspection.detail || '目录不是可用的 Git 仓库。'}`, code: inspection.code });
      return;
    }
    const project = createProject(state, { ...body, root: projectRoot, repository: inspection.gitRoot, sourceRoot, runtimeRoot: layout.runtimeRoot, layout: 'three-layer' });
    if (bootstrap) project.repositoryBootstrap = bootstrap;
    await ensureProjectLayout({ root: projectRoot, repository: inspection.gitRoot, sourceRoot, projectId: project.id });
    json(response, 201, { state: await saveState(state), project });
    return;
  }
  const projectMatch = url.pathname.match(/^\/api\/projects\/([^/]+)$/);
  const projectSelectMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/select$/);
  const projectSourcesMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/sources$/);
  const projectReinitializeMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/reinitialize$/);
  const projectBootstrapMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/bootstrap$/);
  if (request.method === 'POST' && projectBootstrapMatch) {
    const runtime = await agentRuntime.describe();
    const state = await loadState({ runtimeMode: runtime.mode, ensureWorkspace: false });
    guardMutation(state);
    const project = state.projects.find((item) => item.id === decodeURIComponent(projectBootstrapMatch[1]));
    if (!project) {
      json(response, 404, { error: '项目不存在。', code: 'PROJECT_NOT_FOUND' });
      return;
    }
    if (project.layout !== 'three-layer' || !project.root || !project.repository || !project.sourceRoot || !project.runtimeRoot) {
      json(response, 409, { error: '项目尚未初始化为严格三层结构。', code: 'PROJECT_REINITIALIZATION_REQUIRED' });
      return;
    }
    const body = await readJson(request);
    const inspection = await workspaceManager.inspect(project.repository, { refresh: true });
    if (inspection.ready && !inspection.baselineEmpty) {
      json(response, 409, { error: 'Iteration Repository 已包含代码，不能再次自动补齐基线。', code: 'ITERATION_REPOSITORY_NOT_EMPTY' });
      return;
    }
    const bootstrap = await workspaceManager.bootstrapRepository({ target: project.repository, source: body.gitUrl, ref: body.gitRef || project.defaultBranch || 'HEAD' });
    const result = await resetLinkedMissionsAfterRepositoryBootstrap(state, project, bootstrap);
    json(response, 200, { ...result, project, bootstrap });
    return;
  }
  if (request.method === 'POST' && projectReinitializeMatch) {
    const state = await loadRuntimeState();
    guardMutation(state);
    const project = state.projects.find((item) => item.id === decodeURIComponent(projectReinitializeMatch[1]));
    if (!project) {
      json(response, 404, { error: '项目不存在。', code: 'PROJECT_NOT_FOUND' });
      return;
    }
    if (project.layout === 'three-layer' && project.root && project.sourceRoot && project.runtimeRoot) {
      json(response, 409, { error: '项目已经是严格三层结构，无需重新初始化。', code: 'PROJECT_ALREADY_THREE_LAYER' });
      return;
    }
    const linkedMissions = state.missions.filter((mission) => mission.projectId === project.id || mission.repository === project.repository);
    const hasDurableResults = linkedMissions.some((mission) => mission.patchApplied
      || mission.benchmark?.status !== 'idle'
      || mission.candidateEvaluations?.length
      || mission.publishedAssets?.length);
    if (hasDurableResults) {
      json(response, 409, { error: '项目已有 Candidate、Patch、Benchmark 或发布成果，不能自动重初始化。', code: 'PROJECT_REINITIALIZATION_BLOCKED' });
      return;
    }
    const projectRoot = path.resolve(project.root || project.repository);
    if (!path.isAbsolute(projectRoot) || !await directoryExists(projectRoot)) {
      json(response, 409, { error: '项目根目录不存在，无法重新初始化。', code: 'PROJECT_ROOT_UNAVAILABLE' });
      return;
    }
    const repository = path.join(projectRoot, 'repository');
    const sourceRoot = path.join(projectRoot, 'sources');
    if (await directoryExists(repository)) {
      json(response, 409, { error: '项目根目录已存在 repository 子目录，请先确认目录内容。', code: 'ITERATION_REPOSITORY_ALREADY_EXISTS' });
      return;
    }
    const backupName = `.operator-studio-backup-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    const oldRuntime = path.join(projectRoot, '.operator-studio');
    const backupRuntime = path.join(projectRoot, backupName);
    if (await directoryExists(oldRuntime)) await rename(oldRuntime, backupRuntime);
    await mkdir(repository, { recursive: true });
    await mkdir(sourceRoot, { recursive: true });
    for (const entry of await readdir(projectRoot, { withFileTypes: true })) {
      if (['repository', 'sources', backupName, '.operator-studio'].includes(entry.name)) continue;
      await rename(path.join(projectRoot, entry.name), path.join(repository, entry.name));
    }
    let inspection = await workspaceManager.inspect(repository, { refresh: true });
    if (!inspection.ready) {
      await workspaceManager.git(['init'], repository);
      await workspaceManager.git(['config', 'user.name', 'Operator Studio'], repository);
      await workspaceManager.git(['config', 'user.email', 'operator-studio@local.invalid'], repository);
      await workspaceManager.git(['add', '-A'], repository);
      await workspaceManager.git(['commit', '--allow-empty', '-m', 'Operator Studio iteration baseline'], repository);
      inspection = await workspaceManager.inspect(repository, { refresh: true });
    }
    const layout = await ensureProjectLayout({ root: projectRoot, repository: inspection.gitRoot, sourceRoot, projectId: project.id });
    project.root = projectRoot;
    project.repository = inspection.gitRoot;
    project.sourceRoot = sourceRoot;
    project.runtimeRoot = layout.runtimeRoot;
    project.layout = 'three-layer';
    project.updatedAt = new Date().toISOString();
    for (const mission of linkedMissions) {
      mission.repository = inspection.gitRoot;
      mission.projectRoot = projectRoot;
      mission.sourceRoot = sourceRoot;
      mission.stage = 'diagnosis';
      mission.status = 'ready';
      mission.patchApplied = false;
      mission.candidateEvaluations = [];
      mission.workflowRecovery = createWorkflowRecoveryState(mission.id, inspection.gitRoot, projectRoot);
      mission.agent = { ...(mission.agent || {}), status: 'idle', phase: '等待启动', progress: 0, runId: null, threadId: null, startedAt: null, currentAction: null, toolCalls: [], messages: [], artifacts: [], result: null, candidateValidation: null };
    }
    const activeMission = linkedMissions.find((mission) => mission.id === state.activeMissionId);
    if (activeMission) {
      state.stage = 'diagnosis';
      state.patchApplied = false;
      state.candidateEvaluations = [];
      state.workflowRecovery = structuredClone(activeMission.workflowRecovery);
      state.agent = structuredClone(activeMission.agent);
    }
    addAuditEvent(state, '项目已重新初始化为三层结构', `${project.name} · repository / sources / Mission Snapshot`, 'green', 'Layers3');
    const saved = await saveState(state);
    for (const mission of linkedMissions) await ensureMissionWorkspace(mission.id, inspection.gitRoot);
    json(response, 200, { state: saved, project, backupRuntime: await directoryExists(backupRuntime) ? backupRuntime : null });
    return;
  }
  if (request.method === 'GET' && projectSourcesMatch) {
    const state = await loadRuntimeState();
    const project = state.projects.find((item) => item.id === decodeURIComponent(projectSourcesMatch[1]));
    if (!project) {
      json(response, 404, { error: '项目不存在。', code: 'PROJECT_NOT_FOUND' });
      return;
    }
    if (project.layout !== 'three-layer' || !project.root || !project.sourceRoot || !project.runtimeRoot) {
      json(response, 409, { error: '项目尚未初始化为严格三层结构。', code: 'PROJECT_REINITIALIZATION_REQUIRED' });
      return;
    }
    const [repositoryInspection, inspection] = await Promise.all([
      workspaceManager.inspect(project.repository, { refresh: true }),
      workspaceManager.inspectSources(project.sourceRoot, []),
    ]);
    let registry = { schemaVersion: 1, sources: [] };
    if (project.runtimeRoot) {
      try { registry = JSON.parse(await readFile(path.join(project.runtimeRoot, 'source-registry.json'), 'utf8')); } catch { /* 新项目可能尚未引用来源 */ }
    }
    const projectMissions = state.missions.filter((mission) => mission.projectId === project.id);
    const selectedMission = projectMissions.find((mission) => mission.id === state.activeMissionId) || projectMissions[0] || null;
    json(response, 200, {
      projectId: project.id,
      layout: 'three-layer',
      sourceConfigured: true,
      layers: {
        root: project.root || null,
        repository: project.repository,
        sources: project.sourceRoot || null,
        snapshots: project.runtimeRoot ? path.join(project.runtimeRoot, 'workspaces') : null,
        activeSnapshot: selectedMission ? workspaceDirForMission(selectedMission.id, selectedMission.repository, selectedMission.projectRoot) : null,
        artifacts: project.runtimeRoot ? path.join(project.runtimeRoot, 'artifacts') : null,
      },
      repositoryInspection,
      inspection,
      registry,
    });
    return;
  }
  if (request.method === 'POST' && projectSelectMatch) {
    const state = await loadRuntimeState();
    guardMutation(state);
    const selection = selectProject(state, decodeURIComponent(projectSelectMatch[1]));
    json(response, 200, { state: await saveState(state), project: selection.project, selectedMissionId: selection.selectedMission?.id || null });
    return;
  }
  if (request.method === 'PATCH' && projectMatch) {
    const state = await loadRuntimeState();
    guardMutation(state);
    const project = updateProject(state, decodeURIComponent(projectMatch[1]), await readJson(request));
    json(response, 200, { state: await saveState(state), project });
    return;
  }
  if (request.method === 'DELETE' && projectMatch) {
    const state = await loadRuntimeState();
    guardMutation(state);
    const project = deleteProject(state, decodeURIComponent(projectMatch[1]));
    json(response, 200, { state: await saveState(state), project });
    return;
  }
  if (request.method === 'GET' && url.pathname === '/api/operator-tests') {
    json(response, 200, { tasks: await operatorTestQueue.list(), queueFile: operatorTestQueue.path });
    return;
  }
  const operatorTestMatch = url.pathname.match(/^\/api\/operator-tests\/([^/]+)$/);
  if (request.method === 'GET' && operatorTestMatch) {
    json(response, 200, { task: await operatorTestQueue.get(decodeURIComponent(operatorTestMatch[1])) });
    return;
  }
  const operatorTestCancelMatch = url.pathname.match(/^\/api\/operator-tests\/([^/]+)\/cancel$/);
  if (request.method === 'POST' && operatorTestCancelMatch) {
    json(response, 200, { task: await operatorTestQueue.cancel(decodeURIComponent(operatorTestCancelMatch[1])) });
    return;
  }
  if (request.method === 'POST' && url.pathname === '/api/missions') {
    const state = await loadRuntimeState();
    guardMutation(state);
    const body = await readJson(request);
    if (!body.goal?.trim()) {
      json(response, 400, { error: '请输入一个可执行的优化目标。' });
      return;
    }
    const nextState = createMission(state, body);
    const mission = nextState.missions.find((item) => item.id === nextState.activeMissionId);
    await ensureMissionWorkspace(mission.id, mission.repository);
    json(response, 201, { state: await saveState(nextState) });
    return;
  }
  const missionRunMatch = url.pathname.match(/^\/api\/missions\/([^/]+)\/runs$/);
  if (request.method === 'POST' && missionRunMatch) {
    const state = await loadRuntimeState();
    guardMutation(state);
    const missionId = decodeURIComponent(missionRunMatch[1]);
    if (state.activeMissionId !== missionId) selectMission(state, missionId);
    const body = await readJson(request);
    const mission = state.missions.find((item) => item.id === missionId);
    let goal = body.goal?.trim() || mission.goal;
    if (!body.goal && state.iterationStats?.pendingInjection) {
      goal = `${goal}\n【调研注入】${state.iterationStats.pendingInjection.briefing}`;
      state.iterationStats = { ...state.iterationStats, pendingInjection: null };
    }
    // 操作员手动启动 run = 人工接管：恢复循环自动流转（若此前命中全局兜底标记）
    if (state.iterationStats) {
      state.iterationStats = { ...state.iterationStats, loopStatus: 'running', loopStatusReason: null };
    }
    const runtimeDescriptor = await agentRuntime.describe();
    const preflight = await buildRuntimePreflight(mission);
    if (!preflight.ready) {
      const failure = !preflight.workspaceCheck.ready ? preflight.workspaceCheck : preflight.agentCheck;
      const error = new Error(failure.detail || 'Agent Runtime 预检失败。');
      error.status = 503;
      error.code = failure.code || 'RUNTIME_PREFLIGHT_FAILED';
      error.details = preflight;
      throw error;
    }
    assertMissionIntent(goal, mission);
    const workspace = preflight.workspace;
    const resumeThreadId = body.resume === true
      ? state.agent?.threadId || state.runHistory?.find((run) => run.runtimeKind === 'codex-cli' && run.threadId)?.threadId || null
      : null;
    resetMissionRunState(state, goal, { referenceFixture: runtimeDescriptor.mode === 'reference-fixture' });
    if (runtimeDescriptor.mode === 'reference-fixture') await resetMissionWorkspace(missionId);
    if (runtimeDescriptor.mode === 'codex-cli') {
      const baselineCheckpoint = await createWorkspaceCheckpoint(missionId, 'agent-run-baseline');
      state.workflowRecovery = {
        ...(state.workflowRecovery || {}),
        checkpoints: [...(state.workflowRecovery?.checkpoints || []), baselineCheckpoint].slice(-5),
      };
    }
    const runtimeRun = await agentRuntime.startRun({ state, mission, goal, resumeThreadId, workspace });
    if (!runtimeRun.handled) {
      startAgentRun(state, goal, { reset: false });
      appendRuntimeEvent(state, 'mission.run_started', { runId: state.agent.runId, goal }, { kind: 'adapter', mode: 'reference-fixture' });
    }
    json(response, 202, { state: await saveState(runtimeRun.state || state) });
    return;
  }
  const missionRunCancelMatch = url.pathname.match(/^\/api\/missions\/([^/]+)\/runs\/([^/]+)\/cancel$/);
  if (request.method === 'POST' && missionRunCancelMatch) {
    const state = await loadRuntimeState();
    const missionId = decodeURIComponent(missionRunCancelMatch[1]);
    const runId = decodeURIComponent(missionRunCancelMatch[2]);
    if (state.activeMissionId !== missionId) {
      const error = new Error('The requested Agent run does not belong to the active Mission.');
      error.status = 409;
      error.code = 'AGENT_MISSION_MISMATCH';
      throw error;
    }
    const cancelled = await agentRuntime.cancelRun({ state, runId });
    json(response, 202, { state: await saveState(cancelled.state), result: cancelled.result });
    return;
  }
  const missionResearchMatch = url.pathname.match(/^\/api\/missions\/([^/]+)\/research$/);
  if (request.method === 'POST' && missionResearchMatch) {
    const state = await loadRuntimeState();
    guardMutation(state);
    const missionId = decodeURIComponent(missionResearchMatch[1]);
    if (state.activeMissionId !== missionId) selectMission(state, missionId);
    const mission = state.missions.find((item) => item.id === missionId);
    if (!mission) {
      json(response, 404, { error: 'Mission 不存在。', code: 'MISSION_NOT_FOUND' });
      return;
    }
    const body = await readJson(request);
    const direction = body.direction?.trim() || selectResearchDirection(state);
    const researchDir = researchDirForMission(missionId, mission.repository, mission.projectRoot);
    const started = await agentRuntime.startResearch({ state, mission, direction, workspace: researchDir });
    json(response, 202, { state: await saveState(started.state), research: started.state.researchAgent });
    return;
  }
  const missionResearchNotesMatch = url.pathname.match(/^\/api\/missions\/([^/]+)\/research\/notes$/);
  if (request.method === 'GET' && missionResearchNotesMatch) {
    const state = await loadRuntimeState();
    const missionId = decodeURIComponent(missionResearchNotesMatch[1]);
    if (state.activeMissionId !== missionId) selectMission(state, missionId);
    json(response, 200, { missionId, notes: state.researchNotes || [], researchAgent: state.researchAgent || createResearchAgentState() });
    return;
  }
  const missionResearchCancelMatch = url.pathname.match(/^\/api\/missions\/([^/]+)\/research\/([^/]+)\/cancel$/);
  if (request.method === 'POST' && missionResearchCancelMatch) {
    const state = await loadRuntimeState();
    const missionId = decodeURIComponent(missionResearchCancelMatch[1]);
    const runId = decodeURIComponent(missionResearchCancelMatch[2]);
    if (state.activeMissionId !== missionId) {
      const error = new Error('The requested research run does not belong to the active Mission.');
      error.status = 409;
      error.code = 'AGENT_MISSION_MISMATCH';
      throw error;
    }
    const cancelled = await agentRuntime.cancelRun({ state, runId });
    json(response, 202, { state: await saveState(cancelled.state), result: cancelled.result });
    return;
  }
  const missionSelectMatch = url.pathname.match(/^\/api\/missions\/([^/]+)\/select$/);
  if (request.method === 'POST' && missionSelectMatch) {
    const state = await loadRuntimeState();
    const missionId = decodeURIComponent(missionSelectMatch[1]);
    json(response, 200, { state: await saveState(selectMission(state, missionId)) });
    return;
  }
  const missionEventsMatch = url.pathname.match(/^\/api\/missions\/([^/]+)\/events$/);
  if (request.method === 'GET' && missionEventsMatch) {
    const state = await loadRuntimeState();
    const missionId = decodeURIComponent(missionEventsMatch[1]);
    const after = Number(url.searchParams.get('after') || 0);
    const events = (state.runtimeEvents || []).filter((event) => event.missionId === missionId && event.sequence > after);
    json(response, 200, { missionId, events, nextSequence: events.at(-1)?.sequence || after });
    return;
  }
  const missionEventsStreamMatch = url.pathname.match(/^\/api\/missions\/([^/]+)\/events\/stream$/);
  if (request.method === 'GET' && missionEventsStreamMatch) {
    await streamMissionEvents(request, response, decodeURIComponent(missionEventsStreamMatch[1]), Number(url.searchParams.get('after') || 0));
    return;
  }
  if (request.method === 'POST' && url.pathname === '/api/actions/apply-patch') {
    const runtime = await guardSupportedRuntimeAction('Patch');
    const state = await loadRuntimeState();
    guardMutation(state);
    guardWorkflowTransition(state, { stages: ['candidate'], actionType: 'candidate.plan', label: 'Patch 自动策略检查' });
    const body = await readJson(request);
    if (!body.candidate) {
      const error = new Error('候选标识不能为空。');
      error.status = 409;
      error.code = 'CANDIDATE_MISMATCH';
      throw error;
    }
    const candidate = (state.candidateEvaluations || []).find((item) => item.id === body.candidate);
    const declaredFiles = String(candidate?.files || '').split(',').map((item) => item.trim()).filter(Boolean);
    const codexPatch = runtime.mode === 'codex-cli'
      ? await workspaceManager.captureDiff(await ensureMissionWorkspace(state.activeMissionId))
      : null;
    const actualFiles = (codexPatch?.changedFiles || []).map((file) => file.replaceAll('\\', '/'));
    const normalizedDeclaredFiles = declaredFiles.map((file) => file.replaceAll('\\', '/'));
    const undeclaredFiles = actualFiles.filter((file) => !normalizedDeclaredFiles.includes(file));
    const missingFiles = normalizedDeclaredFiles.filter((file) => !actualFiles.includes(file));
    const codexPolicyChecks = runtime.mode === 'codex-cli' ? [
      { id: 'patch.diff.nonempty', label: 'Mission 工作区存在真实 Git Diff', passed: Boolean(codexPatch?.dirty && codexPatch.diff) },
      { id: 'patch.diff.matches', label: 'Candidate 文件清单与真实 Diff 一致', passed: undeclaredFiles.length === 0 && missingFiles.length === 0, detail: { undeclaredFiles, missingFiles } },
    ] : [];
    const policyChecks = [
      { id: 'candidate.exists', label: '候选身份有效', passed: Boolean(candidate) },
      { id: 'patch.declared', label: 'Patch 文件清单非空', passed: declaredFiles.length > 0 },
      { id: 'patch.paths', label: '变更路径位于受控工作区', passed: declaredFiles.length > 0 && declaredFiles.every((file) => !path.isAbsolute(file) && !file.split(/[\\/]/).includes('..') && !file.startsWith('.git')) },
      ...codexPolicyChecks,
      { id: 'risk.policy', label: '风险未命中强制人工介入', passed: state.agent?.currentAction?.risk !== 'high' },
    ];
    if (policyChecks.some((check) => !check.passed)) {
      const error = new Error('Patch 自动策略检查未通过，请通过人工介入查看失败项。');
      error.status = 409;
      error.code = 'PATCH_POLICY_CHECK_FAILED';
      error.details = policyChecks;
      throw error;
    }
    const checkpoint = runtime.mode === 'codex-cli' && state.workflowRecovery?.checkpoints?.length
      ? state.workflowRecovery.checkpoints.at(-1)
      : await createWorkspaceCheckpoint(state.activeMissionId, 'candidate', candidate.id);
    let workspace = runtime.mode === 'codex-cli'
      ? {
          workspace: path.relative(rootDir, codexPatch.workspace).replaceAll('\\', '/'),
          files: actualFiles.map((file) => ({ path: file, status: 'modified' })),
          digest: codexPatch.digest,
          diff: codexPatch.diff,
        }
      : await applyCandidatePatch(state.activeMissionId);
    const appliedDiff = codexPatch || await workspaceManager.captureDiff(await ensureMissionWorkspace(state.activeMissionId));
    if (runtime.mode !== 'codex-cli') workspace = { ...workspace, digest: appliedDiff.digest, diff: appliedDiff.diff };
    candidate.patchDigest = appliedDiff.digest;
    candidate.sourceRunId = state.agent.runId;
    if (runtime.mode === 'codex-cli') candidate.files = actualFiles.join(', ');
    const mission = state.missions.find((item) => item.id === state.activeMissionId) || {};
    const artifactDir = artifactDirForMission(state.activeMissionId, mission.repository, mission.projectRoot);
    await mkdir(artifactDir, { recursive: true });
    const patchPath = path.join(artifactDir, `${candidate.id}.patch`);
    const manifestPath = path.join(artifactDir, `${candidate.id}.manifest.json`);
    const sourceReferences = Array.isArray(candidate.sourceReferences) ? candidate.sourceReferences : [];
    await writeFile(patchPath, appliedDiff.diff, 'utf8');
    await writeFile(manifestPath, `${JSON.stringify({ schemaVersion: 1, missionId: state.activeMissionId, candidateId: candidate.id, digest: appliedDiff.digest, files: appliedDiff.changedFiles, sourceReferences, sourceRunId: state.agent.runId, createdAt: new Date().toISOString() }, null, 2)}\n`, 'utf8');
    candidate.artifacts = { patch: patchPath, manifest: manifestPath };
    if (mission.sourceRoot && mission.runtimeRoot) await workspaceManager.updateSourceRegistry({ sourceRoot: mission.sourceRoot, runtimeRoot: mission.runtimeRoot, missionId: state.activeMissionId, references: sourceReferences });
    state.patchApplied = true;
    state.appliedCandidateId = candidate.id;
    state.stage = 'validation';
    state.workflowRecovery = {
      ...(state.workflowRecovery || {}),
      previousBest: state.workflowRecovery?.previousBest || structuredClone(state.currentBest || { candidateId: null, version: 'baseline', value: '--', improvement: '--', status: 'active' }),
      worktree: { ...(state.workflowRecovery?.worktree || {}), candidateId: candidate.id, status: 'active', activatedAt: new Date().toISOString() },
      checkpoints: [...(state.workflowRecovery?.checkpoints || []).filter((item) => item.id !== checkpoint.id), checkpoint].slice(-5),
      lastRecovery: null,
      invalidatedArtifacts: [],
    };
    state.agent = {
      ...state.agent,
      status: 'awaiting_action',
      phase: '异构验证已就绪',
      currentAction: { id: 'action.validation-matrix', type: 'test.plan', title: '运行 C500 + CUDA 测试矩阵', reason: 'Patch 自动策略检查已通过并写入隔离工作区，下一步验证正确性和完整性能。', expectedOutput: '24 / 24 Correctness · 2 个 Full Benchmark Run', risk: 'medium', approvalRequired: false, approvalPolicy: 'client-controlled' },
      messages: [...(state.agent?.messages || []), { id: `patch-${Date.now()}`, phase: 'candidate', status: 'completed', title: 'Patch 自动检查通过并应用', detail: '变更边界、工作区路径和风险策略均已通过，补丁已写入隔离工作区。', time: '刚刚' }],
    };
    appendRuntimeEvent(state, 'patch.applied', { workspace: workspace.workspace, checkpointId: checkpoint.id, files: workspace.files.map((file) => file.path), digest: workspace.digest || null, artifacts: candidate.artifacts, sourceReferences, policyChecks, approvalRequired: false, mock: false }, { kind: 'workspace', mode: runtime.mode === 'codex-cli' ? 'codex-cli' : 'client' });
    addAuditEvent(state, 'Patch 自动策略检查通过', `${workspace.workspace} · ${body.candidate} · 无需人工审批`, 'green', 'ShieldCheck');
    json(response, 200, { state: await saveState(state), workspace, policyChecks });
    return;
  }
  if (request.method === 'POST' && url.pathname === '/api/actions/start-benchmark') {
    const state = await loadRuntimeState();
    guardMutation(state);
    guardWorkflowTransition(state, { stages: ['validation'], actionType: 'test.plan', label: 'Benchmark 提交' });
    if (!state.patchApplied) {
      json(response, 409, { error: '请先应用候选补丁。' });
      return;
    }
    const body = await readJson(request);
    const matrix = body.matrix || state.testMatrix;
    if (!Array.isArray(matrix?.environments) || !matrix.environments.length || !Array.isArray(matrix?.stages) || !matrix.stages.length) {
      json(response, 400, { error: '本次测试矩阵至少需要一个环境和一个验证阶段。', code: 'TEST_MATRIX_INVALID' });
      return;
    }
    state.testMatrix = structuredClone(matrix);
    const runId = `run_${Date.now().toString(36).toUpperCase()}_${randomUUID().slice(0, 8).toUpperCase()}`;
    const mission = state.missions.find((item) => item.id === state.activeMissionId) || {};
    const candidateId = body.candidate || state.appliedCandidateId;
    if (!candidateId) {
      json(response, 409, { error: '无法确定本次测试对应的候选，请重新应用候选 Patch。', code: 'TEST_CANDIDATE_MISSING' });
      return;
    }
    const appliedCandidate = (state.candidateEvaluations || []).find((candidate) => candidate.id === candidateId);
    const candidateDigest = body.candidateDigest || appliedCandidate?.patchDigest || null;
    if (!candidateDigest) {
      json(response, 409, { error: '候选缺少由真实工作区 Diff 生成的 digest，不能提交测试。', code: 'TEST_CANDIDATE_DIGEST_MISSING' });
      return;
    }
    const submitted = await operatorTestQueue.submit({
      schemaVersion: 1,
      requestId: runId,
      missionId: state.activeMissionId,
      operator: body.operator || 'mla_paged_attention',
      candidate: { id: candidateId, digest: candidateDigest },
      hardware: mission.hardware || matrix.environments,
      runtime: body.runtime || 'client-managed-runtime',
      metric: mission.metric || 'latency_p50',
      matrix: { ...structuredClone(matrix), warmup: Number(body.warmup || 50), repeats: Number(body.repeats || 200), correctnessCases: Number(body.correctnessCases || 24) },
      tracer: { enabled: true, format: 'operator-trace/v1' },
      profiler: { enabled: true, format: 'operator-profile/v1' },
      limits: { timeoutSeconds: Number(body.timeoutSeconds || 3) },
    });
    state.stage = 'validation';
    state.benchmark = { status: 'running', progress: 0, runId, startedAt: new Date().toISOString(), completedAt: null, durationMs: 2600, logs: [{ sequence: 1, progress: 0, message: `调度器已锁定 ${matrix.environments.length} 个环境快照` }], matrix: structuredClone(matrix) };
    state.agent = { ...state.agent, status: 'executing', phase: '异构验证', currentAction: null, messages: [...(state.agent?.messages || []), { id: `test-${runId}`, phase: 'validation', status: 'running', title: 'Validation Agent 已提交测试矩阵', detail: `${runId} 正在两个固定环境中执行。`, time: '刚刚' }] };
    state.benchmark = { ...state.benchmark, candidate: { id: candidateId, digest: candidateDigest }, testTaskId: submitted.taskId, startedAt: submitted.submittedAt, durationMs: 0, result: null, source: { kind: 'operator-test-service', transport: 'local-serial-queue', mock: true }, lastServiceError: null };
    appendRuntimeEvent(state, 'operator_test.queued', { runId, taskId: submitted.taskId, candidate: { id: candidateId, digest: candidateDigest }, environments: matrix.environments, stages: matrix.stages, matrix: structuredClone(matrix) }, { kind: 'operator-test-queue', mode: 'client' });
    addAuditEvent(state, 'Full Benchmark 已提交', `${runId} · ${matrix.environments.length} environments`, 'blue', 'TestTube2');
    json(response, 202, { state: await saveState(state) });
    return;
  }
  if (request.method === 'POST' && url.pathname === '/api/actions/rollback-stage') {
    await guardSupportedRuntimeAction('Workflow Rollback');
    const state = await loadRuntimeState();
    guardMutation(state);
    if (state.decisionReview?.status === 'awaiting_review') {
      const error = new Error('请先撤回待处理的人工意见，再返回上一步。');
      error.status = 409;
      error.code = 'DECISION_REVIEW_PENDING';
      throw error;
    }
    guardWorkflowTransition(state, { stages: ['validation', 'evidence'], label: '返回上一步' });
    const checkpoint = state.workflowRecovery?.checkpoints?.at(-1);
    const recovery = await restoreWorkspaceCheckpoint(checkpoint, state.activeMissionId);
    const candidateId = state.appliedCandidateId || state.decisionReview?.candidateId;
    const invalidatedArtifacts = [
      state.benchmark?.runId ? { type: 'benchmark', id: state.benchmark.runId } : null,
      state.stage === 'evidence' && candidateId ? { type: 'evidence', id: `decision.${candidateId}` } : null,
    ].filter(Boolean);
    state.stage = 'candidate';
    state.patchApplied = false;
    state.benchmark = { status: 'idle', progress: 0, runId: null, startedAt: null, completedAt: null, durationMs: 2600, logs: [] };
    state.decisionReview = createDecisionReviewState('idle');
    state.agent = {
      ...state.agent,
      status: 'awaiting_approval',
      phase: '候选补丁审查',
      currentAction: { id: `action.${candidateId || 'candidate'}-restored`, type: 'candidate.plan', title: `重新审阅 ${candidateId || '候选'}`, reason: '流程已恢复到补丁应用前的工作区检查点。', expectedOutput: 'Candidate Plan · isolated worktree', risk: 'medium', approvalRequired: true },
      messages: [...(state.agent?.messages || []), { id: `rollback-${Date.now()}`, phase: 'candidate', status: 'completed', title: '已返回补丁应用前', detail: `${checkpoint.id} 已恢复，${invalidatedArtifacts.length} 个后续工件已失效。`, time: '刚刚' }],
    };
    state.workflowRecovery = {
      ...state.workflowRecovery,
      worktree: { ...state.workflowRecovery.worktree, status: 'restored' },
      lastRecovery: { type: 'stage_rollback', from: 'validation_or_evidence', to: 'candidate', checkpointId: checkpoint.id, restoredAt: recovery.restoredAt },
      invalidatedArtifacts: [...(state.workflowRecovery.invalidatedArtifacts || []), ...invalidatedArtifacts],
    };
    appendRuntimeEvent(state, 'workflow.stage_rolled_back', { from: 'validation_or_evidence', to: 'candidate', checkpointId: checkpoint.id, invalidatedArtifacts }, { kind: 'recovery', mode: 'client' });
    addAuditEvent(state, '流程已返回补丁应用前', `${checkpoint.id} · ${invalidatedArtifacts.length} artifacts invalidated`, 'warning', 'History');
    json(response, 200, { state: await saveState(state), recovery });
    return;
  }
  if (request.method === 'POST' && url.pathname === '/api/actions/adopt') {
    await guardSupportedRuntimeAction('Decision');
    const state = await loadRuntimeState();
    guardMutation(state);
    if (state.knowledgeMaintenance?.status === 'completed' && state.publishedAssets?.length === state.knowledgeDrafts?.length) {
      json(response, 200, { state, maintenance: state.knowledgeMaintenance, idempotent: true });
      return;
    }
    if (state.decisionReview?.status === 'awaiting_review') {
      const error = new Error('流程已因人工审批意见阻塞，请先处理或撤回该意见。');
      error.status = 409;
      error.code = 'DECISION_REVIEW_PENDING';
      throw error;
    }
    guardWorkflowTransition(state, { stages: ['evidence'], actionType: 'adoption.decision', label: '候选采用' });
    if (state.benchmark.status !== 'complete') {
      json(response, 409, { error: 'Full Benchmark 尚未完成。' });
      return;
    }
    const body = await readJson(request);
    adoptCandidateState(state, body.note || '证据完整且未命中人工复核信号。', 'policy');
    json(response, 200, { state: await saveState(state), maintenance: state.knowledgeMaintenance });
    return;
  }
  if (request.method === 'POST' && url.pathname === '/api/actions/request-review') {
    await guardSupportedRuntimeAction('Decision Review');
    const state = await loadRuntimeState();
    guardMutation(state);
    guardWorkflowTransition(state, { stages: ['candidate', 'validation', 'evidence'], label: '人工介入发起' });
    if (state.decisionReview?.status === 'awaiting_review') {
      const error = new Error('当前已有待处理的人工介入事项。');
      error.status = 409;
      error.code = 'DECISION_REVIEW_PENDING';
      throw error;
    }
    const body = await readJson(request);
    const outcome = ['adopt', 'supplement', 'redirect'].includes(body.outcome) ? body.outcome : 'redirect';
    const allowedOutcomes = state.stage === 'evidence' ? ['adopt', 'supplement', 'redirect'] : state.stage === 'validation' ? ['supplement', 'redirect'] : ['redirect'];
    if (!allowedOutcomes.includes(outcome)) {
      const error = new Error('当前阶段尚不支持该介入指令，请先查看证据状态。');
      error.status = 409;
      error.code = 'INTERVENTION_OUTCOME_UNAVAILABLE';
      throw error;
    }
    const note = String(body.note || '').trim();
    if (note.length < 4) {
      const error = new Error('请填写具体的审批意见后再提交。');
      error.status = 400;
      error.code = 'DECISION_REVIEW_NOTE_REQUIRED';
      throw error;
    }
    const requestedAt = new Date().toISOString();
    const originStage = state.stage;
    const outcomeMeta = interventionOutcomeMeta[outcome];
    state.decisionReview = {
      ...(state.decisionReview || createDecisionReviewState('auto_ready')),
      status: 'awaiting_review',
      requiresApproval: true,
      request: { candidateId: body.candidate || state.appliedCandidateId || null, outcome, note, originStage, submittedBy: body.submittedBy || 'Yilin Lu', requestedAt },
      resolution: null,
      requestedAt,
      resolvedAt: null,
    };
    state.agent = {
      ...state.agent,
      status: 'awaiting_approval',
      phase: '人工介入待处理',
      currentAction: { id: 'action.resolve-decision-review', type: 'review.resolve', title: '处理人工介入事项', reason: note, expectedOutput: outcomeMeta.expectedOutput, risk: 'high', approvalRequired: true, reviewMode: 'human_requested' },
      messages: [...(state.agent?.messages || []), { id: `review-${Date.now()}`, phase: 'approval', status: 'waiting', title: '已收到人工介入意见', detail: `${outcomeMeta.label} · ${note}`, time: '刚刚' }],
    };
    appendRuntimeEvent(state, 'decision.review_requested', { candidate: state.appliedCandidateId || state.decisionReview?.candidateId || null, originStage, outcome, note }, { kind: 'approval', mode: 'client' });
    addAuditEvent(state, '流程已被人工介入阻塞', `${outcomeMeta.label} · ${note}`, 'warning', 'ShieldCheck');
    json(response, 202, { state: await saveState(state), review: state.decisionReview });
    return;
  }
  if (request.method === 'POST' && url.pathname === '/api/actions/cancel-review') {
    await guardSupportedRuntimeAction('Decision Review');
    const state = await loadRuntimeState();
    guardMutation(state);
    guardWorkflowTransition(state, { stages: ['candidate', 'validation', 'evidence'], actionType: 'review.resolve', label: '人工介入撤回' });
    const previousRequest = state.decisionReview?.request;
    const candidateId = state.appliedCandidateId || previousRequest?.candidateId || state.decisionReview?.candidateId;
    const restoredStatus = state.stage === 'evidence' ? 'auto_ready' : 'idle';
    const restoredAction = state.stage === 'evidence'
      ? { id: 'action.adoption-decision', type: 'adoption.decision', title: `确认 ${candidateId || '候选'} 的策略建议`, reason: '人工意见已撤回，当前未命中强制复核信号。', expectedOutput: 'Policy Decision · current best update', risk: 'medium', approvalRequired: false, reviewMode: 'conditional' }
      : state.stage === 'validation'
        ? { id: 'action.validation-resumed', type: 'test.plan', title: '继续异构验证', reason: '人工介入已撤回，恢复原验证计划。', expectedOutput: 'Correctness · Full Benchmark · Level 3 evidence', risk: 'medium', approvalRequired: false }
        : { id: 'action.candidate-resumed', type: 'candidate.plan', title: '继续候选自动检查', reason: '人工介入已撤回，恢复原 Candidate Plan 和自动策略。', expectedOutput: 'Candidate Plan · patch proposal', risk: 'medium', approvalRequired: false, approvalPolicy: 'client-controlled' };
    state.decisionReview = { ...createDecisionReviewState(restoredStatus), cancelledRequest: previousRequest || null };
    state.agent = {
      ...state.agent,
      status: 'awaiting_action',
      phase: state.stage === 'evidence' ? '效果策略评估' : state.stage === 'validation' ? '异构验证' : '候选补丁审查',
      currentAction: restoredAction,
    };
    appendRuntimeEvent(state, 'decision.review_cancelled', { candidate: candidateId || null }, { kind: 'approval', mode: 'client' });
    addAuditEvent(state, '人工审批意见已撤回', '流程恢复为条件式策略决策', 'blue', 'ShieldCheck');
    if (state.stage === 'evidence' && state.benchmark?.status === 'complete') runAutomaticAdoption(state, `人工介入已撤回，Accept Gate 继续按策略自动采用 ${candidateId || '候选'}。`);
    json(response, 200, { state: await saveState(state), review: state.decisionReview });
    return;
  }
  if (request.method === 'POST' && url.pathname === '/api/actions/resolve-review') {
    await guardSupportedRuntimeAction('Decision Review');
    const state = await loadRuntimeState();
    guardMutation(state);
    guardWorkflowTransition(state, { stages: ['candidate', 'validation', 'evidence'], actionType: 'review.resolve', label: '人工介入处理' });
    if (state.decisionReview?.status !== 'awaiting_review' || !state.decisionReview.request) {
      const error = new Error('当前没有待处理的效果决策审批意见。');
      error.status = 409;
      error.code = 'DECISION_REVIEW_NOT_PENDING';
      throw error;
    }
    const body = await readJson(request);
    const outcome = body.outcome || state.decisionReview.request.outcome;
    const note = String(body.note || state.decisionReview.request.note).trim();
    const candidateId = state.appliedCandidateId || state.decisionReview?.candidateId;
    if (outcome === 'adopt') {
      if (state.stage !== 'evidence' || state.benchmark.status !== 'complete') {
        const error = new Error('当前尚未形成可采用的 Level 3 证据。');
        error.status = 409;
        error.code = 'INTERVENTION_ADOPTION_UNAVAILABLE';
        throw error;
      }
      adoptCandidateState(state, note, 'human_review');
      json(response, 200, { state: await saveState(state), maintenance: state.knowledgeMaintenance });
      return;
    }
    if (!['supplement', 'redirect'].includes(outcome)) {
      const error = new Error('人工介入处理结果仅支持采用、补充验证或调整优化方向。');
      error.status = 400;
      error.code = 'DECISION_REVIEW_OUTCOME_INVALID';
      throw error;
    }
    const resolvedAt = new Date().toISOString();
    if (outcome === 'redirect') {
      const checkpoint = state.workflowRecovery?.checkpoints?.at(-1);
      const invalidatedArtifacts = [
        state.benchmark?.runId ? { type: 'benchmark', id: state.benchmark.runId } : null,
        state.stage === 'evidence' && candidateId ? { type: 'evidence', id: `decision.${candidateId}` } : null,
      ].filter(Boolean);
      if (!checkpoint) {
        const error = new Error('当前 Mission 没有可恢复的工作区检查点，无法调整优化方向。');
        error.status = 409;
        error.code = 'WORKSPACE_CHECKPOINT_MISSING';
        throw error;
      }
      const recovery = await restoreWorkspaceCheckpoint(checkpoint, state.activeMissionId);
      state.stage = 'candidate';
      state.patchApplied = false;
      state.benchmark = { status: 'idle', progress: 0, runId: null, startedAt: null, completedAt: null, durationMs: 2600, logs: [] };
      state.decisionReview = { ...state.decisionReview, status: 'resolved', requiresApproval: false, recommendation: null, resolution: { outcome, source: 'human_review', note, resolvedAt }, resolvedAt };
      state.agent = {
        ...state.agent,
        status: 'awaiting_action',
        phase: '调整优化方向',
        currentAction: { id: 'action.redirect-candidate', type: 'candidate.plan', title: '根据人工意见生成新候选方向', reason: note, expectedOutput: 'Revised Candidate Plan · isolated worktree', risk: 'medium', approvalRequired: true, reviewMode: 'resolved' },
        messages: [...(state.agent?.messages || []), { id: `review-redirect-${Date.now()}`, phase: 'candidate', status: 'completed', title: '人工介入已调整优化方向', detail: `${checkpoint?.id || 'candidate baseline'} 已恢复，${invalidatedArtifacts.length} 个后续工件已失效。`, time: '刚刚' }],
      };
      state.workflowRecovery = {
        ...state.workflowRecovery,
        worktree: { ...state.workflowRecovery?.worktree, status: checkpoint ? 'restored' : 'clean' },
        lastRecovery: checkpoint ? { type: 'intervention_redirect', from: state.decisionReview.request?.originStage || 'workflow', to: 'candidate', checkpointId: checkpoint.id, restoredAt: recovery.restoredAt } : state.workflowRecovery?.lastRecovery,
        invalidatedArtifacts: [...(state.workflowRecovery?.invalidatedArtifacts || []), ...invalidatedArtifacts],
      };
      appendRuntimeEvent(state, 'decision.review_resolved', { candidate: candidateId || null, outcome, note }, { kind: 'approval', mode: 'client' });
      appendRuntimeEvent(state, 'workflow.redirected_by_intervention', { candidate: candidateId || null, checkpointId: checkpoint?.id || null, invalidatedArtifacts }, { kind: 'recovery', mode: 'client' });
      addAuditEvent(state, '人工介入已调整优化方向', `${checkpoint?.id || 'candidate baseline'} · ${note}`, 'warning', 'GitBranch');
      json(response, 200, { state: await saveState(state), review: state.decisionReview, recovery });
      return;
    }
    if (!state.patchApplied) {
      const error = new Error('候选补丁尚未应用，当前不能提交补充验证指令。');
      error.status = 409;
      error.code = 'INTERVENTION_VALIDATION_UNAVAILABLE';
      throw error;
    }
    state.stage = 'validation';
    state.benchmark = { status: 'idle', progress: 0, runId: null, startedAt: null, completedAt: null, durationMs: 2600, logs: [] };
    state.decisionReview = { ...state.decisionReview, status: 'resolved', requiresApproval: false, recommendation: null, resolution: { outcome, source: 'human_review', note, resolvedAt }, resolvedAt };
    state.agent = {
      ...state.agent,
      status: 'awaiting_action',
      phase: '补充验证',
      currentAction: { id: 'action.supplement-validation', type: 'test.plan', title: '运行补充验证矩阵', reason: note, expectedOutput: 'Updated Full Benchmark · refreshed Level 3 evidence', risk: 'medium', approvalRequired: false, reviewMode: 'resolved' },
      messages: [...(state.agent?.messages || []), { id: `review-resolved-${Date.now()}`, phase: 'approval', status: 'completed', title: '审批意见已处理', detail: `流程返回验证阶段 · ${note}`, time: '刚刚' }],
    };
    appendRuntimeEvent(state, 'decision.review_resolved', { candidate: candidateId || null, outcome, note }, { kind: 'approval', mode: 'client' });
    addAuditEvent(state, '审批意见已处理：补充验证', note, 'warning', 'TestTube2');
    json(response, 200, { state: await saveState(state), review: state.decisionReview });
    return;
  }
  if (request.method === 'POST' && url.pathname === '/api/actions/reject') {
    await guardSupportedRuntimeAction('Decision');
    const state = await loadRuntimeState();
    guardMutation(state);
    guardWorkflowTransition(state, { stages: ['evidence'], actionType: 'adoption.decision', label: '候选退回' });
    state.stage = 'validation';
    state.benchmark = { status: 'idle', progress: 0, runId: null, startedAt: null, completedAt: null, durationMs: 2600, logs: [] };
    state.decisionReview = { ...createDecisionReviewState('resolved'), recommendation: null, resolution: { outcome: 'supplement', source: 'direct_action', note: '需要补充验证', resolvedAt: new Date().toISOString() } };
    state.agent = { ...state.agent, status: 'awaiting_action', phase: '补充验证', currentAction: { id: 'action.revalidation', type: 'test.plan', title: '运行补充验证矩阵', reason: '效果决策要求补充验证。', expectedOutput: 'Updated Full Benchmark · refreshed Level 3 evidence', risk: 'medium', approvalRequired: false } };
    const candidateId = state.appliedCandidateId || state.decisionReview?.candidateId;
    appendRuntimeEvent(state, 'decision.revalidation_requested', { candidate: candidateId || null, reason: '需要补充验证' }, { kind: 'policy', mode: 'client' });
    addAuditEvent(state, '候选退回验证', `${candidateId || '当前候选'} · 需要补充验证`, 'warning', 'TriangleAlert');
    json(response, 200, { state: await saveState(state) });
    return;
  }
  if (request.method === 'POST' && url.pathname === '/api/actions/revert-adoption') {
    await guardSupportedRuntimeAction('Adoption Revert');
    const state = await loadRuntimeState();
    guardMutation(state);
    if (state.decisionReview?.resolution?.outcome === 'reverted') {
      json(response, 200, { state, idempotent: true });
      return;
    }
    guardWorkflowTransition(state, { stages: ['published'], label: '回退到上一版本' });
    const checkpoint = state.workflowRecovery?.checkpoints?.at(-1);
    const mission = state.missions.find((item) => item.id === state.activeMissionId) || {};
    const repositoryAdoption = state.workflowRecovery?.repositoryAdoption;
    const repositoryRevert = mission.projectRoot && repositoryAdoption?.commit
      ? await workspaceManager.revertAdoption({ repository: mission.repository, commit: repositoryAdoption.commit })
      : null;
    const recovery = await restoreWorkspaceCheckpoint(checkpoint, state.activeMissionId);
    const revertedAt = new Date().toISOString();
    const revertedCandidateId = state.currentBest?.candidateId || state.appliedCandidateId || checkpoint?.candidateId || 'candidate';
    const previousBest = state.workflowRecovery?.previousBest || { candidateId: null, version: 'baseline', value: '--', improvement: '--', status: 'active' };
    state.currentBest = previousBest;
    state.decisionReview = {
      ...(state.decisionReview || createDecisionReviewState('resolved')),
      status: 'resolved',
      recommendation: null,
      requiresApproval: false,
      resolution: { outcome: 'reverted', source: 'human_recovery', note: `已恢复上一稳定版本 ${previousBest.version || 'baseline'}`, resolvedAt: revertedAt },
      resolvedAt: revertedAt,
    };
    state.publishedAssets = (state.publishedAssets || []).map((asset) => ({ ...asset, status: 'superseded', supersededAt: revertedAt, supersededBy: `rollback.${previousBest.version || 'baseline'}` }));
    state.knowledgeMaintenance = {
      ...state.knowledgeMaintenance,
      rollback: { status: 'completed', reason: `${revertedCandidateId} adoption reverted`, revertedAt },
      changes: (state.knowledgeMaintenance?.changes || []).map((change) => ({ ...change, outcome: 'superseded' })),
    };
    state.agent = {
      ...state.agent,
      status: 'completed',
      phase: '已回退到上一稳定版本',
      currentAction: null,
      messages: [...(state.agent?.messages || []), { id: `adoption-revert-${Date.now()}`, phase: 'decision', status: 'completed', title: '采用结果已回退', detail: `current best 已恢复为 ${previousBest.version || 'baseline'}，${revertedCandidateId} 关联知识已标记为被替代。`, time: '刚刚' }],
    };
    state.workflowRecovery = {
      ...state.workflowRecovery,
      repositoryAdoption: repositoryRevert ? { ...repositoryAdoption, status: 'reverted', ...repositoryRevert } : repositoryAdoption,
      worktree: { ...state.workflowRecovery.worktree, status: 'reverted', revertedAt },
      lastRecovery: { type: 'adoption_revert', from: revertedCandidateId, to: previousBest.candidateId || 'baseline', checkpointId: checkpoint.id, restoredAt: recovery.restoredAt },
      invalidatedArtifacts: [...(state.workflowRecovery.invalidatedArtifacts || []), { type: 'decision', id: `decision.${revertedCandidateId}` }, ...(state.publishedAssets || []).map((asset) => ({ type: 'knowledge', id: `${asset.id}@${asset.version}` }))],
    };
    appendRuntimeEvent(state, 'decision.adoption_reverted', { from: revertedCandidateId, to: previousBest.candidateId || 'baseline', checkpointId: checkpoint.id }, { kind: 'recovery', mode: 'client' });
    appendRuntimeEvent(state, 'knowledge.assets_superseded', { assets: state.publishedAssets.map((asset) => `${asset.id}@${asset.version}`) }, { kind: 'knowledge', mode: 'client' });
    addAuditEvent(state, '已回退到上一稳定版本', `${revertedCandidateId} → ${previousBest.version || 'baseline'} · ${checkpoint.id}`, 'warning', 'History');
    json(response, 200, { state: await saveState(state), recovery, repositoryRevert });
    return;
  }
  if (request.method === 'PATCH' && url.pathname.startsWith('/api/knowledge/drafts/')) {
    const state = await loadRuntimeState();
    guardMutation(state);
    const draftId = decodeURIComponent(url.pathname.slice('/api/knowledge/drafts/'.length));
    const body = await readJson(request);
    const index = state.knowledgeDrafts.findIndex((draft) => draft.id === draftId);
    if (index === -1) {
      json(response, 404, { error: '知识草稿不存在。' });
      return;
    }
    if (state.publishedAssets.some((asset) => asset.id === draftId) || state.knowledgeMaintenance?.changes?.some((change) => change.draftId === draftId && change.outcome === 'auto_published')) {
      const error = new Error('知识资产已生成固定版本，不能静默修改；请通过新的维护版本修订。');
      error.status = 409;
      error.code = 'KNOWLEDGE_IMMUTABLE';
      throw error;
    }
    const unsupportedFields = Object.keys(body).filter((field) => !knowledgeDraftWritableFields.has(field));
    if (unsupportedFields.length) {
      const error = new Error(`知识草稿包含不可修改字段：${unsupportedFields.join('、')}。`);
      error.status = 400;
      error.code = 'KNOWLEDGE_PATCH_REJECTED';
      throw error;
    }
    state.knowledgeDrafts[index] = { ...state.knowledgeDrafts[index], ...body, id: draftId };
    json(response, 200, { state: await saveState(state) });
    return;
  }
  if (request.method === 'POST' && url.pathname === '/api/knowledge/publish') {
    json(response, 410, { error: '手工知识发布接口已退役；知识由效果决策触发并按治理策略自动维护。', code: 'KNOWLEDGE_PUBLISH_RETIRED' });
    return;
  }
  if (request.method === 'POST' && url.pathname === '/api/knowledge/publish-all') {
    json(response, 410, { error: '批量手工发布接口已退役；知识由效果决策触发并按治理策略自动维护。', code: 'KNOWLEDGE_PUBLISH_RETIRED' });
    return;
  }
  if (request.method === 'POST' && url.pathname === '/api/knowledge/references') {
    const state = await loadRuntimeState();
    guardMutation(state);
    const body = await readJson(request);
    if (!body.assetId || !body.title || !body.version) {
      json(response, 400, { error: '引用知识资产需要 assetId、title 和 version。' });
      return;
    }
    const reference = {
      assetId: body.assetId,
      missionId: state.activeMissionId,
      version: body.version,
      referencedAt: new Date().toISOString(),
      reason: body.reason || '由工程师从组织知识库引用',
    };
    state.knowledgeReferences = [reference, ...(state.knowledgeReferences || []).filter((item) => !(item.assetId === reference.assetId && item.missionId === reference.missionId))];
    appendRuntimeEvent(state, 'knowledge.referenced', reference, { kind: 'knowledge', mode: 'client' });
    addAuditEvent(state, '知识资产已引用到当前任务', `${body.assetId}@${body.version} · ${body.title}`, 'green', 'BookOpen');
    json(response, 200, { state: await saveState(state), reference });
    return;
  }
  if (request.method === 'PATCH' && url.pathname === '/api/state') {
    const state = await loadRuntimeState();
    const body = await readJson(request);
    if (body.testMatrix && (!Array.isArray(body.testMatrix.environments) || !body.testMatrix.environments.length || !Array.isArray(body.testMatrix.stages) || !body.testMatrix.stages.length)) {
      json(response, 400, { error: '测试矩阵至少需要一个环境和一个验证阶段。' });
      return;
    }
    for (const key of ['testMatrix', 'workspace', 'unreadCount', 'missionPaused']) {
      if (Object.hasOwn(body, key)) state[key] = body[key];
    }
    json(response, 200, { state: await saveState(state) });
    return;
  }
  if (request.method === 'POST' && url.pathname === '/api/reset') {
    await guardSupportedRuntimeAction('Demo Reset');
    json(response, 200, { state: await resetDemoData() });
    return;
  }
  json(response, 404, { error: 'API endpoint not found.' });
}

const mimeTypes = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json; charset=utf-8' };

async function serveStatic(response, url) {
  if (!serveWeb) {
    json(response, 404, { error: 'Web serving disabled in API-only mode.' });
    return;
  }
  const requested = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname.slice(1));
  let target = path.resolve(distDir, requested);
  if (target !== distDir && !target.startsWith(`${distDir}${path.sep}`)) {
    json(response, 403, { error: 'Forbidden path.' });
    return;
  }
  try {
    if (!(await stat(target)).isFile()) throw new Error('not a file');
  } catch {
    target = path.join(distDir, 'index.html');
  }
  const content = await readFile(target);
  response.writeHead(200, { 'Content-Type': mimeTypes[path.extname(target)] || 'application/octet-stream' });
  response.end(content);
}

await ensureStorage();
await mkdir(path.dirname(serverPidPath), { recursive: true });
await writeFile(serverPidPath, `${process.pid}\n`, 'ascii');
let apiQueue = Promise.resolve();
const enqueueApiRequest = (task) => {
  const queued = apiQueue.then(task, task);
  apiQueue = queued.catch(() => {});
  return queued;
};
const server = createServer(async (request, response) => {
  const url = new URL(request.url, `http://${request.headers.host || '127.0.0.1'}`);
  try {
    if (url.pathname.match(/^\/api\/missions\/[^/]+\/events\/stream$/)) await handleApi(request, response, url);
    else if (url.pathname.startsWith('/api/')) await enqueueApiRequest(() => handleApi(request, response, url));
    else await serveStatic(response, url);
  } catch (error) {
    console.error('[client-runtime]', error);
    json(response, error.status || 500, { error: error.message || 'Internal server error.', ...(error.code ? { code: error.code } : {}), ...(error.details ? { details: error.details } : {}) });
  }
});

server.listen(port, '127.0.0.1', () => {
  console.log(`[client-runtime] ${serveWeb ? 'web + local api' : 'local api'} listening on http://127.0.0.1:${port}`);
});

let shuttingDown = false;
const shutdown = () => {
  if (shuttingDown) return;
  shuttingDown = true;
  server.close(() => process.exit(0));
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
