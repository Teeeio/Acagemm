export const createSourceService = ({ readdir, stat, path, workspaceManager }) => {
  if (typeof readdir !== 'function' || typeof stat !== 'function' || !path || !workspaceManager) {
    throw new TypeError('Source service requires filesystem and workspace dependencies.');
  }
  const registerSources = async ({ state, mission }) => {
    if (!mission?.sourceRoot) return { count: 0, errors: ['sourceRoot 未配置'] };
    const runtimeRoot = mission.runtimeRoot || (mission.projectRoot ? path.join(mission.projectRoot, '.operator-studio') : null);
    if (!runtimeRoot) return { count: 0, errors: ['runtimeRoot 未配置'] };
    try {
      const entries = await readdir(mission.sourceRoot).catch(() => []);
      const references = [];
      for (const name of entries.filter((item) => item !== '.git')) {
        const repoPath = path.join(mission.sourceRoot, name);
        const isRepo = await stat(path.join(repoPath, '.git')).then(() => true).catch(() => false);
        if (!isRepo) continue;
        const head = await workspaceManager.git(['rev-parse', 'HEAD'], repoPath).then((result) => result.stdout.trim()).catch(() => null);
        const origin = await workspaceManager.git(['remote', 'get-url', 'origin'], repoPath).then((result) => result.stdout.trim()).catch(() => '');
        // 注册的是**仓库级引用**：断言「这个仓库在这个 commit 上」，不指向仓库内任何文件。
        // 显式写 scope，不靠空 path 表达（空 path 只是历史写法，校验端仍兼容但不再是契约）。
        if (head) references.push({ repository: origin || repoPath, commit: head, scope: 'repository' });
      }
      if (references.length) await workspaceManager.updateSourceRegistry({ sourceRoot: mission.sourceRoot, runtimeRoot, missionId: state.activeMissionId, references });
      return { count: references.length, references };
    } catch (error) {
      return { count: 0, errors: [error.message] };
    }
  };
  // 整个 Source Registry 的目录数：只描述注册表规模，绝不作为「本次研究收获」。
  const countSources = async ({ mission }) => {
    if (!mission?.sourceRoot) return { count: 0 };
    try {
      const entries = await readdir(mission.sourceRoot).catch(() => []);
      return { count: entries.filter((item) => item !== '.git').length };
    } catch { return { count: 0 }; }
  };
  // 本次 researchRun 的实际来源统计：来自该 run 的获取与验证结果，
  // 不混入 Source Registry 的历史目录。来源数量与有效材料数量分开报告。
  const countRunSources = async ({ state }) => {
    const acquisition = state?.researchAgent?.acquisition;
    return {
      count: Number.isFinite(acquisition?.sourceCount) ? acquisition.sourceCount : 0,
      failures: Number.isFinite(acquisition?.failureCount) ? acquisition.failureCount : 0,
      runId: acquisition?.runId || null,
    };
  };
  return Object.freeze({ registerSources, countSources, countRunSources });
};
