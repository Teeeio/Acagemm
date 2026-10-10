import { ensureRoundBudgetStarted } from '../round-budget-contract.mjs';
import { remainingMissionBudgetMs } from '../iteration-loop.mjs';
import { RESEARCH_TRIGGERS, resolveManualResearch } from '../research-policy.mjs';
import { assertResourcesReleased } from '../cancellation-contract.mjs';
import { assertGenerationOnlyAction } from './workflow-command-policy.mjs';
import { assertSemanticSnapshot } from '../semantic-snapshot.mjs';
import { captureGenerationOrigin, freezeGenerationOrigin } from '../generation-origin.mjs';
import { generationPreparationFailureFor } from '../generation-preparation.mjs';

export const createAgentCommands = ({
  addAuditEvent,
  agentRuntime,
  appendRuntimeEvent,
  artifactDirForMission,
  baselineDirForMission,
  buildRuntimePreflight,
  createWorkspaceCheckpoint,
  hashKey,
  isManagedWorkspaceRuntimeMode,
  isStrictZeroSourceMission,
  mkdir,
  path,
  researchDirForMission,
  resetMissionRunState,
  resetMissionWorkspace,
  selectResearchBaselineSource,
  selectResearchDirection,
  startAgentRun,
  roundExperience,
  now = () => new Date(),
}) => Object.freeze({
  'runs': {
    tracksEffects: true,
    keyFor: (state, body) => `run-start:${state.activeMissionId}:${state.runHistory?.length || 0}:${hashKey(body?.goal || state.missions?.find((m) => m.id === state.activeMissionId)?.goal || '')}`,
    isApplied: (state, payload) => state.agent?.runId === payload?.runId && ['running', 'executing', 'awaiting_action'].includes(state.agent?.status),
    plan: ({ state, admittedContinuation = false }) => {
      assertResourcesReleased(state);
      assertGenerationOnlyAction(state, admittedContinuation ? 'continue-run' : 'run');
      const planned = structuredClone(state);
      const previousFailure = generationPreparationFailureFor(state);
      if (previousFailure) planned.iterationStats.roundBudget = structuredClone(previousFailure.roundBudget);
      const { roundBudget } = ensureRoundBudgetStarted(planned, { nowMs: now().getTime(), allowSettledRestart: true });
      const mission = state.missions?.find((mission) => mission.id === state.activeMissionId);
      return { roundBudget: structuredClone(roundBudget), executionMode: mission?.executionMode || 'iterate',
        ...(mission?.executionMode === 'generate-only' ? { generationAdmission: {
          semanticSnapshot: assertSemanticSnapshot(mission.semanticSnapshot, { requireFrozen: true }),
          missionBudgetStartedAt: state.missionBudgetStartedAt,
        } } : {}) };
    },
    prepare: async ({ state, body, intent = {}, recordIntent, runEffect, admittedContinuation = false, verifyBeforeEffects }) => {
      const preparationStartedAt = now().toISOString();
      assertResourcesReleased(state);
      assertGenerationOnlyAction(state, admittedContinuation ? 'continue-run' : 'run');
      const runtimeDescriptor = await agentRuntime.describe();
      const mission = state.missions.find((item) => item.id === state.activeMissionId) || {};
      if (intent.executionMode && intent.executionMode !== (mission.executionMode || 'iterate')) {
        throw Object.assign(new Error('Mission execution mode changed after run admission.'), { code: 'MISSION_EXECUTION_MODE_CHANGED', status: 409 });
      }
      if (mission.executionMode === 'generate-only') {
        const frozen = assertSemanticSnapshot(intent.generationAdmission?.semanticSnapshot, { requireFrozen: true });
        if (frozen.missionId !== mission.id || frozen.digest !== mission.semanticSnapshot?.digest) {
          throw Object.assign(new Error('Generation semantics changed after journal admission.'), { code: 'SEMANTIC_SNAPSHOT_MISMATCH', status: 409 });
        }
        mission.semanticSnapshot = structuredClone(frozen);
      }
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
      const ensureBudget = () => {
        const budget = ensureRoundBudgetStarted(clone, { nowMs: now().getTime() }).roundBudget;
        const remaining = remainingMissionBudgetMs(clone, { nowMs: now().getTime() });
        if (!Number.isFinite(remaining) || remaining <= 0) throw Object.assign(new Error('Mission budget exhausted before Agent start'), { code: 'ROUND_EXPERIENCE_BUDGET_EXCEEDED', status: 409 });
        return budget;
      };
      const experienceLimit = () => Math.min(3000, Date.parse(ensureBudget().deadlineAt) - now().getTime(), remainingMissionBudgetMs(clone, { nowMs: now().getTime() }));
      if (intent.roundBudget) clone.iterationStats = { ...(clone.iterationStats || {}), roundBudget: structuredClone(intent.roundBudget) };
      if (intent.roundExperience) clone.iterationStats = { ...(clone.iterationStats || {}), roundExperience: structuredClone(intent.roundExperience) };
      // 选择清单 sidecar 与 roundExperience 同轮冻结：intent 显式含该字段（含 null）时先原样深拷贝进克隆，
      // 字段缺失代表旧 intent，兼容地用当前 prepare 产物。
      if (intent.roundExperienceSelection !== undefined) clone.iterationStats = { ...(clone.iterationStats || {}), roundExperienceSelection: structuredClone(intent.roundExperienceSelection) };
      ensureBudget();
      if (roundExperience?.preflightCollection) await roundExperience.preflightCollection({ state: clone, mission });
      ensureBudget();
      if (roundExperience?.collect) await roundExperience.collect({ state: clone, mission, timeoutMs: experienceLimit() });
      ensureBudget();
      resetMissionRunState(clone, goal, { referenceFixture });
      // 重放（prepare 重新收到已记录 intent）必须复用 intent 里冻结的轮次事实，不能重新
      // 读取当前可能已经前移的 facts；首次 prepare 才在 reset 归档后取当前快照。
      const frozenRoundFacts = intent.roundFacts !== undefined ? structuredClone(intent.roundFacts) : null;
      if (intent.roundFacts !== undefined) {
        clone.iterationStats = { ...(clone.iterationStats || {}), roundFacts: structuredClone(intent.roundFacts) };
      }
      let experienceContext = null;
      try {
        if (roundExperience) experienceContext = await roundExperience.prepare({ state: clone, mission,
          roundId: clone.iterationStats.roundBudget.roundId, timeoutMs: experienceLimit() });
      } catch (error) {
        const status = clone.iterationStats.roundExperienceStatus;
        // Only a positively identified read failure before checkpoint/Provider
        // effects can be committed this way. All unknown effects retain the
        // journal's existing conservative recovery behavior.
        if (status?.status !== 'failed' || status.missionId !== mission.id
          || status.projectId !== mission.projectId || status.roundId !== clone.iterationStats.roundBudget.roundId
          || status.error?.code !== (error.code || 'ROUND_EXPERIENCE_FAILED')) throw error;
        const failure = { schemaVersion: 1, phase: 'experience-read', effectsStarted: false,
          entryKind: admittedContinuation ? 'continuation' : body?.startDraft === true ? 'draft' : 'manual',
          missionId: mission.id, projectId: mission.projectId, sourceRunId: state.agent?.runId || null,
          semanticDigest: mission.semanticSnapshot?.digest || null,
          pendingManifestDigest: state.iterationStats?.pendingFeedback?.manifestDigest || null,
          missionBudgetStartedAt: state.missionBudgetStartedAt,
          roundBudget: structuredClone(clone.iterationStats.roundBudget), occurredAt: now().toISOString(),
          error: { code: status.error.code, message: status.error.message,
            status: Number.isInteger(error.status) ? error.status : 503, retryable: true } };
        return { payload: { preparationFailure: failure, roundExperienceStatus: structuredClone(status),
          ...(intent.generationAdmission ? { generationAdmission: structuredClone(intent.generationAdmission) } : {}) },
        result: { runId: null, preparationFailure: structuredClone(failure) } };
      }
      // 真实 prepare 在「已有 context + intent 显式 null 清单」时会派生 context-derived 清单并写回状态。
      // 必须在 prepare 之后立刻按 intent 冻结为同一变量，并写回克隆，保证 provider effect 期间不再变化；
      // intent、payload 与 provider.start 都从这一个冻结变量取深拷贝，显式 null 也还原为 null。
      const roundExperienceSelection = intent.roundExperienceSelection !== undefined
        ? structuredClone(intent.roundExperienceSelection)
        : structuredClone(clone.iterationStats.roundExperienceSelection ?? null);
      clone.iterationStats = { ...(clone.iterationStats || {}), roundExperienceSelection: structuredClone(roundExperienceSelection) };
      const roundFacts = intent.roundFacts !== undefined
        ? frozenRoundFacts
        : structuredClone(clone.iterationStats.roundFacts || null);
      const frozenIntent = { ...intent, roundBudget: structuredClone(clone.iterationStats.roundBudget), roundExperience: structuredClone(clone.iterationStats.roundExperience || null), roundExperienceSelection: structuredClone(roundExperienceSelection), roundFacts };
      if (recordIntent) await recordIntent(frozenIntent);
      ensureBudget();
      if (verifyBeforeEffects) await verifyBeforeEffects();
      let checkpoint = null;
      if (runtimeDescriptor.mode === 'reference-fixture') await runEffect(() => resetMissionWorkspace(state.activeMissionId));
      if (isManagedWorkspaceRuntimeMode(runtimeDescriptor.mode)) {
        checkpoint = await runEffect(() => createWorkspaceCheckpoint(state.activeMissionId, 'agent-run-baseline'));
        clone.workflowRecovery = { ...(clone.workflowRecovery || {}), checkpoints: [...(clone.workflowRecovery?.checkpoints || []), checkpoint].slice(-5) };
      }
      ensureBudget();
      const preparationCompletedAt = now().toISOString();
      const generationOrigin = freezeGenerationOrigin(intent.generationOrigin,
        captureGenerationOrigin({ state: clone, mission, checkpoint, goal, capturedAt: preparationCompletedAt }));
      // Checkpoint creation has already crossed the journal's effect boundary.
      // Origin is an observed effect result: persist it in the prepared payload,
      // never rewrite input intent after effects or weaken unknown-effect recovery.
      ensureBudget();
      const runtimeRun = await runEffect(() => agentRuntime.startRun({ state: clone, mission, goal, resumeThreadId: body?.resumeThreadId || null, workspace, experienceContext, advisory: body?.advisory || null }));
      if (!runtimeRun.handled) startAgentRun(clone, goal, { reset: false });
      clone.agent = { ...clone.agent, generationOrigin, preparationStartedAt, preparationCompletedAt };
      const eventType = referenceFixture
        ? 'mission.run_started'
        : runtimeDescriptor.mode === 'cli-file'
          ? 'mission.run_requested'
          : `${runtimeDescriptor.mode === 'claude-code' ? 'claude' : 'codex'}.run_started`;
      return { payload: { goal, referenceFixture, eventType, runtimeMode: runtimeDescriptor.mode, agent: clone.agent, checkpoint, runId: clone.agent.runId, roundBudget: structuredClone(clone.iterationStats.roundBudget), roundExperience: structuredClone(clone.iterationStats.roundExperience || null), roundExperienceSelection: structuredClone(roundExperienceSelection), roundExperienceStatus: structuredClone(clone.iterationStats.roundExperienceStatus || null), experienceCollection: structuredClone(clone.iterationStats.experienceCollection || null), roundFacts,
        ...(intent.generationAdmission ? { generationAdmission: structuredClone(intent.generationAdmission) } : {}) }, result: { runId: clone.agent.runId } };
    },
    apply: (state, payload) => {
      if (payload.preparationFailure) {
        const failure = payload.preparationFailure;
        const mission = state.missions.find(item => item.id === state.activeMissionId);
        if (failure.missionId !== mission?.id || failure.projectId !== mission.projectId
          || failure.sourceRunId !== (state.agent?.runId || null)) {
          throw Object.assign(new Error('Preparation failure belongs to another Mission or run.'), { code: 'GENERATION_PREPARATION_IDENTITY_MISMATCH', status: 409 });
        }
        if (payload.generationAdmission) {
          const frozen = assertSemanticSnapshot(payload.generationAdmission.semanticSnapshot, { requireFrozen: true });
          if (frozen.missionId !== mission.id) throw new Error('Preparation failure semantic identity mismatch.');
          mission.semanticSnapshot = structuredClone(frozen);
          state.semanticSnapshot = structuredClone(frozen);
        }
        state.missionPaused = mission.missionPaused = true;
        state.missionBudgetStartedAt = failure.missionBudgetStartedAt;
        state.iterationStats = { ...state.iterationStats, generationPreparationFailure: structuredClone(failure),
          roundExperienceStatus: structuredClone(payload.roundExperienceStatus) };
        appendRuntimeEvent(state, 'generation.preparation_failed', structuredClone(failure), { kind: 'policy', mode: 'client' });
        return;
      }
      if (payload.generationAdmission) {
        const mission = state.missions.find(item => item.id === state.activeMissionId);
        const frozen = assertSemanticSnapshot(payload.generationAdmission.semanticSnapshot, { requireFrozen: true });
        if (!mission || mission.executionMode !== 'generate-only' || frozen.missionId !== mission.id) {
          throw Object.assign(new Error('Generation admission belongs to another Mission/mode.'), { code: 'MISSION_EXECUTION_MODE_CHANGED', status: 409 });
        }
        mission.semanticSnapshot = structuredClone(frozen);
        state.semanticSnapshot = structuredClone(frozen);
        state.missionPaused = mission.missionPaused = false;
        state.missionBudgetStartedAt = payload.generationAdmission.missionBudgetStartedAt;
      }
      resetMissionRunState(state, payload.goal, { referenceFixture: payload.referenceFixture });
      if (payload.checkpoint) state.workflowRecovery = { ...(state.workflowRecovery || {}), checkpoints: [...(state.workflowRecovery?.checkpoints || []), payload.checkpoint].slice(-5) };
      state.agent = payload.agent;
      state.iterationStats = { ...state.iterationStats, generationPreparationFailure: null };
      if (payload.roundBudget) state.iterationStats = { ...(state.iterationStats || {}), roundBudget: structuredClone(payload.roundBudget), roundExperience: structuredClone(payload.roundExperience || null), roundExperienceStatus: structuredClone(payload.roundExperienceStatus || null), experienceCollection: structuredClone(payload.experienceCollection || null) };
      // 选择清单必须与 payload 冻结的 context 同源还原；显式 null 也还原，缺失字段才留给旧 payload 兼容。
      if (payload.roundExperienceSelection !== undefined) state.iterationStats = { ...(state.iterationStats || {}), roundExperienceSelection: structuredClone(payload.roundExperienceSelection) };
      // apply 只重建准备阶段冻结的事实快照，不从 apply 时的当前状态重新推导。
      if (payload.roundFacts !== undefined) state.iterationStats = { ...(state.iterationStats || {}), roundFacts: structuredClone(payload.roundFacts) };
      if (!state.runtimeEvents?.some((e) => e.type === payload.eventType && e.payload?.runId === payload.runId)) {
        appendRuntimeEvent(state, payload.eventType, { runId: payload.runId, goal: payload.goal }, { kind: 'adapter', mode: payload.referenceFixture ? 'reference-fixture' : payload.eventType === 'mission.run_requested' ? 'cli-file' : payload.runtimeMode });
      }
    },
  },
  'research': {
    tracksEffects: true,
    keyFor: (state, body) => `research:${state.activeMissionId}:${state.researchNotes?.length || 0}:${hashKey(body?.direction || selectResearchDirection(state))}`,
    isApplied: (state, payload) => state.researchAgent?.runId === payload?.runId && state.researchAgent?.status === 'running',
    prepare: async ({ state, body, runEffect }) => {
      const mission = state.missions.find((item) => item.id === state.activeMissionId) || {};
      const direction = body?.direction?.trim() || selectResearchDirection(state);
      const researchDir = researchDirForMission(state.activeMissionId, mission.repository, mission.projectRoot);
      const clone = structuredClone(state);
      // 显式手动研究：不受 sourcePolicy.webResearchEnabled 约束（那是自动联网研究的开关），
      // 只受 researchPolicy.manualEnabled 约束；阶段默认 'acquire' 并在此显式声明。
      const manual = resolveManualResearch({ mission, phase: body?.runPhase || 'acquire' });
      if (!manual.allowed) throw Object.assign(new Error(manual.reason), { code: manual.reasonCode, status: 409 });
      await runEffect(() => mkdir(researchDir, { recursive: true }));
      // 操作员主动触发 → 默认异步（并行，主循环不阻塞）；可在 body 显式传 synchronous:true 改为串行等待
      const started = await runEffect(() => agentRuntime.startResearch({
        state: clone, mission, direction, workspace: researchDir, synchronous: body?.synchronous === true,
        runPhase: manual.phase, budgetMs: manual.budgetMs, trigger: RESEARCH_TRIGGERS.MANUAL, origin: 'manual',
      }));
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
    tracksEffects: true,
    keyFor: (state, body) => {
      const mission = state.missions.find((item) => item.id === state.activeMissionId) || {};
      const source = body?.baselineSource || state.baseline?.source || mission.baseline?.source || selectResearchBaselineSource(state.researchNotes, mission, body) || {};
      return `materialize-baseline:${state.activeMissionId}:${hashKey(JSON.stringify(source))}:${hashKey(JSON.stringify(body?.matrix || state.testMatrix))}`;
    },
    isApplied: (state, payload) => state.baseline?.materializer?.runId === payload?.materializer?.runId
      && ['running', 'completed'].includes(state.baseline?.materializer?.status),
    prepare: async ({ state, body, runEffect }) => {
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
      await runEffect(() => mkdir(materializationDir, { recursive: true }));
      await runEffect(() => agentRuntime.startBaselineMaterialization({ state: clone, mission, source, matrix, workspace: materializationDir }));
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
});
