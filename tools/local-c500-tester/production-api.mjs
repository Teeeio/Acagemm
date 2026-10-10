import { closeSync, existsSync, mkdirSync, openSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { attachSavedMission, operationErrorMessage } from './operation-feedback.mjs';
import { isDraftPreparationRetry } from '../../client-runtime/generation-preparation.mjs';
import { lstat, mkdir, open, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadSourceMirrorPolicy } from '../../client-runtime/source-mirror-policy.mjs';
import { normalizeOperatorLanguage } from '../../client-runtime/operator-language.mjs';
import { findAcceleratorBackend } from '../../client-runtime/accelerator-backends.mjs';
import { probeAcceleratorRuntime } from '../../client-runtime/accelerator-package-adapter.mjs';
import { capabilitySupportsLanguage } from '../../client-runtime/target-capability-registry.mjs';
import { buildFixedOperatorBaselineRunPy, fixedOperatorBaselineSource, fixedOperatorPrompt, fixedOperatorTestMatrix, getFixedOperatorProfile, isTuiOperatorProfile } from '../../client-runtime/fixed-operator-profiles.mjs';
import { isCurrentLocalC500Runtime } from '../../client-runtime/local-c500-runtime-contract.mjs';
import { detectMuxiDevice } from '../../client-runtime/muxi-device.mjs';
import { inspectRuntimeCapabilities, productionWorkflowCapabilities } from '../../client-runtime/agent-runtime/registry.mjs';
import { normalizeAgentRuntimeMode } from '../../client-runtime/agent-runtime/capabilities.mjs';
import { resolveCanonicalStorageRoot, resolvePythonExecutable } from '../../client-runtime/platform-runtime.mjs';
import { inspectExperimentEnvironment } from '../../client-runtime/experiment-storage.mjs';
import { missionSpecificationFromForm, normalizeGenericMissionSpecification, normalizeSourcePath } from './mission-spec.mjs';
import { validateBaselineRunPy } from '../../client-runtime/baseline-materializer.mjs';
import { selectEvidenceDecision } from './workflow-summary.mjs';
import { assertMissionHistory } from './mission-history.mjs';
import { writeBestCandidateExport } from './best-candidate-export.mjs';
import { inspectMissionSources, listMissionSourceDirectory, stageMissionSources } from './mission-sources.mjs';
import { assertRuntimeAttachment } from './runtime-attachment.mjs';

export { listMissionSourceDirectory };
export const previewMissionSources = async (selections, options = {}) => {
  const { contents, ...preview } = await inspectMissionSources(selections, options);
  return preview;
};

// A submitted material set must be the one the engineer reviewed. No refresh
// may silently authorize new bytes, ignore rules or inclusion overrides.
export const confirmedMissionSourceOptions = (draft = {}) => {
  if (!draft.sourceReviewDigest || !draft.sourcePolicy?.digest) throw inputError('请先打开素材清单并确认最终文件范围。', 'MISSION_SOURCE_CONFIRMATION_REQUIRED');
  return { includeIgnoredPaths: draft.sourcePolicy.includeIgnoredPaths || [],
    expectedReviewDigest: draft.sourceReviewDigest, expectedPolicyDigest: draft.sourcePolicy.digest };
};
export const assertMissionSourceConfirmation = (draft, preview) => {
  confirmedMissionSourceOptions(draft);
  if (draft.sourceReviewDigest !== preview.reviewDigest
    || draft.sourcePolicy.digest !== preview.sourcePolicy?.digest
    || !isDeepStrictEqual(draft.importedFiles || [], preview.files || [])) {
    throw inputError('素材内容或导入策略已变化，请重新预览并确认；现有任务未修改。', 'MISSION_SOURCE_CONFIRMATION_CHANGED');
  }
  return preview;
};

export const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
// Resolve once, before exports/Runtime creation, so every managed project and
// run uses the same directory identity. This does not expand Agent authority.
export const testerHome = resolveCanonicalStorageRoot(process.env.LOCAL_C500_TESTER_HOME || path.join(rootDir, '.local-c500-production'));
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

// Launch mode answers "what will actually execute", so it must follow the
// selected backend. Before this, the mode was derived only from the
// simulation/mock switches, so an operator who selected the local NVIDIA
// backend with no other variables set still got `real-c550` and a C550
// preflight that can never pass on an NVIDIA host.
//
// Precedence is simulation > mock > local-shared-gpu > real-c550, so the two
// explicit switches keep their existing meaning and the local shared GPU is a
// real execution path that is never publication authority.
export const resolveLocalC500LaunchMode = (environment = process.env) => {
  const simulation = simulationEnabled(environment);
  const mock = simulation || environment.OPERATOR_LOCAL_C500_MOCK === '1';
  const sharedGpu = !simulation && !mock && environment.OPERATOR_TEST_BACKEND === 'local-shared-gpu';
  const accelerator = !simulation && !mock ? findAcceleratorBackend(environment.OPERATOR_TEST_BACKEND) : null;
  const id = simulation ? 'full-simulation' : mock ? 'hardware-mock' : accelerator ? accelerator.id : sharedGpu ? 'local-shared-gpu' : 'real-c550';
  return {
    id,
    simulation,
    mock,
    sharedGpu,
    ...(accelerator ? { acceleratorBackendId: accelerator.id } : {}),
    hardwareMock: id === 'hardware-mock',
    liveHardware: id === 'real-c550' || id === 'local-shared-gpu',
    // A shared host is development evidence. This is a property of the mode, so
    // the preflight and the UI agree without either of them re-deriving it.
    publishable: id === 'real-c550',
    scenario: mock ? environment.OPERATOR_LOCAL_C500_MOCK_SCENARIO || 'mla-three-round' : null,
    label: simulation
      ? 'full simulation'
      : mock
        ? 'mock hardware'
        : accelerator
          ? accelerator.hardware + ' development adapter (device qualification required)'
          : sharedGpu
          ? 'local shared NVIDIA GPU (development evidence, not publishable)'
          : `real ${environment.OPERATOR_MUXI_DEVICE || 'C550'} hardware`,
  };
};

const launchMode = resolveLocalC500LaunchMode();
// The client runtime derives its own descriptor from OPERATOR_TEST_BACKEND, so
// this is the single value the TUI and the runtime must agree on. Without it
// the runtime kept reporting the C550 release default while executing on the
// local NVIDIA device, which the preflight correctly refuses.
const expectedBackendKind = launchMode.acceleratorBackendId || (launchMode.sharedGpu ? 'local-shared-gpu' : 'local-c500');
const agentRuntimeMode = resolveAgentRuntimeMode();
// A configured target is not a hardware discovery. Opening the client must not
// run a vendor command; explicit Doctor/start performs those probes later.
const muxiDevice = process.env.OPERATOR_MUXI_DEVICE || 'C550';

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
  const attached=process.env.OPERATOR_RUNTIME_CONNECTION_MODE==='attach-only';
  if(attached) await ensureProductionRuntime();
  const response = await fetch(`${apiBaseUrl}${pathname}`, {
    ...options,
    ...(attached?{redirect:'error'}:{}),
    headers: { 'content-type': 'application/json', ...(options.headers || {}),
      ...(attached?{'x-operator-runtime-instance':`${process.env.OPERATOR_RUNTIME_EXPECTED_PID}|${process.env.OPERATOR_RUNTIME_EXPECTED_OWNER_PID}|${process.env.OPERATOR_RUNTIME_EXPECTED_STARTED_AT}`}:{}) },
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

// The existing query returns { preflight }, not a flat readiness record.
// Keep this read independently testable without launching or probing hardware.
export const readAgentPreflight = async (client = api) => {
  try {
    const response = await client.get('/api/runtime/preflight');
    if (!response?.preflight || typeof response.preflight !== 'object') return {
      ready: false, queryFailed: true, code: 'TUI_PREFLIGHT_RECEIPT_INVALID', detail: '生成准入回执缺少 preflight；就绪状态未知。',
    };
    return response.preflight;
  } catch (error) {
    return { ready: false, queryFailed: true, code: error.code, detail: error.message };
  }
};

const health = async () => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 3000);
  try {
    const response = await fetch(`${apiBaseUrl}/api/health`, { signal: controller.signal,
      ...(process.env.OPERATOR_RUNTIME_CONNECTION_MODE==='attach-only'?{redirect:'error'}:{}) });
    return response.ok ? response.json() : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
};

const experimentConflict = (message) => Object.assign(new Error(message), { code: 'EXPERIMENT_RUNTIME_CONFLICT' });
const assertExperimentRuntime = (current, experiment) => {
  const bridge = current?.__bridge || {};
  const observed = bridge.experimentIsolation;
  if (!experiment && !observed) return;
  // Current repository counts change as the experiment learns. Only immutable
  // identity is compared; never reset a valid store to make it match startup.
  const immutable = (value) => value && Object.fromEntries(Object.entries(value)
    .filter(([key]) => !['currentExperienceRevision', 'currentExperienceRecords'].includes(key)));
  if (!experiment || !observed || !isDeepStrictEqual(immutable(experiment), immutable(observed))
    || !bridge.runtimeDir || !bridge.dataDir
    || path.resolve(bridge.runtimeDir) !== path.join(testerHome, 'runtime')
    || path.resolve(bridge.dataDir) !== path.join(testerHome, 'data')) {
    throw experimentConflict('端口上的服务不属于本次冻结实验；不能连接或替换它，请使用该实验自己的目录和空闲端口。');
  }
};

export const ensureProductionRuntime = async ({ onExistingRuntime, existingRuntimePolicy } = {}) => {
  if(process.env.OPERATOR_RUNTIME_CONNECTION_MODE==='attach-only'&&apiBaseUrl!==`http://127.0.0.1:${apiPort}`) {
    throw Object.assign(new Error('Pinned Runtime attachment requires the exact local loopback endpoint.'),{code:'LOCAL_C500_RUNTIME_ATTACHMENT_CONFLICT'});
  }
  // Check the caller before health/reuse as well as before spawn. Otherwise an
  // already-running service could bypass the frozen environment admission.
  const experiment = await inspectExperimentEnvironment();
  if (experiment && (testerHome !== resolveCanonicalStorageRoot(process.env.OPERATOR_EXPERIMENT_ROOT)
    || agentRuntimeMode !== process.env.OPERATOR_RUNTIME_MODE || launchMode.mock || launchMode.simulation)) {
    throw experimentConflict('受控实验的 Tester Home、Agent 模式或测试模式与冻结配置冲突。');
  }
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
      if (!current && processAlive(recordedPid)) {
        const error = new Error('记录的 Runtime 进程仍存活但未响应；为避免同时打开同一队列，本次不会启动第二个服务。');
        error.code = 'LOCAL_C500_RUNTIME_UNRESPONSIVE';
        throw error;
      }
    }
  }
  if (current) {
    assertExperimentRuntime(current, experiment);
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
      // A running runtime that reports a different backend kind is not this
      // launch. Reusing it would run the Mission on a backend the operator did
      // not select, and would label the evidence as that other backend.
      && current.testBackend?.kind === expectedBackendKind
      && current.testBackend?.mock === launchMode.mock
      && (!launchMode.mock || current.testBackend?.scenario === launchMode.scenario)
      && current.runtime?.mode === agentRuntimeMode;

    if (process.env.OPERATOR_RUNTIME_CONNECTION_MODE === 'attach-only') {
      assertRuntimeAttachment(current,{environment:process.env,testerHome,apiPort,
        backendKind:expectedBackendKind,runtimeMode:agentRuntimeMode,ownerAlive});
      if (!compatibleRuntime) throw Object.assign(new Error('The pinned Runtime is not compatible with this client.'), {code:'LOCAL_C500_RUNTIME_ATTACHMENT_CONFLICT'});
      attachedRuntimePid = pid;
      return current;
    }

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
        executionMode: current.testBackend?.executionMode
          || (current.testBackend?.simulation ? 'full-simulation' : current.testBackend?.mock ? 'hardware-mock' : 'real-c550'),
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
        : current.testBackend?.kind !== expectedBackendKind
          ? `backend ${current.testBackend?.kind || 'unknown'} (requested ${expectedBackendKind})`
          : `${current.testBackend?.mock ? 'simulation' : 'real hardware'} mode`;
      throw new Error(`${apiBaseUrl} is occupied by ${detail}, but it does not expose a valid Operator Studio PID/port identity. Stop it manually or use a different LOCAL_C500_API_PORT/LOCAL_C500_TESTER_HOME.`);
    }
  }

  if (process.env.OPERATOR_RUNTIME_CONNECTION_MODE === 'attach-only') {
    throw Object.assign(new Error('The pinned operator-owned Runtime is unavailable; start it in the original ordinary terminal.'), {code:'LOCAL_C500_RUNTIME_ATTACHMENT_UNAVAILABLE'});
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
      OPERATOR_TEST_BACKEND: expectedBackendKind,
      OPERATOR_AUTO_TICK: '1',
      OPERATOR_AUTO_TICK_INTERVAL_MS: launchMode.simulation ? '2500' : '1500',
      OPERATOR_RUNTIME_OWNER_PID: String(process.pid),
      OPERATOR_DATA_DIR: path.join(testerHome, 'data'),
      OPERATOR_RUNTIME_DIR: path.join(testerHome, 'runtime'),
      OPERATOR_LOCAL_C500_DIR: experiment ? process.env.OPERATOR_LOCAL_C500_DIR : path.join(testerHome, 'local-c500-tasks'),
      OPERATOR_LOCAL_C500_MOCK: launchMode.mock ? '1' : '0',
      OPERATOR_LOCAL_C500_SIMULATION: launchMode.simulation ? '1' : '0',
      OPERATOR_LOCAL_C500_MOCK_SCENARIO: launchMode.scenario || '',
    },
  });
  child.unref();
  closeSync(logFd);

  // A real cold start has to load the runtime, its adapters and the platform
  // probes before it answers /api/health. That takes seconds, not milliseconds:
  // measured cold starts on this project's own workstation land between 2s and
  // 5s, so the previous 5s window turned an ordinary slow start into an
  // intermittent "did not start" failure. The window is a start-up tolerance,
  // not an evidence rule: everything the health contract must satisfy is still
  // checked below on every attempt, and a runtime that never satisfies it still
  // fails the launch.
  const readinessTimeoutMs = 30000;
  const readinessDeadline = Date.now() + readinessTimeoutMs;
  let ready = null;
  let lastHealth = null;
  while (Date.now() < readinessDeadline) {
    await sleep(100);
    const started = await health();
    lastHealth = started;
    if (started?.testBackend?.kind === expectedBackendKind
      && started.testBackend?.mock === launchMode.mock
      // Fail closed on the one direction that can mislabel evidence: a shared
      // host that claims publication authority. Mock and simulation runtimes
      // keep their existing descriptor; the preflight refuses those separately.
      && (!launchMode.sharedGpu || started.testBackend?.publishable === false)
      && started.runtime?.mode === agentRuntimeMode
      && (!launchMode.mock || started.testBackend?.scenario === launchMode.scenario)
      && Number(started.__bridge?.pid) === child.pid) {
      try { assertExperimentRuntime(started, experiment); ready = started; break; }
      catch { break; } // Reap only our child below; never replace the foreign service.
    }
  }
  if (ready) return ready;

  // The failed child is ours and was intentionally detached, so nothing else
  // will reap it. Leaving it running would occupy the port, and the next launch
  // would then read it as a foreign process holding this port.
  try {
    process.kill(child.pid, 'SIGTERM');
  } catch (error) {
    if (error.code !== 'ESRCH') { /* the child is already gone or unstoppable */ }
  }

  const observed = lastHealth
    ? `last health: backend ${lastHealth.testBackend?.kind || 'unknown'}, mock ${lastHealth.testBackend?.mock}, `
      + `publishable ${lastHealth.testBackend?.publishable}, runtime mode ${lastHealth.runtime?.mode || 'unknown'} `
      + `(requested backend ${expectedBackendKind}, runtime ${agentRuntimeMode})`
    : 'health endpoint returned nothing at all';
  throw new Error(`Production runtime did not start within ${readinessTimeoutMs}ms; ${observed}. See ${logPath}`);
};

// The production runtime is intentionally detached so the TUI can start it
// without inheriting terminal handles. It is still owned by the current TUI
// process and must be stopped when that owner exits.
export const stopProductionRuntime = async () => {
  // A connection client never owns a Runtime, even if its old port is reused.
  if (process.env.OPERATOR_RUNTIME_CONNECTION_MODE === 'attach-only') return false;
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
  if (!isTuiOperatorProfile(draft.profileId)) {
    const error = new Error('示例模式只允许发布两个完整 v0.1 C550 Profile；自定义算子请选择通用任务。');
    error.code = 'TUI_PROFILE_NOT_PUBLISHABLE';
    error.status = 409;
    throw error;
  }
  if (launchMode.sharedGpu || launchMode.acceleratorBackendId) throw inputError('C550 历史示例需要兼容后端。C500、Ascend910B 和 NVIDIA 请使用通用任务规范。', 'MISSION_TARGET_BACKEND_MISMATCH');
  assertProductionPreflight(await runDoctor());
  const current = await api.get('/api/state');
  const activeMission = current.state.missions?.find((item) => item.id === current.state.activeMissionId);
  if (activeMission && !['completed', 'published', 'stopped', 'archived'].includes(activeMission.status)) await stopMission();
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
      // 自动联网研究默认关闭：只有表单显式勾选才下发 true。
      webResearchEnabled: draft.webResearchEnabled === true,
    },
    baseline: {
      kind: 'pytorch_reference',
      source: baselineSource,
      sourcePolicy: { requireAuthority: false, requireSingleFileExpansion: true, allowGeneratedV0: true },
      materializer: { status: 'completed', phase: '内置 Profile baseline 已就绪', progress: 100, result: { schemaVersion: 'operator-studio.fixed-baseline/v1', summary: profile.summary, runPy: baselineRunPy, runPySource: 'embedded-operator-profile', source: baselineSource, report: { mode: 'fixed-operator-profile', profileId: profile.id } } },
    },
    testScenario: profile.iterationPolicy
      ? { id: profile.id, iterationPolicy: structuredClone(profile.iterationPolicy) }
      : { id: 'fixed-four-operator-v1', fixedRounds: 3 },
    objective: { mode: 'maximize', metric: 'latency p50', direction: 'minimize' },
    testMatrix,
    missionBudgetMs: timeBudget > 0 ? timeBudget : null,
  });
  const missionId = created.state.activeMissionId;
  const started = await api.post(`/api/missions/${encodeURIComponent(missionId)}/runs`, { goal });
  return { missionId, state: started.state, runId: started.runId, project };
};

// Generic execution-source import stays on the Production API boundary. The
// runtime owns source validation, immutable packaging and trusted admission.
export const importExecutionPackage = async (input) => {
  await ensureProductionRuntime();
  return api.post('/api/execution-packages/import', input);
};

// Import an operator-owned source project through the same Production API
// boundary as the fixed-profile publisher. This client only validates/normalizes
// the DTO; Mission state and workflow transitions remain server-owned.
export const importMissionSpecification = async (input, draftIdentity = {}) => {
  const spec = normalizeGenericMissionSpecification(input);
  // Read before any Runtime/project mutation; then verify the same bytes in the
  // managed snapshot before stopping/selecting a Mission.
  const baselineFile = spec.baselineFile ? await readIndependentBaseline(spec.repository, spec.baselineFile, spec.implementation) : null;
  const declaredSources = await readDeclaredSources(spec, spec.repository);
  if (spec.executionMode === 'generate-only') {
    const sourceBytes = [...declaredSources.values()].reduce((total, bytes) => total + bytes.length, 0);
    const runPy = baselineFile?.runPy ?? spec.baseline?.materializer?.result?.runPy;
    const baselineBytes = typeof runPy === 'string' ? Buffer.byteLength(runPy, 'utf8') : 0;
    if (sourceBytes + baselineBytes > 4 * 1024 * 1024) {
      throw inputError(`仅生成模式：声明源码与独立基线代码合计不得超过 4 MiB（当前 ${sourceBytes + baselineBytes} 字节）。基线同时列入源码时，两份均计入冻结输入。`, 'GENERIC_GENERATION_INPUT_TOO_LARGE');
    }
  }
  const baselineReady = Boolean(baselineFile) || spec.baseline?.materializer?.status === 'completed'
    && typeof spec.baseline?.materializer?.result?.runPy === 'string'
    && Boolean(spec.baseline.materializer.result.runPy.trim());
  if (spec.start && !baselineReady) throw inputError('请先提供已完成的基线与冻结测试规范，再启动迭代；当前可保存任务。', 'GENERIC_MISSION_BASELINE_NOT_READY');
  const runtime = await ensureProductionRuntime();
  if (draftIdentity.draftId) {
    const { draft: saved } = await api.get(`/api/mission-drafts/${encodeURIComponent(draftIdentity.draftId)}`);
    if (saved.revision !== draftIdentity.draftRevision) throw inputError('草稿已在其他窗口更新，请重新打开。', 'MISSION_DRAFT_CONFLICT');
  }
  if (spec.start && spec.executionMode !== 'generate-only') {
    assertMissionExecutor(spec, runtime.testBackend);
    assertProductionPreflight(await runDoctor());
  }
  const projects = await api.get('/api/projects');
  let project = projects.projects.find((item) => path.resolve(item.repository || '') === spec.repository)
    || projects.projects.find((item) => path.resolve(item.root || '') === spec.projectRoot);
  if (!project) {
    const expectedRepository = path.join(spec.projectRoot, 'repository');
    if (path.resolve(expectedRepository) !== spec.repository) {
      await mkdir(projectHome, { recursive: true });
      const createdProject = await api.post('/api/projects/import', {
        sourceRepository: spec.repository,
        // Use the operator identity for a bounded Windows path; the full goal/title remains Mission metadata.
        root: path.join(projectHome, `${slug(spec.operatorProfile?.operator || spec.title).slice(0, 32)}-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`),
        name: spec.title,
      });
      project = createdProject.project;
    } else {
      const createdProject = await api.post('/api/projects', { name: spec.title, root: spec.projectRoot, repository: spec.repository, initializeGit: false });
      project = createdProject.project;
    }
  }
  let importedBaseline = null;
  if (baselineFile) {
    const managed = await readIndependentBaseline(project.repository, spec.baselineFile, spec.implementation);
    if (!baselineFile.bytes.equals(managed.bytes)) throw inputError('受管快照中的独立基线与导入前原文件不一致；当前任务未停止。', 'GENERIC_BASELINE_SNAPSHOT_CHANGED');
    const identity = spawnSync('git', ['-C', project.repository, 'rev-parse', '--verify', 'HEAD'], { encoding: 'utf8', windowsHide: true, timeout: 5000 });
    const head = identity.status === 0 ? identity.stdout.trim() : '';
    if (!/^[a-f0-9]{40,64}$/u.test(head)) throw inputError('无法确认受管基线仓库的 Git 身份。', 'GENERIC_BASELINE_SOURCE_INVALID');
    const source = {
      authority: 'user-provided', kind: 'pytorch_reference', repository: project.repository,
      commit: head, path: spec.baselineFile, operator: spec.operatorProfile.operator,
      expandedSingleFile: true, revisionKind: 'working-tree-file', contentDigest: managed.digest,
      originalRepository: spec.repository,
      reason: '用户提供的独立基线；commit 仅记录仓库 HEAD，实际文件以 contentDigest 绑定，不声明上游权威或测试通过。',
    };
    importedBaseline = {
      required: true, kind: 'pytorch_reference', status: 'missing', evidence: null,
      description: '用户提供独立基线文件已导入；正确性、性能与来源权威均未验证。',
      sourcePolicy: { requireAuthority: false, requireSingleFileExpansion: true, allowGeneratedV0: false },
      source,
      resolution: { status: 'unresolved', strategy: 'user-provided-file', attemptedAuthority: false, skippedAuthority: true, skippedAuthorityReason: '用户提供独立基线，不声明上游权威。', reason: '文件工件就绪，等待真实测试。' },
      materializer: { status: 'completed', mode: 'user-provided-file', source,
        result: { runPy: managed.runPy, source, report: {
          schemaVersion: 'operator-studio.baseline-file-import/v1', mode: 'user-provided-file',
          artifactReady: true, tested: false, source, fileDigest: managed.digest,
          runPyDigest: digestBytes(Buffer.from(managed.runPy, 'utf8')), validation: managed.validation,
          testSpec: spec.testMatrix.testSpec,
        } },
      },
    };
  }
  const managedSources = await readDeclaredSources(spec, project.repository);
  for (const [filename, bytes] of declaredSources) {
    if (!bytes.equals(managedSources.get(filename))) throw inputError(`受管快照中的源码与导入前文件不一致：${filename}`, 'GENERIC_SOURCE_SNAPSHOT_CHANGED');
  }
  const current = await api.get('/api/state');
  const activeMission = current.state.missions?.find((item) => item.id === current.state.activeMissionId);
  if (activeMission && !['completed', 'published', 'stopped', 'archived'].includes(activeMission.status)) await stopMission();
  if (projects.activeProjectId !== project.id) await api.post(`/api/projects/${encodeURIComponent(project.id)}/select`);

  const missionInput = {
    ...spec,
    ...(draftIdentity.draftId ? { draftId: draftIdentity.draftId, draftRevision: draftIdentity.draftRevision } : {}),
    projectId: project.id,
    repository: project.repository || spec.repository,
    projectRoot: project.root || spec.repository,
    sourceRoot: project.sourceRoot || null,
    sourcePolicy: { ...spec.sourcePolicy, sourceFiles: spec.sourceFiles,
      ...(draftIdentity.intakeReview ? { intakeReview: structuredClone(draftIdentity.intakeReview) } : {}) },
    // Arm explicitly only after /runs succeeds; auto-tick must not race between
    // creation and the explicit start (also true for imported fixed profiles).
    missionPaused: true,
    // Never manufacture a baseline. An imported Mission may enter the normal
    // Research/Materializer path, but only an explicitly complete baseline may
    // be started immediately.
    baseline: importedBaseline || (baselineReady ? spec.baseline : undefined),
  };
  const created = await api.post('/api/missions', missionInput);
  const missionId = created.state.activeMissionId;
  let started = null;
  if (spec.start) {
    try {
      started = await api.post(`/api/missions/${encodeURIComponent(missionId)}/runs`, { goal: spec.goal, startDraft: true });
    } catch (error) {
      throw attachSavedMission(error, { missionId, state: created.state, runId: null, project, started: false, imported: true });
    }
  }
  return { missionId, state: started?.state || created.state, runId: started?.runId || null, project, started: Boolean(started), imported: true };
};

const inputError = (message, code = 'GENERIC_MISSION_SPEC_INVALID') => Object.assign(new Error(message), { code, status: 409 });

const BASELINE_FILE_LIMIT = 200_000;
const digestBytes = (bytes) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
const sameFile = (a, b) => ['dev', 'ino', 'size', 'mtimeMs', 'ctimeMs'].every((key) => a[key] === b[key]);
const inspectRegularPath = async (filename, code = 'GENERIC_BASELINE_FILE_INVALID') => {
  const parsed = path.parse(filename);
  let current = parsed.root;
  const parts = filename.slice(parsed.root.length).split(path.sep).filter(Boolean);
  for (let index = 0; index < parts.length; index++) {
    current = path.join(current, parts[index]);
    const entry = await lstat(current);
    if (entry.isSymbolicLink() || (index < parts.length - 1 && !entry.isDirectory())
      || (index === parts.length - 1 && !entry.isFile())) throw inputError('路径必须由常规目录与文件组成，不允许链接。', code);
  }
  return lstat(filename);
};

const readDeclaredSources = async (spec, repository) => {
  const files = spec.sourceFiles || [];
  const entry = normalizeOperatorLanguage(spec.implementation).entry;
  if (!files.some((file) => file.role === 'entrypoint' && file.path === entry)) throw inputError(`源码必须声明既有 ${entry} 为 entrypoint。`, 'GENERIC_SOURCE_ENTRYPOINT_INVALID');
  if (files.length > 64) throw inputError('最多声明 64 个源码文件。', 'GENERIC_SOURCE_FILE_INVALID');
  const snapshots = new Map();
  const identities = new Set();
  let totalBytes = 0;
  for (const file of files) {
    const relative = normalizeSourcePath(file.path, 'sourceFiles[].path');
    if (identities.has(relative.toLowerCase())) throw inputError(`重复源码路径：${relative}`, 'GENERIC_SOURCE_FILE_INVALID');
    identities.add(relative.toLowerCase());
    const filename = path.resolve(repository, relative);
    let handle;
    try {
      const before = await inspectRegularPath(filename, 'GENERIC_SOURCE_FILE_INVALID');
      if (before.nlink !== 1 || before.size > 2 * 1024 * 1024 || totalBytes + before.size > 8 * 1024 * 1024) throw inputError('声明源码必须无硬链接；每文件最多 2 MiB、总计最多 8 MiB。', 'GENERIC_SOURCE_FILE_INVALID');
      const canonical = await realpath(filename);
      handle = await open(filename, 'r');
      if (!sameFile(before, await handle.stat())) throw inputError('源码读取前发生变化。', 'GENERIC_SOURCE_FILE_CHANGED');
      const bytes = Buffer.alloc(before.size + 1);
      let size = 0;
      while (size < bytes.length) {
        const chunk = await handle.read(bytes, size, bytes.length - size, size);
        if (!chunk.bytesRead) break;
        size += chunk.bytesRead;
      }
      if (size !== before.size || !sameFile(before, await handle.stat()) || !sameFile(before, await inspectRegularPath(filename, 'GENERIC_SOURCE_FILE_INVALID')) || await realpath(filename) !== canonical) throw inputError('源码读取期间发生变化。', 'GENERIC_SOURCE_FILE_CHANGED');
      totalBytes += size;
      snapshots.set(relative, bytes.subarray(0, size));
    } catch (error) {
      if (error.code?.startsWith('GENERIC_')) throw error;
      throw inputError(`声明源码不可读取：${relative} (${error.code || error.message})`, 'GENERIC_SOURCE_FILE_INVALID');
    } finally { await handle?.close(); }
  }
  return snapshots;
};

const readIndependentBaseline = async (repository, relative, implementation) => {
  const baselinePath = normalizeSourcePath(relative, 'baselineFile');
  if (!baselinePath.toLowerCase().endsWith('.py')) throw inputError('独立基线必须为 .py 文件。', 'GENERIC_BASELINE_FILE_INVALID');
  if (normalizeOperatorLanguage(implementation).allowedFiles.some((file) => file.toLowerCase() === baselinePath.toLowerCase())) {
    throw inputError('独立基线不能属于候选允许写入的文件。', 'GENERIC_BASELINE_NOT_INDEPENDENT');
  }
  const root = path.resolve(repository);
  const filename = path.resolve(root, baselinePath);
  const rel = path.relative(root, filename);
  if (!rel || rel.startsWith(`..${path.sep}`) || rel === '..' || path.isAbsolute(rel)) throw inputError('基线必须在仓库内部。', 'GENERIC_BASELINE_FILE_INVALID');
  let handle;
  try {
    const before = await inspectRegularPath(filename);
    if (before.nlink !== 1 || before.size < 1 || before.size > BASELINE_FILE_LIMIT) throw inputError('基线必须为非空常规文件，大小不超过 200000 字节，且不能有硬链接。', 'GENERIC_BASELINE_FILE_INVALID');
    const canonical = await realpath(filename);
    handle = await open(filename, 'r');
    if (!sameFile(before, await handle.stat())) throw inputError('读取前基线文件已变化。', 'GENERIC_BASELINE_FILE_CHANGED');
    const buffer = Buffer.alloc(BASELINE_FILE_LIMIT + 1);
    let total = 0;
    while (total < buffer.length) {
      const { bytesRead } = await handle.read(buffer, total, buffer.length - total, total);
      if (!bytesRead) break;
      total += bytesRead;
    }
    if (total !== before.size || !sameFile(before, await handle.stat())
      || !sameFile(before, await inspectRegularPath(filename)) || await realpath(filename) !== canonical) throw inputError('读取期间基线文件已变化。', 'GENERIC_BASELINE_FILE_CHANGED');
    const bytes = buffer.subarray(0, total);
    const runPy = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    const validation = validateBaselineRunPy(runPy, { allowExternalImports: false, requireGeneratedTests: true });
    if (!validation.ok) throw inputError(`基线结构不完整：缺少 ${validation.missing.join(', ') || '无'}；不允许 ${validation.banned.join(', ') || '无'}。`, 'GENERIC_BASELINE_CONTRACT_INVALID');
    return { bytes, runPy, digest: digestBytes(bytes), validation };
  } catch (error) {
    if (error.code?.startsWith('GENERIC_')) throw error;
    throw inputError(`独立基线不可读取：${error.code || error.message}`, 'GENERIC_BASELINE_FILE_INVALID');
  } finally { await handle?.close(); }
};

// Compatibility check only; device availability is checked by the selected
// executor's Doctor. Selecting a target while saving never probes hardware.
export const assertMissionExecutor = (spec, backend = {}) => {
  const language = normalizeOperatorLanguage(spec.implementation).id;
  const targets = spec.hardware || [];
  if (targets.length !== 1) throw inputError('当前本地迭代必须选择一个目标硬件。', 'MISSION_TARGET_BACKEND_MISMATCH');
  const target = targets[0];
  const matched = backend.kind === 'local-shared-gpu' && target === 'nvidia-gpu'
    || backend.kind === 'local-c500' && target === 'C550'
    || findAcceleratorBackend(backend.kind)?.hardware === target;
  if (!matched) throw inputError(`目标 ${target} 尚无匹配的当前测试后端（${backend.kind || '未配置'}）。可先保存任务；云端测试尚未部署。`, 'MISSION_TARGET_BACKEND_MISMATCH');
  const accelerator = findAcceleratorBackend(backend.kind);
  if (accelerator && !accelerator.implementationLanguages.includes(language)) throw inputError('当前目标适配器未实现此语言：' + language, 'MISSION_LANGUAGE_BACKEND_UNSUPPORTED');
  if (backend.kind === 'local-shared-gpu' && !capabilitySupportsLanguage(backend.kind, language)) {
    throw inputError(`当前 NVIDIA 测试后端尚未接入 ${language}。`, 'MISSION_LANGUAGE_BACKEND_UNSUPPORTED');
  }
  return spec;
};

export const loadMissionConfigurationDraft = async (id) => {
  await ensureProductionRuntime();
  return api.get(`/api/mission-drafts/${encodeURIComponent(id)}`);
};

// Preparation drafts are deliberately outside executable Missions. Imported
// materials are copied through the existing project-import application path.
export const saveMissionConfigurationDraft = async (draft = {}) => {
  if (draft.mode !== 'generic' || draft.inputMode !== 'form' || draft.sourceMode !== 'managed'
    || !String(draft.operator || '').trim() || !String(draft.goal || '').trim()) {
    throw inputError('保存草稿只需填写算子名称和开发目标，其他参数可稍后补齐。', 'MISSION_DRAFT_INVALID');
  }
  await ensureProductionRuntime();
  if (draft.draftId) {
    const saved = await loadMissionConfigurationDraft(draft.draftId);
    if (saved.draft.revision !== draft.draftRevision) throw inputError('草稿已在其他窗口更新，请重新打开。', 'MISSION_DRAFT_CONFLICT');
  }
  const { draftId, draftRevision, ...form } = draft;
  if (form.sourceSelections?.length) {
    const projects = await api.get('/api/projects');
    const existing = projects.projects.find((item) => item.id === form.materialProjectId
      && form.sourceSelections.length === 1 && path.resolve(form.sourceSelections[0]) === path.resolve(item.repository));
    if (existing) {
      const checked = await previewMissionSources(form.sourceSelections, confirmedMissionSourceOptions(form));
      assertMissionSourceConfirmation(form, checked);
    } else {
      const staged = await stageMissionSources(path.join(testerHome, 'intakes'), form.sourceSelections, form.importedFiles || [], confirmedMissionSourceOptions(form));
      try {
        await mkdir(projectHome, { recursive: true });
        const { project } = await api.post('/api/projects/import', {
          sourceRepository: staged.repository,
          root: path.join(projectHome, `draft-${Date.now().toString(36)}-${randomUUID()}`),
          name: form.operator, activate: false,
        });
        const checked = await previewMissionSources([project.repository], { includeIgnoredPaths: form.sourcePolicy?.includeIgnoredPaths || [] });
        form.sourceSelections = checked.selections;
        form.importedFiles = checked.files;
        form.sourcePolicy = checked.sourcePolicy;
        form.sourceReviewDigest = checked.reviewDigest;
        form.sourceExcludedFiles = checked.excludedFiles;
        form.sourceGeneratedFiles = checked.generatedFiles;
        form.materialProjectId = project.id;
      } finally { await staged.cleanup(); }
    }
  } else { delete form.materialProjectId; }
  return api.post('/api/mission-drafts', { id: draftId, revision: draftRevision, form });
};

export const publishMissionDraft = async (draft = {}) => {
  if (!draft || typeof draft !== 'object' || Array.isArray(draft)
    || (draft.mode !== undefined && !['generic', 'fixed-example'].includes(draft.mode))
    || (draft.execution !== undefined && !['save', 'generate-only', 'start'].includes(draft.execution))
    || (draft.inputMode !== undefined && !['form', 'spec-file'].includes(draft.inputMode))) throw inputError('请选择通用/示例任务，以及保存、仅生成或启动本地迭代。');
  if (draft.timeBudget && (!/^\d+$/.test(String(draft.timeBudget)) || !Number.isSafeInteger(Number(draft.timeBudget)) || Number(draft.timeBudget) <= 0)) throw inputError('时间预算必须是正整数毫秒，或留空。');
  if (draft.mode === 'fixed-example') return publishMission(draft);
  if ((draft.inputMode || 'form') === 'form') {
    const form = { ...draft, execution: draft.execution || 'save' };
    const identity = draft.draftId ? { draftId: draft.draftId, draftRevision: draft.draftRevision } : {};
    // Validate the full explicit semantic/test contract before writing intake files.
    missionSpecificationFromForm(form);
    if (form.sourceMode !== 'managed') return importMissionSpecification(missionSpecificationFromForm(form), identity);
    const staged = await stageMissionSources(path.join(testerHome, 'intakes'), form.sourceSelections || [], form.importedFiles || [], confirmedMissionSourceOptions(form));
    try { return await importMissionSpecification(missionSpecificationFromForm({ ...form, repository: staged.repository }), {
      ...identity, intakeReview: { sourcePolicy: form.sourcePolicy, reviewDigest: form.sourceReviewDigest,
        files: staged.files || [...form.importedFiles, ...(form.sourceGeneratedFiles || [])] },
    }); }
    finally { await staged.cleanup(); }
  }
  const specPath = String(draft.specPath || '').trim();
  if (!path.isAbsolute(specPath)) throw inputError('请输入通用任务规范 JSON 文件的绝对路径。');
  const file = await stat(specPath);
  const maximumBytes = 750_000; // Leave room under the Runtime JSON body limit.
  if (!file.isFile() || file.size > maximumBytes) throw inputError('任务规范必须是小于 750 KB 的 JSON 文件。');
  const content = await readFile(specPath, 'utf8');
  if (Buffer.byteLength(content, 'utf8') > maximumBytes) throw inputError('任务规范超过 750 KB 上限。');
  const spec = JSON.parse(content.replace(/^\uFEFF/, ''));
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) throw inputError('任务规范必须是 JSON 对象。');
  if (draft.repository?.trim()) {
    spec.repository = draft.repository.trim();
    delete spec.projectRoot;
  }
  if (draft.operator?.trim()) spec.operatorProfile = { ...spec.operatorProfile, operator: draft.operator.trim() };
  if (draft.goal?.trim()) spec.goal = draft.goal.trim();
  if (draft.language && draft.language !== 'from-spec') spec.implementation = { ...spec.implementation, id: draft.language, language: draft.language };
  if (draft.target && draft.target !== 'from-spec') {
    spec.hardware = [draft.target];
    spec.testMatrix = { ...spec.testMatrix, environments: [draft.target] };
  }
  if (draft.timeBudget) spec.missionBudgetMs = Number(draft.timeBudget);
  if (draft.execution === 'generate-only') spec.executionMode = 'generate-only';
  else if (draft.execution === 'start') spec.executionMode = 'iterate';
  spec.start = ['start', 'generate-only'].includes(draft.execution);
  return importMissionSpecification(spec);
};

export const loadProjectExperiences = async (projectId) => {
  if (!projectId) return { experiences: [] };
  await ensureProductionRuntime();
  return api.get(`/api/projects/${encodeURIComponent(projectId)}/experiences`);
};

// Read-only projection of the versioned decision the domain already computed.
// This client never produces a decision, never mutates state and never derives
// publication from flat booleans; missing decisions stay null.
export const projectProductionEvidence = (state = {}, mission = null) => {
  const benchmark = state.benchmark || mission?.benchmark || {};
  const review = state.decisionReview || mission?.decisionReview || {};
  const benchmarkCandidate = benchmark.candidate || {};
  const benchmarkCandidateId = benchmarkCandidate.id || state.appliedCandidateId || null;
  const appliedCandidate = (state.candidateEvaluations || []).find((candidate) => candidate.id === benchmarkCandidateId) || {};
  const currentIdentity = {
    candidateId: benchmarkCandidateId,
    candidateDigest: benchmarkCandidate.digest || appliedCandidate.patchDigest || null,
    runId: benchmark.runId || null,
  };
  const best = state.currentBest || mission?.currentBest || {};
  const bestIdentity = {
    candidateId: best.candidateId || null,
    candidateDigest: best.candidateDigest || best.digest || null,
    runId: best.evidenceRunId || best.runId || null,
  };
  // Only a decision bound to this benchmark candidate/run, or to this
  // currentBest candidate, is projected; missing identities never default to a
  // match, so another candidate/run cannot be presented as the current one.
  const evidenceDecision = selectEvidenceDecision(currentIdentity, benchmark.evidenceDecision, review.gate?.decision);
  const currentBestEvidenceDecision = selectEvidenceDecision(bestIdentity, best.evidenceDecision, best.acceptGate?.decision)
    || (bestIdentity.candidateId ? selectEvidenceDecision(bestIdentity, evidenceDecision) : null);
  return { evidenceDecision, currentBestEvidenceDecision };
};

export const loadProductionState = async () => {
  await ensureProductionRuntime();
  const [{ state }, healthState, { tasks }] = await Promise.all([
    api.get('/api/state'),
    api.get('/api/health'),
    api.get('/api/operator-tests'),
  ]);
  const mission = state.missions?.find((item) => item.id === state.activeMissionId) || null;
  return { state, mission, health: healthState, tasks: tasks || [], evidence: projectProductionEvidence(state, mission) };
};

export const pauseMission = () => api.patch('/api/state', { missionPaused: true });
export const selectMission = async (missionId) => {
  if (typeof missionId !== 'string' || !missionId.trim()) throw inputError('请选择一个已有 Mission。', 'TUI_MISSION_SELECTION_INVALID');
  const result = await api.post(`/api/missions/${encodeURIComponent(missionId)}/select`, {});
  if (result?.state?.activeMissionId !== missionId || !result.state.missions?.some(mission => mission.id === missionId)) {
    throw inputError('任务切换回执与所选 Mission 不一致，请刷新任务列表。', 'TUI_MISSION_SELECTION_MISMATCH');
  }
  return result;
};
export const resumeMission = async () => {
  const { state } = await api.get('/api/state');
  const mission = state.missions?.find((item) => item.id === state.activeMissionId);
  const preparationRetry = isDraftPreparationRetry(state) && isDraftPreparationRetry(mission);
  if (mission?.executionMode === 'generate-only' && (state.agent?.runId || mission.agent?.runId
    || state.iterationStats?.pendingValidation || mission.iterationStats?.pendingValidation
    || (mission.missionBudgetStartedAt && !preparationRetry) || Number(state.iterationStats?.round || 0) > 0)) {
    throw inputError('已冻结的候选请使用“提交测试”；恢复生成不会重置原轮次预算。', 'GENERATION_ONLY_TEST_NOT_ENABLED');
  }
  const newDraft = (mission?.sourcePolicy?.mode === 'existing-source-project' || mission?.attemptOrigin)
    && !state.agent?.runId && (!mission.missionBudgetStartedAt || preparationRetry)
    && !Number(state.iterationStats?.round || 0);
  if (newDraft) {
    if (state.baseline?.materializer?.status !== 'completed' || typeof state.baseline?.materializer?.result?.runPy !== 'string' || !state.baseline.materializer.result.runPy.trim()) {
      throw inputError('此任务尚未提供已完成的基线。请补齐任务规范后重新导入，再启动本地迭代。', 'GENERIC_MISSION_BASELINE_NOT_READY');
    }
    const runtime = await ensureProductionRuntime();
    if (mission.executionMode !== 'generate-only') {
      assertMissionExecutor(mission, runtime.testBackend);
      assertProductionPreflight(await runDoctor());
    }
    // Keep Autopilot paused until the explicit run has been admitted. Failed
    // runtime admission leaves the saved draft paused and without work.
    return api.post(`/api/missions/${encodeURIComponent(mission.id)}/runs`, { goal: mission.goal, startDraft: true });
  }
  const result = await api.patch('/api/state', { missionPaused: false });
  if (result.state.iterationStats?.loopStatus === 'paused_budget') return api.post('/api/actions/resume-mission', {});
  return result;
};
export const stopMission = () => api.post('/api/actions/stop-mission', {});
export const submitPendingCandidate = async () => {
  const { state } = await api.get('/api/state');
  const missionId = state.activeMissionId;
  const pending = state.iterationStats?.pendingValidation;
  if (!pending || pending.missionId !== missionId) throw inputError('当前任务没有冻结的待测候选。', 'PENDING_CANDIDATE_NOT_FOUND');
  const frozen = await api.get(`/api/missions/${encodeURIComponent(missionId)}/pending-candidate`);
  if (!isDeepStrictEqual(frozen?.pendingValidation, pending) || frozen?.bundle?.manifestDigest !== pending.manifestDigest) {
    throw inputError('冻结候选身份已变化，请刷新后重试。', 'PENDING_TEST_IDENTITY_MISMATCH');
  }
  const runtime = await ensureProductionRuntime();
  assertMissionExecutor(frozen.bundle.manifest.mission, runtime.testBackend);
  assertProductionPreflight(await runDoctor(), { requireAgent: false });
  const result = await api.post(`/api/missions/${encodeURIComponent(missionId)}/pending-candidate/submit`, { manifestDigest: pending.manifestDigest });
  if (result?.state?.activeMissionId !== missionId || result?.state?.iterationStats?.pendingTest?.manifestDigest !== pending.manifestDigest || !result.taskId) {
    throw inputError('测试提交回执与冻结候选不一致，请刷新查看队列。', 'PENDING_TEST_RECEIPT_INVALID');
  }
  return result;
};
export const addHumanFeedback = (note) => api.post('/api/actions/human-feedback', { note });

const pendingFeedbackAction = async (action) => {
  const { state } = await api.get('/api/state');
  const pending = state.iterationStats?.pendingValidation;
  if (!pending || pending.missionId !== state.activeMissionId) throw inputError('当前任务没有冻结候选。', 'PENDING_CANDIDATE_NOT_FOUND');
  // Settlement needs neither an Agent nor a GPU. Continue admits only generation;
  // its server-side preflight must not require the test backend to be online.
  const result = await api.post(`/api/missions/${encodeURIComponent(pending.missionId)}/pending-candidate/${action}`, { manifestDigest: pending.manifestDigest });
  if (result?.state?.activeMissionId !== pending.missionId || (action === 'continue' ? !result.runId
    : result?.state?.iterationStats?.pendingFeedback?.manifestDigest !== pending.manifestDigest)) {
    throw inputError('结果反馈回执身份不一致，请刷新任务状态。', 'PENDING_FEEDBACK_RECEIPT_INVALID');
  }
  return result;
};
export const settlePendingCandidate = () => pendingFeedbackAction('settle');
export const continuePendingCandidate = () => pendingFeedbackAction('continue');
export const newPendingAttempt = async () => {
  const { state } = await api.get('/api/state');
  const pending = state.iterationStats?.pendingValidation;
  if (!pending || pending.missionId !== state.activeMissionId) throw inputError('当前任务没有冻结候选。', 'PENDING_CANDIDATE_NOT_FOUND');
  const result = await api.post(`/api/missions/${encodeURIComponent(pending.missionId)}/pending-candidate/new-attempt`, { manifestDigest: pending.manifestDigest });
  const mission = result?.state?.missions?.find(item => item.id === result.missionId);
  if (!mission || result.started !== false || mission.attemptOrigin?.missionId !== pending.missionId
    || mission.attemptOrigin.manifestDigest !== pending.manifestDigest) throw inputError('新尝试回执来源不一致。', 'PENDING_ATTEMPT_RECEIPT_INVALID');
  return result;
};

export const loadMissionHistory = async (missionId) => {
  if (!missionId) throw inputError('请先选择 Mission。', 'MISSION_NOT_FOUND');
  return assertMissionHistory(await api.get(`/api/missions/${encodeURIComponent(missionId)}/evaluation/export`), missionId);
};

// Export the exact displayed snapshot, including its original source identity.
export const exportMissionHistory = async (missionId, document) => {
  assertMissionHistory(document, missionId);
  const bytes = `${JSON.stringify(document, null, 2)}\n`;
  await mkdir(exportHome, { recursive: true });
  const target = path.join(exportHome, `history-${Date.now()}-${randomUUID()}.json`);
  await writeFile(target, bytes, { encoding: 'utf8', flag: 'wx' });
  return target;
};

export const exportMission = async () => {
  const snapshot = await loadProductionState();
  if (!snapshot.mission) throw new Error('No active mission to export.');
  const pending = snapshot.state.iterationStats?.pendingValidation || snapshot.mission.iterationStats?.pendingValidation;
  const pendingCandidate = pending ? await api.get(`/api/missions/${encodeURIComponent(snapshot.mission.id)}/pending-candidate`) : null;
  if (pending && (!pendingCandidate?.pendingValidation || !pendingCandidate.bundle
    || !isDeepStrictEqual(pending, pendingCandidate.pendingValidation))) throw inputError('冻结候选导出回执缺少工件或清单已变化，请刷新后重试。', 'PENDING_CANDIDATE_EXPORT_INVALID');
  await mkdir(exportHome, { recursive: true });
  const target = path.join(exportHome, `${snapshot.mission.id}.json`);
  await writeFile(target, `${JSON.stringify({ schemaVersion: 'operator-studio.mission-export/v1', exportedAt: new Date().toISOString(), ...snapshot, pendingCandidate }, null, 2)}\n`, 'utf8');
  return target;
};

// Missing best/source evidence is an error, never a fallback to pending/workspace.
export const exportBestCandidate = async () => {
  const snapshot = await loadProductionState();
  if (!snapshot.mission) throw inputError('请先打开 Mission。', 'MISSION_NOT_FOUND');
  const document = await api.get('/api/missions/' + encodeURIComponent(snapshot.mission.id) + '/best-candidate');
  return writeBestCandidateExport(document, exportHome);
};
const checkCommand = (command, args = ['--version']) => {
  const result = spawnSync(command, args, { encoding: 'utf8', windowsHide: true, timeout: 10000 });
  return { status: result.status === 0 ? 'ok' : 'missing', detail: String(result.stdout || result.stderr || '').trim().split(/\r?\n/)[0] || null };
};

// The doctor must probe the interpreter the runtime will actually use. Before
// this it read `process.env.PYTHON || 'python'`, which on a host with a
// repo-local GPU venv reported a different (e.g. CPU-only) Python than the one
// that runs the work, so the doctor's verdict contradicted the runtime.
const doctorPython = () => resolvePythonExecutable({ rootDir });

const checkC550Stack = () => {
  const python = doctorPython();
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
  const python = doctorPython();
  const script = 'import torch; assert torch.cuda.is_available(); x=torch.ones((1,), device="cuda"); y=x+1; torch.cuda.synchronize(); print(torch.cuda.get_device_name(torch.cuda.current_device()))';
  const result = spawnSync(python, ['-c', script], { encoding: 'utf8', windowsHide: true, timeout: 30000 });
  const detail = String(result.stdout || result.stderr || '').trim().split(/\r?\n/)[0] || null;
  return { status: result.status === 0 && /C550/i.test(detail || device || '') ? 'ok' : 'failed', detail };
};

// Vendor-neutral CUDA smoke: it proves the resolved interpreter can really
// allocate and synchronise on a device, and reports which device, without
// requiring any particular vendor's product name. The C550 check above stays
// as-is because "is this the frozen C550 target" is a different question.
const checkLocalCudaSmoke = () => {
  const python = doctorPython();
  const script = [
    'import json',
    'import torch',
    'payload = {"torch": torch.__version__, "cudaBuild": torch.version.cuda, "available": bool(torch.cuda.is_available()), "device": None, "capability": None}',
    'if payload["available"]:',
    ' payload["device"] = torch.cuda.get_device_name(torch.cuda.current_device())',
    ' payload["capability"] = "sm" + "".join(str(v) for v in torch.cuda.get_device_capability(torch.cuda.current_device()))',
    ' x = torch.ones((1,), device="cuda")',
    ' y = x + 1',
    ' torch.cuda.synchronize()',
    ' payload["ranOnDevice"] = bool(float(y.item()) == 2.0)',
    'print(json.dumps(payload))',
  ].join('\n');
  const result = spawnSync(python, ['-c', script], { encoding: 'utf8', windowsHide: true, timeout: 60000 });
  const raw = String(result.stdout || '').trim().split(/\r?\n/)[0] || null;
  let payload = null;
  try { payload = JSON.parse(raw); } catch { payload = null; }
  if (result.status !== 0 || !payload) {
    return { status: 'failed', detail: String(result.stderr || result.stdout || '').trim().split(/\r?\n/)[0] || 'CUDA smoke probe failed' };
  }
  const ok = payload.available === true && payload.ranOnDevice === true && typeof payload.device === 'string' && payload.device.length > 0;
  return {
    status: ok ? 'ok' : 'failed',
    detail: ok ? `${payload.device} / ${payload.capability} / torch ${payload.torch} (cuda ${payload.cudaBuild})` : `CUDA unavailable or the device allocation did not succeed (torch ${payload.torch})`,
    device: payload.device || null,
    capability: payload.capability || null,
  };
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
  const agentPreflight = await readAgentPreflight();
  if (launchMode.acceleratorBackendId) {
    let qualification;
    try { qualification = await probeAcceleratorRuntime({ backendId: launchMode.acceleratorBackendId, rootDir, python: doctorPython(), probeDevice: true }); }
    catch (error) { qualification = { ready: false, code: error.code, detail: error.message, details: error.details }; }
    return { status: 'completed', executionMode: launchMode.id, runtime, agentPreflight, mock: false, simulation: false,
      publishable: false, checks: { python: checkCommand(doctorPython()), targetQualification: { status: qualification.ready === true ? 'ok' : 'blocked', ...qualification } } };
  }
  const notApplicable = { status: 'not-applicable', detail: '当前测试后端不需要 MetaX 工具链。' };
  const device = launchMode.sharedGpu ? {} : detectMuxiDevice();
  const stack = launchMode.sharedGpu ? notApplicable : checkC550Stack();
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
  const mctracer = launchMode.sharedGpu ? notApplicable : checkCommand('mctracer');
  const mcProfiler = launchMode.sharedGpu ? notApplicable : checkCommand('mcProfiler');
  const python = doctorPython();
  // Only the local shared GPU path pays for the vendor-neutral CUDA probe; the
  // C550 path already spends a torch import in checkC550Smoke above.
  const cuda = launchMode.sharedGpu
    ? checkLocalCudaSmoke()
    : { status: 'not-applicable', detail: 'Only probed for the local-shared-gpu backend.' };
  return {
    status: 'completed',
    executionMode: launchMode.id,
    runtime,
    mock: runtime.testBackend?.mock === true,
    // Which interpreter the verdict describes, so a reader never has to guess
    // whether it is the one the runtime uses.
    pythonExecutable: python,
    agentPreflight,
    checks: {
      // On the shared GPU path the MetaX probe has no bearing, and reporting
      // "C550 / release-default" while executing on an NVIDIA device would
      // describe the run as something it is not.
      device: launchMode.sharedGpu
        ? { status: cuda.status === 'ok' ? 'ok' : 'invalid', detail: cuda.detail, device: cuda.device || null, capability: cuda.capability || null, source: 'cuda-smoke' }
        : { status: device.source === 'release-default' ? 'assumed' : device.device === 'C550' ? 'ok' : 'invalid', detail: `${device.device || 'unknown'} / ${device.source}` },
      python: checkCommand(python, ['--version']),
      mxSmi: launchMode.sharedGpu ? notApplicable : checkCommand('mx-smi', []),
      mctracer: { ...mctracer, required: false, status: launchMode.sharedGpu ? 'not-applicable' : mctracer.status === 'ok' ? 'ok' : 'optional-missing' },
      mcProfiler: { ...mcProfiler, required: false, status: launchMode.sharedGpu ? 'not-applicable' : mcProfiler.status === 'ok' ? 'ok' : 'optional-missing' },
      sourceMirror,
      stack,
      cudaSmoke: launchMode.sharedGpu ? notApplicable : cudaSmoke,
      cuda,
    },
  };
};

export const assertProductionPreflight = (doctor, { requireAgent = true } = {}) => {
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
  if (requireAgent && runtime.connected !== true) {
    const agentCheck = doctor?.agentPreflight?.agentCheck;
    failures.push(agentCheck?.ready === false
      ? operationErrorMessage({ code: agentCheck.code, message: agentCheck.detail || 'Agent 生成准入未就绪' })
      : `Agent Runtime ${runtime.mode || 'unknown'} 未连接`);
  }
  if (requireAgent && !capabilityCheck.supported) failures.push(`Agent Runtime ${runtime.mode || 'unknown'} 缺少能力：${capabilityCheck.missing.join(', ')}`);
  if (executionMode === 'hardware-mock') {
    if (backend.mock !== true || backend.liveHardware !== false) failures.push('hardware-mock 必须使用不可发布的 mock C550 backend');
    if (backend.device !== 'C550') failures.push(`hardware-mock 设备必须是 C550，当前为 ${backend.device || 'unknown'}`);
  } else if (findAcceleratorBackend(executionMode)) {
    if (backend.kind !== executionMode || backend.qualificationRequired !== true || backend.mock === true || backend.publishable !== false) failures.push('目标后端身份或开发证据策略不匹配');
    const qualification = doctor?.checks?.targetQualification;
    if (qualification?.status !== 'ok' || qualification.ready !== true || qualification.deviceProbed !== true || qualification.publishable !== false || qualification.backendId !== executionMode) failures.push('目标设备和版本未通过实际准入：' + (qualification?.code || 'unknown'));
    if (doctor?.checks?.python?.status !== 'ok') failures.push('Python 不可用');
  } else if (executionMode === 'local-shared-gpu') {
    // The local NVIDIA backend is judged on the capability it actually claims:
    // a real local CUDA device reachable from the interpreter the runtime uses.
    // mx-smi, the frozen C550 stack versions and the C550 smoke test belong to
    // the C550 target and are deliberately not required here — requiring them
    // is what made this backend unreachable from the production entry.
    // The TUI derives the execution mode from its own environment while the
    // runtime derives its descriptor from the environment it was spawned with.
    // Requiring both to name this backend is what catches the two disagreeing.
    if (backend.kind !== 'local-shared-gpu') failures.push(`Runtime 测试后端不是 local-shared-gpu，当前为 ${backend.kind || 'unknown'}`);
    if (backend.mock === true || backend.liveHardware !== true) failures.push('测试后端不是本机实机（live hardware）模式');
    // Fail closed: a backend that does not explicitly mark itself non-publishable
    // is not accepted here, so an unmarked descriptor can never be read as
    // publication authority.
    if (backend.publishable !== false) failures.push(`本机共享 GPU 必须显式声明 publishable=false，当前为 ${backend.publishable}`);
    if (doctor?.checks?.python?.status !== 'ok') failures.push('Python 不可用');
    if (doctor?.checks?.cuda?.status !== 'ok') failures.push(`本机 CUDA 运行时 smoke test 未通过（${doctor?.checks?.cuda?.detail || 'unknown'}）`);
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
