export const createBaselineService = ({ loadState, persistState, executeCommand, journal, registry, guardMutation = () => {}, guardWorkflowTransition } = {}) => {
  if (typeof loadState !== 'function' || typeof persistState !== 'function' || typeof executeCommand !== 'function' || !journal || !registry || typeof guardWorkflowTransition !== 'function') {
    throw new TypeError('Baseline service requires state, command, guard, journal, and registry dependencies.');
  }

  const materialize = async (body = {}) => {
    const state = await loadState();
    guardMutation(state);
    guardWorkflowTransition(state, { stages: ['diagnosis', 'candidate', 'validation'], label: 'Baseline 单文件展开' });
    return executeCommand({ journal, saveState: persistState, registry, state, type: 'materialize-baseline', body, expectedVersion: state.stateVersion });
  };

  return Object.freeze({ materialize });
};
