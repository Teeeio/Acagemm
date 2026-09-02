export const createResetService = ({ guardSupportedRuntimeAction, resetDemoData } = {}) => {
  if (typeof guardSupportedRuntimeAction !== 'function' || typeof resetDemoData !== 'function') {
    throw new TypeError('Reset service requires runtime guard and reset dependencies.');
  }

  const reset = async () => {
    await guardSupportedRuntimeAction('Demo Reset');
    return { state: await resetDemoData() };
  };

  return Object.freeze({ reset });
};
