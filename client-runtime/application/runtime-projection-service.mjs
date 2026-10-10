export const createRuntimeProjectionService = ({ reconcileWorkflowState, projectState }) => {
  const project = async ({ state, runtime }) => {
    const reconciled = reconcileWorkflowState(state);
    const projected = await projectState({ ...reconciled.state, runtime });
    return { state: projected.state, changed: reconciled.changed || projected.changed };
  };
  return Object.freeze({ project });
};
