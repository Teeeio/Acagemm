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
        if (head) references.push({ repository: origin || repoPath, commit: head, path: '' });
      }
      if (references.length) await workspaceManager.updateSourceRegistry({ sourceRoot: mission.sourceRoot, runtimeRoot, missionId: state.activeMissionId, references });
      return { count: references.length, references };
    } catch (error) {
      return { count: 0, errors: [error.message] };
    }
  };
  const countSources = async ({ mission }) => {
    if (!mission?.sourceRoot) return { count: 0 };
    try {
      const entries = await readdir(mission.sourceRoot).catch(() => []);
      return { count: entries.filter((item) => item !== '.git').length };
    } catch { return { count: 0 }; }
  };
  return Object.freeze({ registerSources, countSources });
};
