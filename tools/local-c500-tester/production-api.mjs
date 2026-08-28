import { closeSync, existsSync, mkdirSync, openSync, readFileSync } from 'node:fs';
import { mkdir, stat, writeFile } from 'node:fs/promises';
import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadSourceMirrorPolicy } from '../../client-runtime/source-mirror-policy.mjs';
import { normalizeOperatorLanguage } from '../../client-runtime/operator-language.mjs';
import { buildFixedOperatorBaselineRunPy, fixedOperatorBaselineSource, fixedOperatorPrompt, fixedOperatorTestMatrix, getFixedOperatorProfile } from '../../client-runtime/fixed-operator-profiles.mjs';
import { isCurrentLocalC500Runtime } from '../../client-runtime/local-c500-runtime-contract.mjs';
import { detectMuxiDevice } from '../../client-runtime/muxi-device.mjs';

export const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const testerHome = path.resolve(process.env.LOCAL_C500_TESTER_HOME || path.join(rootDir, '.local-c500-production'));
export const projectHome = path.join(testerHome, 'projects');
export const exportHome = path.join(testerHome, 'exports');
export const apiPort = Number(process.env.LOCAL_C500_API_PORT || 4275);
export const apiBaseUrl = process.env.LOCAL_C500_API_URL || `http://127.0.0.1:${apiPort}`;
export const resolveAgentRuntimeMode = (environment = process.env) => environment.OPERATOR_RUNTIME_MODE || 'claude-code';
export const resolveMuxiDevice = (environment = process.env, spawn = spawnSync) => detectMuxiDevice(environment, spawn).device;

export const resolveLocalC500LaunchMode = (environment = process.env) => {
  const mock = environment.OPERATOR_LOCAL_C500_MOCK === '1';
  return {
    mock,
    scenario: mock ? environment.OPERATOR_LOCAL_C500_MOCK_SCENARIO || 'mla-three-round' : null,
    label: mock ? 'simulation' : `real ${resolveMuxiDevice(environment)} hardware`,
  };
};

const launchMode = resolveLocalC500LaunchMode();
const agentRuntimeMode = resolveAgentRuntimeMode();
const muxiDevice = resolveMuxiDevice();

const sleep = (durationMs) => new Promise((resolve) => setTimeout(resolve, durationMs));

const restartStaleProductionRuntime = async (current) => {
  const expectedRuntimeDir = path.join(testerHome, 'runtime');
  const bridge = current?.__bridge || {};
  const pid = Number(bridge.pid || 0);
  const bridgePort = Number(bridge.port || 0);
  const pidFile = path.join(expectedRuntimeDir, 'operator-studio.pid');
  const recordedPid = existsSync(pidFile) ? Number(readFileSync(pidFile, 'ascii').trim()) : 0;
  const sameRuntimeDir = bridge.runtimeDir && path.resolve(bridge.runtimeDir) === path.resolve(expectedRuntimeDir);
  const ownedByThisTester = sameRuntimeDir && recordedPid === pid;
  const recognizedRuntime = current?.service === 'operator-studio-client-runtime'
    && Number.isInteger(pid)
    && pid > 0
    && bridgePort === apiPort;
  if (!recognizedRuntime) {
    throw new Error(`${apiBaseUrl} is occupied by an unrecognized process. Stop it manually or use a different LOCAL_C500_API_PORT.`);
  }
  try {
    process.kill(pid, 'SIGTERM');
  } catch (error) {
    if (error.code !== 'ESRCH') throw new Error(`Unable to stop ${ownedByThisTester ? 'outdated' : 'previous-path'} runtime PID ${pid}: ${error.message}`);
  }
  for (let attempt = 0; attempt < 50; attempt += 1) {
    await sleep(100);
    if (!await health()) return;
  }
  throw new Error(`Runtime PID ${pid} did not stop. Stop it manually, then restart the tester.`);
};

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
    const expectedRuntimeDir = path.join(testerHome, 'runtime');
    const bridge = current?.__bridge || {};
    const pid = Number(bridge.pid || 0);
    const pidFile = path.join(expectedRuntimeDir, 'operator-studio.pid');
    const recordedPid = existsSync(pidFile) ? Number(readFileSync(pidFile, 'ascii').trim()) : 0;
    const ownedByThisTester = current?.service === 'operator-studio-client-runtime'
      && bridge.runtimeDir
      && path.resolve(bridge.runtimeDir) === path.resolve(expectedRuntimeDir)
      && Number.isInteger(pid)
      && pid > 0
      && recordedPid === pid;

    if (ownedByThisTester && isCurrentLocalC500Runtime(current)
      && current.testBackend?.mock === launchMode.mock
      && (!launchMode.mock || current.testBackend?.scenario === launchMode.scenario)
      && current.runtime?.mode === agentRuntimeMode) return current;

    // The health contract, PID and exact target port identify an Operator
    // Studio runtime even when the tester was moved to another container path.
    // Replace that previous-path instance, while never killing an unrelated
    // process that merely occupies the port.
    const recognizedRuntime = current?.service === 'operator-studio-client-runtime'
      && Number.isInteger(pid)
      && pid > 0
      && Number(bridge.port || 0) === apiPort;
    if (recognizedRuntime) {
      await restartStaleProductionRuntime(current);
    } else {
      const detail = current.runtime?.mode && current.runtime.mode !== agentRuntimeMode
        ? `Agent Runtime ${current.runtime.mode} (requested ${agentRuntimeMode})`
        : current.testBackend?.kind !== 'local-c500'
          ? 'a non-local-C500 backend'
          : `${current.testBackend?.mock ? 'simulation' : 'real hardware'} mode`;
      throw new Error(`${apiBaseUrl} is occupied by ${detail}, but it does not expose a valid Operator Studio PID/port identity. Stop it manually or use a different LOCAL_C500_API_PORT/LOCAL_C500_TESTER_HOME.`);
    }
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
      OPERATOR_RUNTIME_MODE: agentRuntimeMode,
      OPERATOR_MUXI_DEVICE: muxiDevice,
      CLAUDE_COMMAND: process.env.CLAUDE_COMMAND || 'claude',
      OPERATOR_CLAUDE_PERMISSION_MODE: 'acceptEdits',
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
      && started.runtime?.mode === agentRuntimeMode
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
  // The API registers the project only after its layout is initialized, but a
  // fresh container or a stale runtime can still return before the directory
  // is visible to this client. Make the publish boundary self-healing and
  // fail with a useful path if the returned repository is invalid.
  await mkdir(project.repository, { recursive: true });
  try {
    const repositoryStat = await stat(project.repository);
    if (!repositoryStat.isDirectory()) throw new Error('not a directory');
  } catch (error) {
    throw new Error(`项目仓库目录不可用，无法写入 Mission brief: ${project.repository} (${error.message})`);
  }
  const profile = getFixedOperatorProfile(draft.profileId);
  const device = resolveMuxiDevice();
  const implementation = normalizeOperatorLanguage(profile.implementationLanguage);
  const candidateFiles = profile.candidateContract?.allowedFiles || implementation.allowedFiles;
  const iterationDescription = profile.iterationPolicy
    ? `Establish correctness within at most ${profile.iterationPolicy.maxCorrectnessAttempts} total attempts, then execute exactly ${profile.iterationPolicy.performanceRounds} performance optimization rounds.`
    : 'Execute exactly three candidate rounds and retain the fastest correctness-passing candidate.';
  const content = [
    '# Operator Optimization Mission',
    '',
    `Title: ${profile.title}`,
    `Hardware: MetaX ${device}`,
    'Metric: latency p50',
    '',
    '## Goal',
    '',
    fixedOperatorPrompt(profile),
    '',
    '## Implementation',
    '',
    `- Language: ${implementation.label} (${implementation.id})`,
    `- Entry: ${implementation.entry}`,
    `- Allowed files: ${candidateFiles.join(', ')}`,
    '',
    '## Execution Contract',
    '',
    '- The embedded operator profile is the immutable semantic and test authority.',
    '- External research supplies optimization experience only and cannot modify the profile.',
    `- ${iterationDescription}`,
    '- Do not substitute an unrelated operator or a smoke template.',
    '- Report a semantic blocker instead of fabricating missing operator behavior.',
    '',
  ].join('\n');
  await writeFile(briefPath, content, 'utf8');
  const runGit = (args) => spawnSync('git', args, { cwd: project.repository, encoding: 'utf8', windowsHide: true });
  const added = runGit(['add', 'MISSION.md']);
  if (added.status !== 0) throw new Error(added.stderr || 'Failed to stage the Mission brief.');
  const committed = runGit(['commit', '--allow-empty', '-m', `Mission brief: ${slug(profile.id).slice(0, 48)}`]);
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
  if (activeMission && !['completed', 'published', 'stopped', 'archived'].includes(activeMission.status)) {
    await stopMission();
  }
  const profile = getFixedOperatorProfile(draft.profileId);
  const device = resolveMuxiDevice();
  const project = await createFreshManagedProject(profile.id);
  await seedMissionBrief(project, draft);
  const timeBudget = Number(draft.timeBudget || 0);
  const implementation = normalizeOperatorLanguage(profile.implementationLanguage);
  const testMatrix = fixedOperatorTestMatrix(profile, device);
  const baselineSource = fixedOperatorBaselineSource(profile);
  const baselineRunPy = buildFixedOperatorBaselineRunPy(profile);
  const goal = profile.iterationPolicy
    ? `在 MetaX ${device} 上独立实现并优化 ${profile.entrypoints.join(' 与 ')}；严格保持内置 Profile 语义，先建立正确的 Triton baseline，再完成三轮性能优化并保留全部固定 profile 上无回退的最佳版本。`
    : `在 MetaX ${device} 上为 ${profile.title} 生成高性能实现；严格保持内置 Profile 语义，完成三轮独立候选并保留 correctness 通过者中的最优版本。`;
  const created = await api.post('/api/missions', {
    goal,
    title: profile.title,
    projectId: project.id,
    repository: project.repository,
    projectRoot: project.root,
    sourceRoot: project.sourceRoot,
    hardware: [device],
    metric: 'latency p50',
    implementation,
    operatorProfile: profile,
    sourcePolicy: {
      mode: 'embedded-operator-profile',
      strictZeroSource: false,
      requireAuthority: draft.requireAuthority === true,
      researchEnabled: draft.researchEnabled !== false,
    },
    baseline: {
      kind: 'pytorch_reference',
      source: baselineSource,
      sourcePolicy: { requireAuthority: false, requireSingleFileExpansion: true, allowGeneratedV0: true },
      materializer: { status: 'completed', phase: '内置 Profile baseline 已就绪', progress: 100, result: { schemaVersion: 'operator-studio.fixed-baseline/v1', summary: profile.summary, runPy: baselineRunPy, runPySource: 'embedded-operator-profile', source: baselineSource, report: { mode: 'fixed-operator-profile', profileId: profile.id } } },
    },
    testScenario: profile.iterationPolicy
      ? { id: profile.id, iterationPolicy: structuredClone(profile.iterationPolicy), researchEnabled: draft.researchEnabled !== false }
      : { id: 'fixed-four-operator-v1', fixedRounds: 3, researchEnabled: draft.researchEnabled !== false },
    objective: { mode: 'maximize', metric: 'latency p50', direction: 'minimize' },
    testMatrix,
    missionBudgetMs: timeBudget > 0 ? timeBudget : null,
  });
  const missionId = created.state.activeMissionId;
  const started = await api.post(`/api/missions/${encodeURIComponent(missionId)}/runs`, { goal });
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
  const device = detectMuxiDevice();
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
  const mctracer = checkCommand('mctracer');
  const mcProfiler = checkCommand('mcProfiler');
  return {
    status: 'completed',
    runtime,
    mock: runtime.testBackend?.mock === true,
    checks: {
      device: { status: device.source === 'release-default' ? 'assumed' : 'ok', detail: `${device.device || 'unknown'} / ${device.source}` },
      python: checkCommand(process.env.PYTHON || 'python', ['--version']),
      mxSmi: checkCommand('mx-smi', []),
      mctracer: { ...mctracer, required: false, status: mctracer.status === 'ok' ? 'ok' : 'optional-missing' },
      mcProfiler: { ...mcProfiler, required: false, status: mcProfiler.status === 'ok' ? 'ok' : 'optional-missing' },
      sourceMirror,
    },
  };
};

export const assertProductionPreflight = (doctor) => {
  const failures = [];
  if (doctor?.runtime?.runtime?.mode !== 'claude-code' || doctor?.runtime?.runtime?.connected !== true) failures.push('Claude Code 未连接或未登录');
  if (doctor?.runtime?.testBackend?.mock === true || doctor?.runtime?.testBackend?.liveHardware !== true) failures.push('测试后端不是实机模式');
  if (doctor?.checks?.python?.status !== 'ok') failures.push('Python 不可用');
  if (doctor?.checks?.mxSmi?.status !== 'ok') failures.push('mx-smi 不可用');
  if (!['ok', 'assumed'].includes(doctor?.checks?.device?.status)) failures.push('沐曦设备型号配置无效');
  if (failures.length) {
    const error = new Error(`启动前检查失败：${failures.join('；')}`);
    error.code = 'LOCAL_C500_PREFLIGHT_FAILED';
    error.details = doctor;
    throw error;
  }
  return doctor;
};

export const readRuntimePid = () => {
  const file = path.join(testerHome, 'runtime', 'operator-studio.pid');
  return existsSync(file) ? readFileSync(file, 'ascii').trim() : null;
};
