import path from 'node:path';

const applicationError = (message, status, code) => {
  const error = new Error(message);
  error.status = status;
  if (code) error.code = code;
  return error;
};

const requireProject = (state, projectId) => {
  const project = state.projects.find((item) => item.id === projectId);
  if (!project) throw applicationError('项目不存在。', 404, 'PROJECT_NOT_FOUND');
  return project;
};

export const createProjectsService = ({
  loadState,
  persistState,
  ensureProjectLayout,
  workspaceDirForMission,
  workspace,
  filesystem,
  projectState,
  guardMutation = () => {},
  createWorkflowRecoveryState = () => ({}),
  addAuditEvent = () => {},
  ensureMissionWorkspace = async () => {},
  rebuildMissionWorkspaceFromRepository = async () => {},
} = {}) => {
  if (typeof loadState !== 'function'
    || typeof persistState !== 'function'
    || typeof ensureProjectLayout !== 'function'
    || typeof workspaceDirForMission !== 'function'
    || !workspace
    || !filesystem
    || ['createProject', 'deleteProject', 'selectProject', 'updateProject'].some((name) => typeof projectState?.[name] !== 'function')) {
    throw new TypeError('Projects service requires state, layout, workspace, and filesystem dependencies.');
  }

  const list = async () => {
    const state = await loadState();
    const projects = state.projects.map((project) => ({
      ...project,
      missionCount: state.missions.filter((mission) => mission.projectId === project.id).length,
      runningMissionCount: state.missions.filter((mission) => mission.projectId === project.id && mission.status === 'running').length,
    }));
    return { projects, activeProjectId: state.activeProjectId };
  };

  const create = async (input = {}) => {
    const state = await loadState();
    const requestedPath = String(input.root || '').trim();
    if (!path.isAbsolute(requestedPath)) {
      throw applicationError('项目根目录必须是本机绝对路径。', 400, 'PROJECT_ROOT_NOT_ABSOLUTE');
    }
    if (!await filesystem.directoryExists(requestedPath)) {
      if (input.initializeGit !== true) {
        throw applicationError('目录不存在。请选择“创建项目结构并初始化 Git”后重试。', 404, 'PROJECT_ROOT_UNAVAILABLE');
      }
      await filesystem.mkdir(requestedPath, { recursive: true });
    }

    const projectRoot = requestedPath;
    const repository = path.join(projectRoot, 'repository');
    const sourceRoot = path.join(projectRoot, 'sources');
    const layout = await ensureProjectLayout({ root: projectRoot, repository, sourceRoot });
    if (!await filesystem.directoryExists(repository)) await filesystem.mkdir(repository, { recursive: true });

    let inspection = await workspace.inspect(repository, { refresh: true });
    if (!inspection.ready && input.initializeGit === true) {
      await workspace.git(['init'], repository);
      await workspace.git(['config', 'user.name', 'Operator Studio'], repository);
      await workspace.git(['config', 'user.email', 'operator-studio@local.invalid'], repository);
      await workspace.git(['add', '-A'], repository);
      await workspace.git(['commit', '--allow-empty', '-m', 'Operator Studio iteration baseline'], repository);
      inspection = await workspace.inspect(repository, { refresh: true });
    }

    let bootstrap = null;
    if (String(input.gitUrl || '').trim()) {
      bootstrap = await workspace.bootstrapRepository({
        target: repository,
        source: input.gitUrl,
        ref: input.gitRef || input.defaultBranch || 'HEAD',
      });
      inspection = await workspace.inspect(repository, { refresh: true });
    }
    if (!inspection.ready) {
      throw applicationError(
        `无法登记仓库：${inspection.detail || '目录不是可用的 Git 仓库。'}`,
        400,
        inspection.code || 'ITERATION_REPOSITORY_UNAVAILABLE',
      );
    }

    const project = projectState.createProject(state, {
      ...input,
      root: projectRoot,
      repository: inspection.gitRoot,
      sourceRoot,
      runtimeRoot: layout.runtimeRoot,
      layout: 'three-layer',
    });
    if (bootstrap) project.repositoryBootstrap = bootstrap;
    await ensureProjectLayout({
      root: projectRoot,
      repository: inspection.gitRoot,
      sourceRoot,
      projectId: project.id,
    });
    return { state: await persistState(state), project };
  };

  const sources = async (projectId) => {
    const state = await loadState();
    const project = requireProject(state, projectId);
    if (project.layout !== 'three-layer' || !project.root || !project.sourceRoot || !project.runtimeRoot) {
      throw applicationError('项目尚未初始化为严格三层结构。', 409, 'PROJECT_REINITIALIZATION_REQUIRED');
    }
    const [repositoryInspection, inspection] = await Promise.all([
      workspace.inspect(project.repository, { refresh: true }),
      workspace.inspectSources(project.sourceRoot, []),
    ]);
    let registry = { schemaVersion: 1, sources: [] };
    try {
      registry = JSON.parse(await filesystem.readFile(path.join(project.runtimeRoot, 'source-registry.json'), 'utf8'));
    } catch {
      // A new project may not have referenced any external source yet.
    }
    const projectMissions = state.missions.filter((mission) => mission.projectId === project.id);
    const selectedMission = projectMissions.find((mission) => mission.id === state.activeMissionId) || projectMissions[0] || null;
    return {
      projectId: project.id,
      layout: 'three-layer',
      sourceConfigured: true,
      layers: {
        root: project.root,
        repository: project.repository,
        sources: project.sourceRoot,
        snapshots: path.join(project.runtimeRoot, 'workspaces'),
        activeSnapshot: selectedMission
          ? workspaceDirForMission(selectedMission.id, selectedMission.repository, selectedMission.projectRoot)
          : null,
        artifacts: path.join(project.runtimeRoot, 'artifacts'),
      },
      repositoryInspection,
      inspection,
      registry,
    };
  };

  const select = async (projectId) => {
    const state = await loadState();
    const selection = projectState.selectProject(state, projectId);
    return {
      state: await persistState(state),
      project: selection.project,
      selectedMissionId: selection.selectedMission?.id || null,
    };
  };

  const update = async (projectId, input) => {
    const state = await loadState();
    const project = projectState.updateProject(state, projectId, input);
    return { state: await persistState(state), project };
  };

  const remove = async (projectId) => {
    const state = await loadState();
    const project = projectState.deleteProject(state, projectId);
    return { state: await persistState(state), project };
  };

  const bootstrap = async (projectId, input = {}) => {
    const state = await loadState();
    guardMutation(state);
    const project = requireProject(state, projectId);
    if (project.layout !== 'three-layer' || !project.root || !project.repository || !project.sourceRoot || !project.runtimeRoot) {
      throw applicationError('项目尚未初始化为严格三层结构。', 409, 'PROJECT_REINITIALIZATION_REQUIRED');
    }
    const inspection = await workspace.inspect(project.repository, { refresh: true });
    if (inspection.ready && !inspection.baselineEmpty) {
      throw applicationError('Iteration Repository 已包含代码，不能再次自动补齐基线。', 409, 'ITERATION_REPOSITORY_NOT_EMPTY');
    }
    const bootstrapResult = await workspace.bootstrapRepository({
      target: project.repository,
      source: input.gitUrl,
      ref: input.gitRef || project.defaultBranch || 'HEAD',
    });
    const linkedMissions = state.missions.filter((mission) => mission.projectId === project.id || mission.repository === project.repository);
    project.repositoryBootstrap = bootstrapResult;
    project.updatedAt = new Date().toISOString();
    for (const mission of linkedMissions) {
      mission.repository = project.repository;
      mission.projectRoot = project.root;
      mission.sourceRoot = project.sourceRoot;
      mission.stage = 'diagnosis';
      mission.status = 'ready';
      mission.patchApplied = false;
      mission.candidateEvaluations = [];
      mission.benchmark = { ...(mission.benchmark || {}), status: 'idle', progress: 0, runId: null, startedAt: null, logs: [] };
      mission.workflowRecovery = createWorkflowRecoveryState(mission.id, project.repository, project.root);
      mission.agent = { ...(mission.agent || {}), status: 'idle', phase: '等待启动', progress: 0, runId: null, threadId: null, startedAt: null, currentAction: null, toolCalls: [], messages: [], artifacts: [], result: null, candidateValidation: null };
    }
    const activeMission = linkedMissions.find((mission) => mission.id === state.activeMissionId);
    if (activeMission) {
      state.stage = 'diagnosis';
      state.patchApplied = false;
      state.candidateEvaluations = [];
      state.benchmark = structuredClone(activeMission.benchmark);
      state.workflowRecovery = structuredClone(activeMission.workflowRecovery);
      state.agent = structuredClone(activeMission.agent);
    }
    addAuditEvent(state, 'Iteration Repository 基线已补齐', `${project.name} · ${bootstrapResult.origin || bootstrapResult.repository} @ ${bootstrapResult.head}`, 'green', 'GitBranch');
    const saved = await persistState(state);
    for (const mission of linkedMissions) await rebuildMissionWorkspaceFromRepository(mission);
    return { state: saved, linkedMissionCount: linkedMissions.length, project, bootstrap: bootstrapResult };
  };

  const reinitialize = async (projectId) => {
    const state = await loadState();
    guardMutation(state);
    const project = requireProject(state, projectId);
    if (project.layout === 'three-layer' && project.root && project.sourceRoot && project.runtimeRoot) {
      throw applicationError('项目已经是严格三层结构，无需重新初始化。', 409, 'PROJECT_ALREADY_THREE_LAYER');
    }
    const linkedMissions = state.missions.filter((mission) => mission.projectId === project.id || mission.repository === project.repository);
    const hasDurableResults = linkedMissions.some((mission) => mission.patchApplied
      || mission.benchmark?.status !== 'idle'
      || mission.candidateEvaluations?.length
      || mission.publishedAssets?.length);
    if (hasDurableResults) {
      throw applicationError('项目已有 Candidate、Patch、Benchmark 或发布成果，不能自动重初始化。', 409, 'PROJECT_REINITIALIZATION_BLOCKED');
    }
    const projectRoot = path.resolve(project.root || project.repository);
    if (!path.isAbsolute(projectRoot) || !await filesystem.directoryExists(projectRoot)) {
      throw applicationError('项目根目录不存在，无法重新初始化。', 409, 'PROJECT_ROOT_UNAVAILABLE');
    }
    const repository = path.join(projectRoot, 'repository');
    const sourceRoot = path.join(projectRoot, 'sources');
    if (await filesystem.directoryExists(repository)) {
      throw applicationError('项目根目录已存在 repository 子目录，请先确认目录内容。', 409, 'ITERATION_REPOSITORY_ALREADY_EXISTS');
    }
    const backupName = `.operator-studio-backup-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    const oldRuntime = path.join(projectRoot, '.operator-studio');
    const backupRuntime = path.join(projectRoot, backupName);
    if (await filesystem.directoryExists(oldRuntime)) await filesystem.rename(oldRuntime, backupRuntime);
    await filesystem.mkdir(repository, { recursive: true });
    await filesystem.mkdir(sourceRoot, { recursive: true });
    for (const entry of await filesystem.readdir(projectRoot, { withFileTypes: true })) {
      if (['repository', 'sources', backupName, '.operator-studio'].includes(entry.name)) continue;
      await filesystem.rename(path.join(projectRoot, entry.name), path.join(repository, entry.name));
    }
    let inspection = await workspace.inspect(repository, { refresh: true });
    if (!inspection.ready) {
      await workspace.git(['init'], repository);
      await workspace.git(['config', 'user.name', 'Operator Studio'], repository);
      await workspace.git(['config', 'user.email', 'operator-studio@local.invalid'], repository);
      await workspace.git(['add', '-A'], repository);
      await workspace.git(['commit', '--allow-empty', '-m', 'Operator Studio iteration baseline'], repository);
      inspection = await workspace.inspect(repository, { refresh: true });
    }
    const layout = await ensureProjectLayout({ root: projectRoot, repository: inspection.gitRoot, sourceRoot, projectId: project.id });
    project.root = projectRoot;
    project.repository = inspection.gitRoot;
    project.sourceRoot = sourceRoot;
    project.runtimeRoot = layout.runtimeRoot;
    project.layout = 'three-layer';
    project.updatedAt = new Date().toISOString();
    for (const mission of linkedMissions) {
      mission.repository = inspection.gitRoot;
      mission.projectRoot = projectRoot;
      mission.sourceRoot = sourceRoot;
      mission.stage = 'diagnosis';
      mission.status = 'ready';
      mission.patchApplied = false;
      mission.candidateEvaluations = [];
      mission.workflowRecovery = createWorkflowRecoveryState(mission.id, inspection.gitRoot, projectRoot);
      mission.agent = { ...(mission.agent || {}), status: 'idle', phase: '等待启动', progress: 0, runId: null, threadId: null, startedAt: null, currentAction: null, toolCalls: [], messages: [], artifacts: [], result: null, candidateValidation: null };
    }
    const activeMission = linkedMissions.find((mission) => mission.id === state.activeMissionId);
    if (activeMission) {
      state.stage = 'diagnosis';
      state.patchApplied = false;
      state.candidateEvaluations = [];
      state.workflowRecovery = structuredClone(activeMission.workflowRecovery);
      state.agent = structuredClone(activeMission.agent);
    }
    addAuditEvent(state, '项目已重新初始化为三层结构', `${project.name} · repository / sources / Mission Snapshot`, 'green', 'Layers3');
    const saved = await persistState(state);
    for (const mission of linkedMissions) {
      await ensureMissionWorkspace(mission.id, inspection.gitRoot, { projectRoot: mission.projectRoot, sourceRoot: mission.sourceRoot });
    }
    return { state: saved, project, backupRuntime: await filesystem.directoryExists(backupRuntime) ? backupRuntime : null };
  };

  return Object.freeze({ list, create, sources, select, update, remove, bootstrap, reinitialize });
};
