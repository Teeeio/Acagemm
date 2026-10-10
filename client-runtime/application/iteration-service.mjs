export const createIterationService = (dependencies = {}) => {
  const required = ['startResearch', 'cancelResearch', 'registerSources', 'countSources', 'startMainRound', 'startBaseline', 'researchDirForMission'];
  // 可选端口：来源获取、本次 run 的来源统计、来源根完整性闸门。缺失时迭代循环按既有停滞/事件/墙钟预算终止采集，
  // 且不因来源根被改动而停下（没有端口就没有证据，判定层不臆造结论）。
  const optional = ['acquireSources', 'countRunSources', 'inspectSourceIntegrity'];
  for (const name of required) if (typeof dependencies[name] !== 'function') throw new TypeError(`Iteration service requires ${name}.`);
  for (const name of optional) if (dependencies[name] !== undefined && typeof dependencies[name] !== 'function') throw new TypeError(`Iteration service optional port ${name} must be a function when provided.`);
  return Object.freeze({ ...dependencies });
};
