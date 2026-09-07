import { createMissionProjectState } from './mission-project-state.mjs';
import { createCandidateCommands } from './application/candidate-commands.mjs';
import { createBenchmarkCommands } from './application/benchmark-command.mjs';
import { createDecisionCommands } from './application/decision-commands.mjs';
import { createAgentCommands } from './application/agent-commands.mjs';
import { randomUUID } from 'node:crypto';
import { createExperienceRepository } from './experience-repository.mjs';
import { createExperienceService } from './application/experience-service.mjs';
import { createExperienceApiService } from './application/experience-api-service.mjs';
import { createRoundExperienceService } from './application/round-experience-service.mjs';
import { createExperienceRoutes } from './server/experience-routes.mjs';
import { createServer } from 'node:http';
import { createRuntimeLifecycleService } from './application/runtime-lifecycle-service.mjs';
import { createRuntimeMaintenanceService } from './application/runtime-maintenance-service.mjs';
import { createRuntimeAdvanceRoutes } from './server/runtime-advance-routes.mjs';
import { createWorkflowCommandPolicy } from './application/workflow-command-policy.mjs';
import { writeFileSync } from 'node:fs';
import { mkdir, readFile, readdir, rename, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeOperatorLanguage } from './operator-language.mjs';
import { addAuditEvent } from './runtime-events.mjs';
import { applyOperatorTestSnapshot } from './operator-test-evidence.mjs';
import { createCurrentBestState, normalizeMissionBudgetMs, createResearchAgentState } from './mission-state-shapes.mjs';
import { ensureStorage, loadState as loadPersistedState, readState as readPersistedState, resetFixtureData, saveState as savePersistedState, runtimeDir } from './state-store.mjs';
import { buildBenchmarkLogsForMatrix, refreshReferenceAgent, refreshReferenceBenchmark } from './state-reference-runtime.mjs';
import { runAutomaticAdoption, markCandidateAccepted, runKnowledgeMaintenance } from './knowledge-state.mjs';
import { createDecisionReviewState } from './evidence-state.mjs';
import { workspaceDir, missionSourceDirFor, ensureMissionWorkspace, ensureProjectLayout, workspaceDirForMission, artifactDirForMission, baselineDirForMission, rebuildMissionWorkspaceFromRepository, resetMissionWorkspace, restoreWorkspaceCheckpoint, workspaceFiles, researchDirForMission } from './state-workspace.mjs';
import { isMaximizeMission } from './mission-objective.mjs';
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
import { createRuntimeAdvanceService } from './application/runtime-advance-service.mjs';
import { createBaselineOrchestrationService } from './application/baseline-orchestration-service.mjs';
import { createRuntimeStatePipelineService } from './application/runtime-state-pipeline-service.mjs';
import { createMainRoundOrchestrationService } from './application/main-round-orchestration-service.mjs';
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

import { createStateWorkspace } from './state-workspace.mjs';

const { applyCandidatePatch, createWorkspaceCheckpoint } = createStateWorkspace({ initializeStorage: ensureStorage });
const serverDir = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(serverDir, '..');
const missionProjectState = createMissionProjectState({ rootDir, workspaceDir, workspaceDirForMission, missionSourceDirFor });
const { createWorkflowRecoveryState, resetMissionRunState, selectMission, resumeMissionState, startAgentRun } = missionProjectState;
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
const experienceRepository = createExperienceRepository({ rootDir: path.join(runtimeDir, 'experiences') });
const experienceService = createExperienceService({ repository: experienceRepository, now: () => new Date().toISOString(), createId: () => 'exp-' + randomUUID() });
const roundExperienceService = createRoundExperienceService({
  experienceService, timers: { setTimeout, clearTimeout },
  resolveAccess: ({ state, mission }) => {
    if (!state.projects?.some((project) => project.id === mission.projectId)) throw Object.assign(new Error('The Mission owning Project is unavailable for experience retrieval.'), { code: 'ROUND_EXPERIENCE_ACCESS_INVALID', status: 409 });
    return { projectId: mission.projectId, allowedProjectIds: [] };
  },
  // Fail closed until the new package-backed execution verifier is installed.
  // Worker-provided evidence/verified flags cannot authorize an observation.
  verifyObservationEvidence: async () => ({ verified: false, code: 'EXECUTION_PACKAGE_EVIDENCE_UNAVAILABLE' }),
});
const commandJournal = createCommandJournal({ filePath: path.join(runtimeDir, 'command-journal.jsonl') });
const stateRepository = createStateRepository({
  load: (options = {}) => (options.recover ? loadPersistedState : readPersistedState)({ ...options, commandJournal, applyRegistry: commandRegistry }),
  save: savePersistedState,
});
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
  projectState: missionProjectState,
  loadState: () => loadRuntimeState(),
  persistState,
  ensureProjectLayout,
  workspaceDirForMission,
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
  missionState: missionProjectState,
  loadState: () => loadRuntimeState(),
  persistState,
  ensureMissionWorkspace,
  validateMissionBudgetInput: (...args) => validateMissionBudgetInput(...args),
});
const missionRoutes = createMissionRoutes({ json, readJson, missions: missionsService });
const missionQuery = createMissionQueryService({ missionState: missionProjectState, loadState: () => loadRuntimeState(), persistState });
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
      const state = await loadRuntimeState();
      const events = (state.runtimeEvents || []).filter((event) => event.missionId === missionId && event.sequence > nextSequence);
      for (const event of events) {
        if (!sse(response, 'runtime', event)) return close();
        nextSequence = Math.max(nextSequence, event.sequence || nextSequence);
      }
      const snapshotRevision = String(state.stateVersion ?? '') || state.updatedAt || `${state.agent?.runId || ''}:${state.benchmark?.status || ''}:${state.benchmark?.progress || 0}`;
      const recovery = state.workflowRecovery?.commandRecovery;
      const revision = JSON.stringify([snapshotRevision, recovery?.status, recovery?.failure?.code, recovery?.failure?.details?.commandId]);
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

const { guardMutation, hasMissionBudgetInput, validateMissionBudgetInput, guardSupportedRuntimeAction, guardWorkflowTransition, interventionOutcomeMeta, adoptCandidateState } = createWorkflowCommandPolicy({ addAuditEvent, agentRuntime, appendRuntimeEvent, createCurrentBestState, createDecisionReviewState, isManagedWorkspaceRuntimeMode, markCandidateAccepted, normalizeMissionBudgetMs });



const resetService = createResetService({ guardSupportedRuntimeAction, resetFixtureData });
const resetRoutes = createResetRoutes({ json, reset: resetService });




// 命令注册表：keyFor（幂等键）、prepare（外部副作用，返回 payload+result）、apply（纯状态变换）、isApplied（去重精确化）。
// apply 必须是纯状态函数：崩溃恢复 reconcile 会用它重放，绝不能再次触发 spawn/提交/文件写入。
const commandRegistry = Object.freeze({
  ...createCandidateCommands({ addAuditEvent, agentRuntime, appendRuntimeEvent, applyCandidatePatch, artifactDirForMission, createDecisionReviewState, createWorkspaceCheckpoint, ensureMissionWorkspace, isManagedWorkspaceRuntimeMode, mkdir, path, restoreWorkspaceCheckpoint, rootDir, workspaceManager, writeFile }),
  ...createBenchmarkCommands({ addAuditEvent, appendRuntimeEvent, baselineMatchesMatrix, createSemanticTaskBinding, hashKey, isFixedOperatorMission, localC500Config, missionShapeKeyFor, normalizeBaselineKind, operatorTestQueue, timeoutSeconds: Number(process.env.OPERATOR_LOCAL_C500_TIMEOUT_SECONDS || 600), readMissionRunPy, resolveBaselineRunPlan }),
  ...createDecisionCommands({ addAuditEvent, adoptCandidateState, appendRuntimeEvent, createDecisionReviewState, hasMissionBudgetInput, interventionOutcomeMeta, normalizeMissionBudgetMs, restoreWorkspaceCheckpoint, runAutomaticAdoption, validateMissionBudgetInput, workspaceManager }),
  ...createAgentCommands({ addAuditEvent, agentRuntime, appendRuntimeEvent, artifactDirForMission, baselineDirForMission, buildRuntimePreflight, createWorkspaceCheckpoint, hashKey, isManagedWorkspaceRuntimeMode, isStrictZeroSourceMission, mkdir, path, researchDirForMission, resetMissionRunState, resetMissionWorkspace, selectResearchBaselineSource, selectResearchDirection, startAgentRun, roundExperience: roundExperienceService }),
});

// 循环驱动依赖：advanceIteration 编排器通过 deps 拿到 agentRuntime 能力与目录函数。
const researchService = createResearchService({ missionState: missionProjectState, loadState: () => loadRuntimeState(), persistState, executeCommand, journal: commandJournal, registry: commandRegistry, agentRuntime, guardMutation: (...args) => guardMutation(...args) });
const researchRoutes = createResearchRoutes({ json, readJson, research: researchService });
const runService = createRunService({ nowMs: Date.now, missionState: missionProjectState, loadState: () => loadRuntimeState(), persistState, executeCommand, journal: commandJournal, registry: commandRegistry, agentRuntime, buildRuntimePreflight, guardMutation: (...args) => guardMutation(...args), assertMissionIntent, isStrictZeroSourceMission, isFixedOperatorMission, selectResearchBaselineSource });
const runRoutes = createRunRoutes({ json, readJson, runs: runService });
const reviewActionService = createReviewActionService({ loadState: () => loadRuntimeState(), persistState, executeCommand, journal: commandJournal, registry: commandRegistry, guardSupportedRuntimeAction, guardMutation: (...args) => guardMutation(...args), guardWorkflowTransition });
const reviewActionRoutes = createReviewActionRoutes({ json, readJson, actions: reviewActionService });
const decisionService = createDecisionService({ loadState: () => loadRuntimeState(), persistState, executeCommand, journal: commandJournal, registry: commandRegistry, guardSupportedRuntimeAction, guardMutation: (...args) => guardMutation(...args), guardWorkflowTransition });
const decisionRoutes = createDecisionRoutes({ json, readJson, decisions: decisionService });
const candidateValidationService = createCandidateValidationService({ loadState: () => loadRuntimeState(), persistState, executeCommand, journal: commandJournal, registry: commandRegistry, guardSupportedRuntimeAction, guardMutation: (...args) => guardMutation(...args), guardWorkflowTransition });
const candidateValidationRoutes = createCandidateValidationRoutes({ json, readJson, workflow: candidateValidationService });
const baselineService = createBaselineService({ loadState: () => loadRuntimeState(), persistState, executeCommand, journal: commandJournal, registry: commandRegistry, guardMutation: (...args) => guardMutation(...args), guardWorkflowTransition });
const baselineRoutes = createBaselineRoutes({ json, readJson, baseline: baselineService });
const operatorTestService = createOperatorTestService({ queue: { path: operatorTestQueue.path, list: operatorTestQueue.readTasks, get: operatorTestQueue.readTask, cancel: operatorTestQueue.cancel } });
const operatorTestRoutes = createOperatorTestRoutes({ json, operatorTests: operatorTestService });
const missionControlService = createMissionControlService({ loadState: () => loadRuntimeState(), persistState, agentRuntime, operatorTestQueue, appendRuntimeEvent, addAuditEvent });
const missionControlRoutes = createMissionControlRoutes({ json, readJson, missionControl: missionControlService });
const knowledgeService = createKnowledgeService({ loadState: () => loadRuntimeState(), persistState, guardMutation: (...args) => guardMutation(...args), appendRuntimeEvent, addAuditEvent });
const knowledgeRoutes = createKnowledgeRoutes({ json, readJson, knowledge: knowledgeService });
const experienceApiService = createExperienceApiService({ loadState: () => loadRuntimeState(), experiences: experienceService });
const experienceRoutes = createExperienceRoutes({ json, readJson, experiences: experienceApiService });
const sourceService = createSourceService({ readdir, stat, path, workspaceManager });
const iterationResearchService = createIterationResearchService({ mkdir, agentRuntime, isManagedWorkspaceRuntimeMode });
const roundRecoveryService = createRoundRecoveryService({ isManagedWorkspaceRuntimeMode, restoreWorkspaceCheckpoint, captureDiff: (...args) => workspaceManager.captureDiff(...args) });
const agentRoundService = createAgentRoundService({ resetMissionRunState, resetMissionWorkspace, createWorkspaceCheckpoint, startAgentRun, appendRuntimeEvent, isManagedWorkspaceRuntimeMode, agentRuntime, roundExperience: roundExperienceService, nowMs: () => Date.now() });
const roundPreflightService = createRoundPreflightService({ settleGenerationAttemptBeforeStart, buildRuntimePreflight });
const roundArtifactGuard = createRoundArtifactGuard({ isStrictZeroSourceMission });
const mainRoundOrchestrationService = createMainRoundOrchestrationService({ agentRuntime, preflight: roundPreflightService, recovery: roundRecoveryService, artifactGuard: roundArtifactGuard, agentRound: agentRoundService, appendRuntimeEvent, addAuditEvent });
const baselineSourceService = createBaselineSourceService({ isFixedOperatorMission, isStrictZeroSourceMission, selectResearchBaselineSource, buildSemanticBaselineSource, inferAuthoritativeBaselineSource, isSemanticBaselineSource });
const benchmarkProjectionService = createBenchmarkProjectionService({ operatorTestQueue: { get: operatorTestQueue.readTask }, testServiceClient, applyOperatorTestSnapshot, artifactDirForMission, mkdir, writeFile, path, collectExperience: roundExperienceService.collect });
const repositoryAdoptionService = createRepositoryAdoptionService({ isManagedWorkspaceRuntimeMode, adoptPatch: (...args) => workspaceManager.adoptPatch(...args), runAutomaticAdoption, runKnowledgeMaintenance, appendRuntimeEvent });
const autopilotContextService = createAutopilotContextService({ isFixedOperatorMission, selectCandidate: selectAutopilotCandidate, autoTick: process.env.OPERATOR_AUTO_TICK === '0' ? '0' : '1' });
const autopilotCandidateActionService = createAutopilotCandidateActionService({ executeCommand, journal: commandJournal, saveState: persistState, registry: commandRegistry });
const autopilotValidationService = createAutopilotValidationService({ executeCommand, journal: commandJournal, saveState: persistState, registry: commandRegistry, inferMissionMatrix });
const materializerPolicyService = createMaterializerPolicyService();

const iterationPorts = {
  startResearch: iterationResearchService.startResearch,
  cancelResearch: iterationResearchService.cancelResearch,
  registerSources: sourceService.registerSources,
  countSources: sourceService.countSources,
  startMainRound: mainRoundOrchestrationService.start,
  startBaseline: (...args) => baselineOrchestrationService.start(...args),
  researchDirForMission,
};

const autopilotFixedProfileService = createAutopilotFixedProfileService({ isResearchAgentActive, startResearch: iterationPorts.startResearch, startMainRound: iterationPorts.startMainRound, researchDirForMission, appendRuntimeEvent });
const autopilotStrictSourceService = createAutopilotStrictSourceService({ isStrictZeroSourceMission, isResearchAgentActive, selectResearchBaselineSource, buildSemanticBaselineSource, startResearch: iterationPorts.startResearch, startBaseline: iterationPorts.startBaseline, startMainRound: iterationPorts.startMainRound, researchDirForMission });
const autopilotCandidateBaselineService = createAutopilotCandidateBaselineService({ isManagedWorkspaceRuntimeMode, startBaseline: iterationPorts.startBaseline, startResearch: iterationPorts.startResearch, researchDirForMission, agentRuntime, appendRuntimeEvent, addAuditEvent });
const baselineBenchmarkService = createBaselineBenchmarkService({ executeCommand, journal: commandJournal, saveState: persistState, registry: commandRegistry });
const baselineMaterializerCommandService = createBaselineMaterializerCommandService({ executeCommand, journal: commandJournal, saveState: persistState, registry: commandRegistry });
const baselineSourceInspectionService = createBaselineSourceInspectionService({ inspectSources: (...args) => workspaceManager.inspectSources(...args), appendRuntimeEvent });
const baselineMaterializerRecoveryService = createBaselineMaterializerRecoveryService({ consumeWorkflowRecoveryBudget, startResearch: iterationPorts.startResearch, researchDirForMission, appendRuntimeEvent });
const baselineOrchestrationService = createBaselineOrchestrationService({ inferMissionMatrix, isFixedOperatorMission, isStrictZeroSourceMission, isResearchAgentActive, sourceService: baselineSourceService, sourceInspection: baselineSourceInspectionService, materializerPolicy: materializerPolicyService, materializerRecovery: baselineMaterializerRecoveryService, materializerCommand: baselineMaterializerCommandService, benchmark: baselineBenchmarkService, appendRuntimeEvent });

const iterationService = createIterationService(iterationPorts);
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
const runtimeAdvanceService = createRuntimeAdvanceService({ autopilot: autopilotService, advanceIteration, iteration: iterationService, reconcileWorkflowState, releaseResources: missionControlService.releaseResources });

const reconcilePersistedBaselineFailure = (state) => projectBaselineFailure({ state, appendRuntimeEvent });
const recordStateMigration = (state, sourcePolicyMigration) => {
  const iterationPolicyMigrated = sourcePolicyMigration.recovery?.iterationPolicyChanged === true;
  appendRuntimeEvent(state, iterationPolicyMigrated ? 'mission.iteration_policy_migrated' : 'mission.source_policy_migrated', sourcePolicyMigration.recovery, { kind: 'migration', mode: 'client' });
  const materializerRecovered = sourcePolicyMigration.recovery?.previousBlocker === 'baseline_materializer_failed';
  const migrationTitle = iterationPolicyMigrated
    ? '固定 Profile 重试策略已升级'
    : materializerRecovered ? 'C550 Materializer 交付协议已升级' : 'C550 来源策略已升级';
  const migrationDetail = iterationPolicyMigrated
    ? `${sourcePolicyMigration.recovery?.previousBlocker ? `${sourcePolicyMigration.recovery.previousBlocker} 已解除，` : ''}候选生成上限调整为 ${sourcePolicyMigration.recovery.generationAttemptLimit}`
    : sourcePolicyMigration.recovery?.previousBlocker
      ? `${sourcePolicyMigration.recovery.previousBlocker} 已解除，${materializerRecovered ? 'Materializer' : 'Research'} 将自动重新执行`
      : 'Research 将按本地、联网、语义 fallback 顺序执行';
  addAuditEvent(state, migrationTitle, migrationDetail, 'blue', 'RefreshCw');
};
const runtimeMaintenanceService = createRuntimeMaintenanceService({ isManagedWorkspaceRuntimeMode, runKnowledgeMaintenance, runAutomaticAdoption, isMaximizeMission, refreshReferenceBenchmark, refreshReferenceAgent });
const runtimeStatePipelineService = createRuntimeStatePipelineService({
  maintenance: runtimeMaintenanceService,
  processTests: (options) => operatorTestQueue.dispatch(options),
  migrateState: (state) => migrateLocalC500TesterState(state, { enabled: localC500Config.enabled }),
  recordMigration: recordStateMigration,
  projectBaselineFailure: reconcilePersistedBaselineFailure,
  runtimeProjection: runtimeProjectionService,
  benchmarkProjection: benchmarkProjectionService,
  repositoryAdoption: repositoryAdoptionService,
  runtimeAdvance: runtimeAdvanceService,
});

const runtimeLifecycleService = createRuntimeLifecycleService({
  readState: stateRepository.read,
  persistState,
  describeRuntime: () => agentRuntime.describe(),
  pipeline: runtimeStatePipelineService,
  canAdvance: () => runtimeOwnerPid <= 0 || processAlive(runtimeOwnerPid),
});
const loadRuntimeState = () => runtimeLifecycleService.read();
const advanceRuntimeState = () => runtimeLifecycleService.advance();
const runtimeAdvanceRoutes = createRuntimeAdvanceRoutes({ json, advanceRuntime: advanceRuntimeState });

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
  if (await experienceRoutes({ request, response, url })) return;
  if (await runtimeQueryRoutes({ request, response, url })) return;
  if (await runtimeAdvanceRoutes({ request, response, url })) return;
  if (await runtimeStateRoutes({ request, response, url })) return;
  if (await resetRoutes({ request, response, url })) return;
  json(response, 404, { error: 'API endpoint not found.' });
}

await ensureStorage();
await mkdir(path.dirname(serverPidPath), { recursive: true });
const server = createServer(async (request, response) => {
  const url = new URL(request.url, `http://${request.headers.host || '127.0.0.1'}`);
  try {
    // Parse bounded request bodies before entering the mutation queue. Routes
    // consume the same cached readJson promise, never the socket a second time.
    if (url.pathname.startsWith('/api/') && ['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method)) await readJson(request);
    if ((url.pathname.startsWith('/api/') && ['GET', 'HEAD'].includes(request.method))
      || url.pathname.match(/^\/api\/missions\/[^/]+\/events\/stream$/)
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
    await stateRepository.runExclusive(() => advanceRuntimeState());
  } catch (error) {
    console.error('[client-runtime:auto-tick]', error);
  } finally {
    autoTickBusy = false;
  }
};
autoTick = process.env.OPERATOR_AUTO_TICK !== '0'
  ? setInterval(() => { void runAutoTick(); }, autoTickIntervalMs)
  : null;
