import { closeSync, existsSync, mkdirSync, openSync, readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadSourceMirrorPolicy } from '../../client-runtime/source-mirror-policy.mjs';

export const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const testerHome = path.resolve(process.env.LOCAL_C500_TESTER_HOME || path.join(rootDir, '.local-c500-production'));
export const projectHome = path.join(testerHome, 'projects');
export const exportHome = path.join(testerHome, 'exports');
export const apiPort = Number(process.env.LOCAL_C500_API_PORT || 4275);
export const apiBaseUrl = process.env.LOCAL_C500_API_URL || `http://127.0.0.1:${apiPort}`;

export const resolveLocalC500LaunchMode = (environment = process.env) => {
  const mock = environment.OPERATOR_LOCAL_C500_MOCK === '1';
  return {
    mock,
    scenario: mock ? environment.OPERATOR_LOCAL_C500_MOCK_SCENARIO || 'mla-three-round' : null,
    label: mock ? 'simulation' : 'real C500 hardware',
  };
};

const launchMode = resolveLocalC500LaunchMode();

const sleep = (durationMs) => new Promise((resolve) => setTimeout(resolve, durationMs));

const requestJson = async (pathname, options = {}) => {
  const response = await fetch(`${apiBaseUrl}${pathname}`, {
    ...options,
    headers: { 'content-type': 'application/json', ...(options.headers || {}) },
    body: options.body == null || typeof options.body === 'string' ? options.body : JSON.stringify(options.body),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(body.error || `${options.method || 'GET'} ${pathname} failed (${response.status})`);
    error.code = body.code || 'LOCAL_C500_API_ERROR';
    error.status = response.status;
    error.details = body.details;
    throw error;
  }
  return body;
};

export const api = {
  get: (pathname) => requestJson(pathname),
  post: (pathname, body = {}) => requestJson(pathname, { method: 'POST', body }),
  patch: (pathname, body = {}) => requestJson(pathname, { method: 'PATCH', body }),
};

const health = async () => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 750);
  try {
    const response = await fetch(`${apiBaseUrl}/api/health`, { signal: controller.signal });
    return response.ok ? response.json() : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
};

export const ensureProductionRuntime = async () => {
  const current = await health();
  if (current) {
    if (current.testBackend?.kind !== 'local-c500') {
      throw new Error(`${apiBaseUrl} is occupied by a runtime that is not using the local C500 backend.`);
    }
    if (current.testBackend?.mock !== launchMode.mock || (launchMode.mock && current.testBackend?.scenario !== launchMode.scenario)) {
      throw new Error(`${apiBaseUrl} is already running in ${current.testBackend?.mock ? 'simulation' : 'real hardware'} mode; requested ${launchMode.label} mode. Use a different LOCAL_C500_API_PORT/LOCAL_C500_TESTER_HOME or stop the existing runtime.`);
    }
    return current;
  }

  mkdirSync(path.join(testerHome, 'logs'), { recursive: true });
  const logPath = path.join(testerHome, 'logs', 'runtime.log');
  const logFd = openSync(logPath, 'a');
  const child = spawn(process.execPath, ['client-runtime/local-server.mjs'], {
    cwd: rootDir,
    detached: true,
    windowsHide: true,
    stdio: ['ignore', logFd, logFd],
    env: {
      ...process.env,
      API_PORT: String(apiPort),
      SERVE_WEB: 'false',
      OPERATOR_RUNTIME_MODE: process.env.OPERATOR_RUNTIME_MODE || 'codex-cli',
      OPERATOR_TEST_BACKEND: 'local-c500',
      OPERATOR_AUTO_TICK: '1',
      OPERATOR_DATA_DIR: path.join(testerHome, 'data'),
      OPERATOR_RUNTIME_DIR: path.join(testerHome, 'runtime'),
      OPERATOR_LOCAL_C500_DIR: path.join(testerHome, 'local-c500-tasks'),
      OPERATOR_LOCAL_C500_MOCK: launchMode.mock ? '1' : '0',
      OPERATOR_LOCAL_C500_MOCK_SCENARIO: launchMode.scenario || '',
    },
  });
  child.unref();
  closeSync(logFd);

  for (let attempt = 0; attempt < 50; attempt += 1) {
    await sleep(100);
    const started = await health();
    if (started?.testBackend?.kind === 'local-c500'
      && started.testBackend?.mock === launchMode.mock
      && (!launchMode.mock || started.testBackend?.scenario === launchMode.scenario)) return started;
  }
  throw new Error(`Production runtime did not start. See ${logPath}`);
};

const slug = (value) => String(value || 'local-c500-project')
  .trim()
  .toLowerCase()
  .replace(/[^a-z0-9._-]+/g, '-')
  .replace(/^-+|-+$/g, '') || 'local-c500-project';

const seedMissionBrief = async (project, draft) => {
  const briefPath = path.join(project.repository, 'MISSION.md');
  const content = [
    '# Operator Optimization Mission',
    '',
    `Title: ${draft.title.trim() || draft.goal.trim().slice(0, 80)}`,
    'Hardware: MetaX C500',
    `Metric: ${draft.metric.trim() || 'latency p50'}`,
    '',
    '## Goal',
    '',
    draft.goal.trim(),
    '',
    '## Execution Contract',
    '',
    '- Discover and validate local source material first, then authoritative online material when needed.',
    '- Build the executable operator entry, reference, representative inputs, and candidate in this Mission Workspace.',
    '- Do not substitute an unrelated operator or a smoke template.',
    '- Report a semantic blocker instead of fabricating missing operator behavior.',
    '',
  ].join('\n');
  await writeFile(briefPath, content, 'utf8');
  const runGit = (args) => spawnSync('git', args, { cwd: project.repository, encoding: 'utf8', windowsHide: true });
  const added = runGit(['add', 'MISSION.md']);
  if (added.status !== 0) throw new Error(added.stderr || 'Failed to stage the Mission brief.');
  const committed = runGit(['commit', '--allow-empty', '-m', `Mission brief: ${slug(draft.title || draft.goal).slice(0, 48)}`]);
  if (committed.status !== 0) throw new Error(committed.stderr || 'Failed to commit the Mission brief.');
  return briefPath;
};

export const ensureManagedProject = async (name) => {
  const root = path.join(projectHome, slug(name));
  const projects = await api.get('/api/projects');
  const existing = projects.projects.find((project) => path.resolve(project.root || '') === path.resolve(root));
  if (existing) {
    if (projects.activeProjectId !== existing.id) await api.post(`/api/projects/${encodeURIComponent(existing.id)}/select`);
    return existing;
  }
  await mkdir(root, { recursive: true });
  const created = await api.post('/api/projects', { name: name || 'Local C500 Project', root, initializeGit: true });
  return created.project;
};

const createFreshManagedProject = async (name) => {
  const uniqueName = `${name || 'local-c500-project'}-${Date.now().toString(36)}`;
  const root = path.join(projectHome, slug(uniqueName));
  await mkdir(root, { recursive: true });
  const created = await api.post('/api/projects', { name: uniqueName, root, initializeGit: true });
  return created.project;
};

export const publishMission = async (draft) => {
  await ensureProductionRuntime();
  const current = await api.get('/api/state');
  const activeMission = current.state.missions?.find((item) => item.id === current.state.activeMissionId);
  let stoppedOldMission = false;
  if (activeMission && !['completed', 'published', 'stopped', 'archived'].includes(activeMission.status)) {
    await stopMission();
    stoppedOldMission = true;
  }
  if (current.state.missionPaused || activeMission?.status === 'stopped' || stoppedOldMission) {
    await api.patch('/api/state', { missionPaused: false, missionBudgetMs: null });
  }
  const project = await createFreshManagedProject(draft.repository || 'local-c500-project');
  await seedMissionBrief(project, draft);
  const timeBudget = Number(draft.timeBudget || 0);
  const created = await api.post('/api/missions', {
    goal: draft.goal.trim(),
    title: draft.title.trim(),
    projectId: project.id,
    repository: project.repository,
    projectRoot: project.root,
    sourceRoot: project.sourceRoot,
    hardware: ['C500'],
    metric: draft.metric.trim() || 'latency p50',
    sourcePolicy: { mode: 'agent-research-only', strictZeroSource: true },
    testScenario: { id: 'mla-three-round', hardwareMockOnly: true },
    objective: { mode: 'threshold', metric: draft.metric.trim() || 'latency p50', direction: 'minimize', targetRelativeImprovement: 0.2 },
    testMatrix: { environments: ['C500'], stages: ['Correctness', 'Full Benchmark'], warmup: 50, repeats: 200, correctnessCases: 24 },
    missionBudgetMs: timeBudget > 0 ? timeBudget : null,
  });
  const missionId = created.state.activeMissionId;
  const started = await api.post(`/api/missions/${encodeURIComponent(missionId)}/runs`, { goal: draft.goal.trim() });
  return { missionId, state: started.state, runId: started.runId, project };
};

export const loadProductionState = async () => {
  await ensureProductionRuntime();
  const [{ state }, healthState, { tasks }] = await Promise.all([
    api.get('/api/state'),
    api.get('/api/health'),
    api.get('/api/operator-tests'),
  ]);
  const mission = state.missions?.find((item) => item.id === state.activeMissionId) || null;
  return { state, mission, health: healthState, tasks: tasks || [] };
};

export const pauseMission = () => api.patch('/api/state', { missionPaused: true });
export const resumeMission = async () => {
  const result = await api.patch('/api/state', { missionPaused: false });
  if (result.state.iterationStats?.loopStatus === 'paused_budget') return api.post('/api/actions/resume-mission', {});
  return result;
};
export const stopMission = () => api.post('/api/actions/stop-mission', {});
export const addHumanFeedback = (note) => api.post('/api/actions/human-feedback', { note });

export const exportMission = async () => {
  const snapshot = await loadProductionState();
  if (!snapshot.mission) throw new Error('No active mission to export.');
  await mkdir(exportHome, { recursive: true });
  const target = path.join(exportHome, `${snapshot.mission.id}.json`);
  await writeFile(target, `${JSON.stringify({ exportedAt: new Date().toISOString(), ...snapshot }, null, 2)}\n`, 'utf8');
  return target;
};

const checkCommand = (command, args = ['--version']) => {
  const result = spawnSync(command, args, { encoding: 'utf8', windowsHide: true, timeout: 10000 });
  return { status: result.status === 0 ? 'ok' : 'missing', detail: String(result.stdout || result.stderr || '').trim().split(/\r?\n/)[0] || null };
};

export const runDoctor = async () => {
  const runtime = await ensureProductionRuntime();
  let sourceMirror;
  try {
    const policy = await loadSourceMirrorPolicy();
    sourceMirror = {
      status: 'ok',
      configured: policy.configured,
      requireMirror: policy.requireMirror,
      mirrors: policy.mirrors.length,
      detail: policy.configured ? `${policy.mirrors.length} mapping(s)${policy.requireMirror ? ' / required' : ''}` : 'direct canonical access',
      configPath: policy.configPath,
    };
  } catch (error) {
    sourceMirror = { status: 'invalid', configured: true, detail: `${error.code || 'SOURCE_MIRROR_CONFIG_INVALID'}: ${error.message}` };
  }
  return {
    status: 'completed',
    runtime,
    mock: runtime.testBackend?.mock === true,
    checks: {
      python: checkCommand(process.env.PYTHON || 'python', ['--version']),
      ixsmi: checkCommand('ixsmi'),
      mctracer: checkCommand('mctracer'),
      mcProfiler: checkCommand('mcProfiler'),
      sourceMirror,
    },
  };
};

export const readRuntimePid = () => {
  const file = path.join(testerHome, 'runtime', 'operator-studio.pid');
  return existsSync(file) ? readFileSync(file, 'ascii').trim() : null;
};
