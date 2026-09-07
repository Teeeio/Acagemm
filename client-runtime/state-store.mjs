import { createStateWorkspace, resetFixtureWorkspaces, workspaceDir, workspaceDirForMission, missionSourceDirFor, ensureMissionWorkspace } from './state-workspace.mjs';
export { workspaceDir, projectLayoutFor, workspaceDirForMission, missionRootFor, missionSourceDirFor, baselineDirForMission, artifactDirForMission, researchDirForMission, researchNotesDirForMission, researchClonesDirForMission, ensureProjectLayout, ensureMissionWorkspace, workspaceFiles, resetMissionWorkspace, rebuildMissionWorkspaceFromRepository, restoreWorkspaceCheckpoint } from './state-workspace.mjs';
import { createStorageInitializer, readStateSnapshot, writeStateSnapshot, quarantineStateSnapshot } from './state-snapshot-storage.mjs';

export { inferMissionObjectiveMode, normalizeMissionObjective, isMaximizeMission } from './mission-objective.mjs';

export { createDecisionReviewState } from './evidence-state.mjs';
export { evaluateAcceptGate } from './accept-gate.mjs';
export { isInfrastructureTestFailure, applyOperatorTestSnapshot } from './operator-test-evidence.mjs';
export { addAuditEvent } from './runtime-events.mjs';

import { projectRoot as rootDir, runtimeDir } from './storage-paths.mjs';

import { createCommandJournal, inspectCommandJournal, journalPathFor, reconcileCommandJournal } from './command-journal.mjs';

import { normalizeWorkflowError, serializeWorkflowError } from './workflow-error.mjs';

export { runtimeDir } from './storage-paths.mjs';

import { createMissionProjectState } from './mission-project-state.mjs';
import { createStateInitialization } from './state-initialization.mjs';
export { knowledgeDrafts, candidateEvaluations, failureRecords } from './state-reference-data.mjs';
export { normalizeMissionBudgetMs, createCurrentBestState, createResearchAgentState, createIterationStats, createResearchNote, appendResearchNote } from './mission-state-shapes.mjs';
export { createKnowledgeMaintenanceState, toPublishedKnowledgeAsset, runKnowledgeMaintenance, markCandidateAccepted, runAutomaticAdoption } from './knowledge-state.mjs';
export { refreshReferenceBenchmark, refreshReferenceAgent, buildBenchmarkLogsForMatrix, buildBenchmarkLogs } from './state-reference-runtime.mjs';

const missionProjectState = createMissionProjectState({ rootDir, workspaceDir, workspaceDirForMission, missionSourceDirFor });
const { normalizeMissionState, projectActiveMission, createMissionDomainState } = missionProjectState;
export const { createWorkflowRecoveryState, selectMission, resumeMissionState, selectProject, createMission, createProject, updateProject, deleteProject, resetMissionRunState, startAgentRun } = missionProjectState;
export const { createSeedState, createProductState } = createStateInitialization({ createMissionDomainState });

export const { ensureStorage } = createStorageInitializer({ createSeedState, createProductState, saveState, ensureMissionWorkspace });

function ensureDomainState(state) {
  normalizeMissionState(state);
  state.schemaVersion = 7;
  if (!Number.isFinite(Number(state.stateVersion))) state.stateVersion = 0;
  if (!Number.isFinite(Number(state.commandJournalSeq))) state.commandJournalSeq = 0;
  return state;
}

const projectCommandRecovery = (state, blocked) => {
  if (!blocked.length) return state;
  const failure = blocked[0];
  state.workflowFailure = failure;
  state.missionPaused = true;
  state.iterationStats = { ...(state.iterationStats || {}), loopStatus: 'needs_human', loopStatusReason: 'command_recovery_blocked' };
  state.workflowRecovery = { ...(state.workflowRecovery || {}), commandRecovery: { status: 'blocked', failure } };
  return projectActiveMission(state);
};

// No initialization, file repair, journal acknowledgement, or workflow effects.
export async function readState({ commandJournal = null, applyRegistry = null } = {}) {
  let state;
  try { state = await readStateSnapshot(); }
  catch (cause) {
    const code = cause.code === 'ENOENT' ? 'STATE_SNAPSHOT_UNAVAILABLE' : cause instanceof SyntaxError ? 'STATE_SNAPSHOT_CORRUPT' : 'STATE_SNAPSHOT_READ_FAILED';
    throw Object.assign(new Error('Runtime snapshot cannot be read; explicit recovery is required.', { cause }), { code, status: 503 });
  }
  state = ensureDomainState(state);
  const inspected = await inspectCommandJournal(state, { journal: commandJournal, registry: applyRegistry });
  return projectCommandRecovery(state, inspected.blocked);
};

// Initialization, compatibility migration, and journal recovery only.
// Runtime maintenance and automatic progression belong to the application tick.
export async function loadState({ ensureWorkspace = true, commandJournal = null, applyRegistry = null } = {}) {
  await ensureStorage({ ensureWorkspace });
  let state;
  let recoveredCorruptSnapshot = false;
  let corruptionFailure = null;
  try {
    state = await readStateSnapshot();
  } catch (error) {
    const corruptPath = await quarantineStateSnapshot(error);
    state = createProductState();
    corruptionFailure = serializeWorkflowError(normalizeWorkflowError(error, {
      code: 'STATE_SNAPSHOT_CORRUPT',
      category: 'configuration',
      phase: 'state.load',
      source: 'state-store',
      details: { corruptSnapshot: corruptPath, originalError: error?.code || null },
    }));
    state.workflowFailure = corruptionFailure;
    state.iterationStats = { ...(state.iterationStats || {}), loopStatus: 'needs_human', loopStatusReason: 'state_snapshot_corrupt' };
    recoveredCorruptSnapshot = true;
  }
  const needsMigration = recoveredCorruptSnapshot || state.schemaVersion !== 7 || !Array.isArray(state.projects) || !Array.isArray(state.missions) || !state.capabilityRegistry || !Array.isArray(state.agent?.toolCalls) || !Array.isArray(state.knowledgeReferences) || !state.knowledgeMaintenance?.policy || !state.decisionReview?.policy || !Array.isArray(state.candidateEvaluations) || !Array.isArray(state.failureRecords) || state.missions.some((mission) => !mission.workflowRecovery || !mission.testMatrix?.testSpec || !mission.implementation || !mission.tokenUsage?.runs || !Array.isArray(mission.knowledgeDrafts) || !Array.isArray(mission.candidateEvaluations) || !Array.isArray(mission.failureRecords) || !Array.isArray(mission.publishedAssets) || !mission.knowledgeMaintenance?.policy || !mission.decisionReview?.policy || !Array.isArray(mission.runtimeEvents) || !Array.isArray(mission.runHistory) || !Object.hasOwn(mission, 'missionBudgetMs'));
  state = ensureDomainState(state);
  if (corruptionFailure) {
    const mission = state.missions?.find((item) => item.id === state.activeMissionId);
    if (mission) {
      mission.workflowFailure = corruptionFailure;
      mission.iterationStats = { ...(mission.iterationStats || {}), loopStatus: 'needs_human', loopStatusReason: 'state_snapshot_corrupt' };
    }
  }
  // 耐久命令日志崩溃恢复：重放 journal 中 seq > commandJournalSeq 的 applied 条目追上快照。
  let recoveryReplayed = false;
  if (commandJournal && applyRegistry) {
    const recovered = await reconcileCommandJournal(state, { journal: commandJournal, registry: applyRegistry });
    if (recovered.blocked.length) {
      return projectCommandRecovery(state, recovered.blocked);
    }
    if (recovered.replayed.length) {
      state = recovered.state;
      recoveryReplayed = true;
    }
  }
  return needsMigration || recoveryReplayed ? saveState(state) : state;
}

export async function saveState(state) {
  const next = { ...projectActiveMission(ensureDomainState(state)), updatedAt: new Date().toISOString(), stateVersion: (Number(state.stateVersion) || 0) + 1 };
  return writeStateSnapshot(next);
}

export async function resetFixtureData() {
  // 清空命令日志，避免旧命令在新 seed（stateVersion=0）上被崩溃恢复误回放。
  await createCommandJournal({ filePath: journalPathFor(runtimeDir) }).reset();
  const state = await saveState(createSeedState());
  await resetFixtureWorkspaces();
  await ensureMissionWorkspace(state.activeMissionId);
  return state;
}

export const { applyCandidatePatch, createWorkspaceCheckpoint } = createStateWorkspace({ initializeStorage: ensureStorage });
