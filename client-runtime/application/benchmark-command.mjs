import { assertResourcesReleased, pendingMissionResources } from '../cancellation-contract.mjs';
import { pendingTestInputs } from '../pending-test-contract.mjs';
import { assertSemanticTaskBinding, semanticSourceDigest } from '../semantic-snapshot.mjs';

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
  readPendingCandidate = null,
  freezeCandidateSource = null,
  timeoutSeconds = 600,
  // Run IDs are derived from the durable command effect identity.
  readMissionRunPy,
  resolveBaselineRunPlan,
  now = () => new Date(),
}) => Object.freeze({
  'start-benchmark': {
    tracksEffects: true,
    scopeFor: body => body?.pendingManifestDigest ? 'mission-runtime' : 'active-mission',
    keyFor: (state, body) => body?.pendingManifestDigest
      ? `pending-test:${state.activeMissionId}:${body.pendingManifestDigest}:${body.purpose}`
      : `benchmark:${state.activeMissionId}:${body?.purpose || body?.testPurpose || 'candidate'}:${body?.candidate || state.appliedCandidateId}:${body?.candidateDigest || (state.candidateEvaluations || []).find((c) => c.id === (body?.candidate || state.appliedCandidateId))?.patchDigest}:${hashKey(JSON.stringify(body?.matrix || state.testMatrix))}`,
    isApplied: (state, payload) => state.benchmark?.status === 'running'
      && state.benchmark?.purpose === payload?.purpose
      && (payload?.pendingValidation
        ? state.benchmark?.pendingManifestDigest === payload.pendingValidation.manifestDigest
          && state.benchmark?.runId === payload.runId && state.benchmark?.testTaskId === payload.taskId
        : (payload?.purpose === 'baseline' || state.appliedCandidateId === payload?.candidateId))
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
      let frozen = null;
      if (body.pendingManifestDigest) {
        if (typeof readPendingCandidate !== 'function') throw Object.assign(new Error('Frozen candidate storage is unavailable.'), { code: 'PENDING_CANDIDATE_STORE_UNAVAILABLE', status: 503 });
        frozen = pendingTestInputs(state, await readPendingCandidate(state.iterationStats?.pendingValidation),
          { missionId: state.activeMissionId, manifestDigest: body.pendingManifestDigest }, { nowMs: now().getTime() });
        // The HTTP body contributes no code, matrix, source or timeout override.
        body = { purpose: body.purpose, pendingManifestDigest: body.pendingManifestDigest,
          ...(body.purpose === 'baseline' ? frozen.baselineBody : {}) };
      }
      const matrix = frozen?.matrix || body.matrix || state.testMatrix;
      const { runId } = intent;
      const mission = frozen?.mission || state.missions.find((item) => item.id === state.activeMissionId) || {};
      const purpose = body.purpose === 'baseline' || body.testPurpose === 'baseline' ? 'baseline' : 'candidate';
      const normalizedMatrix = {
        ...structuredClone(matrix),
        warmup: Number(body.warmup ?? matrix.warmup ?? 50),
        repeats: Number(body.repeats ?? matrix.repeats ?? 200),
        correctnessCases: Number(body.correctnessCases ?? matrix.correctnessCases ?? matrix.testSpec?.correctness?.requestedCases ?? 24),
      };
      const baselinePlan = purpose === 'baseline'
        ? await resolveBaselineRunPlan({ state: frozen ? { ...state, baseline: frozen.baseline } : state, mission, body, matrix: normalizedMatrix, readMissionRunPy })
        : null;
      if (frozen && baselinePlan && baselinePlan.runPy !== frozen.baseline.oracleRunPy) {
        throw Object.assign(new Error('Baseline resolution changed frozen bytes.'), { code: 'PENDING_TEST_BASELINE_CHANGED', status: 409 });
      }
      const baselineKind = baselinePlan?.baselineKind || null;
      const baselineSource = baselinePlan?.baselineSource || null;
      const candidateId = purpose === 'baseline' ? baselinePlan.candidateId : (frozen?.candidate.id || body.candidate || state.appliedCandidateId);
      const appliedCandidate = frozen?.candidate || (state.candidateEvaluations || []).find((candidate) => candidate.id === candidateId);
      const candidateSourceRunId = purpose === 'baseline' ? null : (appliedCandidate?.sourceRunId || null);
      const baselineDigestSeed = baselinePlan?.digestSeed || '';
      let candidateDigest = frozen && purpose === 'baseline' ? frozen.pending.baselineDigest
        : body.candidateDigest || appliedCandidate?.patchDigest || (purpose === 'baseline' ? `sha256:baseline-${hashKey(String(baselineDigestSeed))}` : null);
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
      if (frozen && purpose !== 'baseline' && (state.iterationStats.pendingTest?.manifestDigest !== frozen.pending.manifestDigest
        || state.iterationStats.pendingTest?.status !== 'baseline_complete'
        || !state.iterationStats.pendingTest?.baseline?.runId
        || state.iterationStats.pendingTest.baseline.runId !== state.baseline?.evidence?.runId)) {
        throw Object.assign(new Error('This frozen candidate requires its own completed baseline test.'), { code: 'PENDING_TEST_BASELINE_REQUIRED', status: 409 });
      }
      let automaticFrozenCandidate = null;
      let sourceInputs = null;
      if (!frozen && purpose === 'candidate' && typeof freezeCandidateSource === 'function') {
        if (typeof readPendingCandidate !== 'function') throw Object.assign(new Error('Frozen candidate source reader is unavailable.'), { code: 'PENDING_CANDIDATE_STORE_UNAVAILABLE', status: 503 });
        assertResourcesReleased(state);
        if (state.agent?.resourceRelease?.confirmed !== true || !['completed', 'awaiting_action'].includes(state.agent?.status)
          || pendingMissionResources(state).some(resource => resource.kind !== 'agent')) {
          throw Object.assign(new Error('Candidate source freezing requires released generation/test resources.'), { code: 'MISSION_RESOURCE_RELEASE_PENDING', status: 409 });
        }
        const freezingState = structuredClone(state);
        freezingState.testMatrix = structuredClone(normalizedMatrix);
        // Content-addressed preparation creates no executable test/Agent effect.
        // Freeze before the complete submission intent, like prepareExecutionPackage;
        // runEffect marks only the queue submission that recovery can locate.
        automaticFrozenCandidate = await freezeCandidateSource({
          state: freezingState, mission, candidate: { ...structuredClone(appliedCandidate), sourceRunId: candidateSourceRunId },
        });
        const sourceState = structuredClone(freezingState);
        sourceState.iterationStats = { ...sourceState.iterationStats, pendingValidation: automaticFrozenCandidate };
        sourceInputs = pendingTestInputs(sourceState, await readPendingCandidate(automaticFrozenCandidate),
          { missionId: mission.id, manifestDigest: automaticFrozenCandidate.manifestDigest }, { nowMs: now().getTime() });
        if (automaticFrozenCandidate.candidateId !== candidateId || automaticFrozenCandidate.patchDigest !== candidateDigest
          || automaticFrozenCandidate.sourceRunId !== candidateSourceRunId) {
          throw Object.assign(new Error('Frozen automatic candidate differs from the admitted candidate.'), { code: 'PENDING_CANDIDATE_BINDING_INVALID', status: 409 });
        }
      }
      const executionInputs = sourceInputs || frozen;
      const missionRunPy = purpose === 'baseline'
        ? { content: baselinePlan.runPy, source: baselinePlan.runPySource }
        : executionInputs?.missionRunPy || await readMissionRunPy(state.activeMissionId, mission.repository, mission.projectRoot, mission.implementation, mission.operatorProfile);
      const referenceRunPy = purpose === 'baseline' ? baselinePlan.runPy
        : executionInputs?.baseline.oracleRunPy || state.baseline?.oracleRunPy || state.baseline?.materializer?.result?.runPy;
      const referenceDigest = semanticSourceDigest(referenceRunPy);
      const semanticBinding = mission.semanticSnapshot?.status === 'frozen'
        ? createSemanticTaskBinding(mission.semanticSnapshot, { testSpec: normalizedMatrix.testSpec,
          oracleDigest: referenceDigest, baselineDigest: referenceDigest })
        : null;
      const request = {
        schemaVersion: 1, requestId: runId, missionId: state.activeMissionId,
        purpose, baselineKind,
        operator: mission.operatorProfile?.operator || mission.operator || body.operator || mission.semanticSnapshot?.operator || 'mla_paged_attention', candidate: { id: candidateId, digest: candidateDigest, remoteId: body.remoteCandidateId || null, ...(candidateSourceRunId ? { sourceRunId: candidateSourceRunId } : {}) },
        hardware: mission.hardware || matrix.environments, runtime: body.runtime || 'client-managed-runtime', metric: mission.metric || 'latency_p50',
        matrix: normalizedMatrix, tracer: { enabled: !localC500Config.executionMode?.startsWith('cpu'), format: 'operator-trace/v1' }, profiler: { enabled: !localC500Config.executionMode?.startsWith('cpu'), format: 'operator-profile/v1' },
        limits: { timeoutSeconds: executionInputs ? Math.max(1, Math.min(timeoutSeconds, Math.floor(executionInputs.remainingMs / 1000))) : Number(body.timeoutSeconds || timeoutSeconds) },
        ...(baselineSource ? { baselineSource } : {}),
        ...(baselinePlan?.materializationReport ? { baselineMaterialization: baselinePlan.materializationReport } : {}),
        ...(missionRunPy.content ? { runPy: missionRunPy.content, runPySource: missionRunPy.source } : {}),
        ...(purpose === 'baseline' && baselinePlan?.runPy
          ? { oracleRunPy: baselinePlan.runPy }
          : executionInputs ? { oracleRunPy: executionInputs.baseline.oracleRunPy }
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
      if (semanticBinding) {
        if (semanticSourceDigest(request.oracleRunPy) !== referenceDigest) {
          throw Object.assign(new Error('Prepared execution package changed the independent reference bytes.'), { code: 'SEMANTIC_REFERENCE_SOURCE_CHANGED', status: 409 });
        }
        assertSemanticTaskBinding(request.semanticBinding, mission.semanticSnapshot, semanticBinding);
      }
      if (executionInputs) {
        request.deadline = new Date(Math.min(Date.parse(request.deadline || executionInputs.deadlineAt), Date.parse(executionInputs.deadlineAt))).toISOString();
      }
      if (automaticFrozenCandidate && (request.candidate?.id !== automaticFrozenCandidate.candidateId
        || request.candidate?.digest !== automaticFrozenCandidate.patchDigest
        || request.candidate?.sourceRunId !== automaticFrozenCandidate.sourceRunId)) {
        throw Object.assign(new Error('Prepared execution package changed the frozen candidate identity.'), { code: 'PENDING_CANDIDATE_BINDING_INVALID', status: 409 });
      }
      const submissionIntent = {
        runId, request,
        payload: {
          runId, purpose, baselineKind, baselineSource,
          ...(frozen ? { pendingValidation: structuredClone(frozen.pending), baselineSourcePolicy: structuredClone(frozen.baseline.sourcePolicy) } : {}),
          ...(automaticFrozenCandidate ? { automaticFrozenCandidate: structuredClone(automaticFrozenCandidate) } : {}),
          comparisonBaseline: purpose === 'baseline' ? null : {
            runId: state.baseline?.evidence?.runId || null,
            kind: state.baseline?.evidence?.kind || state.baseline?.kind || null,
            source: structuredClone(state.baseline?.evidence?.source || state.baseline?.source || null),
          },
          baselineOracleRunPy: purpose === 'baseline' ? baselinePlan?.runPy || null : null,
          semanticBinding, baselineResolution: baselinePlan?.resolution || null,
          baselineMaterialization: baselinePlan?.materializationReport || null,
          matrix: structuredClone(matrix), normalizedMatrix, candidateId, candidateDigest,
          ...(candidateSourceRunId ? { candidateSourceRunId } : {}),
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
      if (payload.pendingValidation && state.iterationStats?.pendingValidation?.manifestDigest !== payload.pendingValidation.manifestDigest) {
        throw Object.assign(new Error('Pending candidate changed before command application.'), { code: 'PENDING_TEST_IDENTITY_MISMATCH', status: 409 });
      }
      state.testMatrix = structuredClone(payload.matrix);
      state.stage = 'validation';
      state.benchmark = {
        status: 'running', progress: 0, runId: payload.runId, startedAt: payload.submittedAt || now().toISOString(), completedAt: null, durationMs: 0,
        logs: [{ sequence: 1, progress: 0, message: `调度器已锁定 ${payload.environments.length} 个环境快照` }], matrix: structuredClone(payload.matrix),
        purpose: payload.purpose, baselineKind: payload.baselineKind, baselineSource: payload.baselineSource ? structuredClone(payload.baselineSource) : null, baselineMaterialization: payload.baselineMaterialization ? structuredClone(payload.baselineMaterialization) : null,
        comparisonBaseline: structuredClone(payload.comparisonBaseline || null),
        ...(payload.pendingValidation ? { pendingManifestDigest: payload.pendingValidation.manifestDigest } : {}),
        ...(payload.automaticFrozenCandidate ? { automaticFrozenCandidate: structuredClone(payload.automaticFrozenCandidate) } : {}),
        semanticBinding: payload.semanticBinding ? structuredClone(payload.semanticBinding) : null,
        candidate: { id: payload.candidateId, digest: payload.candidateDigest, ...(payload.candidateSourceRunId ? { sourceRunId: payload.candidateSourceRunId } : {}) }, testTaskId: payload.taskId, result: null,
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
          ...(payload.pendingValidation ? { sourcePolicy: structuredClone(payload.baselineSourcePolicy) } : {}),
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
      if (payload.pendingValidation) {
        state.missionPaused = true;
        state.iterationStats = { ...state.iterationStats, pendingTest: {
          ...(state.iterationStats.pendingTest || {}), manifestDigest: payload.pendingValidation.manifestDigest,
          status: `${payload.purpose}_running`,
          [payload.purpose]: { runId: payload.runId, taskId: payload.taskId, submittedAt: payload.submittedAt || null },
        } };
        // Queue work owns a test resource; no new generation process was started.
        state.agent = { ...state.agent, status: 'completed', phase: '冻结候选测试中', currentAction: null };
      }
      appendRuntimeEvent(state, 'operator_test.queued', { runId: payload.runId, taskId: payload.taskId, purpose: payload.purpose, baselineKind: payload.baselineKind, baselineSource: payload.baselineSource, baselineMaterialization: payload.baselineMaterialization, candidate: { id: payload.candidateId, digest: payload.candidateDigest }, environments: payload.environments, stages: payload.stages, matrix: structuredClone(payload.matrix) }, { kind: 'operator-test-queue', mode: 'client' });
      addAuditEvent(state, title, `${payload.runId} · ${payload.environments.length} environments`, 'blue', 'TestTube2');
    },
  },
});
