import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rename, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeOperatorLanguage } from './operator-language.mjs';
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
  baselineDirForMission,
  ensureStorage,
  buildBenchmarkLogsForMatrix,
  loadState,
  resetDemoData,
  rebuildMissionWorkspaceFromRepository,
  resetMissionWorkspace,
  restoreWorkspaceCheckpoint,
  runAutomaticAdoption,
  markCandidateAccepted,
  normalizeMissionBudgetMs,
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
import { agentRuntime, appendRuntimeEvent, isManagedWorkspaceRuntimeMode, isResearchAgentActive } from './agent-runtime.mjs';
import { advanceIteration, selectResearchDirection } from './iteration-loop.mjs';
import { createCommandJournal, executeCommand, hashKey } from './command-journal.mjs';
import { testServiceClient } from './test-service-client.mjs';
import { createOperatorTestQueue } from './operator-test-queue.mjs';
import { consumeWorkflowRecoveryBudget, reconcileWorkflowState } from './workflow-kernel.mjs';
import { createLocalC500ServiceClient, localC500Config } from './local-c500-service-client.mjs';
import { migrateLocalC500TesterState } from './local-c500-state-migration.mjs';
import { LOCAL_C500_RUNTIME_CONTRACT_VERSION } from './local-c500-runtime-contract.mjs';
import { workspaceManager } from './workspace-manager.mjs';
import { assertMissionIntent } from './mission-intent.mjs';
import { nativeDirectoryPicker } from './native-directory-picker.mjs';
import { dataDir } from './storage-paths.mjs';
import { isFixedOperatorMission } from './fixed-operator-profiles.mjs';
import {
  baselineMatchesMatrix,
  buildSemanticBaselineSource,
  inferAuthoritativeBaselineSource,
  isSemanticBaselineSource,
  isStrictZeroSourceMission,
  missionShapeKeyFor,
  normalizeBaselineKind,
  resolveBaselineRunPlan,
  selectResearchBaselineSource,
} from './baseline-resolver.mjs';

const serverDir = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(serverDir, '..');
const distDir = path.join(rootDir, 'dist');
const serverPidPath = path.join(runtimeDir, 'operator-studio.pid');
const port = Number(process.env.API_PORT || process.env.PORT || 4173);
const serveWeb = process.env.SERVE_WEB !== 'false';
const startedAt = new Date().toISOString();
const bridge = {
  schemaVersion: 1,
  service: 'operator-studio-client-runtime',
  pid: process.pid,
  port,
  apiUrl: `http://127.0.0.1:${port}`,
  serveWeb,
  dataDir,
  runtimeDir,
  runtimeContractVersion: LOCAL_C500_RUNTIME_CONTRACT_VERSION,
  startedAt,
};
const activeTestServiceClient = localC500Config.enabled
  ? createLocalC500ServiceClient()
  : testServiceClient;
const operatorTestQueue = createOperatorTestQueue({ serviceClient: activeTestServiceClient });
const commandJournal = createCommandJournal({ filePath: path.join(runtimeDir, 'command-journal.jsonl') });

const inferMissionMatrix = (mission = {}, fallback = {}) => {
  const text = `${mission.title || ''} ${mission.goal || ''} ${(mission.hardware || []).join(' ')}`.toLowerCase();
  const environments = /iluvatar|天数|mr-v100|gpu-iluvatar-mainstream/.test(text)
    ? ['gpu-iluvatar-mainstream']
    : /ascend|昇腾|910/.test(text)
      ? ['npu-ascend-910']
      : Array.isArray(fallback.environments) && fallback.environments.length
        ? fallback.environments
        : Array.isArray(mission.hardware) && mission.hardware.length
          ? mission.hardware
          : ['gpu-iluvatar-mainstream'];
  const shape = !isStrictZeroSourceMission(mission) && /paged[_\s-]*attention|paged attention/i.test(`${mission.title || ''} ${mission.goal || ''}`)
    ? { batch: 1, num_heads: 4, seq_len: 128, head_dim: 1024 }
    : fallback.shape || mission.upstream?.case || undefined;
  return {
    ...structuredClone(fallback || {}),
    environments,
    stages: Array.isArray(fallback.stages) && fallback.stages.length ? fallback.stages : ['Correctness', 'Full Benchmark'],
    warmup: Number(fallback.warmup || 50),
    repeats: Number(fallback.repeats || 200),
    correctnessCases: Number(fallback.correctnessCases || 24),
    ...(shape ? { shape } : {}),
  };
};

const hasSourceContent = async (sourceRoot) => {
  if (!sourceRoot) return false;
  try {
    const entries = await readdir(sourceRoot).catch(() => []);
    return entries.filter((name) => name !== '.git').length > 0;
  } catch { return false; }
};

const readMissionRunPy = async (missionId, repository, projectRoot = null, implementation = null) => {
  const workspace = await ensureMissionWorkspace(missionId, repository, { projectRoot });
  const candidates = [
    path.join(workspace, 'run.py'),
    path.join(workspace, 'operator', 'run.py'),
  ];
  for (const filePath of candidates) {
    try {
      const source = path.relative(workspace, filePath).replaceAll('\\', '/');
      const adapter = normalizeOperatorLanguage(implementation);
      const implementationFiles = {};
      for (const relativePath of adapter.allowedFiles.filter((file) => file !== source)) {
        try {
          implementationFiles[relativePath] = await readFile(path.join(workspace, relativePath), 'utf8');
        } catch (error) {
          if (error.code !== 'ENOENT') throw error;
        }
      }
      return { content: await readFile(filePath, 'utf8'), source, implementationFiles };
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  return { content: null, source: null };
};

const buildRuntimePreflight = async (mission) => {
  const workspace = await ensureMissionWorkspace(mission.id, mission.repository, { projectRoot: mission.projectRoot, sourceRoot: mission.sourceRoot });
  let [workspaceCheck, agentCheck] = await Promise.all([
    workspaceManager.inspect(workspace, { refresh: true }),
    agentRuntime.preflight({ workspace }),
  ]);
  // 空基线：若 sources/（Source Registry）已有参考资料（研究员已拉取），视为"从参考迁移"场景，
  // 允许主 agent 从空工作区起步、从 sources/ 参考资料构建迁移对象；否则阻断。
  // 注意：inspect 返回的是缓存对象，绝不能原地改（会污染 inspectionCache，导致后续 loadState 抛错）；
  // 用副本标记 ready:false。
  const sourceInspection = isStrictZeroSourceMission(mission)
    ? await workspaceManager.inspectSources(mission.sourceRoot)
    : null;
  const migrationFromSource = workspaceCheck.baselineEmpty && (isStrictZeroSourceMission(mission)
    ? sourceInspection?.ready === true && sourceInspection.sources.length > 0
    : await hasSourceContent(mission.sourceRoot));
  if (workspaceCheck.ready && workspaceCheck.baselineEmpty && !migrationFromSource) {
    workspaceCheck = { ...workspaceCheck, ready: false, code: 'WORKSPACE_BASELINE_EMPTY', detail: 'Iteration Repository 基线为空，Mission 工作区没有可供 Agent 检查的源码或测试文件。请先把项目文件放入 repository，或重新选择包含代码的 Git 仓库。' };
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
    sourceInspection,
    agentCheck,
    checkedAt: new Date().toISOString(),
  };
};

const json = (response, status, payload) => {
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Operator-Studio-Bridge': `${bridge.pid}:${bridge.port}`,
  });
  response.end(JSON.stringify({ ...payload, __bridge: bridge }));
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
      const revision = String(state.stateVersion ?? '') || state.updatedAt || `${state.agent?.runId || ''}:${state.benchmark?.status || ''}:${state.benchmark?.progress || 0}`;
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
  const budgetMs = normalizeMissionBudgetMs(state.missionBudgetMs);
  state.missionBudgetMs = budgetMs;
  if (!budgetMs) {
    state.missionBudgetStartedAt = null;
    return;
  }
  if (!state.missionBudgetStartedAt) {
    state.missionBudgetStartedAt = new Date().toISOString();
    return;
  }
  const startedAtMs = Date.parse(state.missionBudgetStartedAt);
  if (!Number.isFinite(startedAtMs)) {
    state.missionBudgetStartedAt = new Date().toISOString();
    return;
  }
  const elapsedMs = Date.now() - startedAtMs;
  if (elapsedMs >= budgetMs) {
    const error = new Error('Mission 时间预算已耗尽，请调整预算后继续。');
    error.status = 409;
    error.code = 'MISSION_BUDGET_EXCEEDED';
    error.details = { budgetMs, elapsedMs, startedAt: state.missionBudgetStartedAt };
    throw error;
  }
};

const missionBudgetRawValue = (valueOrInput) => {
  if (!valueOrInput || typeof valueOrInput !== 'object' || Array.isArray(valueOrInput)) return valueOrInput;
  if (Object.hasOwn(valueOrInput, 'missionBudgetMs')) return valueOrInput.missionBudgetMs;
  if (Object.hasOwn(valueOrInput, 'timeBudgetMs')) return valueOrInput.timeBudgetMs;
  if (Object.hasOwn(valueOrInput, 'missionBudgetHours')) return Number(valueOrInput.missionBudgetHours) * 60 * 60 * 1000;
  if (Object.hasOwn(valueOrInput, 'timeBudgetHours')) return Number(valueOrInput.timeBudgetHours) * 60 * 60 * 1000;
  return null;
};
const hasMissionBudgetInput = (valueOrInput) => Boolean(valueOrInput && typeof valueOrInput === 'object' && !Array.isArray(valueOrInput) && ['missionBudgetMs', 'timeBudgetMs', 'missionBudgetHours', 'timeBudgetHours'].some((key) => Object.hasOwn(valueOrInput, key)));
const isMissionBudgetDisableValue = (valueOrInput) => {
  if (!hasMissionBudgetInput(valueOrInput) && valueOrInput && typeof valueOrInput === 'object' && !Array.isArray(valueOrInput)) return true;
  const raw = missionBudgetRawValue(valueOrInput);
  return raw === null || raw === undefined || raw === '' || raw === false || Number(raw) === 0;
};
const validateMissionBudgetInput = (valueOrInput) => {
  if (isMissionBudgetDisableValue(valueOrInput)) return { ok: true, value: null };
  const normalized = normalizeMissionBudgetMs(valueOrInput);
  return normalized ? { ok: true, value: normalized } : { ok: false, value: null };
};

const guardSupportedRuntimeAction = async (action) => {
  const runtime = await agentRuntime.describe();
  if (runtime.mode === 'reference-fixture') return runtime;
  // Codex owns reasoning and workspace changes; all workflow decisions remain
  // client-owned so the local harness can inspect, pause, adopt, redirect, and
  // roll back a verified candidate without asking the Agent adapter to mutate state.
  if (isManagedWorkspaceRuntimeMode(runtime.mode)) return runtime;
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

// 命令注册表：keyFor（幂等键）、prepare（外部副作用，返回 payload+result）、apply（纯状态变换）、isApplied（去重精确化）。
// apply 必须是纯状态函数：崩溃恢复 reconcile 会用它重放，绝不能再次触发 spawn/提交/文件写入。
const commandRegistry = {
  'apply-patch': {
    keyFor: (state, body) => `apply-patch:${state.activeMissionId}:${body?.candidate || state.appliedCandidateId}`,
    isApplied: (state, payload) => state.patchApplied === true && state.appliedCandidateId === payload?.candidateId,
    prepare: async ({ state, body }) => {
      const runtime = await agentRuntime.describe();
      const candidate = (state.candidateEvaluations || []).find((item) => item.id === body.candidate);
      const declaredFiles = String(candidate?.files || '').split(',').map((item) => item.trim()).filter(Boolean);
      const codexPatch = isManagedWorkspaceRuntimeMode(runtime.mode) ? await workspaceManager.captureDiff(await ensureMissionWorkspace(state.activeMissionId)) : null;
      const actualFiles = (codexPatch?.changedFiles || []).map((file) => file.replaceAll('\\', '/'));
      const normalizedDeclaredFiles = declaredFiles.map((file) => file.replaceAll('\\', '/'));
      const undeclaredFiles = actualFiles.filter((file) => !normalizedDeclaredFiles.includes(file));
      const missingFiles = normalizedDeclaredFiles.filter((file) => !actualFiles.includes(file));
      const codexPolicyChecks = isManagedWorkspaceRuntimeMode(runtime.mode) ? [
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
      const checkpoint = isManagedWorkspaceRuntimeMode(runtime.mode) && state.workflowRecovery?.checkpoints?.length
        ? state.workflowRecovery.checkpoints.at(-1)
        : await createWorkspaceCheckpoint(state.activeMissionId, 'candidate', body.candidate);
      const workspace = isManagedWorkspaceRuntimeMode(runtime.mode)
        ? { workspace: path.relative(rootDir, codexPatch.workspace).replaceAll('\\', '/'), files: actualFiles.map((file) => ({ path: file, status: 'modified' })), digest: codexPatch.digest, diff: codexPatch.diff }
        : await applyCandidatePatch(state.activeMissionId);
      const appliedDiff = codexPatch || await workspaceManager.captureDiff(await ensureMissionWorkspace(state.activeMissionId));
      if (!isManagedWorkspaceRuntimeMode(runtime.mode)) workspace.digest = appliedDiff.digest, workspace.diff = appliedDiff.diff;
      const mission = state.missions.find((item) => item.id === state.activeMissionId) || {};
      const artifactDir = artifactDirForMission(state.activeMissionId, mission.repository, mission.projectRoot);
      await mkdir(artifactDir, { recursive: true });
      const patchPath = path.join(artifactDir, `${body.candidate}.patch`);
      const manifestPath = path.join(artifactDir, `${body.candidate}.manifest.json`);
      const sourceReferences = Array.isArray(candidate?.sourceReferences) ? candidate.sourceReferences : [];
      await writeFile(patchPath, appliedDiff.diff, 'utf8');
      await writeFile(manifestPath, `${JSON.stringify({ schemaVersion: 1, missionId: state.activeMissionId, candidateId: body.candidate, digest: appliedDiff.digest, files: appliedDiff.changedFiles, sourceReferences, sourceRunId: state.agent.runId, createdAt: new Date().toISOString() }, null, 2)}\n`, 'utf8');
      if (mission.sourceRoot && mission.runtimeRoot) await workspaceManager.updateSourceRegistry({ sourceRoot: mission.sourceRoot, runtimeRoot: mission.runtimeRoot, missionId: state.activeMissionId, references: sourceReferences });
      return {
        payload: { candidateId: body.candidate, checkpoint, workspace, digest: appliedDiff.digest, files: actualFiles, sourceReferences, artifacts: { patch: patchPath, manifest: manifestPath }, policyChecks, runtimeMode: runtime.mode },
        result: { workspace, policyChecks },
      };
    },
    apply: (state, payload) => {
      const candidate = (state.candidateEvaluations || []).find((item) => item.id === payload.candidateId);
      candidate.patchDigest = payload.digest;
      candidate.sourceRunId = state.agent.runId;
      if (isManagedWorkspaceRuntimeMode(payload.runtimeMode)) candidate.files = payload.files.join(', ');
      candidate.artifacts = payload.artifacts;
      state.patchApplied = true;
      state.appliedCandidateId = payload.candidateId;
      state.stage = 'validation';
      state.workflowRecovery = {
        ...(state.workflowRecovery || {}),
        previousBest: state.workflowRecovery?.previousBest || structuredClone(state.currentBest || { candidateId: null, version: 'baseline', value: '--', improvement: '--', status: 'active' }),
        worktree: { ...(state.workflowRecovery?.worktree || {}), candidateId: payload.candidateId, status: 'active', activatedAt: new Date().toISOString() },
        checkpoints: [...(state.workflowRecovery?.checkpoints || []).filter((item) => item.id !== payload.checkpoint.id), payload.checkpoint].slice(-5),
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
      appendRuntimeEvent(state, 'patch.applied', { workspace: payload.workspace.workspace, checkpointId: payload.checkpoint.id, files: payload.workspace.files.map((file) => file.path), digest: payload.digest || null, artifacts: payload.artifacts, sourceReferences: payload.sourceReferences, policyChecks: payload.policyChecks, approvalRequired: false, mock: false }, { kind: 'workspace', mode: isManagedWorkspaceRuntimeMode(payload.runtimeMode) ? payload.runtimeMode : 'client' });
      addAuditEvent(state, 'Patch 自动策略检查通过', `${payload.workspace.workspace} · ${payload.candidateId} · 无需人工审批`, 'green', 'ShieldCheck');
    },
  },
  'start-benchmark': {
    keyFor: (state, body) => `benchmark:${state.activeMissionId}:${body?.purpose || body?.testPurpose || 'candidate'}:${body?.candidate || state.appliedCandidateId}:${body?.candidateDigest || (state.candidateEvaluations || []).find((c) => c.id === (body?.candidate || state.appliedCandidateId))?.patchDigest}:${hashKey(JSON.stringify(body?.matrix || state.testMatrix))}`,
    isApplied: (state, payload) => state.benchmark?.status === 'running'
      && state.benchmark?.purpose === payload?.purpose
      && (payload?.purpose === 'baseline' || state.appliedCandidateId === payload?.candidateId)
      && JSON.stringify(state.benchmark?.matrix || {}) === JSON.stringify(payload?.matrix || {}),
    prepare: async ({ state, body }) => {
      const matrix = body.matrix || state.testMatrix;
      const runId = `run_${Date.now().toString(36).toUpperCase()}_${randomUUID().slice(0, 8).toUpperCase()}`;
      const mission = state.missions.find((item) => item.id === state.activeMissionId) || {};
      const purpose = body.purpose === 'baseline' || body.testPurpose === 'baseline' ? 'baseline' : 'candidate';
      const normalizedMatrix = {
        ...structuredClone(matrix),
        warmup: Number(body.warmup ?? matrix.warmup ?? 50),
        repeats: Number(body.repeats ?? matrix.repeats ?? 200),
        correctnessCases: Number(body.correctnessCases ?? matrix.correctnessCases ?? matrix.testSpec?.correctness?.requestedCases ?? 24),
      };
      const baselinePlan = purpose === 'baseline'
        ? await resolveBaselineRunPlan({ state, mission, body, matrix: normalizedMatrix, readMissionRunPy })
        : null;
      const baselineKind = baselinePlan?.baselineKind || null;
      const baselineSource = baselinePlan?.baselineSource || null;
      const candidateId = purpose === 'baseline' ? baselinePlan.candidateId : (body.candidate || state.appliedCandidateId);
      const appliedCandidate = (state.candidateEvaluations || []).find((candidate) => candidate.id === candidateId);
      const baselineDigestSeed = baselinePlan?.digestSeed || '';
      const candidateDigest = body.candidateDigest || appliedCandidate?.patchDigest || (purpose === 'baseline' ? `sha256:baseline-${hashKey(String(baselineDigestSeed))}` : null);
      if (!candidateDigest) {
        const error = new Error('候选缺少由真实工作区 Diff 生成的 digest，不能提交测试。');
        error.status = 409;
        error.code = 'TEST_CANDIDATE_DIGEST_MISSING';
        throw error;
      }
      if (purpose !== 'baseline' && !baselineMatchesMatrix(state.baseline || mission.baseline || {}, mission, normalizedMatrix)) {
        const error = new Error('优化候选测试前必须先完成当前有效 baseline：同一 runner、同一输入 shape、单文件 run.py。');
        error.status = 409;
        error.code = 'BASELINE_REQUIRED_BEFORE_CANDIDATE';
        error.details = {
          baselineStatus: state.baseline?.status || mission.baseline?.status || 'missing',
          expectedKind: state.baseline?.kind || mission.baseline?.kind || 'pytorch_reference',
          expectedShapeKey: missionShapeKeyFor(mission, normalizedMatrix),
          requestedEnvironments: normalizedMatrix.environments || mission.hardware || [],
        };
        throw error;
      }
      const missionRunPy = purpose === 'baseline'
        ? { content: baselinePlan.runPy, source: baselinePlan.runPySource }
        : await readMissionRunPy(state.activeMissionId, mission.repository, mission.projectRoot, mission.implementation);
      const submitted = await operatorTestQueue.submit({
        schemaVersion: 1, requestId: runId, missionId: state.activeMissionId,
        purpose, baselineKind,
        operator: body.operator || 'mla_paged_attention', candidate: { id: candidateId, digest: candidateDigest, remoteId: body.remoteCandidateId || null },
        hardware: mission.hardware || matrix.environments, runtime: body.runtime || 'client-managed-runtime', metric: mission.metric || 'latency_p50',
        matrix: normalizedMatrix, tracer: { enabled: true, format: 'operator-trace/v1' }, profiler: { enabled: true, format: 'operator-profile/v1' },
        limits: { timeoutSeconds: Number(body.timeoutSeconds || 120) },
        ...(baselineSource ? { baselineSource } : {}),
        ...(baselinePlan?.materializationReport ? { baselineMaterialization: baselinePlan.materializationReport } : {}),
        ...(missionRunPy.content ? { runPy: missionRunPy.content, runPySource: missionRunPy.source } : {}),
        ...(purpose !== 'baseline' && state.baseline?.materializer?.result?.runPy ? { oracleRunPy: state.baseline.materializer.result.runPy } : {}),
        ...(purpose !== 'baseline' && isFixedOperatorMission(mission) && (state.baseline?.source || mission.baseline?.source) ? { baselineSource: state.baseline?.source || mission.baseline?.source } : {}),
        ...(Object.keys(missionRunPy.implementationFiles || {}).length ? { implementationFiles: missionRunPy.implementationFiles } : {}),
        ...(body.packageId ? { packageId: body.packageId } : {}),
        ...(body.remoteCandidateId ? { remoteCandidateId: body.remoteCandidateId } : {}),
      });
      return {
        payload: { runId, taskId: submitted.taskId, purpose, baselineKind, baselineSource, baselineResolution: baselinePlan?.resolution || null, baselineMaterialization: baselinePlan?.materializationReport || null, matrix: structuredClone(matrix), normalizedMatrix, candidateId, candidateDigest, environments: matrix.environments, stages: matrix.stages, submittedAt: submitted.submittedAt },
        result: { runId, taskId: submitted.taskId },
      };
    },
    apply: (state, payload) => {
      state.testMatrix = structuredClone(payload.matrix);
      state.stage = 'validation';
      state.benchmark = {
        status: 'running', progress: 0, runId: payload.runId, startedAt: payload.submittedAt || new Date().toISOString(), completedAt: null, durationMs: 0,
        logs: [{ sequence: 1, progress: 0, message: `调度器已锁定 ${payload.environments.length} 个环境快照` }], matrix: structuredClone(payload.matrix),
        purpose: payload.purpose, baselineKind: payload.baselineKind, baselineSource: payload.baselineSource ? structuredClone(payload.baselineSource) : null, baselineMaterialization: payload.baselineMaterialization ? structuredClone(payload.baselineMaterialization) : null,
        candidate: { id: payload.candidateId, digest: payload.candidateDigest }, testTaskId: payload.taskId, result: null,
        source: {
          kind: localC500Config.enabled ? 'local-c500-adapter' : 'operator-test-service',
          transport: 'local-serial-queue',
          mock: localC500Config.enabled ? localC500Config.mock : true,
          liveHardware: localC500Config.enabled ? !localC500Config.mock : false,
        },
        lastServiceError: null,
      };
      if (payload.purpose === 'baseline') {
        state.baseline = {
          ...(state.baseline || { required: true, status: 'missing', sourcePolicy: { requireAuthority: true, requireSingleFileExpansion: true } }),
          kind: normalizeBaselineKind(payload.baselineKind),
          status: 'running',
          source: payload.baselineSource ? structuredClone(payload.baselineSource) : state.baseline?.source || null,
          resolution: payload.baselineResolution
            ? structuredClone(payload.baselineResolution)
            : {
              ...(state.baseline?.resolution || {}),
              status: 'running',
              strategy: payload.baselineKind === 'naive_v0' ? 'fallback_naive_v0' : 'authoritative_first',
              kind: normalizeBaselineKind(payload.baselineKind),
              attemptedAuthority: payload.baselineKind !== 'naive_v0',
              reused: false,
              reason: payload.baselineKind === 'naive_v0' ? '权威 baseline 不可用，使用 v0 fallback。' : '正在执行权威 baseline。',
              resolvedAt: null,
              previousEvidenceRunId: null,
            },
        };
      }
      const title = payload.purpose === 'baseline'
        ? (normalizeBaselineKind(payload.baselineKind) === 'naive_v0' ? 'naive v0 baseline 已提交' : 'PyTorch reference baseline 已提交')
        : 'Full Benchmark 已提交';
      state.agent = { ...state.agent, status: 'executing', phase: payload.purpose === 'baseline' ? 'Baseline 验证' : '异构验证', currentAction: null, messages: [...(state.agent?.messages || []), { id: `test-${payload.runId}`, phase: 'validation', status: 'running', title: 'Validation Agent 已提交测试矩阵', detail: `${payload.runId} 正在 ${payload.environments.length} 个固定环境中执行。`, time: '刚刚' }] };
      appendRuntimeEvent(state, 'operator_test.queued', { runId: payload.runId, taskId: payload.taskId, purpose: payload.purpose, baselineKind: payload.baselineKind, baselineSource: payload.baselineSource, baselineMaterialization: payload.baselineMaterialization, candidate: { id: payload.candidateId, digest: payload.candidateDigest }, environments: payload.environments, stages: payload.stages, matrix: structuredClone(payload.matrix) }, { kind: 'operator-test-queue', mode: 'client' });
      addAuditEvent(state, title, `${payload.runId} · ${payload.environments.length} environments`, 'blue', 'TestTube2');
    },
  },
  'resume-mission': {
    keyFor: (state, body) => `resume-mission:${state.activeMissionId}:${state.stage}:${state.candidateEvaluations?.[0]?.patchDigest || 'no-candidate'}:${body?.missionBudgetMs ?? body?.missionBudgetHours ?? 'keep'}`,
    isApplied: (state, payload) => state.stage === 'candidate'
      && state.agent?.status === 'awaiting_action'
      && state.missionBudgetStartedAt === payload?.missionBudgetStartedAt,
    prepare: async ({ state, body }) => {
      const mission = state.missions.find((item) => item.id === state.activeMissionId) || {};
      const hasCandidate = Array.isArray(state.candidateEvaluations) && state.candidateEvaluations.length > 0;
      const currentBestEmpty = !state.currentBest?.candidateId && (!state.currentBest?.value || state.currentBest.value === '--' || state.currentBest.value === '—');
      const budgetEnded = state.stage === 'published'
        && state.agent?.phase === 'Mission budget 已到，保留 current best'
        && currentBestEmpty
        && hasCandidate;
      if (!budgetEnded) {
        const error = new Error('当前 Mission 不满足预算兜底恢复条件。');
        error.status = 409;
        error.code = 'MISSION_RESUME_NOT_APPLICABLE';
        error.details = { stage: state.stage, agentPhase: state.agent?.phase || null, currentBest: state.currentBest || null, candidateCount: state.candidateEvaluations?.length || 0 };
        throw error;
      }
      const requestedBudget = hasMissionBudgetInput(body)
        ? validateMissionBudgetInput(body)
        : { ok: true, value: normalizeMissionBudgetMs(state.missionBudgetMs) || 5 * 60 * 60 * 1000 };
      if (!requestedBudget.ok) {
        const error = new Error('missionBudgetMs 必须是正数毫秒；传 null、空值或 0 表示不启用时间限制。');
        error.status = 400;
        error.code = 'INVALID_MISSION_BUDGET';
        throw error;
      }
      return {
        payload: {
          missionId: state.activeMissionId,
          missionTitle: mission.title || state.activeMissionId,
          candidateId: state.candidateEvaluations[0].id || 'candidate-01',
          candidateDigest: state.candidateEvaluations[0].patchDigest || null,
          missionBudgetMs: requestedBudget.value,
          missionBudgetStartedAt: new Date().toISOString(),
        },
      };
    },
    apply: (state, payload) => {
      state.stage = 'candidate';
      state.patchApplied = false;
      state.missionPaused = false;
      state.missionBudgetMs = payload.missionBudgetMs;
      state.missionBudgetStartedAt = payload.missionBudgetStartedAt;
      state.benchmark = { ...(state.benchmark || {}), status: 'idle', progress: 0, runId: null, testTaskId: null, startedAt: null, completedAt: null, durationMs: 0, logs: [], result: null, lastServiceError: null };
      state.decisionReview = createDecisionReviewState('idle');
      state.iterationStats = { ...(state.iterationStats || {}), loopStatus: 'running', loopStatusReason: null };
      state.agent = {
        ...(state.agent || {}),
        status: 'awaiting_action',
        phase: 'Candidate Plan 已生成',
        progress: 100,
        currentAction: {
          id: `action.${payload.candidateId}.resume`,
          type: 'candidate.plan',
          title: `提交 ${payload.candidateId} 测试`,
          reason: 'Mission 预算兜底结束后恢复：保留已有单文件候选，刷新预算窗口并继续真实 runner 验证。',
          expectedOutput: 'Correctness · Benchmark · Tracer · Profiler',
          risk: 'medium',
          approvalRequired: false,
          approvalPolicy: 'client-controlled',
        },
      };
      appendRuntimeEvent(state, 'mission.resumed_after_budget', { missionId: payload.missionId, candidateId: payload.candidateId, candidateDigest: payload.candidateDigest, missionBudgetMs: payload.missionBudgetMs, missionBudgetStartedAt: payload.missionBudgetStartedAt }, { kind: 'mission', mode: 'client' });
      addAuditEvent(state, 'Mission 已从预算结束态恢复', `${payload.missionTitle} · ${payload.candidateId} · budget ${payload.missionBudgetMs ? `${Math.round(payload.missionBudgetMs / 60 / 60 / 1000)}h` : 'none'}`, 'blue', 'RefreshCw');
    },
  },
  'adopt': {
    keyFor: (state) => `adopt:${state.activeMissionId}:${state.appliedCandidateId || state.decisionReview?.candidateId}`,
    isApplied: (state) => state.knowledgeMaintenance?.status === 'completed' && state.publishedAssets?.length === state.knowledgeDrafts?.length,
    apply: (state, payload) => { adoptCandidateState(state, payload?.note || '证据完整且未命中人工复核信号。', 'policy'); },
    prepare: async ({ body }) => ({ payload: { note: body?.note || '' }, result: null }),
  },
  'reject': {
    keyFor: (state) => `reject:${state.activeMissionId}:${state.appliedCandidateId || state.decisionReview?.candidateId}`,
    isApplied: (state) => state.decisionReview?.resolution?.outcome === 'supplement' && state.decisionReview?.resolution?.source === 'direct_action',
    apply: (state) => {
      state.stage = 'validation';
      state.benchmark = { status: 'idle', progress: 0, runId: null, startedAt: null, completedAt: null, durationMs: 2600, logs: [] };
      state.decisionReview = { ...createDecisionReviewState('resolved'), recommendation: null, resolution: { outcome: 'supplement', source: 'direct_action', note: '需要补充验证', resolvedAt: new Date().toISOString() } };
      state.agent = { ...state.agent, status: 'awaiting_action', phase: '补充验证', currentAction: { id: 'action.revalidation', type: 'test.plan', title: '运行补充验证矩阵', reason: '效果决策要求补充验证。', expectedOutput: 'Updated Full Benchmark · refreshed Level 3 evidence', risk: 'medium', approvalRequired: false } };
      const candidateId = state.appliedCandidateId || state.decisionReview?.candidateId;
      appendRuntimeEvent(state, 'decision.revalidation_requested', { candidate: candidateId || null, reason: '需要补充验证' }, { kind: 'policy', mode: 'client' });
      addAuditEvent(state, '候选退回验证', `${candidateId || '当前候选'} · 需要补充验证`, 'warning', 'TriangleAlert');
    },
  },
  'rollback-stage': {
    keyFor: (state) => `rollback-stage:${state.activeMissionId}:${state.workflowRecovery?.checkpoints?.at(-1)?.id || 'none'}`,
    isApplied: (state) => state.stage === 'candidate' && state.patchApplied === false,
    prepare: async ({ state }) => {
      const checkpoint = state.workflowRecovery?.checkpoints?.at(-1);
      const recovery = await restoreWorkspaceCheckpoint(checkpoint, state.activeMissionId);
      return { payload: { checkpointId: checkpoint.id, recovery }, result: { recovery } };
    },
    apply: (state, payload) => {
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
        messages: [...(state.agent?.messages || []), { id: `rollback-${Date.now()}`, phase: 'candidate', status: 'completed', title: '已返回补丁应用前', detail: `${payload.checkpointId} 已恢复，${invalidatedArtifacts.length} 个后续工件已失效。`, time: '刚刚' }],
      };
      state.workflowRecovery = {
        ...state.workflowRecovery,
        worktree: { ...state.workflowRecovery.worktree, status: 'restored' },
        lastRecovery: { type: 'stage_rollback', from: 'validation_or_evidence', to: 'candidate', checkpointId: payload.checkpointId, restoredAt: payload.recovery.restoredAt },
        invalidatedArtifacts: [...(state.workflowRecovery.invalidatedArtifacts || []), ...invalidatedArtifacts],
      };
      appendRuntimeEvent(state, 'workflow.stage_rolled_back', { from: 'validation_or_evidence', to: 'candidate', checkpointId: payload.checkpointId, invalidatedArtifacts }, { kind: 'recovery', mode: 'client' });
      addAuditEvent(state, '流程已返回补丁应用前', `${payload.checkpointId} · ${invalidatedArtifacts.length} artifacts invalidated`, 'warning', 'History');
    },
  },
  'request-review': {
    keyFor: (state) => `request-review:${state.activeMissionId}`,
    isApplied: (state) => state.decisionReview?.status === 'awaiting_review',
    apply: (state, payload) => {
      const requestedAt = new Date().toISOString();
      const outcomeMeta = interventionOutcomeMeta[payload.outcome];
      state.decisionReview = {
        ...(state.decisionReview || createDecisionReviewState('auto_ready')),
        status: 'awaiting_review', requiresApproval: true,
        request: { candidateId: payload.candidate || state.appliedCandidateId || null, outcome: payload.outcome, note: payload.note, originStage: payload.originStage, submittedBy: payload.submittedBy || 'Yilin Lu', requestedAt },
        resolution: null, requestedAt, resolvedAt: null,
      };
      state.agent = {
        ...state.agent,
        status: 'awaiting_approval', phase: '人工介入待处理',
        currentAction: { id: 'action.resolve-decision-review', type: 'review.resolve', title: '处理人工介入事项', reason: payload.note, expectedOutput: outcomeMeta.expectedOutput, risk: 'high', approvalRequired: true, reviewMode: 'human_requested' },
        messages: [...(state.agent?.messages || []), { id: `review-${Date.now()}`, phase: 'approval', status: 'waiting', title: '已收到人工介入意见', detail: `${outcomeMeta.label} · ${payload.note}`, time: '刚刚' }],
      };
      appendRuntimeEvent(state, 'decision.review_requested', { candidate: state.appliedCandidateId || state.decisionReview?.candidateId || null, originStage: payload.originStage, outcome: payload.outcome, note: payload.note }, { kind: 'approval', mode: 'client' });
      addAuditEvent(state, '流程已被人工介入阻塞', `${outcomeMeta.label} · ${payload.note}`, 'warning', 'ShieldCheck');
    },
    prepare: async ({ state, body }) => {
      const outcome = ['adopt', 'supplement', 'redirect'].includes(body.outcome) ? body.outcome : 'redirect';
      const allowedOutcomes = state.stage === 'evidence' ? ['adopt', 'supplement', 'redirect'] : state.stage === 'validation' ? ['supplement', 'redirect'] : ['redirect'];
      if (!allowedOutcomes.includes(outcome)) {
        const error = new Error('当前阶段尚不支持该介入指令，请先查看证据状态。');
        error.status = 409; error.code = 'INTERVENTION_OUTCOME_UNAVAILABLE'; throw error;
      }
      const note = String(body.note || '').trim();
      if (note.length < 4) {
        const error = new Error('请填写具体的审批意见后再提交。');
        error.status = 400; error.code = 'DECISION_REVIEW_NOTE_REQUIRED'; throw error;
      }
      return { payload: { outcome, note, candidate: body.candidate || null, originStage: state.stage, submittedBy: body.submittedBy || null }, result: null };
    },
  },
  'cancel-review': {
    keyFor: (state) => `cancel-review:${state.activeMissionId}`,
    isApplied: (state) => !state.decisionReview?.request,
    apply: (state) => {
      const previousRequest = state.decisionReview?.request;
      const candidateId = state.appliedCandidateId || previousRequest?.candidateId || state.decisionReview?.candidateId;
      const restoredStatus = state.stage === 'evidence' ? 'auto_ready' : 'idle';
      const restoredAction = state.stage === 'evidence'
        ? { id: 'action.adoption-decision', type: 'adoption.decision', title: `确认 ${candidateId || '候选'} 的策略建议`, reason: '人工意见已撤回，当前未命中强制复核信号。', expectedOutput: 'Policy Decision · current best update', risk: 'medium', approvalRequired: false, reviewMode: 'conditional' }
        : state.stage === 'validation'
          ? { id: 'action.validation-resumed', type: 'test.plan', title: '继续异构验证', reason: '人工介入已撤回，恢复原验证计划。', expectedOutput: 'Correctness · Full Benchmark · Level 3 evidence', risk: 'medium', approvalRequired: false }
          : { id: 'action.candidate-resumed', type: 'candidate.plan', title: '继续候选自动检查', reason: '人工介入已撤回，恢复原 Candidate Plan 和自动策略。', expectedOutput: 'Candidate Plan · patch proposal', risk: 'medium', approvalRequired: false, approvalPolicy: 'client-controlled' };
      state.decisionReview = { ...createDecisionReviewState(restoredStatus), cancelledRequest: previousRequest || null };
      state.agent = { ...state.agent, status: 'awaiting_action', phase: state.stage === 'evidence' ? '效果策略评估' : state.stage === 'validation' ? '异构验证' : '候选补丁审查', currentAction: restoredAction };
      appendRuntimeEvent(state, 'decision.review_cancelled', { candidate: candidateId || null }, { kind: 'approval', mode: 'client' });
      addAuditEvent(state, '人工审批意见已撤回', '流程恢复为条件式策略决策', 'blue', 'ShieldCheck');
      if (state.stage === 'evidence' && state.benchmark?.status === 'complete') runAutomaticAdoption(state, `人工介入已撤回，Accept Gate 继续按策略自动采用 ${candidateId || '候选'}。`);
    },
  },
  'revert-adoption': {
    keyFor: (state) => `revert-adoption:${state.activeMissionId}:${state.currentBest?.candidateId || state.appliedCandidateId}`,
    isApplied: (state) => state.decisionReview?.resolution?.outcome === 'reverted',
    prepare: async ({ state }) => {
      const checkpoint = state.workflowRecovery?.checkpoints?.at(-1);
      const mission = state.missions.find((item) => item.id === state.activeMissionId) || {};
      const repositoryAdoption = state.workflowRecovery?.repositoryAdoption;
      const repositoryRevert = mission.projectRoot && repositoryAdoption?.commit
        ? await workspaceManager.revertAdoption({ repository: mission.repository, commit: repositoryAdoption.commit })
        : null;
      const recovery = await restoreWorkspaceCheckpoint(checkpoint, state.activeMissionId);
      return { payload: { checkpointId: checkpoint.id, recovery, repositoryRevert, repositoryAdoption, revertedAt: new Date().toISOString(), previousBest: state.workflowRecovery?.previousBest || { candidateId: null, version: 'baseline', value: '--', improvement: '--', status: 'active' } }, result: { recovery, repositoryRevert } };
    },
    apply: (state, payload) => {
      const revertedCandidateId = state.currentBest?.candidateId || state.appliedCandidateId || 'candidate';
      state.currentBest = payload.previousBest;
      state.decisionReview = { ...(state.decisionReview || createDecisionReviewState('resolved')), status: 'resolved', recommendation: null, requiresApproval: false, resolution: { outcome: 'reverted', source: 'human_recovery', note: `已恢复上一稳定版本 ${payload.previousBest.version || 'baseline'}`, resolvedAt: payload.revertedAt }, resolvedAt: payload.revertedAt };
      state.publishedAssets = (state.publishedAssets || []).map((asset) => ({ ...asset, status: 'superseded', supersededAt: payload.revertedAt, supersededBy: `rollback.${payload.previousBest.version || 'baseline'}` }));
      state.knowledgeMaintenance = { ...state.knowledgeMaintenance, rollback: { status: 'completed', reason: `${revertedCandidateId} adoption reverted`, revertedAt: payload.revertedAt }, changes: (state.knowledgeMaintenance?.changes || []).map((change) => ({ ...change, outcome: 'superseded' })) };
      state.agent = { ...state.agent, status: 'completed', phase: '已回退到上一稳定版本', currentAction: null, messages: [...(state.agent?.messages || []), { id: `adoption-revert-${Date.now()}`, phase: 'decision', status: 'completed', title: '采用结果已回退', detail: `current best 已恢复为 ${payload.previousBest.version || 'baseline'}，${revertedCandidateId} 关联知识已标记为被替代。`, time: '刚刚' }] };
      state.workflowRecovery = {
        ...state.workflowRecovery,
        repositoryAdoption: payload.repositoryRevert ? { ...payload.repositoryAdoption, status: 'reverted', ...payload.repositoryRevert } : payload.repositoryAdoption,
        worktree: { ...state.workflowRecovery.worktree, status: 'reverted', revertedAt: payload.revertedAt },
        lastRecovery: { type: 'adoption_revert', from: revertedCandidateId, to: payload.previousBest.candidateId || 'baseline', checkpointId: payload.checkpointId, restoredAt: payload.recovery.restoredAt },
        invalidatedArtifacts: [...(state.workflowRecovery.invalidatedArtifacts || []), { type: 'decision', id: `decision.${revertedCandidateId}` }, ...(state.publishedAssets || []).map((asset) => ({ type: 'knowledge', id: `${asset.id}@${asset.version}` }))],
      };
      appendRuntimeEvent(state, 'decision.adoption_reverted', { from: revertedCandidateId, to: payload.previousBest.candidateId || 'baseline', checkpointId: payload.checkpointId }, { kind: 'recovery', mode: 'client' });
      appendRuntimeEvent(state, 'knowledge.assets_superseded', { assets: state.publishedAssets.map((asset) => `${asset.id}@${asset.version}`) }, { kind: 'knowledge', mode: 'client' });
      addAuditEvent(state, '已回退到上一稳定版本', `${revertedCandidateId} → ${payload.previousBest.version || 'baseline'} · ${payload.checkpointId}`, 'warning', 'History');
    },
  },
  'resolve-review': {
    keyFor: (state, body) => `resolve-review:${state.activeMissionId}:${body?.outcome || state.decisionReview?.request?.outcome}`,
    isApplied: (state) => state.decisionReview?.status === 'resolved',
    prepare: async ({ state, body }) => {
      const outcome = body.outcome || state.decisionReview?.request?.outcome;
      const note = String(body.note || state.decisionReview?.request?.note || '').trim();
      if (outcome === 'redirect') {
        const checkpoint = state.workflowRecovery?.checkpoints?.at(-1);
        if (!checkpoint) {
          const error = new Error('当前 Mission 没有可恢复的工作区检查点，无法调整优化方向。');
          error.status = 409; error.code = 'WORKSPACE_CHECKPOINT_MISSING'; throw error;
        }
        const recovery = await restoreWorkspaceCheckpoint(checkpoint, state.activeMissionId);
        return { payload: { outcome, note, checkpointId: checkpoint.id, recovery }, result: { review: null, recovery } };
      }
      return { payload: { outcome, note, checkpointId: null, recovery: null }, result: null };
    },
    apply: (state, payload) => {
      const candidateId = state.appliedCandidateId || state.decisionReview?.candidateId;
      const resolvedAt = new Date().toISOString();
      if (payload.outcome === 'adopt') {
        adoptCandidateState(state, payload.note, 'human_review');
        return;
      }
      if (payload.outcome === 'redirect') {
        const invalidatedArtifacts = [
          state.benchmark?.runId ? { type: 'benchmark', id: state.benchmark.runId } : null,
          state.stage === 'evidence' && candidateId ? { type: 'evidence', id: `decision.${candidateId}` } : null,
        ].filter(Boolean);
        state.stage = 'candidate';
        state.patchApplied = false;
        state.benchmark = { status: 'idle', progress: 0, runId: null, startedAt: null, completedAt: null, durationMs: 2600, logs: [] };
        state.decisionReview = { ...state.decisionReview, status: 'resolved', requiresApproval: false, recommendation: null, resolution: { outcome: payload.outcome, source: 'human_review', note: payload.note, resolvedAt }, resolvedAt };
        state.agent = {
          ...state.agent, status: 'awaiting_action', phase: '调整优化方向',
          currentAction: { id: 'action.redirect-candidate', type: 'candidate.plan', title: '根据人工意见生成新候选方向', reason: payload.note, expectedOutput: 'Revised Candidate Plan · isolated worktree', risk: 'medium', approvalRequired: true, reviewMode: 'resolved' },
          messages: [...(state.agent?.messages || []), { id: `review-redirect-${Date.now()}`, phase: 'candidate', status: 'completed', title: '人工介入已调整优化方向', detail: `${payload.checkpointId || 'candidate baseline'} 已恢复，${invalidatedArtifacts.length} 个后续工件已失效。`, time: '刚刚' }],
        };
        state.workflowRecovery = {
          ...state.workflowRecovery,
          worktree: { ...state.workflowRecovery?.worktree, status: payload.checkpointId ? 'restored' : 'clean' },
          lastRecovery: payload.checkpointId ? { type: 'intervention_redirect', from: state.decisionReview.request?.originStage || 'workflow', to: 'candidate', checkpointId: payload.checkpointId, restoredAt: payload.recovery.restoredAt } : state.workflowRecovery?.lastRecovery,
          invalidatedArtifacts: [...(state.workflowRecovery?.invalidatedArtifacts || []), ...invalidatedArtifacts],
        };
        appendRuntimeEvent(state, 'decision.review_resolved', { candidate: candidateId || null, outcome: payload.outcome, note: payload.note }, { kind: 'approval', mode: 'client' });
        appendRuntimeEvent(state, 'workflow.redirected_by_intervention', { candidate: candidateId || null, checkpointId: payload.checkpointId || null, invalidatedArtifacts }, { kind: 'recovery', mode: 'client' });
        addAuditEvent(state, '人工介入已调整优化方向', `${payload.checkpointId || 'candidate baseline'} · ${payload.note}`, 'warning', 'GitBranch');
        return;
      }
      // supplement
      state.stage = 'validation';
      state.benchmark = { status: 'idle', progress: 0, runId: null, startedAt: null, completedAt: null, durationMs: 2600, logs: [] };
      state.decisionReview = { ...state.decisionReview, status: 'resolved', requiresApproval: false, recommendation: null, resolution: { outcome: payload.outcome, source: 'human_review', note: payload.note, resolvedAt }, resolvedAt };
      state.agent = {
        ...state.agent, status: 'awaiting_action', phase: '补充验证',
        currentAction: { id: 'action.supplement-validation', type: 'test.plan', title: '运行补充验证矩阵', reason: payload.note, expectedOutput: 'Updated Full Benchmark · refreshed Level 3 evidence', risk: 'medium', approvalRequired: false, reviewMode: 'resolved' },
        messages: [...(state.agent?.messages || []), { id: `review-resolved-${Date.now()}`, phase: 'approval', status: 'completed', title: '审批意见已处理', detail: `流程返回验证阶段 · ${payload.note}`, time: '刚刚' }],
      };
      appendRuntimeEvent(state, 'decision.review_resolved', { candidate: candidateId || null, outcome: payload.outcome, note: payload.note }, { kind: 'approval', mode: 'client' });
      addAuditEvent(state, '审批意见已处理：补充验证', payload.note, 'warning', 'TestTube2');
    },
  },
  'runs': {
    keyFor: (state, body) => `run-start:${state.activeMissionId}:${state.runHistory?.length || 0}:${hashKey(body?.goal || state.missions?.find((m) => m.id === state.activeMissionId)?.goal || '')}`,
    isApplied: (state, payload) => state.agent?.runId === payload?.runId && ['running', 'executing', 'awaiting_action'].includes(state.agent?.status),
    prepare: async ({ state, body }) => {
      const runtimeDescriptor = await agentRuntime.describe();
      const mission = state.missions.find((item) => item.id === state.activeMissionId) || {};
      const goal = body?.goal?.trim() || mission.goal;
      let workspace = body?.workspace;
      if (!workspace) {
        const preflight = await buildRuntimePreflight(mission);
        if (!preflight.ready) {
          const error = new Error(preflight.workspaceCheck?.detail || 'Agent Runtime 预检失败。');
          error.status = 503; error.code = preflight.workspaceCheck?.code || 'RUNTIME_PREFLIGHT_FAILED'; throw error;
        }
        workspace = preflight.workspace;
      }
      const referenceFixture = runtimeDescriptor.mode === 'reference-fixture';
      // 捕获-重放：在克隆上执行 reset + startRun（含 spawn），把结果摘进 payload；apply 只做确定性的状态重建。
      const clone = structuredClone(state);
      resetMissionRunState(clone, goal, { referenceFixture });
      let checkpoint = null;
      if (runtimeDescriptor.mode === 'reference-fixture') await resetMissionWorkspace(state.activeMissionId);
      if (isManagedWorkspaceRuntimeMode(runtimeDescriptor.mode)) {
        checkpoint = await createWorkspaceCheckpoint(state.activeMissionId, 'agent-run-baseline');
        clone.workflowRecovery = { ...(clone.workflowRecovery || {}), checkpoints: [...(clone.workflowRecovery?.checkpoints || []), checkpoint].slice(-5) };
      }
      const runtimeRun = await agentRuntime.startRun({ state: clone, mission, goal, resumeThreadId: body?.resumeThreadId || null, workspace });
      if (!runtimeRun.handled) startAgentRun(clone, goal, { reset: false });
      const eventType = referenceFixture
        ? 'mission.run_started'
        : runtimeDescriptor.mode === 'cli-file'
          ? 'mission.run_requested'
          : `${runtimeDescriptor.mode === 'claude-code' ? 'claude' : 'codex'}.run_started`;
      return { payload: { goal, referenceFixture, eventType, runtimeMode: runtimeDescriptor.mode, agent: clone.agent, checkpoint, runId: clone.agent.runId }, result: { runId: clone.agent.runId } };
    },
    apply: (state, payload) => {
      resetMissionRunState(state, payload.goal, { referenceFixture: payload.referenceFixture });
      if (payload.checkpoint) state.workflowRecovery = { ...(state.workflowRecovery || {}), checkpoints: [...(state.workflowRecovery?.checkpoints || []), payload.checkpoint].slice(-5) };
      state.agent = payload.agent;
      if (!state.runtimeEvents?.some((e) => e.type === payload.eventType && e.payload?.runId === payload.runId)) {
        appendRuntimeEvent(state, payload.eventType, { runId: payload.runId, goal: payload.goal }, { kind: 'adapter', mode: payload.referenceFixture ? 'reference-fixture' : payload.eventType === 'mission.run_requested' ? 'cli-file' : payload.runtimeMode });
      }
    },
  },
  'research': {
    keyFor: (state, body) => `research:${state.activeMissionId}:${state.researchNotes?.length || 0}:${hashKey(body?.direction || selectResearchDirection(state))}`,
    isApplied: (state, payload) => state.researchAgent?.runId === payload?.runId && state.researchAgent?.status === 'running',
    prepare: async ({ state, body }) => {
      const mission = state.missions.find((item) => item.id === state.activeMissionId) || {};
      const direction = body?.direction?.trim() || selectResearchDirection(state);
      const researchDir = researchDirForMission(state.activeMissionId, mission.repository, mission.projectRoot);
      const clone = structuredClone(state);
      await mkdir(researchDir, { recursive: true });
      // 操作员主动触发 → 默认异步（并行，主循环不阻塞）；可在 body 显式传 synchronous:true 改为串行等待
      const started = await agentRuntime.startResearch({ state: clone, mission, direction, workspace: researchDir, synchronous: body?.synchronous === true });
      return { payload: { direction, researchAgent: clone.researchAgent }, result: { runId: clone.researchAgent.runId } };
    },
    apply: (state, payload) => {
      state.researchAgent = payload.researchAgent;
      if (!state.runtimeEvents?.some((e) => e.type === 'research.run_started' && e.payload?.runId === payload.researchAgent.runId)) {
        appendRuntimeEvent(state, 'research.run_started', { runId: payload.researchAgent.runId, direction: payload.direction, researchDir: payload.researchAgent.researchDir }, { kind: 'research', mode: payload.researchAgent.runtimeKind });
      }
    },
  },
  'materialize-baseline': {
    keyFor: (state, body) => {
      const mission = state.missions.find((item) => item.id === state.activeMissionId) || {};
      const source = body?.baselineSource || state.baseline?.source || mission.baseline?.source || selectResearchBaselineSource(state.researchNotes, mission, body) || {};
      return `materialize-baseline:${state.activeMissionId}:${hashKey(JSON.stringify(source))}:${hashKey(JSON.stringify(body?.matrix || state.testMatrix))}`;
    },
    isApplied: (state, payload) => state.baseline?.materializer?.runId === payload?.materializer?.runId
      && ['running', 'completed'].includes(state.baseline?.materializer?.status),
    prepare: async ({ state, body }) => {
      const mission = state.missions.find((item) => item.id === state.activeMissionId) || {};
      const matrix = body.matrix || state.testMatrix;
      const source = body?.baselineSource || body?.source || state.baseline?.source || mission.baseline?.source || selectResearchBaselineSource(state.researchNotes, mission, body);
      if (!source) {
        const error = new Error('Baseline materializer 缺少权威 source；请先让调查员查找 upstream baseline source。');
        error.status = 409;
        error.code = 'BASELINE_SOURCE_REQUIRED';
        throw error;
      }
      const materializationDir = isStrictZeroSourceMission(mission)
        ? baselineDirForMission(state.activeMissionId, mission.repository, mission.projectRoot)
        : path.join(artifactDirForMission(state.activeMissionId, mission.repository, mission.projectRoot), 'baseline-materialization');
      const clone = structuredClone(state);
      await mkdir(materializationDir, { recursive: true });
      await agentRuntime.startBaselineMaterialization({ state: clone, mission, source, matrix, workspace: materializationDir });
      return { payload: { materializer: clone.baseline.materializer, baselineSource: source, matrix: structuredClone(matrix) }, result: { runId: clone.baseline.materializer.runId } };
    },
    apply: (state, payload) => {
      state.baseline = {
        ...(state.baseline || { required: true, status: 'missing' }),
        kind: 'pytorch_reference',
        source: payload.baselineSource ? structuredClone(payload.baselineSource) : state.baseline?.source || null,
        materializer: structuredClone(payload.materializer),
        resolution: {
          ...(state.baseline?.resolution || {}),
          status: 'materializing',
          strategy: 'agent_assisted_materializer',
          kind: 'pytorch_reference',
          attemptedAuthority: true,
          reused: false,
          reason: '正在将权威 upstream baseline 展开为单文件 run.py。',
          resolvedAt: null,
          previousEvidenceRunId: null,
        },
      };
      if (!state.runtimeEvents?.some((e) => e.type === 'baseline.materializer_started' && e.payload?.runId === payload.materializer.runId)) {
        appendRuntimeEvent(state, 'baseline.materializer_started', { runId: payload.materializer.runId, source: payload.baselineSource, materializationDir: payload.materializer.materializationDir }, { kind: 'baseline-materializer', mode: payload.materializer.runtimeKind });
      }
      addAuditEvent(state, 'Baseline materializer 已启动', `${payload.materializer.runId} · authoritative source → single-file run.py`, 'blue', 'Baseline');
    },
  },
};

// 循环驱动依赖：advanceIteration 编排器通过 deps 拿到 agentRuntime 能力与目录函数。
const iterationDeps = {
  startResearch: async ({ state, mission, direction, workspace, synchronous = true, runPhase = 'acquire' }) => {
    // 非受管理 Workspace CLI 模式不支持研究员，避免 reference-fixture 等模式进入真实调研链路。
    if (!isManagedWorkspaceRuntimeMode(agentRuntime.mode)) return state;
    await mkdir(workspace, { recursive: true });
    // 停滞升级 → synchronous:true（主循环串行等待）；隧道视野 → synchronous:false（主线程继续，并行审查）
    const started = await agentRuntime.startResearch({ state, mission, direction, workspace, synchronous, runPhase });
    return started.state;
  },
  cancelResearch: async ({ state, runId }) => agentRuntime.cancelRun({ state, runId }),
  registerSources: async ({ state, mission }) => {
    if (!mission?.sourceRoot) return { count: 0, errors: ['sourceRoot 未配置'] };
    // mission 记录可能没存 runtimeRoot；three-layer 项目由 projectRoot 推导
    const runtimeRoot = mission.runtimeRoot || (mission.projectRoot ? path.join(mission.projectRoot, '.operator-studio') : null);
    if (!runtimeRoot) return { count: 0, errors: ['runtimeRoot 未配置'] };
    try {
      const entries = await readdir(mission.sourceRoot).catch(() => []);
      const repos = entries.filter((name) => name !== '.git');
      const references = [];
      for (const name of repos) {
        const repoPath = path.join(mission.sourceRoot, name);
        const isRepo = await stat(path.join(repoPath, '.git')).then(() => true).catch(() => false);
        if (!isRepo) continue;
        const head = await workspaceManager.git(['rev-parse', 'HEAD'], repoPath).then((result) => result.stdout.trim()).catch(() => null);
        const origin = await workspaceManager.git(['remote', 'get-url', 'origin'], repoPath).then((result) => result.stdout.trim()).catch(() => '');
        if (head) references.push({ repository: origin || repoPath, commit: head, path: '' });
      }
      if (references.length) {
        await workspaceManager.updateSourceRegistry({ sourceRoot: mission.sourceRoot, runtimeRoot, missionId: state.activeMissionId, references });
      }
      return { count: references.length, references };
    } catch (error) {
      return { count: 0, errors: [error.message] };
    }
  },
  countSources: async ({ state, mission }) => {
    if (!mission?.sourceRoot) return { count: 0 };
    try {
      const entries = await readdir(mission.sourceRoot).catch(() => []);
      return { count: entries.filter((name) => name !== '.git').length };
    } catch { return { count: 0 }; }
  },
  startMainRound: async ({ state, goal }) => {
    const runtimeDescriptor = await agentRuntime.describe();
    const mission = state.missions.find((item) => item.id === state.activeMissionId) || {};
    const preflight = await buildRuntimePreflight(mission);
    if (!preflight.ready) return state;
    const workspace = preflight.workspace;
    const previousCheckpoint = state.workflowRecovery?.checkpoints?.at(-1) || null;
    const previousGate = state.decisionReview?.gate || null;
    const previousCandidateId = state.appliedCandidateId || state.decisionReview?.candidateId || state.benchmark?.candidate?.id || null;
    const previousCandidateDigest = state.benchmark?.candidate?.digest
      || (state.candidateEvaluations || []).find((item) => item.id === previousCandidateId)?.patchDigest
      || null;
    const shouldRestoreRejectedRound = isManagedWorkspaceRuntimeMode(runtimeDescriptor.mode)
      && previousCheckpoint
      && (previousGate?.passed === false || state.decisionReview?.resolution?.outcome === 'reject');
    let rollback = null;
    if (shouldRestoreRejectedRound) {
      const recovery = await restoreWorkspaceCheckpoint(previousCheckpoint, state.activeMissionId);
      const restoredDiff = await workspaceManager.captureDiff(workspace);
      if (!previousCheckpoint.stableDigest || restoredDiff.digest !== previousCheckpoint.stableDigest) {
        const error = new Error('上一轮候选恢复后工作区未回到 baseline checkpoint，已阻止下一轮 Agent。');
        error.status = 409;
        error.code = 'ROUND_ROLLBACK_WORKSPACE_DIRTY';
        throw error;
      }
      rollback = { checkpointId: previousCheckpoint.id, candidateId: previousCandidateId, candidateDigest: previousCandidateDigest, workspaceClean: true, restoredAt: recovery.restoredAt };
    }
    if (isStrictZeroSourceMission(mission)) {
      const baselineRunPy = state.baseline?.materializer?.result?.runPy;
      if (!baselineRunPy) {
        const error = new Error('Iteration Agent 启动前缺少本轮 Materializer 生成的 baseline run.py。');
        error.status = 409;
        error.code = 'ITERATION_BASELINE_ARTIFACT_MISSING';
        throw error;
      }
    }
    resetMissionRunState(state, goal, { referenceFixture: runtimeDescriptor.mode === 'reference-fixture' });
    if (rollback) {
      state.workflowRecovery = { ...(state.workflowRecovery || {}), lastRecovery: { type: 'round_rollback', ...rollback } };
      appendRuntimeEvent(state, 'workflow.round_rolled_back', rollback, { kind: 'recovery', mode: 'client' });
      addAuditEvent(state, '未采纳候选已回退', `${rollback.candidateId || 'candidate'} · ${rollback.checkpointId} · workspace clean`, 'warning', 'History');
    }
    if (runtimeDescriptor.mode === 'reference-fixture') await resetMissionWorkspace(state.activeMissionId);
    if (isManagedWorkspaceRuntimeMode(runtimeDescriptor.mode)) {
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
  startBaseline: async ({ state, mission, reason }) => {
    const matrix = inferMissionMatrix(mission, state.testMatrix || mission.testMatrix || {});
    const fixedOperator = isFixedOperatorMission(mission);
    const strictZeroSource = isStrictZeroSourceMission(mission);
    // A fixed-profile Mission may be resumed from an older failed state. Once a
    // fresh baseline is being submitted, clear the stale human-block marker.
    if (fixedOperator && state.iterationStats?.loopStatus === 'needs_human') {
      state.iterationStats = { ...(state.iterationStats || {}), loopStatus: 'running', loopStatusReason: null };
      appendRuntimeEvent(state, 'workflow.stale_block_cleared', { reason: 'fixed-profile baseline restarted' }, { kind: 'workflow-kernel', mode: 'client' });
    }
    if (state.benchmark?.purpose === 'baseline' && ['queued', 'running'].includes(state.benchmark.status)) return state;
    if (state.benchmark?.purpose === 'baseline' && state.benchmark.status === 'failed') {
      state.iterationStats = { ...(state.iterationStats || {}), loopStatus: 'needs_human', loopStatusReason: 'baseline_test_failed' };
      return state;
    }
    const research = state.researchAgent || {};
    // 四算子测试包的 baseline 由发布时冻结的 profile 提供；经验调研只给
    // 后续候选提示词增益，绝不能阻塞可复现的 reference benchmark。
    if (!fixedOperator && isResearchAgentActive(research)) return state;
    const researchTerminal = ['completed', 'failed', 'cancelled', 'timed_out'].includes(research.status);
    const researchedSource = selectResearchBaselineSource(state.researchNotes, mission, { operator: mission.operator || mission.title, excludedSources: state.baseline?.rejectedSources });
    const semanticSource = mission.sourcePolicy?.allowSemanticFallback === true && researchTerminal
      ? buildSemanticBaselineSource(mission, research)
      : null;
    const baselineSource = fixedOperator
      ? state.baseline?.source || mission.baseline?.source
      : strictZeroSource
      ? researchedSource || semanticSource
      : state.baseline?.source
      || mission.baseline?.source
      || researchedSource
      || inferAuthoritativeBaselineSource(mission, { operator: mission.operator || mission.title, reason });
    if (!baselineSource) return state;
    const semanticFallback = isSemanticBaselineSource(baselineSource);
    if (semanticFallback) {
      state.baseline = {
        ...(state.baseline || {}),
        source: baselineSource,
        sourcePolicy: {
          ...(state.baseline?.sourcePolicy || {}),
          requireAuthority: false,
          requireSingleFileExpansion: true,
          allowAgentSemantic: true,
        },
      };
      appendRuntimeEvent(state, 'baseline.semantic_fallback_selected', { missionId: state.activeMissionId, reason: baselineSource.reason }, { kind: 'baseline', mode: 'agent-semantic' });
    }
    if (strictZeroSource) {
      if (!semanticFallback) {
        const inspection = await workspaceManager.inspectSources(mission.sourceRoot, [baselineSource]);
        if (!inspection.ready || inspection.references.some((reference) => !reference.verified)) {
          state.iterationStats = { ...(state.iterationStats || {}), loopStatus: 'needs_human', loopStatusReason: 'baseline_source_unverified' };
          appendRuntimeEvent(state, 'baseline.source_unverified', { missionId: state.activeMissionId, errors: inspection.errors }, { kind: 'baseline', mode: 'client' });
          return state;
        }
      }
      const materializer = state.baseline?.materializer || {};
      if (materializer.status !== 'completed' || !materializer.result?.runPy) {
        if (['running', 'cancel_requested'].includes(materializer.status)) return state;
        if (['failed', 'cancelled', 'timed_out'].includes(materializer.status)) {
          const recovery = consumeWorkflowRecoveryBudget(state, { component: 'baseline-materializer', limit: 1 });
          if (recovery.allowed && materializer.status !== 'cancelled') {
            const rejectedSource = {
              ...(materializer.source || baselineSource),
              errorCode: materializer.error?.code || 'BASELINE_MATERIALIZER_FAILED',
              reason: materializer.error?.details?.summary || materializer.error?.message || 'Materializer could not construct the required artifact.',
            };
            state.baseline = {
              ...(state.baseline || {}),
              source: null,
              rejectedSources: [...(state.baseline?.rejectedSources || []), rejectedSource],
              materializer: { ...materializer, status: 'redirected', phase: '返回 Source 调研', recoveryAttempt: recovery.attempt },
            };
            const unsupported = Array.isArray(materializer.error?.details?.unsupported)
              ? materializer.error.details.unsupported.slice(0, 6).join('；')
              : materializer.error?.message || 'source evidence was insufficient';
            const direction = [
              `上一权威 Source 无法物化为 ${mission.title || mission.operator || '目标算子'} baseline，必须选择不同的 source path 或补齐真正定义数学语义的实现文件。`,
              `已拒绝 Source：${rejectedSource.repository}@${rejectedSource.commit}:${rejectedSource.path}。`,
              `Materializer 反馈：${unsupported}。`,
              '重新从官方上游中固定 repository、commit、path 和 operator；不要再次选择已拒绝的包装层。',
            ].join('\n');
            const researchDir = researchDirForMission(state.activeMissionId, mission.repository, mission.projectRoot);
            const redirected = await iterationDeps.startResearch({ state, mission, direction, workspace: researchDir, synchronous: true });
            appendRuntimeEvent(redirected, 'workflow.recovery_redirected', { component: recovery.component, attempt: recovery.attempt, limit: recovery.limit, from: 'materializer', to: 'research', rejectedSource }, { kind: 'workflow-kernel', mode: 'client' });
            return redirected;
          }
          state.iterationStats = { ...(state.iterationStats || {}), loopStatus: 'needs_human', loopStatusReason: 'baseline_materializer_failed' };
          return state;
        }
        const materialized = await executeCommand({
          journal: commandJournal,
          saveState,
          registry: commandRegistry,
          state,
          type: 'materialize-baseline',
          body: { baselineSource, matrix },
          expectedVersion: state.stateVersion,
        });
        return materialized.state || state;
      }
    }
    const result = await executeCommand({
      journal: commandJournal,
      saveState,
      registry: commandRegistry,
      state,
      type: 'start-benchmark',
      body: {
        purpose: 'baseline',
        operator: mission.operator || mission.title || 'operator',
        baselineSource,
        ...((strictZeroSource || fixedOperator) ? { strictZeroSource: strictZeroSource, materializerResult: state.baseline?.materializer?.result } : {}),
        matrix,
        warmup: matrix.warmup,
        repeats: matrix.repeats,
        correctnessCases: matrix.correctnessCases,
        timeoutSeconds: 120,
      },
      expectedVersion: state.stateVersion,
    });
    return result.state || state;
  },
  researchDirForMission,
};

const advanceTesterAutopilot = async (state) => {
  if (process.env.OPERATOR_AUTO_TICK !== '1' || state.missionPaused) return { state, action: 'none' };
  const mission = state.missions?.find((item) => item.id === state.activeMissionId) || {};
  const actionType = state.agent?.currentAction?.type;
  const candidate = (state.candidateEvaluations || []).find((item) => item.patchDigest)
    || (state.candidateEvaluations || [])[0];

  // 专用四算子路径：冻结语义和测试矩阵 -> baseline -> 可选经验调研 -> 三轮候选。
  // 经验调研的失败被记录，但不会改变 baseline 或使任务进入 needs_human。
  if (isFixedOperatorMission(mission)) {
    if (state.baseline?.status !== 'complete') {
      const nextState = await iterationDeps.startBaseline({ state, mission, reason: 'fixed operator profile baseline' });
      return { state: nextState, action: nextState.benchmark?.status === 'running' ? 'baseline_started' : 'wait_baseline' };
    }
    const research = state.researchAgent || {};
    const researchEnabled = mission.sourcePolicy?.researchEnabled !== false;
    let experienceStarted = false;
    if (researchEnabled && !research.runId) {
      const direction = `为 ${mission.title || mission.operator} 搜寻 C500 / ${mission.operatorProfile?.language || 'target'} 的实现经验。只输出优化方向与参考；不得修改冻结语义、Correctness 或 Benchmark。`;
      const researchDir = researchDirForMission(state.activeMissionId, mission.repository, mission.projectRoot);
      try {
        const started = await iterationDeps.startResearch({ state, mission, direction, workspace: researchDir, synchronous: false, runPhase: 'experience' });
        state = started;
        experienceStarted = true;
      } catch (error) {
        state.researchAgent = { ...research, status: 'failed', runPhase: 'experience', phase: '经验调研不可用（不阻塞）', progress: 100, error: { code: error.code || 'EXPERIENCE_RESEARCH_FAILED', message: error.message } };
        appendRuntimeEvent(state, 'research.experience_unavailable', { missionId: state.activeMissionId, error: error.message }, { kind: 'research', mode: 'client' });
      }
    }
    // Experience research is a side-channel. It is intentionally asynchronous;
    // a slow or unavailable web agent must never hold up candidate round 1.
    if (isResearchAgentActive(state.researchAgent || {}) && state.researchAgent?.synchronous) return { state, action: 'wait_experience_research' };    if (!state.agent?.runId && ['idle', 'ready', 'awaiting_action', 'completed', 'failed', 'cancelled'].includes(state.agent?.status)) {
      return { state: await iterationDeps.startMainRound({ state, goal: mission.goal }), action: 'candidate_agent_started' };
    }
  }

  if (isStrictZeroSourceMission(mission)) {
    const research = state.researchAgent || {};
    if (state.baseline?.status !== 'complete' && isResearchAgentActive(research)) {
      return { state, action: 'wait_research' };
    }
    const researchTerminal = ['completed', 'failed', 'cancelled', 'timed_out'].includes(research.status);
    const source = selectResearchBaselineSource(state.researchNotes, mission, { operator: mission.operator || mission.title, excludedSources: state.baseline?.rejectedSources })
      || (mission.sourcePolicy?.allowSemanticFallback === true && researchTerminal && (research.runPhase === 'synthesize' || research.acquireHandled === true)
        ? buildSemanticBaselineSource(mission, research)
        : null);
    if (state.baseline?.status !== 'complete' && !source) {
      if (!research.runId) {
        const direction = `从零研究 ${mission.title || mission.goal}：在官方上游仓库中固定可验证的 MLA paged attention baseline source，记录 repository、commit、path 和 operator；不得生成候选代码。`;
        const researchDir = researchDirForMission(state.activeMissionId, mission.repository, mission.projectRoot);
        return { state: await iterationDeps.startResearch({ state, mission, direction, workspace: researchDir, synchronous: true }), action: 'baseline_research_started' };
      }
      if (researchTerminal) {
        if (research.runPhase === 'acquire' && research.acquireHandled !== true) return { state, action: 'none' };
        state.iterationStats = { ...(state.iterationStats || {}), loopStatus: 'needs_human', loopStatusReason: 'baseline_source_unresolved' };
        return { state, action: 'needs_human' };
      }
      return { state, action: 'wait_research' };
    }
    if (state.baseline?.status !== 'complete') {
      const nextState = await iterationDeps.startBaseline({ state, mission, reason: 'strict zero-source workflow' });
      const materializerStatus = nextState.baseline?.materializer?.status;
      const action = materializerStatus === 'running' ? 'baseline_materializer_started' : nextState.baseline?.status === 'running' ? 'baseline_started' : 'none';
      return { state: nextState, action };
    }
    if (!candidate
        && !state.agent?.runId
        && ['idle', 'ready', 'awaiting_action', 'completed'].includes(state.agent?.status)) {
      return { state: await iterationDeps.startMainRound({ state, goal: mission.goal }), action: 'candidate_agent_started' };
    }
  }

  if (state.stage === 'candidate' && state.agent?.status === 'awaiting_action' && state.baseline?.status !== 'complete') {
    const nextState = await iterationDeps.startBaseline({ state, mission, reason: state.agent?.currentAction?.reason || state.agent?.result?.summary || '' });
    if (nextState.benchmark?.status === 'running' || nextState.baseline?.status === 'running') return { state: nextState, action: 'baseline_started' };
    const runtime = await agentRuntime.describe();
    const research = state.researchAgent || {};
    if (isManagedWorkspaceRuntimeMode(runtime.mode) && !research.runId && research.status !== 'running') {
      const direction = [
        `为 Mission ${mission.id} 查找可验证的权威 baseline：${mission.goal}`,
        '优先检查本地 Source Registry，再检索上游官方仓库、测试和 benchmark。',
        '必须在研究笔记的 baselineSources 中记录 repository、固定 commit、path、operator、confidence 和语义依据。',
        '不能用无关算子、smoke template 或没有固定版本的网页片段代替。',
      ].join('\n');
      const researchDir = researchDirForMission(state.activeMissionId, mission.repository, mission.projectRoot);
      return { state: await iterationDeps.startResearch({ state, mission, direction, workspace: researchDir, synchronous: true }), action: 'baseline_research_started' };
    }
    const researchTerminal = ['completed', 'failed', 'cancelled', 'timed_out'].includes(research.status);
    if (isManagedWorkspaceRuntimeMode(runtime.mode) && research.runId && researchTerminal && research.runPhase !== 'acquire') {
      state.iterationStats = { ...(state.iterationStats || {}), loopStatus: 'needs_human', loopStatusReason: 'baseline_source_unresolved' };
      appendRuntimeEvent(state, 'baseline.source_unresolved', { missionId: state.activeMissionId, researchRunId: research.runId }, { kind: 'baseline', mode: 'client' });
      addAuditEvent(state, 'Baseline 来源需要人工确认', 'Research Agent 未找到可固定版本且语义可验证的权威 baseline。', 'warning', 'UserRound');
      return { state, action: 'needs_human' };
    }
  }

  if (state.stage === 'candidate' && state.agent?.status === 'awaiting_action' && state.baseline?.status === 'complete') {
    if (candidate?.patchDigest && actionType === 'candidate.plan') {
      const result = await executeCommand({
        journal: commandJournal,
        saveState,
        registry: commandRegistry,
        state,
        type: 'apply-patch',
        body: { candidate: candidate.id },
        expectedVersion: state.stateVersion,
      });
      return { state: result.state || state, action: 'candidate_applied' };
    }
    if (!candidate?.patchDigest) {
      const goal = `${mission.goal || state.agent?.goal || ''}\n【系统恢复】同 runner / 同 shape baseline 已完成，请生成一个有真实工作区 Diff 的 run.py 优化候选。`;
      return { state: await iterationDeps.startMainRound({ state, goal }), action: 'candidate_resumed' };
    }
  }

  if (state.stage === 'validation'
      && state.patchApplied
      && state.baseline?.status === 'complete'
      && state.agent?.status === 'awaiting_action'
      && actionType === 'test.plan') {
    const matrix = inferMissionMatrix(mission, state.testMatrix || mission.testMatrix || {});
    const result = await executeCommand({
      journal: commandJournal,
      saveState,
      registry: commandRegistry,
      state,
      type: 'start-benchmark',
      body: { purpose: 'candidate', candidate: state.appliedCandidateId, matrix },
      expectedVersion: state.stateVersion,
    });
    return { state: result.state || state, action: 'candidate_test_started' };
  }

  return { state, action: 'none' };
};

let runtimeStateInFlight = null;
const reconcilePersistedBaselineFailure = (state) => {
  if (state.benchmark?.purpose !== 'baseline' || state.benchmark?.status !== 'failed' || state.baseline?.status === 'failed') return false;
  const error = state.benchmark.lastServiceError || { code: 'BASELINE_TEST_FAILED', message: 'Baseline operator test failed.' };
  state.baseline = { ...(state.baseline || {}), status: 'failed', error: structuredClone(error), failedAt: state.benchmark.completedAt || new Date().toISOString() };
  if (!(state.runtimeEvents || []).some((event) => event.type === 'baseline.failure_projected')) {
    appendRuntimeEvent(state, 'baseline.failure_projected', { error }, { kind: 'migration', mode: 'client' });
  }
  return true;
};

const loadRuntimeState = async () => {
  if (runtimeStateInFlight) return structuredClone(await runtimeStateInFlight);
  runtimeStateInFlight = (async () => {
  const runtime = await agentRuntime.describe();
  const state = await loadState({ runtimeMode: runtime.mode, commandJournal, applyRegistry: commandRegistry });
  const sourcePolicyMigration = migrateLocalC500TesterState(state, { enabled: localC500Config.enabled });
  if (sourcePolicyMigration.changed) {
    appendRuntimeEvent(state, 'mission.source_policy_migrated', sourcePolicyMigration.recovery, { kind: 'migration', mode: 'client' });
    const materializerRecovered = sourcePolicyMigration.recovery?.previousBlocker === 'baseline_materializer_failed';
    addAuditEvent(state, materializerRecovered ? 'C500 Materializer 交付协议已升级' : 'C500 来源策略已升级', sourcePolicyMigration.recovery?.previousBlocker
      ? `${sourcePolicyMigration.recovery.previousBlocker} 已解除，${materializerRecovered ? 'Materializer' : 'Research'} 将自动重新执行`
      : 'Research 将按本地、联网、语义 fallback 顺序执行', 'blue', 'RefreshCw');
  }
  const baselineFailureProjected = reconcilePersistedBaselineFailure(state);
  const initialReconciliation = reconcileWorkflowState(state);
  const projection = await agentRuntime.projectState({ ...initialReconciliation.state, runtime });
  let changed = baselineFailureProjected || sourcePolicyMigration.changed || projection.changed || initialReconciliation.changed;
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
  const shouldAdoptThreeLayer = isManagedWorkspaceRuntimeMode(projection.state.agent?.runtimeKind)
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
  const autopilot = await advanceTesterAutopilot(projection.state);
  projection.state = autopilot.state;
  if (autopilot.action !== 'none') changed = true;
  const looped = await advanceIteration(projection.state, iterationDeps);
  if (['research_timeout', 'research_injected', 'research_noted', 'round_counted', 'resumed_agent', 'research_escalated', 'baseline_started', 'resumed_after_baseline', 'failed_candidate_recorded'].includes(looped.action)) changed = true;
  const finalReconciliation = reconcileWorkflowState(looped.state);
  changed ||= finalReconciliation.changed;
  return changed ? saveState(finalReconciliation.state) : finalReconciliation.state;
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
    json(response, 200, { status: 'ok', service: 'operator-studio-client-runtime', persistence: 'local-disk', runtime: await agentRuntime.describe(), testBackend: localC500Config.enabled ? localC500Config : { kind: 'operator-test-service', liveHardware: false }, time: new Date().toISOString() });
    return;
  }
  if (request.method === 'GET' && url.pathname === '/api/runtime') {
    json(response, 200, { runtime: await agentRuntime.describe(), testBackend: localC500Config.enabled ? localC500Config : { kind: 'operator-test-service', liveHardware: false } });
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
    const activeWorkspace = await ensureMissionWorkspace(state.activeMissionId, mission?.repository, { projectRoot: mission?.projectRoot, sourceRoot: mission?.sourceRoot });
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
    const state = await loadState({ runtimeMode: runtime.mode, ensureWorkspace: false, commandJournal, applyRegistry: commandRegistry });
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
    for (const mission of linkedMissions) await ensureMissionWorkspace(mission.id, inspection.gitRoot, { projectRoot: mission.projectRoot, sourceRoot: mission.sourceRoot });
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
    const budgetInput = validateMissionBudgetInput(body);
    if (!budgetInput.ok) {
      json(response, 400, { error: 'missionBudgetMs 必须是正数毫秒；传 null、空值或 0 表示不启用时间限制。', code: 'INVALID_MISSION_BUDGET' });
      return;
    }
    const nextState = createMission(state, body);
    const mission = nextState.missions.find((item) => item.id === nextState.activeMissionId);
    await ensureMissionWorkspace(mission.id, mission.repository, { projectRoot: mission.projectRoot, sourceRoot: mission.sourceRoot });
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
    if (isStrictZeroSourceMission(mission)
        && state.baseline?.status !== 'complete'
        && !selectResearchBaselineSource(state.researchNotes, mission, { operator: mission.operator || mission.title })) {
      assertMissionIntent(goal, mission);
      if (state.researchAgent?.runId && ['running', 'cancel_requested'].includes(state.researchAgent?.status)) {
        json(response, 202, { state, research: state.researchAgent, runId: state.researchAgent.runId, idempotent: true });
        return;
      }
      const direction = `从零研究 ${mission.title || mission.goal}：在官方上游仓库中固定可验证的 MLA paged attention baseline source，记录 repository、commit、path 和 operator；不得生成候选代码。`;
      const result = await executeCommand({ journal: commandJournal, saveState, registry: commandRegistry, state, type: 'research', body: { direction, synchronous: true }, expectedVersion: state.stateVersion });
      if (result.status === 'conflict') return json(response, 409, { error: '状态已变更，请刷新后重试。', code: 'STATE_VERSION_CONFLICT', retryable: true });
      json(response, 202, { state: result.state, research: result.state.researchAgent, runId: result.result?.runId, ...(result.status === 'skipped_idempotent' ? { idempotent: true } : {}) });
      return;
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
    // Fixed operator profiles are driven by the autopilot. The public run
    // command only arms the mission; starting an iteration here would race
    // the deterministic baseline and produce a phantom first round.
    if (isFixedOperatorMission(mission)) {
      state.agent = { ...(state.agent || {}), runId: null, status: 'idle', phase: '等待固定 baseline', progress: 0, currentAction: null, goal };
      state.stage = 'candidate';
      await saveState(state);
      json(response, 202, { state, runId: null, armed: true });
      return;
    }
    const resumeThreadId = body.resume === true
      ? state.agent?.threadId || state.runHistory?.find((run) => run.runtimeKind === runtimeDescriptor.mode && run.threadId)?.threadId || null
      : null;
    const result = await executeCommand({ journal: commandJournal, saveState, registry: commandRegistry, state, type: 'runs', body: { ...body, goal, resumeThreadId, workspace: preflight.workspace }, expectedVersion: state.stateVersion });
    if (result.status === 'conflict') return json(response, 409, { error: '状态已变更，请刷新后重试。', code: 'STATE_VERSION_CONFLICT', retryable: true });
    json(response, 202, { state: result.state, runId: result.result?.runId, ...(result.status === 'skipped_idempotent' ? { idempotent: true } : {}) });
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
    const result = await executeCommand({ journal: commandJournal, saveState, registry: commandRegistry, state, type: 'research', body, expectedVersion: state.stateVersion });
    if (result.status === 'conflict') return json(response, 409, { error: '状态已变更，请刷新后重试。', code: 'STATE_VERSION_CONFLICT', retryable: true });
    json(response, 202, { state: result.state, research: result.state.researchAgent, ...(result.status === 'skipped_idempotent' ? { idempotent: true } : {}) });
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
  if (request.method === 'POST' && url.pathname === '/api/actions/resume-mission') {
    await guardSupportedRuntimeAction('Mission Resume');
    const state = await loadRuntimeState();
    const body = await readJson(request);
    const result = await executeCommand({ journal: commandJournal, saveState, registry: commandRegistry, state, type: 'resume-mission', body, expectedVersion: state.stateVersion });
    if (result.status === 'conflict') return json(response, 409, { error: '状态已变更，请刷新后重试。', code: 'STATE_VERSION_CONFLICT', retryable: true });
    json(response, 200, { state: result.state, ...(result.status === 'skipped_idempotent' ? { idempotent: true } : {}) });
    return;
  }
  if (request.method === 'POST' && url.pathname === '/api/actions/apply-patch') {
    await guardSupportedRuntimeAction('Patch');
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
    const result = await executeCommand({ journal: commandJournal, saveState, registry: commandRegistry, state, type: 'apply-patch', body, expectedVersion: state.stateVersion });
    if (result.status === 'conflict') return json(response, 409, { error: '状态已变更，请刷新后重试。', code: 'STATE_VERSION_CONFLICT', retryable: true });
    json(response, 200, { state: result.state, workspace: result.result?.workspace, policyChecks: result.result?.policyChecks, ...(result.status === 'skipped_idempotent' ? { idempotent: true } : {}) });
    return;
  }
  if (request.method === 'POST' && url.pathname === '/api/actions/materialize-baseline') {
    const state = await loadRuntimeState();
    guardMutation(state);
    guardWorkflowTransition(state, { stages: ['diagnosis', 'candidate', 'validation'], label: 'Baseline 单文件展开' });
    const body = await readJson(request);
    const result = await executeCommand({ journal: commandJournal, saveState, registry: commandRegistry, state, type: 'materialize-baseline', body, expectedVersion: state.stateVersion });
    if (result.status === 'conflict') return json(response, 409, { error: '状态已变更，请刷新后重试。', code: 'STATE_VERSION_CONFLICT', retryable: true });
    json(response, 202, { state: result.state, materializer: result.state.baseline?.materializer, runId: result.result?.runId, ...(result.status === 'skipped_idempotent' ? { idempotent: true } : {}) });
    return;
  }
  if (request.method === 'POST' && url.pathname === '/api/actions/start-benchmark') {
    const state = await loadRuntimeState();
    guardMutation(state);
    const body = await readJson(request);
    const purpose = body.purpose === 'baseline' || body.testPurpose === 'baseline' ? 'baseline' : 'candidate';
    if (purpose === 'baseline') {
      guardWorkflowTransition(state, { stages: ['diagnosis', 'candidate', 'validation'], label: 'Baseline 提交' });
    } else {
      guardWorkflowTransition(state, { stages: ['validation'], actionType: 'test.plan', label: 'Benchmark 提交' });
      if (!state.patchApplied) {
        json(response, 409, { error: '请先应用候选补丁。', code: 'PATCH_REQUIRED_BEFORE_CANDIDATE_BENCHMARK' });
        return;
      }
    }
    const matrix = body.matrix || state.testMatrix;
    if (!Array.isArray(matrix?.environments) || !matrix.environments.length || !Array.isArray(matrix?.stages) || !matrix.stages.length) {
      json(response, 400, { error: '本次测试矩阵至少需要一个环境和一个验证阶段。', code: 'TEST_MATRIX_INVALID' });
      return;
    }
    const candidateId = body.candidate || state.appliedCandidateId;
    if (purpose !== 'baseline' && !candidateId) {
      json(response, 409, { error: '无法确定本次测试对应的候选，请重新应用候选 Patch。', code: 'TEST_CANDIDATE_MISSING' });
      return;
    }
    const result = await executeCommand({ journal: commandJournal, saveState, registry: commandRegistry, state, type: 'start-benchmark', body, expectedVersion: state.stateVersion });
    if (result.status === 'conflict') return json(response, 409, { error: '状态已变更，请刷新后重试。', code: 'STATE_VERSION_CONFLICT', retryable: true });
    json(response, 202, { state: result.state, runId: result.result?.runId, taskId: result.result?.taskId, ...(result.status === 'skipped_idempotent' ? { idempotent: true } : {}) });
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
    const result = await executeCommand({ journal: commandJournal, saveState, registry: commandRegistry, state, type: 'rollback-stage', body: {}, expectedVersion: state.stateVersion });
    if (result.status === 'conflict') return json(response, 409, { error: '状态已变更，请刷新后重试。', code: 'STATE_VERSION_CONFLICT', retryable: true });
    json(response, 200, { state: result.state, recovery: result.result?.recovery, ...(result.status === 'skipped_idempotent' ? { idempotent: true } : {}) });
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
    const result = await executeCommand({ journal: commandJournal, saveState, registry: commandRegistry, state, type: 'adopt', body, expectedVersion: state.stateVersion });
    if (result.status === 'conflict') return json(response, 409, { error: '状态已变更，请刷新后重试。', code: 'STATE_VERSION_CONFLICT', retryable: true });
    json(response, 200, { state: result.state, maintenance: result.state.knowledgeMaintenance, ...(result.status === 'skipped_idempotent' ? { idempotent: true } : {}) });
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
    const result = await executeCommand({ journal: commandJournal, saveState, registry: commandRegistry, state, type: 'request-review', body, expectedVersion: state.stateVersion });
    if (result.status === 'conflict') return json(response, 409, { error: '状态已变更，请刷新后重试。', code: 'STATE_VERSION_CONFLICT', retryable: true });
    json(response, 202, { state: result.state, review: result.state.decisionReview, ...(result.status === 'skipped_idempotent' ? { idempotent: true } : {}) });
    return;
  }
  if (request.method === 'POST' && url.pathname === '/api/actions/cancel-review') {
    await guardSupportedRuntimeAction('Decision Review');
    const state = await loadRuntimeState();
    guardMutation(state);
    guardWorkflowTransition(state, { stages: ['candidate', 'validation', 'evidence'], actionType: 'review.resolve', label: '人工介入撤回' });
    const result = await executeCommand({ journal: commandJournal, saveState, registry: commandRegistry, state, type: 'cancel-review', body: {}, expectedVersion: state.stateVersion });
    if (result.status === 'conflict') return json(response, 409, { error: '状态已变更，请刷新后重试。', code: 'STATE_VERSION_CONFLICT', retryable: true });
    json(response, 200, { state: result.state, review: result.state.decisionReview, ...(result.status === 'skipped_idempotent' ? { idempotent: true } : {}) });
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
    if (outcome === 'adopt' && (state.stage !== 'evidence' || state.benchmark.status !== 'complete')) {
      const error = new Error('当前尚未形成可采用的 Level 3 证据。');
      error.status = 409;
      error.code = 'INTERVENTION_ADOPTION_UNAVAILABLE';
      throw error;
    }
    if (!['adopt', 'supplement', 'redirect'].includes(outcome)) {
      const error = new Error('人工介入处理结果仅支持采用、补充验证或调整优化方向。');
      error.status = 400;
      error.code = 'DECISION_REVIEW_OUTCOME_INVALID';
      throw error;
    }
    const result = await executeCommand({ journal: commandJournal, saveState, registry: commandRegistry, state, type: 'resolve-review', body, expectedVersion: state.stateVersion });
    if (result.status === 'conflict') return json(response, 409, { error: '状态已变更，请刷新后重试。', code: 'STATE_VERSION_CONFLICT', retryable: true });
    json(response, 200, {
      state: result.state,
      ...(outcome === 'adopt' ? { maintenance: result.state.knowledgeMaintenance } : { review: result.state.decisionReview }),
      ...(outcome === 'redirect' ? { recovery: result.result?.recovery } : {}),
      ...(result.status === 'skipped_idempotent' ? { idempotent: true } : {}),
    });
    return;
  }
  if (request.method === 'POST' && url.pathname === '/api/actions/reject') {
    await guardSupportedRuntimeAction('Decision');
    const state = await loadRuntimeState();
    guardMutation(state);
    guardWorkflowTransition(state, { stages: ['evidence'], actionType: 'adoption.decision', label: '候选退回' });
    const result = await executeCommand({ journal: commandJournal, saveState, registry: commandRegistry, state, type: 'reject', body: {}, expectedVersion: state.stateVersion });
    if (result.status === 'conflict') return json(response, 409, { error: '状态已变更，请刷新后重试。', code: 'STATE_VERSION_CONFLICT', retryable: true });
    json(response, 200, { state: result.state, ...(result.status === 'skipped_idempotent' ? { idempotent: true } : {}) });
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
    const result = await executeCommand({ journal: commandJournal, saveState, registry: commandRegistry, state, type: 'revert-adoption', body: {}, expectedVersion: state.stateVersion });
    if (result.status === 'conflict') return json(response, 409, { error: '状态已变更，请刷新后重试。', code: 'STATE_VERSION_CONFLICT', retryable: true });
    json(response, 200, { state: result.state, recovery: result.result?.recovery, repositoryRevert: result.result?.repositoryRevert, ...(result.status === 'skipped_idempotent' ? { idempotent: true } : {}) });
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
  if (request.method === 'POST' && url.pathname === '/api/actions/human-feedback') {
    const state = await loadRuntimeState();
    const body = await readJson(request);
    const note = String(body.note || '').trim();
    if (note.length < 2) {
      json(response, 400, { error: '人工意见至少需要 2 个字符。', code: 'HUMAN_FEEDBACK_REQUIRED' });
      return;
    }
    const feedback = {
      id: `feedback_${Date.now().toString(36)}`,
      note,
      submittedAt: new Date().toISOString(),
      source: 'local-c500-tui',
    };
    state.missionPaused = false;
    state.iterationStats = {
      ...(state.iterationStats || {}),
      loopStatus: 'running',
      loopStatusReason: null,
      pendingInjection: {
        noteId: feedback.id,
        direction: 'human_feedback',
        briefing: `人工意见：${note}`,
        value: 'high',
      },
    };
    const activeMission = state.missions?.find((item) => item.id === state.activeMissionId);
    if (activeMission) activeMission.status = 'running';
    appendRuntimeEvent(state, 'mission.human_feedback_added', feedback, { kind: 'human-feedback', mode: 'client' });
    addAuditEvent(state, '已添加人工意见', note, 'blue', 'UserRound');
    json(response, 202, { state: await saveState(state), feedback });
    return;
  }
  if (request.method === 'POST' && url.pathname === '/api/actions/stop-mission') {
    const state = await loadRuntimeState();
    const mission = state.missions?.find((item) => item.id === state.activeMissionId);
    if (!mission) {
      json(response, 404, { error: '当前没有可停止的 Mission。', code: 'MISSION_NOT_FOUND' });
      return;
    }
    if (state.benchmark?.status === 'running' && state.benchmark?.testTaskId) {
      await operatorTestQueue.cancel(state.benchmark.testTaskId).catch(() => null);
    }
    if (state.agent?.runId && ['running', 'executing', 'awaiting_action', 'cancel_requested'].includes(state.agent.status)) {
      const cancelled = await agentRuntime.cancelRun({ state, runId: state.agent.runId }).catch(() => null);
      if (cancelled?.state) Object.assign(state, cancelled.state);
    }
    state.missionPaused = true;
    state.iterationStats = { ...(state.iterationStats || {}), loopStatus: 'stopped', loopStatusReason: 'stopped_by_tester', stoppedAt: new Date().toISOString() };
    const activeMission = state.missions?.find((item) => item.id === state.activeMissionId) || mission;
    activeMission.status = 'stopped';
    appendRuntimeEvent(state, 'mission.stopped', { missionId: activeMission.id, source: 'local-c500-tui' }, { kind: 'mission', mode: 'client' });
    addAuditEvent(state, 'Mission 已停止', `${activeMission.id} · 测试人员停止`, 'warning', 'Square');
    json(response, 200, { state: await saveState(state) });
    return;
  }
  if (request.method === 'PATCH' && url.pathname === '/api/state') {
    const state = await loadRuntimeState();
    const body = await readJson(request);
    if (body.testMatrix && (!Array.isArray(body.testMatrix.environments) || !body.testMatrix.environments.length || !Array.isArray(body.testMatrix.stages) || !body.testMatrix.stages.length)) {
      json(response, 400, { error: '测试矩阵至少需要一个环境和一个验证阶段。' });
      return;
    }
    if (hasMissionBudgetInput(body)) {
      const budgetInput = validateMissionBudgetInput(body);
      if (!budgetInput.ok) {
        json(response, 400, { error: 'missionBudgetMs 必须是正数毫秒；传 null、空值或 0 表示不启用时间限制。', code: 'INVALID_MISSION_BUDGET' });
        return;
      }
      state.missionBudgetMs = budgetInput.value;
      if (!budgetInput.value) state.missionBudgetStartedAt = null;
    }
    for (const key of ['testMatrix', 'workspace', 'unreadCount', 'missionPaused']) {
      if (Object.hasOwn(body, key)) state[key] = body[key];
    }
    if (body.missionPaused === false && state.iterationStats?.loopStatus === 'stopped') {
      state.iterationStats = { ...state.iterationStats, loopStatus: 'running', loopStatusReason: null, stoppedAt: null };
      const activeMission = state.missions?.find((item) => item.id === state.activeMissionId);
      if (activeMission) activeMission.status = 'running';
      appendRuntimeEvent(state, 'mission.resumed', { missionId: state.activeMissionId, source: 'local-c500-tui' }, { kind: 'mission', mode: 'client' });
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

server.on('error', (error) => {
  if (error?.code === 'EADDRINUSE') {
    console.error(`[client-runtime] port ${port} is already in use; refusing duplicate runtime start (mode=${agentRuntime.mode || 'unknown'}, pid=${process.pid}).`);
    process.exitCode = 98;
    return;
  }
  console.error('[client-runtime] server error', error);
  process.exitCode = 1;
});

server.listen(port, '127.0.0.1', () => {
  console.log(`[client-runtime] ${serveWeb ? 'web + local api' : 'local api'} listening on http://127.0.0.1:${port}`);
});

const autoTick = process.env.OPERATOR_AUTO_TICK === '1'
  ? setInterval(() => enqueueApiRequest(() => loadRuntimeState()).catch((error) => console.error('[client-runtime:auto-tick]', error)), 750)
  : null;

let shuttingDown = false;
const shutdown = () => {
  if (shuttingDown) return;
  shuttingDown = true;
  if (autoTick) clearInterval(autoTick);
  server.close(() => process.exit(0));
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
