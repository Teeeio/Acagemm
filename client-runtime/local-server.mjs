import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { mkdir, readFile, readdir, rename, stat, writeFile } from 'node:fs/promises';
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
  createWorkspaceCheckpoint,
  ensureMissionWorkspace,
  ensureProjectLayout,
  artifactDirForMission,
  baselineDirForMission,
  ensureStorage,
  buildBenchmarkLogsForMatrix,
  loadState as loadPersistedState,
  resetDemoData,
  rebuildMissionWorkspaceFromRepository,
  resetMissionWorkspace,
  restoreWorkspaceCheckpoint,
  runAutomaticAdoption,
  markCandidateAccepted,
  normalizeMissionBudgetMs,
  resetMissionRunState,
  runKnowledgeMaintenance,
  saveState as savePersistedState,
  selectMission,
  resumeMissionState,
  startAgentRun,
  runtimeDir,
  workspaceFiles,
  researchDirForMission,
  createResearchAgentState,
} from './state-store.mjs';
import { agentRuntime, isResearchAgentActive } from './agent-runtime.mjs';
import { isManagedWorkspaceRuntimeMode } from './agent-runtime/capabilities.mjs';
import { appendRuntimeEvent } from './runtime-events.mjs';
import { advanceIteration, selectResearchDirection, settleGenerationAttemptBeforeStart } from './iteration-loop.mjs';
import { createCommandJournal, executeCommand, hashKey } from './command-journal.mjs';
import { testServiceClient } from './test-service-client.mjs';
import { createOperatorTestQueue } from './operator-test-queue.mjs';
import { consumeWorkflowRecoveryBudget, reconcileWorkflowState } from './workflow-kernel.mjs';
import { normalizeWorkflowError, serializeWorkflowError } from './workflow-error.mjs';
import { createLocalC500ServiceClient, localC500Config } from './local-c500-service-client.mjs';
import { migrateLocalC500TesterState } from './local-c500-state-migration.mjs';
import { LOCAL_C500_RUNTIME_CONTRACT_VERSION } from './local-c500-runtime-contract.mjs';
import { workspaceManager } from './workspace-manager.mjs';
import { assertMissionIntent } from './mission-intent.mjs';
import { nativeDirectoryPicker } from './native-directory-picker.mjs';
import { dataDir } from './storage-paths.mjs';
import { isFixedOperatorMission } from './fixed-operator-profiles.mjs';
import { createSemanticSnapshot, createSemanticTaskBinding, freezeSemanticSnapshot } from './semantic-snapshot.mjs';
import { createStateRepository } from './state-repository.mjs';
import { createJsonResponder, createStaticFileHandler, readJson, sendSse as sse } from './server/http.mjs';
import { createSystemRoutes } from './server/system-routes.mjs';
import { createFilesystemService, directoryExists } from './server/filesystem-service.mjs';
import { createFilesystemRoutes } from './server/filesystem-routes.mjs';
import { createProjectRoutes } from './server/project-routes.mjs';
import { createMissionRoutes } from './server/mission-routes.mjs';
import { createProjectsService } from './application/projects-service.mjs';
import { createMissionsService } from './application/missions-service.mjs';
import { createMissionQueryService } from './application/mission-query-service.mjs';
import { createMissionQueryRoutes } from './server/mission-query-routes.mjs';
import { createSemanticRoutes } from './server/semantic-routes.mjs';
import { createSemanticService } from './application/semantic-service.mjs';
import { createResearchService } from './application/research-service.mjs';
import { createRunService } from './application/run-service.mjs';
import { createResearchRoutes } from './server/research-routes.mjs';
import { createRunRoutes } from './server/run-routes.mjs';
import { createReviewActionRoutes } from './server/review-action-routes.mjs';
import { createReviewActionService } from './application/review-action-service.mjs';
import { createDecisionRoutes } from './server/decision-routes.mjs';
import { createDecisionService } from './application/decision-service.mjs';
import { createCandidateValidationRoutes } from './server/candidate-validation-routes.mjs';
import { createCandidateValidationService } from './application/candidate-validation-service.mjs';
import { createBaselineRoutes } from './server/baseline-routes.mjs';
import { createBaselineService } from './application/baseline-service.mjs';
import { createOperatorTestRoutes } from './server/operator-test-routes.mjs';
import { createOperatorTestService } from './application/operator-test-service.mjs';
import { createMissionControlRoutes } from './server/mission-control-routes.mjs';
import { createMissionControlService } from './application/mission-control-service.mjs';
import { createKnowledgeRoutes } from './server/knowledge-routes.mjs';
import { createKnowledgeService } from './application/knowledge-service.mjs';
import { createSourceService } from './application/source-service.mjs';
import { createIterationResearchService } from './application/iteration-research-service.mjs';
import { createRoundRecoveryService } from './application/round-recovery-service.mjs';
import { createAgentRoundService } from './application/agent-round-service.mjs';
import { createRoundPreflightService } from './application/round-preflight-service.mjs';
import { createRoundArtifactGuard } from './application/round-artifact-guard.mjs';
import { createBaselineSourceService } from './application/baseline-source-service.mjs';
import { createMaterializerPolicyService } from './application/materializer-policy-service.mjs';
import { projectBaselineFailure } from './application/baseline-failure-projection.mjs';
import { createBenchmarkProjectionService } from './application/benchmark-projection-service.mjs';
import { createRepositoryAdoptionService } from './application/repository-adoption-service.mjs';
import { selectAutopilotCandidate } from './application/autopilot-candidate-service.mjs';
import { createAutopilotContextService } from './application/autopilot-context-service.mjs';
import { createAutopilotCandidateActionService } from './application/autopilot-candidate-action-service.mjs';
import { createAutopilotValidationService } from './application/autopilot-validation-service.mjs';
import { createAutopilotService } from './application/autopilot-service.mjs';
import { createAutopilotFixedProfileService } from './application/autopilot-fixed-profile-service.mjs';
import { createAutopilotStrictSourceService } from './application/autopilot-strict-source-service.mjs';
import { createAutopilotCandidateBaselineService } from './application/autopilot-candidate-baseline-service.mjs';
import { createBaselineBenchmarkService } from './application/baseline-benchmark-service.mjs';
import { createBaselineMaterializerCommandService } from './application/baseline-materializer-command-service.mjs';
import { createBaselineSourceInspectionService } from './application/baseline-source-inspection-service.mjs';
import { createBaselineMaterializerRecoveryService } from './application/baseline-materializer-recovery-service.mjs';
import { createIterationService } from './application/iteration-service.mjs';
import { createRuntimeProjectionService } from './application/runtime-projection-service.mjs';
import { createRuntimeQueryRoutes } from './server/runtime-query-routes.mjs';
import { createRuntimeQueryService } from './application/runtime-query-service.mjs';
import { createRuntimeStateRoutes } from './server/runtime-state-routes.mjs';
import { createRuntimeStateService } from './application/runtime-state-service.mjs';
import { createResetRoutes } from './server/reset-routes.mjs';
import { createResetService } from './application/reset-service.mjs';
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
const runtimeOwnerPid = Number(process.env.OPERATOR_RUNTIME_OWNER_PID || 0);
const processAlive = (pid) => {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
};
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
  ownerPid: runtimeOwnerPid || null,
  startedAt,
};
const activeTestServiceClient = localC500Config.enabled
  ? createLocalC500ServiceClient()
  : testServiceClient;
const operatorTestQueue = createOperatorTestQueue({ serviceClient: activeTestServiceClient });
const commandJournal = createCommandJournal({ filePath: path.join(runtimeDir, 'command-journal.jsonl') });
const stateRepository = createStateRepository({ load: loadPersistedState, save: savePersistedState });
const persistState = stateRepository.persist;
const json = createJsonResponder(bridge);
const testBackendDescriptor = localC500Config.enabled
  ? localC500Config
  : { kind: 'operator-test-service', liveHardware: false };
const systemRoutes = createSystemRoutes({
  json,
  describeRuntime: () => agentRuntime.describe(),
  testBackend: testBackendDescriptor,
});
const filesystemService = createFilesystemService({ picker: nativeDirectoryPicker });
const filesystemRoutes = createFilesystemRoutes({ json, readJson, filesystem: filesystemService });
const projectsService = createProjectsService({
  loadState: () => loadRuntimeState(),
  persistState,
  ensureProjectLayout,
  workspace: workspaceManager,
  filesystem: { directoryExists, mkdir, readFile, readdir, rename },
  guardMutation: (...args) => guardMutation(...args),
  createWorkflowRecoveryState,
  addAuditEvent,
  ensureMissionWorkspace,
  rebuildMissionWorkspaceFromRepository,
});
const projectRoutes = createProjectRoutes({ json, readJson, projects: projectsService });
const missionsService = createMissionsService({
  loadState: () => loadRuntimeState(),
  persistState,
  ensureMissionWorkspace,
  validateMissionBudgetInput: (...args) => validateMissionBudgetInput(...args),
});
const missionRoutes = createMissionRoutes({ json, readJson, missions: missionsService });
const missionQuery = createMissionQueryService({ loadState: () => loadRuntimeState(), persistState });
const missionQueryRoutes = createMissionQueryRoutes({ json, missionQuery, streamEvents: (...args) => streamMissionEvents(...args) });
const semanticService = createSemanticService({ loadState: () => loadRuntimeState(), persistState, guardMutation: (...args) => guardMutation(...args), appendRuntimeEvent, addAuditEvent });
const semanticRoutes = createSemanticRoutes({ json, readJson, semantic: semanticService });
const serveStatic = createStaticFileHandler({ distDir, serveWeb, json });

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

const runtimeQueryService = createRuntimeQueryService({
  loadState: () => loadRuntimeState(),
  ensureMissionWorkspace,
  inspectWorkspace: (...args) => workspaceManager.inspect(...args),
  inspectSources: (...args) => workspaceManager.inspectSources(...args),
  preflightAgent: (...args) => agentRuntime.preflight(...args),
  inspectSourceContent: hasSourceContent,
  artifactDirForMission,
  isStrictZeroSourceMission,
  isSimulationRuntime: () => agentRuntime.mode === 'reference-fixture' && localC500Config.simulation,
  presentWorkspacePath: (workspace) => path.relative(rootDir, workspace).replaceAll('\\', '/'),
  workspaceFiles,
});
const runtimeQueryRoutes = createRuntimeQueryRoutes({ json, runtimeQuery: runtimeQueryService });
const buildRuntimePreflight = (mission) => runtimeQueryService.buildPreflight(mission);
const runtimeStateService = createRuntimeStateService({ loadState: () => loadRuntimeState(), persistState, resumeMissionState, normalizeMissionBudgetMs });
const runtimeStateRoutes = createRuntimeStateRoutes({ json, readJson, runtimeState: runtimeStateService });

const readMissionRunPy = async (missionId, repository, projectRoot = null, implementation = null, operatorProfile = null) => {
  const workspace = await ensureMissionWorkspace(missionId, repository, { projectRoot });
  const candidates = [
    path.join(workspace, 'run.py'),
    path.join(workspace, 'operator', 'run.py'),
  ];
  for (const filePath of candidates) {
    try {
      const source = path.relative(workspace, filePath).replaceAll('\\', '/');
      const adapter = normalizeOperatorLanguage(implementation);
      const allowedFiles = operatorProfile?.candidateContract?.allowedFiles || adapter.allowedFiles;
      const implementationFiles = {};
      for (const relativePath of allowedFiles.filter((file) => file !== source)) {
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
      const state = await stateRepository.runExclusive(() => loadRuntimeState());
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

const resetService = createResetService({ guardSupportedRuntimeAction, resetDemoData });
const resetRoutes = createResetRoutes({ json, reset: resetService });

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
        : await applyCandidatePatch(state.activeMissionId, body.candidate);
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
      const semanticBinding = mission.semanticSnapshot?.status === 'frozen'
        ? createSemanticTaskBinding(mission.semanticSnapshot, { testSpec: normalizedMatrix.testSpec })
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
        : await readMissionRunPy(state.activeMissionId, mission.repository, mission.projectRoot, mission.implementation, mission.operatorProfile);
      const submitted = await operatorTestQueue.submit({
        schemaVersion: 1, requestId: runId, missionId: state.activeMissionId,
        purpose, baselineKind,
        operator: body.operator || 'mla_paged_attention', candidate: { id: candidateId, digest: candidateDigest, remoteId: body.remoteCandidateId || null },
        hardware: mission.hardware || matrix.environments, runtime: body.runtime || 'client-managed-runtime', metric: mission.metric || 'latency_p50',
        matrix: normalizedMatrix, tracer: { enabled: true, format: 'operator-trace/v1' }, profiler: { enabled: true, format: 'operator-profile/v1' },
        limits: { timeoutSeconds: Number(body.timeoutSeconds || process.env.OPERATOR_LOCAL_C500_TIMEOUT_SECONDS || 600) },
        ...(baselineSource ? { baselineSource } : {}),
        ...(baselinePlan?.materializationReport ? { baselineMaterialization: baselinePlan.materializationReport } : {}),
        ...(missionRunPy.content ? { runPy: missionRunPy.content, runPySource: missionRunPy.source } : {}),
        ...(purpose !== 'baseline' && state.baseline?.materializer?.result?.runPy ? { oracleRunPy: state.baseline.materializer.result.runPy } : {}),
        ...(purpose !== 'baseline' && isFixedOperatorMission(mission) && (state.baseline?.source || mission.baseline?.source) ? { baselineSource: state.baseline?.source || mission.baseline?.source } : {}),
        ...(Object.keys(missionRunPy.implementationFiles || {}).length ? { implementationFiles: missionRunPy.implementationFiles } : {}),
        ...(body.packageId ? { packageId: body.packageId } : {}),
        ...(body.remoteCandidateId ? { remoteCandidateId: body.remoteCandidateId } : {}),
        ...(semanticBinding ? { semanticBinding } : {}),
      });
      return {
        payload: { runId, taskId: submitted.taskId, purpose, baselineKind, baselineSource, semanticBinding, baselineResolution: baselinePlan?.resolution || null, baselineMaterialization: baselinePlan?.materializationReport || null, matrix: structuredClone(matrix), normalizedMatrix, candidateId, candidateDigest, environments: matrix.environments, stages: matrix.stages, submittedAt: submitted.submittedAt },
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
        semanticBinding: payload.semanticBinding ? structuredClone(payload.semanticBinding) : null,
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
const researchService = createResearchService({ loadState: () => loadRuntimeState(), persistState, executeCommand, journal: commandJournal, registry: commandRegistry, agentRuntime, guardMutation: (...args) => guardMutation(...args) });
const researchRoutes = createResearchRoutes({ json, readJson, research: researchService });
const runService = createRunService({ loadState: () => loadRuntimeState(), persistState, executeCommand, journal: commandJournal, registry: commandRegistry, agentRuntime, buildRuntimePreflight, guardMutation: (...args) => guardMutation(...args), assertMissionIntent, isStrictZeroSourceMission, isFixedOperatorMission, selectResearchBaselineSource });
const runRoutes = createRunRoutes({ json, readJson, runs: runService });
const reviewActionService = createReviewActionService({ loadState: () => loadRuntimeState(), persistState, executeCommand, journal: commandJournal, registry: commandRegistry, guardSupportedRuntimeAction, guardMutation: (...args) => guardMutation(...args), guardWorkflowTransition });
const reviewActionRoutes = createReviewActionRoutes({ json, readJson, actions: reviewActionService });
const decisionService = createDecisionService({ loadState: () => loadRuntimeState(), persistState, executeCommand, journal: commandJournal, registry: commandRegistry, guardSupportedRuntimeAction, guardMutation: (...args) => guardMutation(...args), guardWorkflowTransition });
const decisionRoutes = createDecisionRoutes({ json, readJson, decisions: decisionService });
const candidateValidationService = createCandidateValidationService({ loadState: () => loadRuntimeState(), persistState, executeCommand, journal: commandJournal, registry: commandRegistry, guardSupportedRuntimeAction, guardMutation: (...args) => guardMutation(...args), guardWorkflowTransition });
const candidateValidationRoutes = createCandidateValidationRoutes({ json, readJson, workflow: candidateValidationService });
const baselineService = createBaselineService({ loadState: () => loadRuntimeState(), persistState, executeCommand, journal: commandJournal, registry: commandRegistry, guardMutation: (...args) => guardMutation(...args), guardWorkflowTransition });
const baselineRoutes = createBaselineRoutes({ json, readJson, baseline: baselineService });
const operatorTestService = createOperatorTestService({ queue: operatorTestQueue });
const operatorTestRoutes = createOperatorTestRoutes({ json, operatorTests: operatorTestService });
const missionControlService = createMissionControlService({ loadState: () => loadRuntimeState(), persistState, agentRuntime, operatorTestQueue, appendRuntimeEvent, addAuditEvent });
const missionControlRoutes = createMissionControlRoutes({ json, readJson, missionControl: missionControlService });
const knowledgeService = createKnowledgeService({ loadState: () => loadRuntimeState(), persistState, guardMutation: (...args) => guardMutation(...args), appendRuntimeEvent, addAuditEvent });
const knowledgeRoutes = createKnowledgeRoutes({ json, readJson, knowledge: knowledgeService });
const sourceService = createSourceService({ readdir, stat, path, workspaceManager });
const iterationResearchService = createIterationResearchService({ mkdir, agentRuntime, isManagedWorkspaceRuntimeMode });
const roundRecoveryService = createRoundRecoveryService({ isManagedWorkspaceRuntimeMode, restoreWorkspaceCheckpoint, captureDiff: (...args) => workspaceManager.captureDiff(...args) });
const agentRoundService = createAgentRoundService({ resetMissionRunState, resetMissionWorkspace, createWorkspaceCheckpoint, startAgentRun, appendRuntimeEvent, isManagedWorkspaceRuntimeMode, agentRuntime });
const roundPreflightService = createRoundPreflightService({ settleGenerationAttemptBeforeStart, buildRuntimePreflight });
const roundArtifactGuard = createRoundArtifactGuard({ isStrictZeroSourceMission });
const baselineSourceService = createBaselineSourceService({ isFixedOperatorMission, isStrictZeroSourceMission, selectResearchBaselineSource, buildSemanticBaselineSource, inferAuthoritativeBaselineSource, isSemanticBaselineSource });
const benchmarkProjectionService = createBenchmarkProjectionService({ operatorTestQueue, testServiceClient, applyOperatorTestSnapshot, artifactDirForMission, mkdir, writeFile, path });
const repositoryAdoptionService = createRepositoryAdoptionService({ isManagedWorkspaceRuntimeMode, adoptPatch: (...args) => workspaceManager.adoptPatch(...args), runAutomaticAdoption, runKnowledgeMaintenance, appendRuntimeEvent });
const autopilotContextService = createAutopilotContextService({ isFixedOperatorMission, selectCandidate: selectAutopilotCandidate });
const autopilotCandidateActionService = createAutopilotCandidateActionService({ executeCommand, journal: commandJournal, saveState: persistState, registry: commandRegistry });
const autopilotValidationService = createAutopilotValidationService({ executeCommand, journal: commandJournal, saveState: persistState, registry: commandRegistry, inferMissionMatrix });
const materializerPolicyService = createMaterializerPolicyService({ consumeWorkflowRecoveryBudget: (...args) => consumeWorkflowRecoveryBudget(...args) });

const iterationDeps = {
  startResearch: iterationResearchService.startResearch,
  cancelResearch: iterationResearchService.cancelResearch,
  registerSources: sourceService.registerSources,
  countSources: sourceService.countSources,
  startMainRound: async ({ state, goal, retryMode = 'generation' }) => {
    const runtimeDescriptor = await agentRuntime.describe();
    const prepared = await roundPreflightService.prepare({ state, goal, retryMode });
    if (prepared.blocked) return state;
    const { mission, preflight } = prepared;
    const workspace = preflight.workspace;
    const rollback = await roundRecoveryService.restoreRejectedRound({ state, workspace, runtimeMode: runtimeDescriptor.mode });
    roundArtifactGuard.assertReady({ mission, state });
    if (rollback) {
      state.workflowRecovery = { ...(state.workflowRecovery || {}), lastRecovery: { type: 'round_rollback', ...rollback } };
      appendRuntimeEvent(state, 'workflow.round_rolled_back', rollback, { kind: 'recovery', mode: 'client' });
      addAuditEvent(state, '未采纳候选已回退', `${rollback.candidateId || 'candidate'} · ${rollback.checkpointId} · workspace clean`, 'warning', 'History');
    }
    return agentRoundService.startRound({ state, mission, goal, workspace, runtimeMode: runtimeDescriptor.mode });
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
    const { source: baselineSource, semanticFallback } = baselineSourceService.select({ state, mission, reason });
    if (!baselineSource) return state;
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
        const inspection = await baselineSourceInspectionService.inspect({ state, mission, baselineSource });
        if (!inspection.valid) return inspection.state;
      }
      const materializer = state.baseline?.materializer || {};
      const materializerPolicy = materializerPolicyService.inspect({ state, materializer, baselineSource });
      if (materializerPolicy.action === 'wait') return state;
      if (materializerPolicy.action === 'continue') {
        // fall through to benchmark submission below
      }
      if (materializer.status !== 'completed' || !materializer.result?.runPy) {
        if (['running', 'cancel_requested'].includes(materializer.status)) return state;
        if (['failed', 'cancelled', 'timed_out'].includes(materializer.status)) {
          const recovered = await baselineMaterializerRecoveryService.recover({ state, mission, baselineSource, materializer });
          return recovered.state;
        }
        return baselineMaterializerCommandService.start({ state, baselineSource, matrix });
      }
    }
    return baselineBenchmarkService.start({ state, mission, baselineSource, matrix, strictZeroSource, fixedOperator });
  },
  researchDirForMission,
};

const autopilotFixedProfileService = createAutopilotFixedProfileService({ isResearchAgentActive, startResearch: iterationDeps.startResearch, startMainRound: iterationDeps.startMainRound, researchDirForMission, appendRuntimeEvent });
const autopilotStrictSourceService = createAutopilotStrictSourceService({ isStrictZeroSourceMission, isResearchAgentActive, selectResearchBaselineSource, buildSemanticBaselineSource, startResearch: iterationDeps.startResearch, startBaseline: iterationDeps.startBaseline, startMainRound: iterationDeps.startMainRound, researchDirForMission });
const autopilotCandidateBaselineService = createAutopilotCandidateBaselineService({ isManagedWorkspaceRuntimeMode, startBaseline: iterationDeps.startBaseline, startResearch: iterationDeps.startResearch, researchDirForMission, agentRuntime, appendRuntimeEvent, addAuditEvent });
const baselineBenchmarkService = createBaselineBenchmarkService({ executeCommand, journal: commandJournal, saveState: persistState, registry: commandRegistry });
const baselineMaterializerCommandService = createBaselineMaterializerCommandService({ executeCommand, journal: commandJournal, saveState: persistState, registry: commandRegistry });
const baselineSourceInspectionService = createBaselineSourceInspectionService({ inspectSources: (...args) => workspaceManager.inspectSources(...args), appendRuntimeEvent });
const baselineMaterializerRecoveryService = createBaselineMaterializerRecoveryService({ consumeWorkflowRecoveryBudget, startResearch: iterationDeps.startResearch, researchDirForMission, appendRuntimeEvent });

const advanceTesterAutopilot = async (state) => {
  const context = autopilotContextService.prepare(state);
  if (!context.enabled) return { state, action: 'none' };
  const { mission } = context;
  const actionType = state.agent?.currentAction?.type;
  const { candidate } = context;

  // 专用四算子路径：冻结语义和测试矩阵 -> baseline -> 可选经验调研 -> 三轮候选。
  // 经验调研的失败被记录，但不会改变 baseline 或使任务进入 needs_human。
  if (isFixedOperatorMission(mission)) {
    if (state.baseline?.status !== 'complete') {
      const nextState = await iterationDeps.startBaseline({ state, mission, reason: 'fixed operator profile baseline' });
      return { state: nextState, action: nextState.benchmark?.status === 'running' ? 'baseline_started' : 'wait_baseline' };
    }
    return autopilotFixedProfileService.advance({ state, mission });
  }

  if (isStrictZeroSourceMission(mission)) {
    return (await autopilotStrictSourceService.advance({ state, mission, candidate })) || { state, action: 'none' };
  }

  if (state.stage === 'candidate' && state.agent?.status === 'awaiting_action' && state.baseline?.status !== 'complete') {
    return (await autopilotCandidateBaselineService.advance({ state, mission })) || { state, action: 'none' };
  }

  if (state.stage === 'candidate' && state.agent?.status === 'awaiting_action' && state.baseline?.status === 'complete') {
    if (agentRuntime.mode === 'reference-fixture' && candidate?.id && !candidate.patchDigest && actionType === 'candidate.plan') {
      return { state: await autopilotCandidateActionService.applyCandidate({ state, candidateId: candidate.id }), action: 'simulation_candidate_applied' };
    }
    if (candidate?.patchDigest && actionType === 'candidate.plan') {
      return { state: await autopilotCandidateActionService.applyCandidate({ state, candidateId: candidate.id }), action: 'candidate_applied' };
    }
    if (!candidate?.patchDigest) {
      return { state: await autopilotCandidateActionService.resumeCandidate({ state, mission, startMainRound: iterationDeps.startMainRound }), action: 'candidate_resumed' };
    }
  }

  if (state.stage === 'validation'
      && state.patchApplied
      && state.baseline?.status === 'complete'
      && state.agent?.status === 'awaiting_action'
      && actionType === 'test.plan') {
    return { state: await autopilotValidationService.startCandidateTest({ state, mission }), action: 'candidate_test_started' };
  }

  return { state, action: 'none' };
};
const iterationService = createIterationService(iterationDeps);
const runtimeProjectionService = createRuntimeProjectionService({ reconcileWorkflowState, projectState: (...args) => agentRuntime.projectState(...args) });

const autopilotService = createAutopilotService({
  contextService: autopilotContextService,
  fixedProfileService: autopilotFixedProfileService,
  strictSourceService: autopilotStrictSourceService,
  candidateBaselineService: autopilotCandidateBaselineService,
  candidateActionService: autopilotCandidateActionService,
  validationService: autopilotValidationService,
  iteration: iterationService,
  isFixedOperatorMission,
  isStrictZeroSourceMission,
  runtimeMode: () => agentRuntime.mode,
});

let runtimeStateInFlight = null;
const reconcilePersistedBaselineFailure = (state) => projectBaselineFailure({ state, appendRuntimeEvent });

const loadRuntimeState = async () => {
  if (runtimeStateInFlight) return structuredClone(await runtimeStateInFlight);
  runtimeStateInFlight = (async () => {
  const runtime = await agentRuntime.describe();
  const state = await stateRepository.read({ runtimeMode: runtime.mode, commandJournal, applyRegistry: commandRegistry });
  const sourcePolicyMigration = migrateLocalC500TesterState(state, { enabled: localC500Config.enabled });
  if (sourcePolicyMigration.changed) {
    const iterationPolicyMigrated = sourcePolicyMigration.recovery?.iterationPolicyChanged === true;
    appendRuntimeEvent(state, iterationPolicyMigrated ? 'mission.iteration_policy_migrated' : 'mission.source_policy_migrated', sourcePolicyMigration.recovery, { kind: 'migration', mode: 'client' });
    const materializerRecovered = sourcePolicyMigration.recovery?.previousBlocker === 'baseline_materializer_failed';
    const migrationTitle = iterationPolicyMigrated
      ? '固定 Profile 重试策略已升级'
      : materializerRecovered ? 'C500 Materializer 交付协议已升级' : 'C500 来源策略已升级';
    const migrationDetail = iterationPolicyMigrated
      ? `${sourcePolicyMigration.recovery?.previousBlocker ? `${sourcePolicyMigration.recovery.previousBlocker} 已解除，` : ''}候选生成上限调整为 ${sourcePolicyMigration.recovery.generationAttemptLimit}`
      : sourcePolicyMigration.recovery?.previousBlocker
        ? `${sourcePolicyMigration.recovery.previousBlocker} 已解除，${materializerRecovered ? 'Materializer' : 'Research'} 将自动重新执行`
        : 'Research 将按本地、联网、语义 fallback 顺序执行';
    addAuditEvent(state, migrationTitle, migrationDetail, 'blue', 'RefreshCw');
  }
  const baselineFailureProjected = reconcilePersistedBaselineFailure(state);
  const projection = await runtimeProjectionService.project({ state, runtime });
  let changed = baselineFailureProjected || sourcePolicyMigration.changed || projection.changed;
  const benchmarkProjection = await benchmarkProjectionService.project({ state: projection.state });
  changed ||= benchmarkProjection.changed;
  const adoption = await repositoryAdoptionService.adopt({ state: projection.state });
  changed ||= adoption.changed;
  const autopilot = await autopilotService.advance(projection.state);
  projection.state = autopilot.state;
  if (autopilot.action !== 'none') changed = true;
  const looped = await advanceIteration(projection.state, iterationService);
  if (['research_timeout', 'research_injected', 'research_noted', 'round_counted', 'correctness_attempt_counted', 'generation_attempt_counted', 'resumed_agent', 'research_escalated', 'baseline_started', 'resumed_after_baseline', 'failed_candidate_recorded'].includes(looped.action)) changed = true;
  const finalReconciliation = reconcileWorkflowState(looped.state);
  changed ||= finalReconciliation.changed;
  return changed ? persistState(finalReconciliation.state) : finalReconciliation.state;
  })().finally(() => { runtimeStateInFlight = null; });
  return structuredClone(await runtimeStateInFlight);
};

async function handleApi(request, response, url) {
  if (await systemRoutes({ request, response, url })) return;
  if (await filesystemRoutes({ request, response, url })) return;
  if (await projectRoutes({ request, response, url })) return;
  if (await missionRoutes({ request, response, url })) return;
  if (await missionQueryRoutes({ request, response, url })) return;
  if (await semanticRoutes({ request, response, url })) return;
  if (await researchRoutes({ request, response, url })) return;
  if (await runRoutes({ request, response, url })) return;
  if (await reviewActionRoutes({ request, response, url })) return;
  if (await decisionRoutes({ request, response, url })) return;
  if (await candidateValidationRoutes({ request, response, url })) return;
  if (await baselineRoutes({ request, response, url })) return;
  if (await operatorTestRoutes({ request, response, url })) return;
  if (await missionControlRoutes({ request, response, url })) return;
  if (await knowledgeRoutes({ request, response, url })) return;
  if (await runtimeQueryRoutes({ request, response, url })) return;
  if (await runtimeStateRoutes({ request, response, url })) return;
  if (await resetRoutes({ request, response, url })) return;
  json(response, 404, { error: 'API endpoint not found.' });
}

await ensureStorage();
await mkdir(path.dirname(serverPidPath), { recursive: true });
const server = createServer(async (request, response) => {
  const url = new URL(request.url, `http://${request.headers.host || '127.0.0.1'}`);
  try {
    if (url.pathname.match(/^\/api\/missions\/[^/]+\/events\/stream$/)
      || url.pathname === '/api/health'
      || url.pathname === '/api/runtime') await handleApi(request, response, url);
    else if (url.pathname.startsWith('/api/')) await stateRepository.runExclusive(() => handleApi(request, response, url));
    else await serveStatic(response, url);
  } catch (error) {
    console.error('[client-runtime]', error);
    const workflowError = serializeWorkflowError(normalizeWorkflowError(error, { phase: `api:${request.method} ${url.pathname}`, source: 'client-runtime-api' }));
    json(response, error.status || 500, { error: workflowError.message, code: workflowError.code, workflowError, ...(error.details ? { details: error.details } : {}) });
  }
});

let autoTick = null;
server.on('error', (error) => {
  if (error?.code === 'EADDRINUSE') {
    console.error(`[client-runtime] port ${port} is already in use; refusing duplicate runtime start (mode=${agentRuntime.mode || 'unknown'}, pid=${process.pid}).`);
    // A failed listener must not leave its auto-tick loop alive. This used to
    // keep a duplicate process spinning and competing for the same state file.
    if (autoTick) clearInterval(autoTick);
    process.exit(98);
    return;
  }
  console.error('[client-runtime] server error', error);
  process.exitCode = 1;
});

server.listen(port, '127.0.0.1', () => {
  // Only publish the PID after the listener is bound. A duplicate process
  // must never overwrite the live runtime's PID file before EADDRINUSE.
  writeFileSync(serverPidPath, `${process.pid}\n`, 'ascii');
  console.log(`[client-runtime] ${serveWeb ? 'web + local api' : 'local api'} listening on http://127.0.0.1:${port}`);
});

let shuttingDown = false;
const shutdown = () => {
  if (shuttingDown) return;
  shuttingDown = true;
  if (autoTick) clearInterval(autoTick);
  server.close(() => process.exit(0));
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// A detached production runtime may only advance the workflow while its TUI
// owner is alive. Legacy/direct server launches without an owner retain their
// explicit OPERATOR_AUTO_TICK behavior for integration harnesses.
let autoTickBusy = false;
const configuredAutoTickIntervalMs = Number(process.env.OPERATOR_AUTO_TICK_INTERVAL_MS || 1500);
const autoTickIntervalMs = Number.isFinite(configuredAutoTickIntervalMs)
  ? Math.max(1000, configuredAutoTickIntervalMs)
  : 1500;
const runAutoTick = async () => {
  if (autoTickBusy) return;
  autoTickBusy = true;
  try {
    if (runtimeOwnerPid > 0 && !processAlive(runtimeOwnerPid)) {
      shutdown();
      return;
    }
    await stateRepository.runExclusive(() => loadRuntimeState());
  } catch (error) {
    console.error('[client-runtime:auto-tick]', error);
  } finally {
    autoTickBusy = false;
  }
};
autoTick = process.env.OPERATOR_AUTO_TICK === '1'
  ? setInterval(() => { void runAutoTick(); }, autoTickIntervalMs)
  : null;
