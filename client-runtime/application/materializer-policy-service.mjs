export const createMaterializerPolicyService = () => {
  const inspect = ({ state, materializer = {}, baselineSource }) => {
    if (materializer.status === 'completed' && materializer.result?.runPy) return { action: 'continue' };
    if (['running', 'cancel_requested'].includes(materializer.status)) return { action: 'wait' };
    if (['failed', 'cancelled', 'timed_out'].includes(materializer.status)) return { action: 'recover' };
    return { action: 'materialize' };
  };
  return Object.freeze({ inspect });
};
