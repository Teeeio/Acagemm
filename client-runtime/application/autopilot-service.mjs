export const createAutopilotService = ({ contextService, fixedProfileService, strictSourceService, candidateBaselineService, candidateActionService, validationService, iteration, isFixedOperatorMission, isStrictZeroSourceMission, runtimeMode }) => {
  // 通用决策表：baseline 完成之后的候选应用与验证。它只认状态，不认 Mission 由哪条路进来的。
  // 任何 Mission 类别在自己的专用阶段无事可做时都落回这里，而不是各自 return none——
  // 否则「候选已生成但无人应用」会在每一条专用分支上重新出现一次。
  const advanceSharedDecisionTable = async ({ state, mission, candidate, actionType }) => {
    // 「客户端有动作待办」的判据是挂起的动作本身，而不是产生它的 Agent 进程怎么结束的。
    // codex 路径正常终结时写 completed（phase 已是「Candidate Plan 已生成」），Mission 投影
    // 随后补一个 client-controlled 的 candidate.plan 动作却保留 completed——只认 awaiting_action
    // 就会让这类候选永远等不到应用，即使候选已验证、动作已挂起。completed 只对「候选已就绪」
    // 这一条生效，避免把一个没有候选的后继状态也拉进重开主轮的路径。
    const agentSettledWithAction = state.agent?.status === 'awaiting_action'
      || (state.agent?.status === 'completed' && Boolean(candidate?.patchDigest));
    if (state.stage === 'candidate' && state.agent?.status === 'awaiting_action' && state.baseline?.status !== 'complete') return (await candidateBaselineService.advance({ state, mission })) || { state, action: 'none' };
    if (state.stage === 'candidate' && agentSettledWithAction && state.baseline?.status === 'complete') {
      const simulationCandidate = runtimeMode() === 'reference-fixture' && candidate?.id && !candidate.patchDigest;
      if ((simulationCandidate || candidate?.patchDigest) && actionType === 'candidate.plan') {
        const nextState = await candidateActionService.applyCandidate({ state, candidateId: candidate.id });
        return { state: nextState, action: nextState.iterationStats?.loopStatusReason === 'patch_policy_rejected' ? 'needs_human' : simulationCandidate ? 'simulation_candidate_applied' : 'candidate_applied' };
      }
      if (!candidate?.patchDigest && state.agent?.status === 'awaiting_action') return { state: await candidateActionService.resumeCandidate({ state, mission, startMainRound: iteration.startMainRound }), action: 'candidate_resumed' };
    }
    if (state.stage === 'validation' && state.patchApplied && state.baseline?.status === 'complete' && agentSettledWithAction && actionType === 'test.plan') return { state: await validationService.startCandidateTest({ state, mission }), action: 'candidate_test_started' };
    return { state, action: 'none' };
  };

  const advance = async (state) => {
    const context = contextService.prepare(state);
    if (!context.enabled) return { state, action: 'none' };
    const { mission, candidate } = context;
    const actionType = state.agent?.currentAction?.type;

    if (isFixedOperatorMission(mission)) {
      if (state.baseline?.status !== 'complete') {
        const nextState = await iteration.startBaseline({ state, mission, reason: 'fixed operator profile baseline' });
        return { state: nextState, action: nextState.benchmark?.status === 'running' ? 'baseline_started' : 'wait_baseline' };
      }
      return fixedProfileService.advance({ state, mission });
    }
    if (isStrictZeroSourceMission(mission)) {
      const strict = await strictSourceService.advance({ state, mission, candidate });
      if (strict) return strict;
      // strict 服务返回 null = 它这一轮已经没有自己的事要做（只可能在 baseline 完成后发生），
      // 于是落回通用决策表去应用候选 / 启动验证。在这里 return none 就是那个断路点。
      // baseline 未完成时是服务自身的缺口，宁可停住也不能交给通用表——严格来源门禁
      // 必须自己推进基线，通用表的 candidateBaselineService 对 strict 是禁止的。
      if (state.baseline?.status !== 'complete') return { state, action: 'none' };
    }
    return advanceSharedDecisionTable({ state, mission, candidate, actionType });
  };
  return Object.freeze({ advance });
};
