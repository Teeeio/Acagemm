const missionNotFound = () => ({
  statusCode: 404,
  payload: { error: 'Mission 不存在。', code: 'MISSION_NOT_FOUND' },
});

export const createRuntimeQueryService = ({
  loadState,
  ensureMissionWorkspace,
  inspectWorkspace,
  inspectSources,
  preflightAgent,
  inspectSourceContent,
  artifactDirForMission,
  isStrictZeroSourceMission,
  isSimulationRuntime,
  presentWorkspacePath,
  workspaceFiles = [],
  now = () => new Date(),
} = {}) => {
  const required = [loadState, ensureMissionWorkspace, inspectWorkspace, inspectSources, preflightAgent, inspectSourceContent, artifactDirForMission, isStrictZeroSourceMission, isSimulationRuntime, presentWorkspacePath];
  if (required.some((dependency) => typeof dependency !== 'function')) {
    throw new TypeError('Runtime query service requires state, workspace, Agent, source, path, and clock dependencies.');
  }

  const buildPreflight = async (mission) => {
    const workspace = await ensureMissionWorkspace(mission.id, mission.repository, {
      projectRoot: mission.projectRoot,
      sourceRoot: mission.sourceRoot,
    });
    let [workspaceCheck, agentCheck] = await Promise.all([
      inspectWorkspace(workspace, { refresh: true }),
      preflightAgent({ workspace }),
    ]);
    const strictZeroSource = isStrictZeroSourceMission(mission);
    const sourceInspection = strictZeroSource ? await inspectSources(mission.sourceRoot) : null;
    const migrationFromSource = workspaceCheck.baselineEmpty && (strictZeroSource
      ? sourceInspection?.ready === true && sourceInspection.sources.length > 0
      : await inspectSourceContent(mission.sourceRoot));
    if (workspaceCheck.ready && workspaceCheck.baselineEmpty && !migrationFromSource && !isSimulationRuntime()) {
      workspaceCheck = {
        ...workspaceCheck,
        ready: false,
        code: 'WORKSPACE_BASELINE_EMPTY',
        detail: 'Iteration Repository 基线为空，Mission 工作区没有可供 Agent 检查的源码或测试文件。请先把项目文件放入 repository，或重新选择包含代码的 Git 仓库。',
      };
    }
    return {
      ready: workspaceCheck.ready && agentCheck.ready,
      missionId: mission.id,
      workspace,
      layers: {
        repository: mission.repository,
        sources: mission.sourceRoot || null,
        snapshot: workspace,
        artifacts: artifactDirForMission(mission.id, mission.repository, mission.projectRoot),
      },
      workspaceCheck,
      sourceInspection,
      agentCheck,
      checkedAt: now().toISOString(),
    };
  };

  const preflight = async (missionId = null) => {
    const state = await loadState();
    const selectedMissionId = missionId || state.activeMissionId;
    const mission = state.missions.find((item) => item.id === selectedMissionId);
    if (!mission) return missionNotFound();
    return { statusCode: 200, payload: { preflight: await buildPreflight(mission) } };
  };

  const getState = async () => ({ state: await loadState() });

  const workspace = async () => {
    const state = await loadState();
    const mission = state.missions.find((item) => item.id === state.activeMissionId);
    const activeWorkspace = await ensureMissionWorkspace(state.activeMissionId, mission?.repository, {
      projectRoot: mission?.projectRoot,
      sourceRoot: mission?.sourceRoot,
    });
    const hasDeclaredPatch = (state.candidateEvaluations || []).some((candidate) => String(candidate.files || '').trim());
    return {
      patchApplied: state.patchApplied,
      workspace: presentWorkspacePath(activeWorkspace),
      files: hasDeclaredPatch ? workspaceFiles : [],
    };
  };

  return Object.freeze({ buildPreflight, preflight, getState, workspace });
};
