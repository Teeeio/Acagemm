const defaultClone = (value) => value == null ? value : structuredClone(value);

const versionConflict = (expectedVersion, actualVersion) => {
  const error = new Error(`State version conflict: expected ${expectedVersion}, received ${actualVersion}.`);
  error.code = 'STATE_VERSION_CONFLICT';
  error.status = 409;
  error.retryable = true;
  error.expectedVersion = expectedVersion;
  error.actualVersion = actualVersion;
  return error;
};

export const createStateRepository = ({ load, save, clone = defaultClone } = {}) => {
  if (typeof load !== 'function' || typeof save !== 'function') {
    throw new TypeError('StateRepository requires load and save functions.');
  }

  let tail = Promise.resolve();
  let pending = 0;

  const runExclusive = (operation) => {
    if (typeof operation !== 'function') throw new TypeError('StateRepository operation must be a function.');
    pending += 1;
    const execute = async () => {
      try {
        return await operation();
      } finally {
        pending -= 1;
      }
    };
    const result = tail.then(execute, execute);
    tail = result.catch(() => {});
    return result;
  };

  const read = async (options) => clone(await load(options));
  const persist = async (state) => clone(await save(state));

  const update = (mutate, { expectedVersion = null, loadOptions } = {}) => runExclusive(async () => {
    const state = await read(loadOptions);
    const actualVersion = Number(state?.stateVersion || 0);
    if (expectedVersion != null && Number(expectedVersion) !== actualVersion) {
      throw versionConflict(Number(expectedVersion), actualVersion);
    }
    const result = await mutate(state);
    const nextState = result?.state || state;
    const saved = await persist(nextState);
    return { state: saved, result: result?.state ? result.result : result };
  });

  return Object.freeze({
    read,
    persist,
    update,
    runExclusive,
    pending: () => pending,
  });
};
