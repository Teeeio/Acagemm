export const createResetService = ({ guardSupportedRuntimeAction, resetFixtureData } = {}) => {
  if (typeof guardSupportedRuntimeAction !== 'function' || typeof resetFixtureData !== 'function') {
    throw new TypeError('Reset service requires runtime guard and reset dependencies.');
  }

  const reset = async () => {
    await guardSupportedRuntimeAction('Test Fixture Reset');
    return { state: await resetFixtureData() };
  };

  return Object.freeze({ reset });
};
