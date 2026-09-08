export const createCandidateCommands = ({
  addAuditEvent,
  agentRuntime,
  appendRuntimeEvent,
  applyCandidatePatch,
  artifactDirForMission,
  createDecisionReviewState,
  createWorkspaceCheckpoint,
  ensureMissionWorkspace,
  isManagedWorkspaceRuntimeMode,
  mkdir,
  path,
  restoreWorkspaceCheckpoint,
  rootDir,
  workspaceManager,
  writeFile,
  now = () => new Date(),
}) => Object.freeze({
  'apply-patch': {
    tracksEffects: true,
    keyFor: (state, body) => `apply-patch:${state.activeMissionId}:${body?.candidate || state.appliedCandidateId}`,
    isApplied: (state, payload) => state.patchApplied === true && state.appliedCandidateId === payload?.candidateId,
    prepare: async ({ state, body, runEffect }) => {
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
      return runEffect(async () => {
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
        await writeFile(manifestPath, `${JSON.stringify({ schemaVersion: 1, missionId: state.activeMissionId, candidateId: body.candidate, digest: appliedDiff.digest, files: appliedDiff.changedFiles, sourceReferences, sourceRunId: state.agent.runId, createdAt: now().toISOString() }, null, 2)}\n`, 'utf8');
        if (mission.sourceRoot && mission.runtimeRoot) await workspaceManager.updateSourceRegistry({ sourceRoot: mission.sourceRoot, runtimeRoot: mission.runtimeRoot, missionId: state.activeMissionId, references: sourceReferences });
        return {
          payload: { candidateId: body.candidate, candidate: candidate ? structuredClone(candidate) : null, checkpoint, workspace, digest: appliedDiff.digest, files: actualFiles, sourceReferences, artifacts: { patch: patchPath, manifest: manifestPath }, policyChecks, runtimeMode: runtime.mode },
          result: { workspace, policyChecks },
        };
      });
    },
    apply: (state, payload) => {
      let candidate = (state.candidateEvaluations || []).find((item) => item.id === payload.candidateId);
      // If the Agent result was projected immediately before this command but
      // its state snapshot was lost in the same crash window, the frozen
      // command payload remains the authoritative candidate identity.
      if (!candidate && payload.candidate?.id === payload.candidateId) {
        state.candidateEvaluations = [...(state.candidateEvaluations || []), structuredClone(payload.candidate)];
        candidate = state.candidateEvaluations.at(-1);
      }
      if (!candidate) throw Object.assign(new Error('Candidate identity is unavailable for patch application recovery.'), { code: 'PATCH_CANDIDATE_NOT_FOUND', status: 409 });
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
        worktree: { ...(state.workflowRecovery?.worktree || {}), candidateId: payload.candidateId, status: 'active', activatedAt: now().toISOString() },
        checkpoints: [...(state.workflowRecovery?.checkpoints || []).filter((item) => item.id !== payload.checkpoint.id), payload.checkpoint].slice(-5),
        lastRecovery: null,
        invalidatedArtifacts: [],
      };
      state.agent = {
        ...state.agent,
        status: 'awaiting_action',
        phase: '异构验证已就绪',
        currentAction: { id: 'action.validation-matrix', type: 'test.plan', title: '运行 C550 + CUDA 测试矩阵', reason: 'Patch 自动策略检查已通过并写入隔离工作区，下一步验证正确性和完整性能。', expectedOutput: '24 / 24 Correctness · 2 个 Full Benchmark Run', risk: 'medium', approvalRequired: false, approvalPolicy: 'client-controlled' },
        messages: [...(state.agent?.messages || []), { id: `patch-${now().getTime()}`, phase: 'candidate', status: 'completed', title: 'Patch 自动检查通过并应用', detail: '变更边界、工作区路径和风险策略均已通过，补丁已写入隔离工作区。', time: '刚刚' }],
      };
      appendRuntimeEvent(state, 'patch.applied', { workspace: payload.workspace.workspace, checkpointId: payload.checkpoint.id, files: payload.workspace.files.map((file) => file.path), digest: payload.digest || null, artifacts: payload.artifacts, sourceReferences: payload.sourceReferences, policyChecks: payload.policyChecks, approvalRequired: false, mock: false }, { kind: 'workspace', mode: isManagedWorkspaceRuntimeMode(payload.runtimeMode) ? payload.runtimeMode : 'client' });
      addAuditEvent(state, 'Patch 自动策略检查通过', `${payload.workspace.workspace} · ${payload.candidateId} · 无需人工审批`, 'green', 'ShieldCheck');
    },
  },
  'rollback-stage': {
    tracksEffects: true,
    keyFor: (state) => `rollback-stage:${state.activeMissionId}:${state.workflowRecovery?.checkpoints?.at(-1)?.id || 'none'}`,
    isApplied: (state) => state.stage === 'candidate' && state.patchApplied === false,
    prepare: async ({ state, runEffect }) => {
      const checkpoint = state.workflowRecovery?.checkpoints?.at(-1);
      const recovery = await runEffect(() => restoreWorkspaceCheckpoint(checkpoint, state.activeMissionId));
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
        messages: [...(state.agent?.messages || []), { id: `rollback-${now().getTime()}`, phase: 'candidate', status: 'completed', title: '已返回补丁应用前', detail: `${payload.checkpointId} 已恢复，${invalidatedArtifacts.length} 个后续工件已失效。`, time: '刚刚' }],
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
});
