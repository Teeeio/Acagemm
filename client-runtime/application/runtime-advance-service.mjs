import { detectLoopGuard } from '../iteration-loop.mjs';
import { isResourceReleaseQuarantined, pendingMissionResources, resourceReleaseBarrier } from '../cancellation-contract.mjs';

export const createRuntimeAdvanceService = ({ autopilot, advanceIteration, iteration, reconcileWorkflowState, detectGuard = detectLoopGuard, releaseResources }) => {
  const changingActions = new Set(['research_timeout', 'research_injected', 'research_noted', 'round_counted', 'correctness_attempt_counted', 'generation_attempt_counted', 'resumed_agent', 'research_escalated', 'baseline_started', 'resumed_after_baseline', 'failed_candidate_recorded']);
  const canStartNewWork = (state) => !state.missionPaused && !resourceReleaseBarrier(state) && !detectGuard(state);
  const advance = async ({ state }) => {
    const releaseBarrier = resourceReleaseBarrier(state);
    if (releaseBarrier) {
      // Let the policy boundary persist the finite human-intervention state for
      // a quarantined owner. Ordinary pending release remains a read-only
      // barrier and must not be promoted to a terminal failure prematurely.
      if (isResourceReleaseQuarantined(releaseBarrier) || state.agent?.status === 'needs_human') {
        const looped = await advanceIteration(state, iteration);
        const reconciled = reconcileWorkflowState(looped.state);
        return { state: reconciled.state, changed: looped.changed === true || reconciled.changed, actions: { autopilot: 'none', iteration: looped.action } };
      }
      return { state, changed: false, actions: { autopilot: 'none', iteration: 'resource_release_pending' } };
    }
    const guard = detectGuard(state);
    if (state.missionPaused && !['round_budget', 'round_budget_invalid', 'total_budget'].includes(guard)) return { state, changed: false, actions: { autopilot: 'none', iteration: 'paused' } };
    if (guard) {
      const before = JSON.stringify(state);
      if (pendingMissionResources(state).length) {
        if (typeof releaseResources !== 'function') throw Object.assign(new Error('Budget termination requires an execution resource release port.'), { code: 'MISSION_SHUTDOWN_UNAVAILABLE' });
        await releaseResources(state, { reason: guard });
        if (resourceReleaseBarrier(state)) return { state, changed: true, actions: { autopilot: 'none', iteration: 'resource_release_pending' } };
      }
      const looped = await advanceIteration(state, iteration);
      const reconciled = reconcileWorkflowState(looped.state);
      return { state: reconciled.state, changed: before !== JSON.stringify(reconciled.state), actions: { autopilot: 'none', iteration: looped.action } };
    }
    const automatic = await autopilot.advance(state);
    const looped = await advanceIteration(automatic.state, iteration);
    const reconciled = reconcileWorkflowState(looped.state);
    return { state: reconciled.state, changed: automatic.action !== 'none' || changingActions.has(looped.action) || looped.changed === true || reconciled.changed, actions: { autopilot: automatic.action, iteration: looped.action } };
  };
  return Object.freeze({ advance, canStartNewWork });
};
