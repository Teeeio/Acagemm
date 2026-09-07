import { ensureRoundBudgetStarted } from '../round-budget-contract.mjs';

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
    plan: ({ state }) => {
      const planned = structuredClone(state);
      const { roundBudget } = ensureRoundBudgetStarted(planned, { nowMs: now().getTime(), allowSettledRestart: true });
      return { roundBudget: structuredClone(roundBudget) };
    },
    prepare: async ({ state, body, intent = {}, recordIntent, runEffect }) => {
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
      if (intent.roundBudget) clone.iterationStats = { ...(clone.iterationStats || {}), roundBudget: structuredClone(intent.roundBudget) };
      if (intent.roundExperience) clone.iterationStats = { ...(clone.iterationStats || {}), roundExperience: structuredClone(intent.roundExperience) };
      ensureRoundBudgetStarted(clone, { nowMs: now().getTime() });
      if (roundExperience?.collect) await roundExperience.collect({ state: clone, mission });
      ensureRoundBudgetStarted(clone, { nowMs: now().getTime() });
      resetMissionRunState(clone, goal, { referenceFixture });
      const experienceContext = roundExperience
        ? await roundExperience.prepare({ state: clone, mission, roundId: clone.iterationStats.roundBudget.roundId })
        : null;
      if (recordIntent) await recordIntent({ ...intent, roundBudget: structuredClone(clone.iterationStats.roundBudget), roundExperience: structuredClone(clone.iterationStats.roundExperience || null) });
      ensureRoundBudgetStarted(clone, { nowMs: now().getTime() });
      let checkpoint = null;
      if (runtimeDescriptor.mode === 'reference-fixture') await runEffect(() => resetMissionWorkspace(state.activeMissionId));
      if (isManagedWorkspaceRuntimeMode(runtimeDescriptor.mode)) {
        checkpoint = await runEffect(() => createWorkspaceCheckpoint(state.activeMissionId, 'agent-run-baseline'));
        clone.workflowRecovery = { ...(clone.workflowRecovery || {}), checkpoints: [...(clone.workflowRecovery?.checkpoints || []), checkpoint].slice(-5) };
      }
      ensureRoundBudgetStarted(clone, { nowMs: now().getTime() });
      const runtimeRun = await runEffect(() => agentRuntime.startRun({ state: clone, mission, goal, resumeThreadId: body?.resumeThreadId || null, workspace, experienceContext }));
      if (!runtimeRun.handled) startAgentRun(clone, goal, { reset: false });
      const eventType = referenceFixture
        ? 'mission.run_started'
        : runtimeDescriptor.mode === 'cli-file'
          ? 'mission.run_requested'
          : `${runtimeDescriptor.mode === 'claude-code' ? 'claude' : 'codex'}.run_started`;
      return { payload: { goal, referenceFixture, eventType, runtimeMode: runtimeDescriptor.mode, agent: clone.agent, checkpoint, runId: clone.agent.runId, roundBudget: structuredClone(clone.iterationStats.roundBudget), roundExperience: structuredClone(clone.iterationStats.roundExperience || null), roundExperienceStatus: structuredClone(clone.iterationStats.roundExperienceStatus || null), experienceCollection: structuredClone(clone.iterationStats.experienceCollection || null) }, result: { runId: clone.agent.runId } };
    },
    apply: (state, payload) => {
      resetMissionRunState(state, payload.goal, { referenceFixture: payload.referenceFixture });
      if (payload.checkpoint) state.workflowRecovery = { ...(state.workflowRecovery || {}), checkpoints: [...(state.workflowRecovery?.checkpoints || []), payload.checkpoint].slice(-5) };
      state.agent = payload.agent;
      if (payload.roundBudget) state.iterationStats = { ...(state.iterationStats || {}), roundBudget: structuredClone(payload.roundBudget), roundExperience: structuredClone(payload.roundExperience || null), roundExperienceStatus: structuredClone(payload.roundExperienceStatus || null), experienceCollection: structuredClone(payload.experienceCollection || null) };
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
      await runEffect(() => mkdir(researchDir, { recursive: true }));
      // 操作员主动触发 → 默认异步（并行，主循环不阻塞）；可在 body 显式传 synchronous:true 改为串行等待
      const started = await runEffect(() => agentRuntime.startResearch({ state: clone, mission, direction, workspace: researchDir, synchronous: body?.synchronous === true }));
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
