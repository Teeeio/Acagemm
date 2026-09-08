import { closeSync, existsSync, mkdirSync, openSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { mkdir, stat, writeFile } from 'node:fs/promises';
import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadSourceMirrorPolicy } from '../../client-runtime/source-mirror-policy.mjs';
import { normalizeOperatorLanguage } from '../../client-runtime/operator-language.mjs';
import { buildFixedOperatorBaselineRunPy, fixedOperatorBaselineSource, fixedOperatorPrompt, fixedOperatorTestMatrix, getFixedOperatorProfile, isTuiOperatorProfile } from '../../client-runtime/fixed-operator-profiles.mjs';
import { isCurrentLocalC500Runtime } from '../../client-runtime/local-c500-runtime-contract.mjs';
import { detectMuxiDevice } from '../../client-runtime/muxi-device.mjs';
import { inspectRuntimeCapabilities, productionWorkflowCapabilities } from '../../client-runtime/agent-runtime/registry.mjs';
import { normalizeAgentRuntimeMode } from '../../client-runtime/agent-runtime/capabilities.mjs';

export const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const testerHome = path.resolve(process.env.LOCAL_C500_TESTER_HOME || path.join(rootDir, '.local-c500-production'));
export const projectHome = path.join(testerHome, 'projects');
export const exportHome = path.join(testerHome, 'exports');
export const apiPort = Number(process.env.LOCAL_C500_API_PORT || 4275);
export const apiBaseUrl = process.env.LOCAL_C500_API_URL || `http://127.0.0.1:${apiPort}`;
const simulationEnabled = (environment = process.env) => environment.OPERATOR_LOCAL_C500_SIMULATION === '1' || environment.OPERATOR_SIMULATION === '1';
export const resolveAgentRuntimeMode = (environment = process.env) => simulationEnabled(environment)
  ? 'reference-fixture'
  : normalizeAgentRuntimeMode(environment.OPERATOR_RUNTIME_MODE || 'claude-code');
export const resolveMuxiDevice = (environment = process.env, spawn = spawnSync) => {
  if (simulationEnabled(environment)) return environment.OPERATOR_MUXI_DEVICE || 'C550';
  if (environment.OPERATOR_LOCAL_C500_MOCK === '1') return environment.OPERATOR_MUXI_DEVICE || 'C550';
  return detectMuxiDevice(environment, spawn).device;
};

export const C550_STACK = Object.freeze({
  python: '3.12.11',
  torch: '2.8.0+metax3.3.0.2',
  triton: '3.7.1',
  maca: '3.3.0.15',
  vllm: '0.13.0',
  vllm_metax: '0.13.0+g181dc3.d20260129.maca3.3.0.15.torch2.8',
});

// C550 images in the field can expose a different package build string from
// the release manifest (for example Triton 3.1.0 and a vllm-metax build
// without the local suffix). The runner only relies on the Triton testing API
// and the MetaX Torch runtime, so these known-compatible variants must not be
// rejected as a broken installation.
export const c550StackCompatibility = (key, actual, fullActual = {}) => {
  if (actual === C550_STACK[key]) return { status: 'ok', reason: 'exact release target' };
  if (key === 'triton' && /^3\.1(?:\.\d+)?$/.test(String(actual || ''))) {
    return { status: 'ok', reason: 'compatible MetaX C550 Triton line' };
  }
  if (key === 'maca') {
    const torchMacaVersion = String(fullActual.torch || '').match(/metax(\d+(?:\.\d+)+)/i)?.[1] || null;
    if (actual && actual === torchMacaVersion) {
      return { status: 'ok', reason: 'matches the MACA version embedded in the MetaX Torch build' };
    }
    if (!actual && torchMacaVersion === '3.3.0.2') {
      return { status: 'inferred', reason: 'inferred from the MetaX Torch build; MACA_VERSION is not exported' };
    }
  }
  if (key === 'vllm_metax' && /^0\.13\.0\+g181dc3\.d20260129(?:\.|$)/.test(String(actual || ''))) {
    return { status: 'ok', reason: 'compatible vllm-metax build suffix' };
  }
  if (actual == null && ['vllm', 'vllm_metax'].includes(key)) return { status: 'optional-missing', reason: 'optional package not importable' };
  return { status: 'mismatch', reason: 'version is outside the C550 compatibility policy' };
};

export const evaluateC550Stack = (actual = {}) => {
  const checks = Object.fromEntries(Object.entries(C550_STACK).map(([key, expected]) => {
    const actualValue = actual[key] ?? null;
    const compatibility = c550StackCompatibility(key, actualValue, actual);
    return [key, { status: compatibility.status, reason: compatibility.reason, expected, actual: actualValue }];
  }));
  const required = ['python', 'torch', 'triton', 'maca'];
  const requiredPassed = required.every((key) => ['ok', 'inferred'].includes(checks[key].status));
  return {
    status: requiredPassed ? 'ok' : 'mismatch',
    expected: C550_STACK,
    actual,
    checks,
    detail: requiredPassed ? 'C550 Python stack is compatible with the frozen target and runner contract.' : 'C550 Python stack does not satisfy the C550 compatibility policy.',
  };
};

export const resolveLocalC500LaunchMode = (environment = process.env) => {
  const simulation = simulationEnabled(environment);
  const mock = simulation || environment.OPERATOR_LOCAL_C500_MOCK === '1';
  const id = simulation ? 'full-simulation' : mock ? 'hardware-mock' : 'real-c550';
  return {
    id,
    simulation,
    mock,
    hardwareMock: id === 'hardware-mock',
    liveHardware: id === 'real-c550',
    scenario: mock ? environment.OPERATOR_LOCAL_C500_MOCK_SCENARIO || 'mla-three-round' : null,
    label: simulation ? 'full simulation' : mock ? 'mock hardware' : `real ${resolveMuxiDevice(environment)} hardware`,
  };
};

const launchMode = resolveLocalC500LaunchMode();
const agentRuntimeMode = resolveAgentRuntimeMode();
const muxiDevice = resolveMuxiDevice();

const sleep = (durationMs) => new Promise((resolve) => setTimeout(resolve, durationMs));
const processAlive = (pid) => {
  const numeric = Number(pid);
  if (!Number.isInteger(numeric) || numeric <= 0) return false;
  try { process.kill(numeric, 0); return true; } catch (error) { return error.code === 'EPERM'; }
};

let attachedRuntimePid = 0;

export const normalizeExistingRuntimePolicy = (value) => {
  const normalized = String(value || '').trim().toLowerCase();
  if (['reuse', 'attach', 'use', '1'].includes(normalized)) return 'reuse';
  if (['replace', 'restart', 'kill', '2'].includes(normalized)) return 'replace';
  if (['cancel', 'fail', 'error', 'q'].includes(normalized)) return 'cancel';
  return null;
};

const waitForProcessExit = async (pid, attempts = 30) => {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (!processAlive(pid)) return true;
    await sleep(100);
  }
  return !processAlive(pid);
};

const terminateProcess = async (pid, label) => {
  if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid || !processAlive(pid)) return;
  try {
    process.kill(pid, 'SIGTERM');
  } catch (error) {
    if (error.code !== 'ESRCH') throw new Error(`无法停止${label} PID ${pid}: ${error.message}`);
  }
  if (await waitForProcessExit(pid)) return;
  try {
    process.kill(pid, 'SIGKILL');
  } catch (error) {
    if (error.code !== 'ESRCH') throw new Error(`无法强制停止${label} PID ${pid}: ${error.message}`);
  }
  if (!await waitForProcessExit(pid, 20)) throw new Error(`${label} PID ${pid} 未能退出，请手动停止后重试。`);
};

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
  const timer = setTimeout(() => controller.abort(), 3000);
  try {
    const response = await fetch(`${apiBaseUrl}/api/health`, { signal: controller.signal });
    return response.ok ? response.json() : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
};

export const ensureProductionRuntime = async ({ onExistingRuntime, existingRuntimePolicy } = {}) => {
  let current = await health();
  if (!current) {
    // A busy auto-tick can delay /api/health behind a queue operation. If this
    // tester still owns a live PID, wait for that runtime instead of spawning
    // a second process against the same queue and port.
    const expectedRuntimeDir = path.join(testerHome, 'runtime');
    const pidFile = path.join(expectedRuntimeDir, 'operator-studio.pid');
    const recordedPid = existsSync(pidFile) ? Number(readFileSync(pidFile, 'ascii').trim()) : 0;
    if (processAlive(recordedPid)) {
      for (let attempt = 0; attempt < 30 && !current; attempt += 1) {
        await sleep(100);
        current = await health();
      }
    }
  }
  if (current) {
    const expectedRuntimeDir = path.join(testerHome, 'runtime');
    const bridge = current?.__bridge || {};
    const pid = Number(bridge.pid || 0);
    const ownerPid = Number(bridge.ownerPid || 0);
    const ownerAlive = ownerPid > 0 && processAlive(ownerPid);
    const pidFile = path.join(expectedRuntimeDir, 'operator-studio.pid');
    const recordedPid = existsSync(pidFile) ? Number(readFileSync(pidFile, 'ascii').trim()) : 0;
    const ownedByThisTester = current?.service === 'operator-studio-client-runtime'
      && bridge.runtimeDir
      && path.resolve(bridge.runtimeDir) === path.resolve(expectedRuntimeDir)
      && Number.isInteger(pid)
      && pid > 0
      && recordedPid === pid;
    const recognizedRuntime = current?.service === 'operator-studio-client-runtime'
      && Number.isInteger(pid)
      && pid > 0
      && Number(bridge.port || 0) === apiPort;
    const compatibleRuntime = recognizedRuntime
      && isCurrentLocalC500Runtime(current)
      && current.testBackend?.mock === launchMode.mock
      && (!launchMode.mock || current.testBackend?.scenario === launchMode.scenario)
      && current.runtime?.mode === agentRuntimeMode;

    if (ownedByThisTester && ownerPid === process.pid && compatibleRuntime) return current;
    if (attachedRuntimePid === pid && compatibleRuntime) return current;

    if (ownerAlive && ownerPid !== process.pid) {
      if (!recognizedRuntime) {
        const error = new Error(`${apiBaseUrl} 被无法识别的活动进程占用。为避免误杀进程，系统不会提供自动替换；请人工确认端口占用，或更换 LOCAL_C500_API_PORT。`);
        error.code = 'LOCAL_C500_UNRECOGNIZED_RUNTIME';
        throw error;
      }
      const conflict = {
        apiUrl: apiBaseUrl,
        runtimePid: pid,
        ownerPid,
        runtimeDir: bridge.runtimeDir || null,
        dataDir: bridge.dataDir || null,
        mode: current.runtime?.mode || null,
        executionMode: current.testBackend?.simulation ? 'full-simulation' : current.testBackend?.mock ? 'hardware-mock' : 'real-c550',
        canReuse: compatibleRuntime,
      };
      const configuredPolicy = normalizeExistingRuntimePolicy(existingRuntimePolicy || process.env.OPERATOR_EXISTING_RUNTIME_POLICY);
      const selectedPolicy = configuredPolicy || normalizeExistingRuntimePolicy(await onExistingRuntime?.(conflict));
      if (selectedPolicy === 'reuse') {
        if (!compatibleRuntime) {
          const error = new Error('旧实例的版本、Agent Runtime 或测试后端与本次启动不兼容，不能直接连接；请选择停止旧实例并启动新实例。');
          error.code = 'LOCAL_C500_RUNTIME_REUSE_INCOMPATIBLE';
          error.details = conflict;
          throw error;
        }
        attachedRuntimePid = pid;
        return current;
      }
      if (selectedPolicy === 'replace') {
        await terminateProcess(ownerPid, '旧 C550 TUI');
        const activeAfterOwnerExit = await health();
        if (activeAfterOwnerExit) await restartStaleProductionRuntime(activeAfterOwnerExit);
        current = null;
      } else {
        const error = new Error(`${apiBaseUrl} 已由旧 C550 测试实例占用（TUI PID ${ownerPid}，Runtime PID ${pid}）。交互终端可选择连接或替换；非交互运行请设置 OPERATOR_EXISTING_RUNTIME_POLICY=reuse 或 replace。`);
        error.code = 'LOCAL_C500_RUNTIME_CONFLICT';
        error.details = conflict;
        throw error;
      }
    }

    // The health contract, PID and exact target port identify an Operator
    // Studio runtime even when the tester was moved to another container path.
    // Replace that previous-path instance, while never killing an unrelated
    // process that merely occupies the port.
    if (current && recognizedRuntime) {
      await restartStaleProductionRuntime(current);
    } else if (current) {
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
  // Keep persistent tester homes bounded. Simulation homes are temporary, but
  // explicit real/mock homes can survive many runs and should not grow without
  // limit when a runtime reports repeated failures.
  try {
    if (statSync(logPath).size > 5 * 1024 * 1024) writeFileSync(logPath, '', 'utf8');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
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
      OPERATOR_AUTO_TICK_INTERVAL_MS: launchMode.simulation ? '2500' : '1500',
      OPERATOR_RUNTIME_OWNER_PID: String(process.pid),
      OPERATOR_DATA_DIR: path.join(testerHome, 'data'),
      OPERATOR_RUNTIME_DIR: path.join(testerHome, 'runtime'),
      OPERATOR_LOCAL_C500_DIR: path.join(testerHome, 'local-c500-tasks'),
      OPERATOR_LOCAL_C500_MOCK: launchMode.mock ? '1' : '0',
      OPERATOR_LOCAL_C500_SIMULATION: launchMode.simulation ? '1' : '0',
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

// The production runtime is intentionally detached so the TUI can start it
// without inheriting terminal handles. It is still owned by the current TUI
// process and must be stopped when that owner exits.
export const stopProductionRuntime = async () => {
  const current = await health();
  if (!current) return false;
  const bridge = current.__bridge || {};
  const ownerPid = Number(bridge.ownerPid || 0);
  if (ownerPid > 0 && ownerPid !== process.pid) return false;
  const pid = Number(bridge.pid || 0);
  if (!Number.isInteger(pid) || pid <= 0 || Number(bridge.port || 0) !== apiPort) return false;
  try {
    process.kill(pid, 'SIGTERM');
  } catch (error) {
    if (error.code !== 'ESRCH') throw error;
  }
  for (let attempt = 0; attempt < 30; attempt += 1) {
    await sleep(50);
    if (!await health()) return true;
  }
  return false;
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
  const created = await api.post('/api/projects', { name: name || 'Local C550 Project', root, initializeGit: true });
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
  if (!isTuiOperatorProfile(draft.profileId)) {
    const error = new Error('当前 TUI 只允许发布两个完整 v0.1 C550 Profile。');
    error.code = 'TUI_PROFILE_NOT_PUBLISHABLE';
    error.status = 409;
    throw error;
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

const checkC550Stack = () => {
  const python = process.env.PYTHON || 'python';
  const script = [
    'import json, platform',
    'import torch',
    'import triton',
    'try:',
    ' import vllm',
    ' vllm_version = getattr(vllm, "__version__", "unknown")',
    'except Exception:',
    ' vllm_version = None',
    'try:',
    ' import vllm_metax',
    ' vllm_metax_version = getattr(vllm_metax, "__version__", "unknown")',
    'except Exception:',
    ' vllm_metax_version = None',
    'maca_version = __import__("os").environ.get("MACA_VERSION") or getattr(getattr(torch, "version", None), "maca", None)',
    'print(json.dumps({"python": platform.python_version(), "torch": torch.__version__, "triton": triton.__version__, "maca": maca_version, "vllm": vllm_version, "vllm_metax": vllm_metax_version}))',
  ].join('\n');
  const result = spawnSync(python, ['-c', script], { encoding: 'utf8', windowsHide: true, timeout: 30000 });
  if (result.status !== 0) return { status: 'missing', expected: C550_STACK, actual: null, detail: String(result.stderr || result.stdout || '').trim().split(/\r?\n/)[0] || 'C550 Python stack probe failed' };
  let actual;
  try { actual = JSON.parse(String(result.stdout || '').trim()); } catch { return { status: 'invalid', expected: C550_STACK, actual: null, detail: 'C550 Python stack probe returned invalid JSON' }; }
  return evaluateC550Stack(actual);
};

const checkC550Smoke = (device) => {
  const python = process.env.PYTHON || 'python';
  const script = 'import torch; assert torch.cuda.is_available(); x=torch.ones((1,), device="cuda"); y=x+1; torch.cuda.synchronize(); print(torch.cuda.get_device_name(torch.cuda.current_device()))';
  const result = spawnSync(python, ['-c', script], { encoding: 'utf8', windowsHide: true, timeout: 30000 });
  const detail = String(result.stdout || result.stderr || '').trim().split(/\r?\n/)[0] || null;
  return { status: result.status === 0 && /C550/i.test(detail || device || '') ? 'ok' : 'failed', detail };
};

export const runDoctor = async () => {
  const runtime = await ensureProductionRuntime();
  if (launchMode.simulation) {
    const simulatedCheck = (detail) => ({ status: 'simulated', detail });
    return {
      status: 'completed',
      executionMode: launchMode.id,
      runtime,
      mock: true,
      simulation: true,
      checks: {
        device: simulatedCheck(`${muxiDevice} / simulation (no hardware probe)`),
        python: simulatedCheck('not queried in full simulation'),
        mxSmi: simulatedCheck('not queried in full simulation'),
        mctracer: { ...simulatedCheck('not queried in full simulation'), required: false },
        mcProfiler: { ...simulatedCheck('not queried in full simulation'), required: false },
        sourceMirror: simulatedCheck('not queried in full simulation'),
      },
    };
  }
  if (launchMode.hardwareMock) {
    const mockedCheck = (detail) => ({ status: 'mocked', detail });
    return {
      status: 'completed',
      executionMode: launchMode.id,
      runtime,
      mock: true,
      simulation: false,
      checks: {
        device: mockedCheck('C550 backend mocked; no hardware probe'),
        python: mockedCheck('not queried in hardware-mock mode'),
        mxSmi: mockedCheck('not queried in hardware-mock mode'),
        mctracer: { ...mockedCheck('not queried in hardware-mock mode'), required: false },
        mcProfiler: { ...mockedCheck('not queried in hardware-mock mode'), required: false },
        sourceMirror: mockedCheck('validated by workflow source policy'),
        stack: mockedCheck('not queried in hardware-mock mode'),
        cudaSmoke: mockedCheck('not queried in hardware-mock mode'),
      },
    };
  }
  const device = detectMuxiDevice();
  const stack = checkC550Stack();
  const cudaSmoke = device.device === 'C550' && device.source !== 'release-default' ? checkC550Smoke(device.device) : { status: 'blocked', detail: 'Skipped because C550 was not independently detected.' };
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
    executionMode: launchMode.id,
    runtime,
    mock: runtime.testBackend?.mock === true,
    checks: {
      device: { status: device.source === 'release-default' ? 'assumed' : device.device === 'C550' ? 'ok' : 'invalid', detail: `${device.device || 'unknown'} / ${device.source}` },
      python: checkCommand(process.env.PYTHON || 'python', ['--version']),
      mxSmi: checkCommand('mx-smi', []),
      mctracer: { ...mctracer, required: false, status: mctracer.status === 'ok' ? 'ok' : 'optional-missing' },
      mcProfiler: { ...mcProfiler, required: false, status: mcProfiler.status === 'ok' ? 'ok' : 'optional-missing' },
      sourceMirror,
      stack,
      cudaSmoke,
    },
  };
};

export const assertProductionPreflight = (doctor) => {
  const executionMode = doctor?.executionMode || (doctor?.simulation ? 'full-simulation' : doctor?.runtime?.testBackend?.mock ? 'hardware-mock' : 'real-c550');
  const runtime = doctor?.runtime?.runtime || {};
  const backend = doctor?.runtime?.testBackend || {};
  if (executionMode === 'full-simulation') {
    if (runtime.mode === 'reference-fixture' && runtime.connected === true && backend.device === 'C550' && backend.mock === true && backend.liveHardware === false) return doctor;
    const error = new Error('启动前检查失败：完整模拟必须使用 reference-fixture Agent 和 mock C550 backend');
    error.code = 'LOCAL_C500_PREFLIGHT_FAILED';
    error.details = doctor;
    throw error;
  }
  const failures = [];
  const capabilityCheck = inspectRuntimeCapabilities(runtime.mode, productionWorkflowCapabilities);
  if (runtime.connected !== true) failures.push(`Agent Runtime ${runtime.mode || 'unknown'} 未连接`);
  if (!capabilityCheck.supported) failures.push(`Agent Runtime ${runtime.mode || 'unknown'} 缺少能力：${capabilityCheck.missing.join(', ')}`);
  if (executionMode === 'hardware-mock') {
    if (backend.mock !== true || backend.liveHardware !== false) failures.push('hardware-mock 必须使用不可发布的 mock C550 backend');
    if (backend.device !== 'C550') failures.push(`hardware-mock 设备必须是 C550，当前为 ${backend.device || 'unknown'}`);
  } else {
    if (backend.mock === true || backend.liveHardware !== true) failures.push('测试后端不是 C550 实机模式');
    if (doctor?.checks?.python?.status !== 'ok') failures.push('Python 不可用');
    if (doctor?.checks?.mxSmi?.status !== 'ok') failures.push('mx-smi 不可用');
    if (doctor?.checks?.device?.status !== 'ok' || !/^C550(?:\s|\/|$)/i.test(String(doctor?.checks?.device?.detail || ''))) failures.push('未实际探测到目标 C550 设备');
    if (doctor?.checks?.stack?.status !== 'ok') failures.push('C550 Python 软件栈版本不匹配');
    if (doctor?.checks?.cudaSmoke?.status !== 'ok') failures.push('C550 CUDA 运行时 smoke test 失败');
  }
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
