export const createIterationService = (dependencies = {}) => {
  const required = ['startResearch', 'cancelResearch', 'registerSources', 'countSources', 'startMainRound', 'startBaseline', 'researchDirForMission'];
  for (const name of required) if (typeof dependencies[name] !== 'function') throw new TypeError(`Iteration service requires ${name}.`);
  return Object.freeze({ ...dependencies });
};
