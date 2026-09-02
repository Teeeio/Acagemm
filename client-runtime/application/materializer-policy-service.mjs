export const createMaterializerPolicyService = ({ consumeWorkflowRecoveryBudget }) => {
  if (typeof consumeWorkflowRecoveryBudget !== 'function') throw new TypeError('Materializer policy requires recovery budget.');
  const inspect = ({ state, materializer = {}, baselineSource }) => {
    if (materializer.status === 'completed' && materializer.result?.runPy) return { action: 'continue' };
    if (['running', 'cancel_requested'].includes(materializer.status)) return { action: 'wait' };
    if (['failed', 'cancelled', 'timed_out'].includes(materializer.status)) {
      const recovery = consumeWorkflowRecoveryBudget(state, { component: 'baseline-materializer', limit: 1 });
      if (recovery.allowed && materializer.status !== 'cancelled') return { action: 'redirect', recovery, baselineSource };
      return { action: 'needs_human' };
    }
    return { action: 'materialize' };
  };
  return Object.freeze({ inspect });
};
