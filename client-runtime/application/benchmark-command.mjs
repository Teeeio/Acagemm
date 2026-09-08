const captureSubmission = (intent, task) => ({
  payload: { ...intent.payload, taskId: task.taskId, submittedAt: task.submittedAt },
  result: { runId: intent.runId, taskId: task.taskId },
});

export const createBenchmarkCommands = ({
  addAuditEvent,
  appendRuntimeEvent,
  baselineMatchesMatrix,
  createSemanticTaskBinding,
  hashKey,
  isFixedOperatorMission,
  localC500Config,
  missionShapeKeyFor,
  normalizeBaselineKind,
  operatorTestQueue,
  prepareExecutionPackage = null,
  timeoutSeconds = 600,
  // Run IDs are derived from the durable command effect identity.
  readMissionRunPy,
  resolveBaselineRunPlan,
  now = () => new Date(),
}) => Object.freeze({
  'start-benchmark': {
    tracksEffects: true,
    keyFor: (state, body) => `benchmark:${state.activeMissionId}:${body?.purpose || body?.testPurpose || 'candidate'}:${body?.candidate || state.appliedCandidateId}:${body?.candidateDigest || (state.candidateEvaluations || []).find((c) => c.id === (body?.candidate || state.appliedCandidateId))?.patchDigest}:${hashKey(JSON.stringify(body?.matrix || state.testMatrix))}`,
    isApplied: (state, payload) => state.benchmark?.status === 'running'
      && state.benchmark?.purpose === payload?.purpose
      && (payload?.purpose === 'baseline' || state.appliedCandidateId === payload?.candidateId)
      && JSON.stringify(state.benchmark?.matrix || {}) === JSON.stringify(payload?.matrix || {}),
    plan: ({ effectId }) => ({ runId: 'run_' + effectId.slice(7).toUpperCase() }),
    recover: async ({ state, intent }) => {
      const task = await operatorTestQueue.findByRequestId(intent.runId, state.activeMissionId, intent.request);
      if (!task) return { status: 'not_started' };
      if (!intent.payload || !intent.request) return { status: 'unknown' };
      return { status: 'prepared', prepared: captureSubmission(intent, task) };
    },
    prepare: async ({ state, body, intent, recordIntent, runEffect }) => {
      if (intent.request) {
        return captureSubmission(intent, await runEffect(() => operatorTestQueue.submit(intent.request)));
      }
      const matrix = body.matrix || state.testMatrix;
      const { runId } = intent;
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
      let candidateDigest = body.candidateDigest || appliedCandidate?.patchDigest || (purpose === 'baseline' ? `sha256:baseline-${hashKey(String(baselineDigestSeed))}` : null);
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
      const request = {
        schemaVersion: 1, requestId: runId, missionId: state.activeMissionId,
        purpose, baselineKind,
        operator: mission.operatorProfile?.operator || mission.operator || body.operator || mission.semanticSnapshot?.operator || 'mla_paged_attention', candidate: { id: candidateId, digest: candidateDigest, remoteId: body.remoteCandidateId || null },
        hardware: mission.hardware || matrix.environments, runtime: body.runtime || 'client-managed-runtime', metric: mission.metric || 'latency_p50',
        matrix: normalizedMatrix, tracer: { enabled: !localC500Config.executionMode?.startsWith('cpu'), format: 'operator-trace/v1' }, profiler: { enabled: !localC500Config.executionMode?.startsWith('cpu'), format: 'operator-profile/v1' },
        limits: { timeoutSeconds: Number(body.timeoutSeconds || timeoutSeconds) },
        ...(baselineSource ? { baselineSource } : {}),
        ...(baselinePlan?.materializationReport ? { baselineMaterialization: baselinePlan.materializationReport } : {}),
        ...(missionRunPy.content ? { runPy: missionRunPy.content, runPySource: missionRunPy.source } : {}),
        ...(purpose === 'baseline' && baselinePlan?.runPy
          ? { oracleRunPy: baselinePlan.runPy }
          : (state.baseline?.oracleRunPy || state.baseline?.materializer?.result?.runPy)
            ? { oracleRunPy: state.baseline.oracleRunPy || state.baseline.materializer.result.runPy }
            : {}),
        ...(purpose !== 'baseline' && isFixedOperatorMission(mission) && (state.baseline?.source || mission.baseline?.source) ? { baselineSource: state.baseline?.source || mission.baseline?.source } : {}),
        ...(Object.keys(missionRunPy.implementationFiles || {}).length ? { implementationFiles: missionRunPy.implementationFiles } : {}),
        ...(body.packageId ? { packageId: body.packageId } : {}),
        ...(body.remoteCandidateId ? { remoteCandidateId: body.remoteCandidateId } : {}),
        ...(semanticBinding ? { semanticBinding } : {}),
      };
      if (typeof prepareExecutionPackage === 'function') {
        const packageBinding = await prepareExecutionPackage({
          request: structuredClone(request),
          mission,
          matrix: normalizedMatrix,
          missionRunPy,
          purpose,
          candidateId,
        });
        if (!packageBinding || typeof packageBinding !== 'object') {
          const error = new Error('Execution package preparation did not return an admission binding.');
          error.status = 409;
          error.code = 'PACKAGE_PREPARATION_INVALID';
          throw error;
        }
        Object.assign(request, packageBinding);
        candidateDigest = request.candidate?.digest || candidateDigest;
      }
      const submissionIntent = {
        runId, request,
        payload: {
          runId, purpose, baselineKind, baselineSource,
          baselineOracleRunPy: purpose === 'baseline' ? baselinePlan?.runPy || null : null,
          semanticBinding, baselineResolution: baselinePlan?.resolution || null,
          baselineMaterialization: baselinePlan?.materializationReport || null,
          matrix: structuredClone(matrix), normalizedMatrix, candidateId, candidateDigest,
          environments: matrix.environments, stages: matrix.stages,
          ...(request.packageDigest ? { executionPackage: {
            packageDigest: request.packageDigest, admissionId: request.admissionId,
            preparedArtifactDigest: request.preparedArtifactDigest || null,
            environmentDigest: request.environmentDigest, acceptanceDigest: request.acceptanceDigest,
            workspaceId: request.workspaceId, target: request.target,
            build: request.build, adapter: request.adapter,
          } } : {}),
        },
      };
      await recordIntent(submissionIntent);
      return captureSubmission(submissionIntent, await runEffect(() => operatorTestQueue.submit(request)));
    },
    apply: (state, payload) => {
      state.testMatrix = structuredClone(payload.matrix);
      state.stage = 'validation';
      state.benchmark = {
        status: 'running', progress: 0, runId: payload.runId, startedAt: payload.submittedAt || now().toISOString(), completedAt: null, durationMs: 0,
        logs: [{ sequence: 1, progress: 0, message: `调度器已锁定 ${payload.environments.length} 个环境快照` }], matrix: structuredClone(payload.matrix),
        purpose: payload.purpose, baselineKind: payload.baselineKind, baselineSource: payload.baselineSource ? structuredClone(payload.baselineSource) : null, baselineMaterialization: payload.baselineMaterialization ? structuredClone(payload.baselineMaterialization) : null,
        semanticBinding: payload.semanticBinding ? structuredClone(payload.semanticBinding) : null,
        candidate: { id: payload.candidateId, digest: payload.candidateDigest }, testTaskId: payload.taskId, result: null,
        ...(payload.executionPackage ? { executionPackage: structuredClone(payload.executionPackage) } : {}),
        source: {
          kind: localC500Config.enabled ? `${localC500Config.kind || 'local-c500'}-adapter` : 'operator-test-service',
          transport: 'local-serial-queue',
          mock: localC500Config.enabled ? localC500Config.mock : true,
          liveHardware: localC500Config.enabled ? localC500Config.liveHardware === true : false,
        },
        lastServiceError: null,
      };
      if (payload.purpose === 'baseline') {
        state.baseline = {
          ...(state.baseline || { required: true, status: 'missing', sourcePolicy: { requireAuthority: true, requireSingleFileExpansion: true } }),
          kind: normalizeBaselineKind(payload.baselineKind),
          status: 'running',
          source: payload.baselineSource ? structuredClone(payload.baselineSource) : state.baseline?.source || null,
          oracleRunPy: payload.baselineOracleRunPy || state.baseline?.oracleRunPy || null,
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
});
