export const createMainRoundOrchestrationService = ({ agentRuntime, preflight, recovery, artifactGuard, agentRound, appendRuntimeEvent, addAuditEvent }) => {
  // advisory：本轮要交付的研究建议材料（已通过价值筛选、已绑定身份与 digest）。
  // injection：该材料的交付身份；preflight 阻止启动或启动抛错时原样保留在 state，
  // 由迭代循环裁决为 deferred/uncertain，绝不在这里静默消费掉材料。
  const start = async ({ state, goal, retryMode = 'generation', advisory = null, injection = null }) => {
    const runtimeDescriptor = await agentRuntime.describe();
    const prepared = await preflight.prepare({ state, goal, retryMode });
    if (prepared.blocked) {
      if (injection) {
        appendRuntimeEvent(state, 'research.advisory_preflight_blocked', {
          noteId: injection.noteId, digest: injection.digest, reason: 'preflight_blocked',
        }, { kind: 'research', mode: 'policy' });
      }
      return state;
    }
    const { mission, preflight: runtimePreflight } = prepared;
    const workspace = runtimePreflight.workspace;
    const rollback = await recovery.restoreRejectedRound({ state, workspace, runtimeMode: runtimeDescriptor.mode });
    artifactGuard.assertReady({ mission, state });
    if (rollback) {
      state.workflowRecovery = { ...(state.workflowRecovery || {}), lastRecovery: { type: 'round_rollback', ...rollback } };
      appendRuntimeEvent(state, 'workflow.round_rolled_back', rollback, { kind: 'recovery', mode: 'client' });
      addAuditEvent(state, '未采纳候选已回退', `${rollback.candidateId || 'candidate'} · ${rollback.checkpointId} · workspace clean`, 'warning', 'History');
    }
    return agentRound.startRound({ state, mission, goal, workspace, runtimeMode: runtimeDescriptor.mode, advisory });
  };

  return Object.freeze({ start });
};
