import { RESEARCH_PHASES } from '../research-policy.mjs';

export const createIterationResearchService = ({ mkdir, agentRuntime, isManagedWorkspaceRuntimeMode }) => {
  if (typeof mkdir !== 'function' || !agentRuntime || typeof agentRuntime.startResearch !== 'function' || typeof isManagedWorkspaceRuntimeMode !== 'function') {
    throw new TypeError('Iteration research service requires workspace and Agent runtime dependencies.');
  }
  // 阶段必须由调用方显式给出：这里不再提供 'acquire' 之类的默认值。
  // 默认阶段正是「通用停滞升级悄悄重新找仓库」的成因，去掉它之后，
  // 任何新增入口都必须自己说明要哪个阶段，研究策略也才能在 research-policy 里统一裁决。
  const startResearch = async ({ state, mission, direction, workspace, synchronous = true, runPhase, budgetMs = null, trigger = null, origin = 'automatic' }) => {
    if (!RESEARCH_PHASES.includes(runPhase)) {
      throw Object.assign(
        new Error(`Iteration research service requires an explicit research phase; received ${String(runPhase)}.`),
        { code: runPhase == null ? 'RESEARCH_PHASE_REQUIRED' : 'RESEARCH_PHASE_UNKNOWN', status: 400 },
      );
    }
    if (!isManagedWorkspaceRuntimeMode(agentRuntime.mode)) return state;
    await mkdir(workspace, { recursive: true });
    const started = await agentRuntime.startResearch({ state, mission, direction, workspace, synchronous, runPhase, budgetMs, trigger, origin });
    return started.state;
  };
  const cancelResearch = async ({ state, runId }) => agentRuntime.cancelRun({ state, runId });
  return Object.freeze({ startResearch, cancelResearch });
};
