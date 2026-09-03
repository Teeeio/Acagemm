export const createRuntimeAdvanceService = ({ autopilot, advanceIteration, iteration, reconcileWorkflowState }) => {
  const changingActions = new Set(['research_timeout', 'research_injected', 'research_noted', 'round_counted', 'correctness_attempt_counted', 'generation_attempt_counted', 'resumed_agent', 'research_escalated', 'baseline_started', 'resumed_after_baseline', 'failed_candidate_recorded']);
  const advance = async ({ state }) => {
    const automatic = await autopilot.advance(state);
    const looped = await advanceIteration(automatic.state, iteration);
    const reconciled = reconcileWorkflowState(looped.state);
    return { state: reconciled.state, changed: automatic.action !== 'none' || changingActions.has(looped.action) || reconciled.changed, actions: { autopilot: automatic.action, iteration: looped.action } };
  };
  return Object.freeze({ advance });
};
