export const createIterationService = (dependencies = {}) => {
  const required = ['startResearch', 'cancelResearch', 'registerSources', 'countSources', 'startMainRound', 'startBaseline', 'researchDirForMission'];
  // 可选端口：来源获取与本次 run 的来源统计。缺失时迭代循环按既有停滞/事件/墙钟预算终止采集。
  const optional = ['acquireSources', 'countRunSources'];
  for (const name of required) if (typeof dependencies[name] !== 'function') throw new TypeError(`Iteration service requires ${name}.`);
  for (const name of optional) if (dependencies[name] !== undefined && typeof dependencies[name] !== 'function') throw new TypeError(`Iteration service optional port ${name} must be a function when provided.`);
  return Object.freeze({ ...dependencies });
};
