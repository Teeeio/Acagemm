import readline from 'node:readline';
import { spawn, spawnSync } from 'node:child_process';
import { appendFile, cp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createLocalC500Adapter } from './local-c500-adapter.mjs';
import { evaluateLocalAcceptGate } from './accept-gate.mjs';
import { generateMissionCandidate } from './candidate-generation.mjs';
import { adoptCandidatePatch, recordCandidateExperience } from './adoption.mjs';
import { discoverOperatorMaterial } from './source-discovery.mjs';
import { materializeOperatorMaterial } from './materializer.mjs';
import { normalizeWorkflowError, serializeWorkflowError } from '../../client-runtime/workflow-error.mjs';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const testerDir = path.join(rootDir, 'tools', 'local-c500-tester');
const homeDir = process.env.LOCAL_C500_TESTER_HOME || path.join(rootDir, '.local-c500-tester');
const currentMissionDir = path.join(homeDir, 'current');
const archiveRoot = path.join(homeDir, 'archive');
const DEFAULT_MAX_ROUNDS = 20;
const DEFAULT_MAX_RESEARCH = 3;
const WORKFLOW_RECOVERY_AGE_MS = 15 * 60 * 1000;

const expectedEnvironment = {
  triton: '3.7.1',
  torch: '2.8.0+metax3.3.0.2',
  python: '3.12.11',
  vllm: '0.13.0',
  vllm_metax: '0.13.0+g181dc3.d20260129.maca3.3.0.15.torch2.8',
  maca: '3.3.0.15',
};

const nowIso = () => new Date().toISOString();
const processAlive = (pid) => {
  const numeric = Number(pid);
  if (!Number.isInteger(numeric) || numeric <= 0) return false;
  try { process.kill(numeric, 0); return true; } catch (error) { return error.code === 'EPERM'; }
};

const parseArgs = (argv) => {
  const positional = [];
  const flags = {};
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (!item.startsWith('--')) {
      positional.push(item);
      continue;
    }
    const key = item.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith('--')) {
      flags[key] = true;
    } else {
      flags[key] = next;
      index += 1;
    }
  }
  return { positional, flags };
};

const envFlag = (name) => process.env[`npm_config_${name.replaceAll('-', '_')}`];
const envValue = (name) => {
  const value = envFlag(name);
  return value && value !== 'true' && value !== 'false' ? value : undefined;
};

const normalizeNpmArgs = (positional, flags) => {
  for (const key of ['mock', 'json', 'once']) {
    if (flags[key] == null && envFlag(key) != null) flags[key] = envFlag(key) === 'true' ? true : envFlag(key);
  }
  const [command, subcommand, ...extras] = positional;
  if (command === 'mission' && subcommand === 'create') {
    flags.name ??= envValue('name') || extras[0];
    flags.operator ??= envValue('operator') || extras[1];
    const thirdLooksLikePath = extras[2] && (
      String(extras[2]).includes('/')
      || String(extras[2]).includes('\\')
      || String(extras[2]).endsWith('.py')
      || existsSync(path.resolve(String(extras[2])))
    );
    flags.backend ??= envValue('backend') || (thirdLooksLikePath ? undefined : extras[2]);
    flags['time-budget'] = flags['time-budget'] === true ? undefined : flags['time-budget'];
    flags['token-budget'] = flags['token-budget'] === true ? undefined : flags['token-budget'];
    flags['time-budget'] ??= envValue('time-budget') || (thirdLooksLikePath ? undefined : extras[3]);
    flags['token-budget'] ??= envValue('token-budget') || (thirdLooksLikePath ? extras[3] : extras[4]);
    flags['operator-path'] = flags['operator-path'] === true ? undefined : flags['operator-path'];
    flags['operator-path'] ??= envValue('operator-path') || (thirdLooksLikePath ? extras[2] : extras[5]);
  }
  if (command === 'mission' && subcommand === 'run') {
    flags.mission ??= envValue('mission') || (extras.length >= 2 ? extras[0] : undefined);
    flags['operator-path'] = flags['operator-path'] === true ? undefined : flags['operator-path'];
    flags['operator-path'] ??= envValue('operator-path') || (extras.length >= 2 ? extras[1] : extras[0]);
  }
  if (command === 'mission' && subcommand === 'note') {
    flags.mission ??= envValue('mission') || extras[0];
    flags.text ??= envValue('text') || extras.slice(flags.mission ? 1 : 0).join(' ');
  }
  if (command === 'mission' && subcommand === 'export') {
    flags.mission ??= envValue('mission') || extras[0];
  }
  if (command === 'mission' && ['pause', 'resume', 'stop'].includes(subcommand)) {
    flags.mission ??= envValue('mission') || extras[0];
  }
  return { positional, flags };
};

const parseBudgetMs = (value) => {
  if (!value || value === true) return null;
  const match = String(value).trim().toLowerCase().match(/^(\d+(?:\.\d+)?)(ms|s|m|h)?$/);
  if (!match) throw new Error(`invalid time budget: ${value}`);
  const scale = match[2] === 'h' ? 3_600_000 : match[2] === 'm' ? 60_000 : match[2] === 's' ? 1000 : 1;
  return Math.round(Number(match[1]) * scale);
};

const ensureHome = async () => {
  await mkdir(path.join(homeDir, 'missions'), { recursive: true });
  await mkdir(path.join(homeDir, 'exports'), { recursive: true });
};

const writeJson = async (file, value) => {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
};

const readJson = async (file) => JSON.parse(await readFile(file, 'utf8'));
const missionDirFor = (missionId) => missionId === 'current' ? currentMissionDir : path.join(homeDir, 'missions', missionId);

const safeName = (value) => String(value || 'mission').replace(/[^a-zA-Z0-9._-]/g, '_');

const readOperatorRegistry = async () => readJson(path.join(testerDir, 'operator-registry.json'));

const resolveRegisteredOperator = async (operatorId) => {
  const registry = await readOperatorRegistry();
  const id = operatorId;
  if (!id) throw new Error('operator identity is required');
  const operator = registry.operators.find((item) => item.id === id);
  if (!operator) throw new Error(`operator is not registered: ${id}`);
  const template = path.resolve(testerDir, operator.template);
  if (!existsSync(template)) throw new Error(`operator template is missing: ${operator.template}`);
  return { ...operator, template_path: template };
};

const createMissionId = () => `local_${new Date().toISOString().replace(/\D/g, '').slice(0, 14)}_${Math.random().toString(16).slice(2, 8)}`;

const inferOperatorIdFromMission = async ({ goal, repository, explicitOperator }) => {
  if (explicitOperator) return explicitOperator;
  const registry = await readOperatorRegistry();
  const haystack = `${goal || ''} ${repository || ''}`.toLowerCase();
  const matched = registry.operators.find((item) => {
    const names = [item.id, item.name, ...(item.aliases || [])].filter(Boolean).map((value) => String(value).toLowerCase());
    return names.some((name) => haystack.includes(name));
  });
  return matched?.id || null;
};

const runAgentDiscovery = async ({ missionId, goal, repository, flags }) => {
  let operatorId = await inferOperatorIdFromMission({ goal, repository, explicitOperator: flags.operator });
  if (!operatorId && flags.smoke === true) {
    const registry = await readOperatorRegistry();
    operatorId = registry.active_operator;
  }
  if (operatorId === 'vector_add' && flags.smoke !== true) {
    return {
      mission_id: missionId,
      status: 'needs_human',
      reason: 'smoke_mode_required',
      resolved_by: 'local-agent-discovery',
      source_kind: null,
      source_policy: 'no_fallback',
      repository,
      operator_id: operatorId,
      operator_name: 'Vector Add Smoke',
      backend: flags.backend || 'triton',
      metric: flags.metric || 'latency p50',
      hardware: ['C500'],
      user_visible_source_path: false,
      message: 'vector_add 仅允许通过显式 --smoke 调试路径运行，普通 Mission 不使用 smoke template。',
      created_at: nowIso(),
    };
  }
  const registry = await readOperatorRegistry();
  const materialRegistry = {
    operators: (registry.operators || []).map((item) => ({
      ...item,
      source_path: item.source_path || path.resolve(testerDir, item.template),
      entry: item.entry || 'run.py',
      semantic_evidence: item.semantic_evidence || ['local registry entry'],
    })),
  };
  const researchMaterialPath = process.env.LOCAL_C500_TESTER_RESEARCH_MATERIAL;
  const material = await discoverOperatorMaterial({
    goal,
    repository,
    operatorId,
    registry: materialRegistry,
    research: researchMaterialPath ? async () => readJson(path.resolve(researchMaterialPath)) : null,
  });
  if (material.status !== 'resolved') {
    return {
      mission_id: missionId,
      ...material,
      resolved_by: 'local-agent-discovery',
      backend: flags.backend || 'triton',
      metric: flags.metric || 'latency p50',
      hardware: ['C500'],
      user_visible_source_path: false,
      created_at: nowIso(),
    };
  }
  const resolvedOperatorId = operatorId || material.operator_id;
  const registeredOperator = (registry.operators || []).find((item) => item.id === resolvedOperatorId);
  const operator = registeredOperator ? await resolveRegisteredOperator(resolvedOperatorId) : {
    id: resolvedOperatorId,
    name: material.operator_name || resolvedOperatorId,
    backend: material.backend || flags.backend || 'triton',
    hardware: material.hardware || ['C500'],
    metricDefaults: [flags.metric || 'latency p50'],
    template_path: material.source_path || null,
  };
  if (!operator.template_path && !material.generated_entry) {
    return {
      mission_id: missionId,
      status: 'needs_human',
      reason: 'material_entry_unresolved',
      resolved_by: 'local-agent-discovery',
      source_kind: material.source_kind,
      source_policy: 'no_fallback',
      repository,
      operator_id: resolvedOperatorId,
      operator_name: operator.name,
      backend: flags.backend || 'triton',
      metric: flags.metric || 'latency p50',
      hardware: ['C500'],
      user_visible_source_path: false,
      material,
      created_at: nowIso(),
    };
  }
  return {
    mission_id: missionId,
    status: 'resolved',
    resolved_by: 'local-agent-discovery',
    source_kind: flags.smoke === true ? 'explicit_smoke_fixture' : material.source_kind,
    source_policy: flags.smoke === true ? 'explicit_debug_only' : 'registered_local_material',
    repository,
    operator_id: operator.id,
    operator_name: operator.name,
    backend: operator.backend || 'triton',
    metric: flags.metric || operator.metricDefaults?.[0] || 'latency p50',
    hardware: operator.hardware || ['C500'],
    template_path: operator.template_path,
    material,
    user_visible_source_path: false,
    reason: flags.smoke === true
      ? 'Explicit smoke mode selected the registered vector_add fixture.'
      : 'Local registered material resolved the operator.',
    created_at: nowIso(),
  };
};

const materializeMissionWorkspace = async ({ discovery }) => {
  const workspaceRoot = path.join(currentMissionDir, 'workspace');
  const repositoryRoot = path.join(workspaceRoot, 'repository');
  const operatorRoot = path.join(workspaceRoot, 'operator');
  await mkdir(workspaceRoot, { recursive: true });
  if (discovery.material) {
    const materialized = await materializeOperatorMaterial({ material: { ...discovery.material, source_kind: discovery.source_kind, operator_id: discovery.operator_id }, workspaceRoot, operatorDir: operatorRoot });
    if (materialized.status !== 'validated') {
      const error = new Error(`operator materialization blocked: ${materialized.reason}`);
      error.code = 'MATERIALIZATION_NEEDS_HUMAN';
      throw error;
    }
    await cp(operatorRoot, repositoryRoot, { recursive: true, force: true });
  } else {
    await cp(discovery.template_path, repositoryRoot, { recursive: true, force: true });
    await cp(discovery.template_path, operatorRoot, { recursive: true, force: true });
  }
  return {
    root: currentMissionDir,
    workspace_root: workspaceRoot,
    repository: repositoryRoot,
    operator: operatorRoot,
    isolation: 'current-mission-managed',
    source_visibility: 'internal',
  };
};

const materializeBaseline = ({ missionId, discovery }) => ({
  mission_id: missionId,
  status: 'missing',
  source: discovery.source_kind === 'authoritative_library'
    ? 'authoritative_library_reference'
    : discovery.source_kind === 'explicit_smoke_fixture'
      ? 'explicit_smoke_fixture_reference'
      : 'registered_local_material_reference',
  measured_before_candidate: true,
  completed_before_first_candidate: false,
  backend: discovery.backend,
  operator_id: discovery.operator_id,
  metric: discovery.metric,
  created_at: nowIso(),
});

const materializeCandidate = ({ missionId, discovery, workspace }) => ({
  mission_id: missionId,
  candidate_id: 'candidate-001',
  source: 'agent_materialized_candidate',
  operator_id: discovery.operator_id,
  workspace: workspace.operator,
  created_at: nowIso(),
});

const archiveCurrentMission = async () => {
  const missionFile = path.join(currentMissionDir, 'mission.json');
  if (!existsSync(missionFile)) return null;
  const mission = await readJson(missionFile);
  const archiveDir = path.join(archiveRoot, safeName(mission.mission_id || mission.id || Date.now()));
  if (existsSync(archiveDir)) await rm(archiveDir, { recursive: true, force: true });
  await mkdir(archiveRoot, { recursive: true });
  await cp(currentMissionDir, archiveDir, { recursive: true, force: true });
  await rm(currentMissionDir, { recursive: true, force: true });
  return archiveDir;
};

const latestMissionId = async () => {
  const missionsDir = path.join(homeDir, 'missions');
  if (!existsSync(missionsDir)) return null;
  const entries = await readdir(missionsDir);
  let latest = null;
  for (const id of entries) {
    const missionFile = path.join(missionsDir, id, 'mission.json');
    if (!existsSync(missionFile)) continue;
    const info = await stat(missionFile);
    if (!latest || info.mtimeMs > latest.mtimeMs) latest = { id, mtimeMs: info.mtimeMs };
  }
  return latest?.id || null;
};

const getMissionId = async (flags) => {
  const id = flags.mission || flags.id || await latestMissionId();
  if (!id) throw new Error('mission is required');
  return id;
};

const commandExists = (command) => {
  const result = spawnSync(process.platform === 'win32' ? 'where.exe' : 'which', [command], { encoding: 'utf8' });
  return result.status === 0;
};

const pythonProbe = (code) => {
  const result = spawnSync('python', ['-c', code], { encoding: 'utf8' });
  if (result.status !== 0) return null;
  return result.stdout.trim() || null;
};

const statusFor = (actual, expected, required = true) => {
  if (!actual) return required ? 'missing' : 'missing_optional';
  return actual === expected ? 'ok' : 'warn';
};

const buildEnvironment = ({ mock = false } = {}) => {
  if (mock) {
    return {
      expected: expectedEnvironment,
      actual: { ...expectedEnvironment, c500_device: 'MetaX C500', torch_cuda: true },
      checks: Object.fromEntries(Object.entries(expectedEnvironment).map(([key, value]) => [key, { status: 'ok', expected: value, actual: value }])),
      tools: {
        mxSmi: { status: 'ok', command: 'mx-smi' },
        mctracer: { status: 'ok', command: 'mctracer' },
        mcProfiler: { status: 'ok', command: 'mcProfiler' },
      },
    };
  }
  const actual = {
    python: pythonProbe('import platform; print(platform.python_version())'),
    torch: pythonProbe('import torch; print(torch.__version__)'),
    triton: pythonProbe('import triton; print(triton.__version__)'),
    vllm: pythonProbe('import vllm; print(vllm.__version__)'),
    vllm_metax: pythonProbe('import vllm_metax; print(getattr(vllm_metax, "__version__", "unknown"))'),
    maca: process.env.MACA_VERSION || null,
    torch_cuda: pythonProbe('import torch; print(torch.cuda.is_available())') === 'True',
  };
  return {
    expected: expectedEnvironment,
    actual,
    checks: {
      python: { status: statusFor(actual.python, expectedEnvironment.python), expected: expectedEnvironment.python, actual: actual.python },
      torch: { status: statusFor(actual.torch, expectedEnvironment.torch), expected: expectedEnvironment.torch, actual: actual.torch },
      triton: { status: statusFor(actual.triton, expectedEnvironment.triton, false), expected: expectedEnvironment.triton, actual: actual.triton },
      vllm: { status: statusFor(actual.vllm, expectedEnvironment.vllm, false), expected: expectedEnvironment.vllm, actual: actual.vllm },
      vllm_metax: { status: statusFor(actual.vllm_metax, expectedEnvironment.vllm_metax, false), expected: expectedEnvironment.vllm_metax, actual: actual.vllm_metax },
      maca: { status: statusFor(actual.maca, expectedEnvironment.maca), expected: expectedEnvironment.maca, actual: actual.maca },
      c500: { status: actual.torch_cuda ? 'ok' : 'missing', expected: 'visible', actual: actual.torch_cuda ? 'visible' : 'not visible' },
    },
    tools: {
      mxSmi: { status: commandExists('mx-smi') ? 'ok' : 'missing', command: 'mx-smi' },
      mctracer: { status: commandExists('mctracer') ? 'ok' : 'missing', command: 'mctracer' },
      mcProfiler: { status: commandExists('mcProfiler') ? 'ok' : 'missing', command: 'mcProfiler' },
    },
  };
};

const doctorStatus = (environment) => {
  if (['python', 'torch', 'maca', 'c500'].some((key) => ['missing', 'missing_optional'].includes(environment.checks[key]?.status))) return 'blocked';
  if (Object.values(environment.checks).some((item) => item.status === 'warn') || Object.values(environment.tools).some((item) => item.status !== 'ok')) return 'partial';
  return 'ready';
};

const printJsonOrText = (body, flags, text) => {
  process.stdout.write(`${flags.json ? JSON.stringify(body, null, 2) : text || JSON.stringify(body, null, 2)}\n`);
};

const createMissionRecord = async (flags) => {
  await ensureHome();
  const id = createMissionId();
  const environment = buildEnvironment({ mock: Boolean(flags.mock) });
  const budget = {
    time_limit_ms: parseBudgetMs(flags['time-budget']),
    token_limit: flags['token-budget'] ? Number(flags['token-budget']) : null,
    tokens_used: 0,
    round_limit: flags['round-budget'] ? Number(flags['round-budget']) : null,
    stop_policy: 'budget_or_completed',
  };
  const mission = {
    mission_id: id,
    name: flags.name || flags.operator || 'local_c500_mission',
    operator: flags.operator || 'unknown_operator',
    backend: flags.backend || 'triton',
    platform: 'local-c500',
    operator_path: flags['operator-path'] ? path.resolve(flags['operator-path']) : null,
    status: 'created',
    stage: 'mission_created',
    completed: false,
    started_at: nowIso(),
    completed_at: null,
    elapsed_ms: 0,
    budget,
    environment,
    current_best: null,
    runner: null,
    recent_events: [{ time: nowIso(), message: 'Mission published from TUI/CLI' }],
  };
  const dir = missionDirFor(id);
  await writeJson(path.join(dir, 'mission.json'), mission);
  await writeJson(path.join(dir, 'environment.json'), environment);
  await writeJson(path.join(dir, 'summary.json'), {
    mission_id: id,
    status: 'created',
    mission_completed: false,
    stage: mission.stage,
    budget,
    current_best: null,
    agent_context: { policy: 'summary_only', allowed_files: ['summary.json'] },
  });
  return { id, dir, mission };
};

const createMission = async (flags) => {
  const { id, dir } = await createMissionRecord(flags);
  if (flags['operator-path']) {
    await runMission({ ...flags, mission: id });
    return;
  }
  printJsonOrText({ status: 'created', mission_id: id, mission_dir: dir }, flags, `created mission ${id}`);
};

const markMissionRunning = async ({ missionId, runner }) => {
  const dir = missionDirFor(missionId);
  const missionFile = path.join(dir, 'mission.json');
  const mission = await readJson(missionFile);
  mission.status = 'running';
  mission.stage = 'runner_started';
  mission.runner = runner;
  mission.recent_events = [{ time: nowIso(), message: `Background runner started pid=${runner.pid}` }, ...(mission.recent_events || [])].slice(0, 20);
  await writeJson(missionFile, mission);
  const summaryFile = path.join(dir, 'summary.json');
  const summary = existsSync(summaryFile) ? await readJson(summaryFile) : { mission_id: missionId };
  summary.status = 'running';
  summary.mission_completed = false;
  summary.stage = 'runner_started';
  summary.repository = mission.repository;
  summary.agent = mission.agent;
  summary.baseline = mission.baseline;
  summary.candidate_evaluations = mission.candidateEvaluations || [];
  summary.backend = mission.backend;
  summary.platform = mission.platform;
  summary.hardware = mission.hardware;
  summary.budget = mission.budget;
  summary.runner = runner;
  summary.current_best = mission.current_best || null;
  summary.agent_context = { policy: 'summary_only', allowed_files: ['summary.json'] };
  await writeJson(summaryFile, summary);
  return { mission, summary };
};

const startBackgroundRunner = async ({ missionId, operatorPath, flags, command = 'run' }) => {
  const dir = missionDirFor(missionId);
  const logsDir = path.join(dir, 'runner');
  await mkdir(logsDir, { recursive: true });
  const args = [
    fileURLToPath(import.meta.url),
    'mission',
    command,
    '--mission',
    missionId,
    '--operator-path',
    operatorPath,
    '--json',
  ];
  if (flags.mock) args.push('--mock');
  if (flags.smoke) args.push('--smoke');
  const stdoutPath = path.join(logsDir, 'stdout.log');
  const stderrPath = path.join(logsDir, 'stderr.log');
  await writeFile(stdoutPath, '', 'utf8');
  await writeFile(stderrPath, '', 'utf8');
  const child = spawn(process.execPath, args, {
    cwd: rootDir,
    detached: true,
    stdio: 'ignore',
    env: {
      ...process.env,
      LOCAL_C500_TESTER_HOME: homeDir,
      FORCE_COLOR: '0',
    },
  });
  child.unref();
  const runner = {
    pid: child.pid,
    mode: 'background',
    started_at: nowIso(),
    command: `${process.execPath} ${args.map((item) => (String(item).includes(' ') ? `"${item}"` : item)).join(' ')}`,
    stdout_file: stdoutPath,
    stderr_file: stderrPath,
  };
  await writeJson(path.join(logsDir, 'runner.json'), runner);
  await markMissionRunning({ missionId, runner });
  return runner;
};

const createMissionFromPanel = async (flags) => {
  if (!flags['operator-path']) throw new Error('operator path is required');
  const { id, dir } = await createMissionRecord(flags);
  const runner = await startBackgroundRunner({ missionId: id, operatorPath: path.resolve(flags['operator-path']), flags });
  printJsonOrText(
    { status: 'running', background: true, mission_id: id, mission_dir: dir, runner },
    flags,
    `created mission ${id}; background runner pid=${runner.pid}`,
  );
};

const publishMission = async (flags) => {
  await ensureHome();
  const archived = await archiveCurrentMission();
  const id = createMissionId();
  const repository = String(flags.repository || 'local-c500-demo').trim();
  const goal = String(flags.goal || `Run local C500 validation for ${repository}`).trim();
  const title = String(flags.title || flags.name || goal.slice(0, 42) || 'Local C500 mission').trim();
  const environment = buildEnvironment({ mock: Boolean(flags.mock) });
  const budget = {
    time_limit_ms: parseBudgetMs(flags['time-budget']),
    token_limit: flags['token-budget'] ? Number(flags['token-budget']) : null,
    tokens_used: 0,
    round_limit: flags['round-budget'] ? Number(flags['round-budget']) : null,
    stop_policy: 'budget_or_completed',
  };
  const researchRounds = flags['research-rounds'] ? Number(flags['research-rounds']) : 0;
  const maxResearch = flags['max-research'] ? Number(flags['max-research']) : DEFAULT_MAX_RESEARCH;
  await mkdir(currentMissionDir, { recursive: true });
  const discovery = await runAgentDiscovery({ missionId: id, goal, repository, flags });
  if (discovery.status === 'needs_human') {
    const mission = {
      mission_id: id,
      id,
      title,
      name: title,
      goal,
      projectId: repository,
      repository,
      backend: discovery.backend,
      metric: discovery.metric,
      hardware: discovery.hardware,
      platform: 'local-c500',
      status: 'needs_human',
      stage: 'discovery',
      client_stage: 'diagnosis',
      completed: false,
      started_at: nowIso(),
      completed_at: null,
      elapsed_ms: 0,
      budget,
      environment,
      agent: {
        resolved_by: discovery.resolved_by,
        source_kind: discovery.source_kind,
        operator_id: discovery.operator_id,
        reason: discovery.reason,
        phase: 'needs_human',
        context_policy: 'summary_only',
      },
      iterationStats: {
        round: 0,
        consecutiveNoAdopt: 0,
        researchRounds,
        maxResearch,
        researchExhausted: researchRounds >= maxResearch,
        maxResearchStopsMainLoop: false,
        loopStatus: 'needs_human',
        loopStatusReason: discovery.reason,
        loopStartedAt: nowIso(),
      },
      workflowRecovery: { can_resume: false, current_dir: currentMissionDir, archive_root: archiveRoot },
      current_best: null,
      runner: null,
      recent_events: [
        { time: nowIso(), message: `Mission needs human: ${discovery.reason}` },
        ...(archived ? [{ time: nowIso(), message: `Previous mission archived: ${path.basename(archived)}` }] : []),
      ],
    };
    await writeJson(path.join(currentMissionDir, 'agent_discovery.json'), discovery);
    await writeJson(path.join(currentMissionDir, 'mission.json'), mission);
    await writeJson(path.join(currentMissionDir, 'environment.json'), environment);
    await writeJson(path.join(currentMissionDir, 'summary.json'), {
      mission_id: id,
      id,
      title,
      goal,
      repository,
      projectId: repository,
      backend: mission.backend,
      metric: mission.metric,
      hardware: mission.hardware,
      status: mission.status,
      mission_completed: false,
      stop_reason: discovery.reason,
      stage: mission.stage,
      client_stage: mission.client_stage,
      budget,
      agent: mission.agent,
      discovery,
      current_best: null,
      iteration: mission.iterationStats,
      context_policy: 'summary_only',
      agent_context: { policy: 'summary_only', allowed_files: ['summary.json'] },
    });
    printJsonOrText(
      { status: 'needs_human', background: false, mission_id: id, mission_dir: currentMissionDir, archived, reason: discovery.reason },
      flags,
      `mission needs human: ${id} (${discovery.reason})`,
    );
    return;
  }
  const workspace = await materializeMissionWorkspace({ discovery });
  const baseline = materializeBaseline({ missionId: id, discovery });
  const candidate = materializeCandidate({ missionId: id, discovery, workspace });
  const candidateEvaluation = {
    candidate_id: candidate.candidate_id,
    status: 'scheduled',
    source: candidate.source,
    platform: 'local-c500',
    metric: discovery.metric,
    baseline_measured: baseline.measured_before_candidate,
    created_at: nowIso(),
  };
  await writeJson(path.join(currentMissionDir, 'agent_discovery.json'), discovery);
  await writeJson(path.join(currentMissionDir, 'baseline.json'), baseline);
  await writeJson(path.join(currentMissionDir, 'candidate.json'), candidate);
  const mission = {
    mission_id: id,
    id,
    title,
    name: title,
    goal,
    projectId: repository,
    repository,
    backend: discovery.backend,
    metric: discovery.metric,
    hardware: discovery.hardware,
    platform: 'local-c500',
    status: 'published',
    stage: 'local_preflight',
    client_stage: 'diagnosis',
    completed: false,
    started_at: nowIso(),
    completed_at: null,
    elapsed_ms: 0,
    budget,
    environment,
    workspace,
    agent: {
      resolved_by: discovery.resolved_by,
      source_kind: discovery.source_kind,
      operator_id: discovery.operator_id,
      phase: 'materialized_candidate',
      context_policy: 'summary_only',
    },
    testMatrix: {
      platforms: ['local-c500'],
      hardware: discovery.hardware,
      tests: ['correctness', 'benchmark', 'tracer', 'profiler'],
      local_runner: true,
    },
    iterationStats: {
      round: 0,
      consecutiveNoAdopt: 0,
      researchRounds,
      maxResearch,
      researchExhausted: researchRounds >= maxResearch,
      maxResearchStopsMainLoop: false,
      loopStatus: 'running',
      loopStatusReason: null,
      loopStartedAt: nowIso(),
    },
    baseline,
    candidates: [candidate],
    candidateEvaluations: [candidateEvaluation],
    failureRecords: [],
    workflowRecovery: { can_resume: true, current_dir: currentMissionDir, archive_root: archiveRoot },
    current_best: null,
    runner: null,
    recent_events: [
      { time: nowIso(), message: `Mission published: ${title}` },
      { time: nowIso(), message: `Agent resolved source for repository=${repository}` },
      { time: nowIso(), message: `Baseline scheduled before candidate on local C500` },
      ...(researchRounds >= maxResearch ? [{ time: nowIso(), message: `Research escalation exhausted at ${researchRounds}; main loop will continue` }] : []),
      ...(archived ? [{ time: nowIso(), message: `Previous mission archived: ${path.basename(archived)}` }] : []),
    ],
  };
  await writeJson(path.join(currentMissionDir, 'mission.json'), mission);
  await writeJson(path.join(currentMissionDir, 'environment.json'), environment);
  await writeJson(path.join(currentMissionDir, 'summary.json'), {
    mission_id: id,
    id,
    title,
    goal,
    repository,
    projectId: repository,
    backend: mission.backend,
    metric: mission.metric,
    hardware: mission.hardware,
    status: 'published',
    mission_completed: false,
    stage: mission.stage,
    client_stage: mission.client_stage,
    budget,
    agent: mission.agent,
    baseline,
    candidate_evaluations: mission.candidateEvaluations,
    iteration: mission.iterationStats,
    current_best: null,
    workspace: mission.workspace,
    context_policy: 'summary_only',
    agent_context: { policy: 'summary_only', allowed_files: ['summary.json'] },
  });
  const runner = await startBackgroundRunner({ missionId: 'current', operatorPath: workspace.operator, flags, command: 'loop' });
  printJsonOrText(
    { status: 'running', background: true, mission_id: id, mission_dir: currentMissionDir, runner, archived },
    flags,
    `published mission ${id}; background runner pid=${runner.pid}`,
  );
};

const addNote = async (flags) => {
  const missionId = await getMissionId(flags);
  const text = flags.text || '';
  if (!text.trim()) throw new Error('note text is required');
  const dir = missionDirFor(missionId);
  const note = { time: nowIso(), text };
  await appendFile(path.join(dir, 'human_notes.jsonl'), `${JSON.stringify(note)}\n`, 'utf8');
  const mission = await readJson(path.join(dir, 'mission.json'));
  mission.recent_events = [{ time: note.time, message: `Human note: ${text}` }, ...(mission.recent_events || [])].slice(0, 20);
  await writeJson(path.join(dir, 'mission.json'), mission);
  printJsonOrText({ status: 'noted', mission_id: missionId }, flags, `noted: ${text}`);
};

const updateMissionControl = async (flags, action) => {
  const missionId = await getMissionId(flags);
  const dir = missionDirFor(missionId);
  const missionFile = path.join(dir, 'mission.json');
  const mission = await readJson(missionFile);
  const nextStatus = action === 'pause' ? 'paused' : action === 'resume' ? 'running' : 'stopped';
  const stopReason = action === 'pause' ? 'paused_by_user' : action === 'resume' ? null : 'stopped_by_user';
  mission.status = nextStatus;
  mission.stage = action === 'resume' ? 'running' : nextStatus;
  mission.completed = false;
  mission.completed_at = action === 'stop' ? nowIso() : mission.completed_at;
  mission.recent_events = [{ time: nowIso(), message: `Mission ${nextStatus} by user` }, ...(mission.recent_events || [])].slice(0, 20);
  await writeJson(missionFile, mission);
  const summaryFile = path.join(dir, 'summary.json');
  const summary = existsSync(summaryFile) ? await readJson(summaryFile) : { mission_id: missionId };
  summary.status = nextStatus;
  summary.mission_completed = false;
  summary.stage = mission.stage;
  summary.stop_reason = stopReason;
  summary.budget = mission.budget;
  summary.current_best = mission.current_best || summary.current_best || null;
  summary.agent_context = { policy: 'summary_only', allowed_files: ['summary.json'] };
  await writeJson(summaryFile, summary);
  printJsonOrText({ status: nextStatus, mission_id: missionId }, flags, `mission ${nextStatus}: ${missionId}`);
};

const generateTestCases = (mission) => ({
  operator: mission.operator || mission.agent?.operator_id || mission.agent?.operator || 'agent_resolved_operator',
  backend: mission.backend,
  generated_by: 'local-c500-tester',
  seed: 20260824,
  cases: [{
    name: 'small_decode_or_default',
    batch: 1,
    num_heads: 4,
    seq_len: 128,
    head_dim: 1024,
    dtype: 'float16',
    rtol: 0.001,
    atol: 0.001,
  }],
});

const runAdapterTask = async ({ dir, mission, operatorPath, flags, purpose, round = 0, candidateDigest = null }) => {
  const environment = buildEnvironment({ mock: Boolean(flags.mock) });
  const testCases = generateTestCases(mission);
  const adapter = createLocalC500Adapter({ missionDir: dir, mock: Boolean(flags.mock), environment });
  const task = await adapter.submitTest({
    purpose,
    candidateArtifact: {
      digest: candidateDigest || `sha256:local-c500-${purpose}-${mission.mission_id}-${round || 'baseline'}`,
      path: path.resolve(operatorPath),
    },
    matrix: {
      shapeKey: testCases.cases[0].name,
      cases: testCases.cases,
      dtype: testCases.cases[0].dtype,
      backend: mission.backend,
      hardware: mission.hardware,
    },
    stages: ['correctness', 'benchmark', 'tracer', 'profiler'],
    round,
    baselineLatency: mission.baseline?.latency_p50_us || null,
  });
  const completed = await adapter.pollTest(task.taskId);
  return { task: completed, result: completed.result, environment };
};

const analysisFromAdapterResult = (result) => ({
  runs: {
    mctracer: result?.tracer || null,
    mcProfiler: result?.profiler || null,
  },
  artifacts: {
    mctracer: result?.tracer || null,
    mcProfiler: result?.profiler || null,
  },
});

const copyOperator = async (source, target) => {
  try {
    await mkdir(target, { recursive: true });
    await cp(source, target, { recursive: true, force: true });
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') {
      const cause = error.code;
      error.code = 'OPERATOR_SOURCE_UNAVAILABLE';
      error.category = 'configuration';
      error.retryable = false;
      error.details = { source, target, cause };
    }
    throw error;
  }
};

const runHarness = (operatorPath, flags, context = {}) => {
  if (flags.mock) {
    if (context.purpose === 'baseline') {
      return {
        status: 'completed',
        correctness: 'pass',
        correctness_detail: { passed: true, reference_only: true },
        latency_p50_us: 356.2615,
        latency_p95_us: 372.4,
        warmup: 50,
        repeats: 200,
        mctracer: 'not_run',
        mcProfiler: 'not_run',
      };
    }
    const loopLatencies = [160.0, 120.5, 100.0, 99.5, 99.2];
    const latency = context.loop ? loopLatencies[Math.min(Math.max(Number(context.round || 1) - 1, 0), loopLatencies.length - 1)] : 120.5;
    const baselineLatency = Number(context.baselineLatency || 356.2615);
    return {
      status: 'completed',
      correctness: 'pass',
      correctness_detail: { passed: true, max_abs_diff: 0 },
      latency_p50_us: latency,
      latency_p95_us: latency * 1.1,
      baseline_latency_p50_us: baselineLatency,
      speedup: baselineLatency / latency,
      warmup: 50,
      repeats: 200,
      mctracer: 'generated',
      mcProfiler: 'generated',
    };
  }
  const args = [path.join(testerDir, 'harness.py'), '--operator-path', operatorPath];
  if (context.purpose === 'baseline') args.push('--mode', 'reference');
  const result = spawnSync('python', args, { encoding: 'utf8' });
  if (result.status !== 0) return { status: 'failed', error: result.stderr || result.stdout || 'harness failed' };
  return JSON.parse(result.stdout);
};

const quoteForShell = (value) => {
  const text = String(value);
  if (process.platform === 'win32') return `"${text.replaceAll('"', '\\"')}"`;
  return `'${text.replaceAll("'", "'\\''")}'`;
};

const renderAnalysisCommand = (template, values) => Object.entries(values).reduce(
  (current, [key, value]) => current.replaceAll(`{${key}}`, quoteForShell(value)),
  template,
);

const runAnalysisTool = async ({ toolName, environment, operatorPath, roundDir }) => {
  const available = environment.tools?.[toolName]?.status === 'ok';
  const artifactDir = path.join(roundDir, 'analysis', toolName);
  await mkdir(artifactDir, { recursive: true });
  const stdoutFile = path.join(artifactDir, 'stdout.txt');
  const stderrFile = path.join(artifactDir, 'stderr.txt');
  const commandTemplate = process.env[`LOCAL_C500_TESTER_${toolName.toUpperCase()}_CMD`];
  if (!available && !commandTemplate) {
    return {
      status: 'missing',
      tool: toolName,
      artifact_dir: artifactDir,
      stdout_file: null,
      stderr_file: null,
      exit_code: null,
      elapsed_ms: 0,
      command: toolName,
    };
  }

  const harnessPath = path.join(testerDir, 'harness.py');
  const started = Date.now();
  const values = {
    operatorPath,
    roundDir,
    artifactDir,
    harness: harnessPath,
    python: 'python',
  };
  const command = commandTemplate
    ? renderAnalysisCommand(commandTemplate, values)
    : `${toolName} --output ${quoteForShell(artifactDir)} python ${quoteForShell(harnessPath)} --operator-path ${quoteForShell(operatorPath)} --warmup 5 --repeats 10`;
  const result = commandTemplate
    ? spawnSync(command, { encoding: 'utf8', shell: true, cwd: rootDir })
    : spawnSync(toolName, ['--output', artifactDir, 'python', harnessPath, '--operator-path', operatorPath, '--warmup', '5', '--repeats', '10'], {
      encoding: 'utf8',
      shell: process.platform === 'win32',
      cwd: rootDir,
    });
  await writeFile(stdoutFile, result.stdout || '', 'utf8');
  await writeFile(stderrFile, result.stderr || '', 'utf8');
  const status = result.status === 0 ? 'completed' : 'failed';
  return {
    status,
    tool: toolName,
    artifact_dir: artifactDir,
    stdout_file: stdoutFile,
    stderr_file: stderrFile,
    exit_code: result.status,
    elapsed_ms: Date.now() - started,
    command,
  };
};

const runAnalysisTools = async ({ result, environment, operatorPath, roundDir, flags }) => {
  if (flags.mock) {
    const mctracer = { status: 'generated', tool: 'mctracer', artifact_dir: path.join(roundDir, 'analysis', 'mctracer') };
    const mcProfiler = { status: 'generated', tool: 'mcProfiler', artifact_dir: path.join(roundDir, 'analysis', 'mcProfiler') };
    return { runs: { mctracer, mcProfiler }, artifacts: { mctracer, mcProfiler } };
  }
  if (result.status !== 'completed') {
    const mctracer = { status: 'skipped_harness_failed', tool: 'mctracer' };
    const mcProfiler = { status: 'skipped_harness_failed', tool: 'mcProfiler' };
    return { runs: { mctracer, mcProfiler }, artifacts: { mctracer, mcProfiler } };
  }
  const mctracer = await runAnalysisTool({ toolName: 'mctracer', environment, operatorPath, roundDir });
  const mcProfiler = await runAnalysisTool({ toolName: 'mcProfiler', environment, operatorPath, roundDir });
  return { runs: { mctracer, mcProfiler }, artifacts: { mctracer, mcProfiler } };
};

const terminalStatuses = new Set(['completed', 'budget_exhausted', 'needs_human', 'failed', 'stopped', 'paused']);

const workflowStateFor = async (dir) => {
  const file = path.join(dir, 'workflow_state.json');
  if (!existsSync(file)) return { status: 'running', stalled: false, events: [] };
  return readJson(file);
};

const writeWorkflowState = async (dir, mission, extra = {}) => {
  const previous = await workflowStateFor(dir);
  const state = {
    ...previous,
    mission_id: mission.mission_id,
    status: mission.status,
    stalled: false,
    baseline: mission.baseline || null,
    iteration: mission.iterationStats || {},
    current_best: mission.current_best || null,
    candidate_evaluations: mission.candidateEvaluations || [],
    updated_at: nowIso(),
    runner_pid: process.pid,
    ...extra,
    events: extra.events || previous.events || [],
  };
  await writeJson(path.join(dir, 'workflow_state.json'), state);
  return state;
};

const appendWorkflowEvent = async (dir, mission, type, payload = {}) => {
  const previous = await workflowStateFor(dir);
  const events = [
    ...(previous.events || []),
    { sequence: (previous.events || []).length + 1, time: nowIso(), type, payload },
  ].slice(-200);
  return writeWorkflowState(dir, mission, { events });
};

const writeLoopSummary = async ({ dir, mission, latestRound = null, analysis = null, stopReason = null }) => {
  const summary = {
    mission_id: mission.mission_id,
    status: mission.status,
    mission_completed: mission.completed,
    stop_reason: stopReason,
    stop_detail: mission.stopDetail || null,
    failure: mission.workflowFailure || null,
    repository: mission.repository,
    projectId: mission.projectId,
    agent: mission.agent,
    backend: mission.backend,
    platform: mission.platform,
    hardware: mission.hardware,
    stage: mission.stage,
    elapsed_ms: mission.elapsed_ms,
    tokens_used: mission.budget.tokens_used,
    budget: mission.budget,
    correctness: latestRound?.test_result?.correctness || null,
    baseline: mission.baseline,
    baseline_latency_p50_us: mission.baseline?.latency_p50_us || null,
    latency_p50_us: latestRound?.test_result?.latency_p50_us || null,
    speedup: latestRound?.test_result?.speedup || null,
    current_best: mission.current_best,
    candidate_evaluations: mission.candidateEvaluations || [],
    iteration: {
      ...(mission.iterationStats || {}),
      maxResearchStopsMainLoop: false,
    },
    test_tools: analysis?.runs || null,
    analysis_runs: analysis?.runs || null,
    analysis_artifacts: analysis?.artifacts || null,
    report_dir: latestRound?.report_dir || null,
    context_policy: 'summary_only',
    agent_context: { policy: 'summary_only', allowed_files: ['summary.json'] },
  };
  await writeJson(path.join(dir, 'summary.json'), summary);
  return summary;
};

const workflowFailureView = (error, phase) => {
  const normalized = normalizeWorkflowError(error, { phase, source: 'local-c500-workflow' });
  if (/TIMEOUT|TIMED_OUT|QUEUE_TIMEOUT|POLL_TIMEOUT/i.test(normalized.code)) {
    return serializeWorkflowError(normalizeWorkflowError({ ...error, code: 'TEST_QUEUE_TIMEOUT', message: error?.message }, { phase, source: 'local-c500-workflow', category: 'timeout' }));
  }
  return serializeWorkflowError(normalized);
};

const persistUnexpectedWorkflowStop = async ({ dir, mission, phase, error, latestRound = null, latestAnalysis = null }) => {
  const failure = workflowFailureView(error, phase);
  const reason = failure.code === 'TEST_QUEUE_TIMEOUT' ? 'test_queue_timeout' : 'workflow_error';
  mission.status = 'needs_human';
  mission.completed = false;
  mission.stage = 'needs_human';
  mission.client_stage = 'evidence';
  mission.completed_at = nowIso();
  mission.stopDetail = { reason, phase, failure };
  mission.workflowFailure = failure;
  mission.iterationStats = {
    ...(mission.iterationStats || {}),
    loopStatus: 'needs_human',
    loopStatusReason: reason,
    loopStoppedAt: mission.completed_at,
  };
  mission.recent_events = [
    { time: mission.completed_at, message: `Workflow stopped at ${phase}: ${reason} (${failure.code})` },
    ...(mission.recent_events || []),
  ].slice(0, 20);
  await writeJson(path.join(dir, 'mission.json'), mission);
  await appendWorkflowEvent(dir, mission, 'loop_interrupted', { reason, phase, failure });
  const summary = await writeLoopSummary({ dir, mission, latestRound, analysis: latestAnalysis, stopReason: reason });
  await writeWorkflowState(dir, mission, {
    status: 'needs_human',
    stalled: true,
    stop_reason: reason,
    stop_detail: mission.stopDetail,
    failure,
    recovery: { required: true, resumable: true, command: `mission loop --mission ${mission.mission_id}` },
  });
  return { failure, summary, reason };
};

const ensureBaselineMeasured = async ({ dir, mission, operatorPath, flags }) => {
  if (mission.baseline?.status === 'complete' && Number.isFinite(Number(mission.baseline.latency_p50_us))) return mission.baseline;
  mission.stage = 'baseline';
  mission.client_stage = 'diagnosis';
  mission.baseline = {
    ...(mission.baseline || {}),
    status: 'running',
    measured_before_candidate: true,
    completed_before_first_candidate: false,
    started_at: nowIso(),
  };
  mission.recent_events = [{ time: nowIso(), message: 'Baseline started before candidate loop' }, ...(mission.recent_events || [])].slice(0, 20);
  await writeJson(path.join(dir, 'mission.json'), mission);
  await appendWorkflowEvent(dir, mission, 'baseline_started', { source: mission.baseline.source || null });
  await writeLoopSummary({ dir, mission });

  const adapterRun = await runAdapterTask({ dir, mission, operatorPath, flags, purpose: 'baseline' });
  const result = adapterRun.result || { status: 'failed', error: adapterRun.task.error?.message || 'baseline adapter task failed' };
  await writeJson(path.join(dir, 'baseline_result.json'), result);
  const latency = Number(result.latency_p50_us);
  mission.baseline = {
    ...(mission.baseline || {}),
    status: result.status === 'completed' && Number.isFinite(latency) ? 'complete' : 'failed',
    latency_p50_us: Number.isFinite(latency) ? latency : null,
    measured_before_candidate: true,
    completed_before_first_candidate: true,
    completed_at: nowIso(),
    evidence: Number.isFinite(latency) ? { environment: mission.platform, value: latency, unit: 'us', shapeKey: 'small_decode_or_default' } : null,
  };
  await writeJson(path.join(dir, 'baseline.json'), mission.baseline);
  mission.recent_events = [{ time: nowIso(), message: `Baseline ${mission.baseline.status}: ${mission.baseline.latency_p50_us ?? '--'} us` }, ...(mission.recent_events || [])].slice(0, 20);
  await writeJson(path.join(dir, 'mission.json'), mission);
  await appendWorkflowEvent(dir, mission, 'baseline_completed', { status: mission.baseline.status, latency_p50_us: mission.baseline.latency_p50_us });
  await writeLoopSummary({ dir, mission });
  return mission.baseline;
};

const executeCandidateRound = async ({ dir, mission, operatorPath, flags }) => {
  const started = Date.now();
  const round = Number(mission.rounds_completed || 0) + 1;
  const candidateId = `candidate-${String(round).padStart(3, '0')}`;
  const roundDir = path.join(dir, 'reports', `round-${String(round).padStart(3, '0')}`);
  const snapshotDir = path.join(dir, 'operator_snapshot');
  const resolvedOperator = path.resolve(operatorPath);
  mission.stage = 'candidate';
  mission.client_stage = 'validation';
  mission.status = 'running';
  mission.agent = { ...(mission.agent || {}), phase: `candidate_round_${round}` };
  await writeJson(path.join(dir, 'mission.json'), mission);
  await appendWorkflowEvent(dir, mission, 'candidate_round_started', { round, candidate_id: candidateId });

  const smokeAgent = flags.smoke === true ? {
    run: async ({ workspaceRoot }) => {
      const entryPath = path.join(workspaceRoot, 'run.py');
      const source = await readFile(entryPath, 'utf8');
      const marker = `# local-c500 explicit smoke candidate round ${round}`;
      if (source.includes(marker)) return { status: 'no_candidate', reason: 'smoke_candidate_already_applied' };
      await writeFile(entryPath, `${source.trimEnd()}\n${marker}\n`, 'utf8');
      return { status: 'candidate_ready', source: 'explicit_smoke_agent', hypothesis: 'explicit smoke candidate mutation', changedFiles: ['run.py'] };
    },
  } : {};
  const generated = await generateMissionCandidate({
    mission,
    workspaceRoot: resolvedOperator,
    checkpointRoot: path.join(dir, 'checkpoints', `round-${String(round).padStart(3, '0')}`),
    baseline: mission.baseline,
    failureRecords: mission.failureRecords || [],
    currentBest: mission.current_best,
    previousDigests: (mission.candidateEvaluations || []).map((item) => item.candidate_digest || item.patchDigest).filter(Boolean),
    agent: smokeAgent,
  });
  if (generated.status !== 'candidate_ready' || !generated.admission?.admitted) {
    const roundRecord = {
      round,
      candidate_id: candidateId,
      status: 'no_candidate',
      started_at: new Date(started).toISOString(),
      completed_at: nowIso(),
      elapsed_ms: Date.now() - started,
      tokens_used: 0,
      candidate_digest: generated.admission?.manifest?.digest || null,
      decision: { accepted: false, result: 'no_candidate', reason: generated.admission?.reason || generated.reason || 'candidate_agent_unavailable' },
      report_dir: roundDir,
    };
    await mkdir(roundDir, { recursive: true });
    await appendFile(path.join(dir, 'rounds.jsonl'), `${JSON.stringify(roundRecord)}\n`, 'utf8');
    mission.status = 'needs_human';
    mission.stage = 'needs_human';
    mission.client_stage = 'diagnosis';
    mission.rounds_completed = round;
    mission.iterationStats = { ...(mission.iterationStats || {}), round, loopStatus: 'needs_human', loopStatusReason: roundRecord.decision.reason };
    mission.candidateEvaluations = [
      ...(mission.candidateEvaluations || []).filter((item) => item.status !== 'scheduled'),
      { candidate_id: candidateId, status: 'no_candidate', candidate_digest: roundRecord.candidate_digest, decision: roundRecord.decision },
    ];
    mission.recent_events = [{ time: nowIso(), message: `Round ${round} stopped: ${roundRecord.decision.reason}` }, ...(mission.recent_events || [])].slice(0, 20);
    await writeJson(path.join(dir, 'mission.json'), mission);
    await appendWorkflowEvent(dir, mission, 'candidate_not_generated', { round, reason: roundRecord.decision.reason });
    await writeLoopSummary({ dir, mission, latestRound: roundRecord });
    return { roundRecord, analysis: null };
  }

  await copyOperator(resolvedOperator, snapshotDir);
  await copyOperator(resolvedOperator, path.join(roundDir, 'operator_snapshot'));
  const environment = buildEnvironment({ mock: Boolean(flags.mock) });
  const testCases = generateTestCases(mission);
  await writeJson(path.join(dir, 'test_cases.json'), testCases);
  await writeJson(path.join(roundDir, 'test_cases.json'), testCases);
  await writeJson(path.join(roundDir, 'environment.json'), environment);

  const adapterRun = await runAdapterTask({ dir, mission, operatorPath: resolvedOperator, flags, purpose: 'candidate', round, candidateDigest: generated.admission.manifest.digest });
  const result = adapterRun.result || { status: 'failed', error: adapterRun.task.error?.message || 'candidate adapter task failed' };
  const analysis = analysisFromAdapterResult(result);
  result.analysis_runs = analysis.runs;
  result.analysis_artifacts = analysis.artifacts;
  const elapsedMs = Date.now() - started;
  const tokensUsed = flags.mock ? 12_000 + round * 111 : Number(flags['tokens-used'] || 0);
  const baseline = Number(result.baseline_latency_p50_us || mission.baseline?.latency_p50_us);
  const latency = Number(result.latency_p50_us);
  const speedup = result.speedup || (Number.isFinite(baseline) && Number.isFinite(latency) ? baseline / latency : null);
  const gate = evaluateLocalAcceptGate({
    baseline: { ...(mission.baseline || {}), shapeKey: mission.baseline?.evidence?.shapeKey || 'small_decode_or_default', runner: 'local-c500' },
    candidate: { id: candidateId, digest: result.candidate?.digest },
    result,
    currentBest: mission.current_best,
  });
  const accepted = gate.result === 'adopt';
  const bestEligible = gate.passed;
  const adoption = accepted && mission.workspace?.repository
    ? await adoptCandidatePatch({ candidateRoot: resolvedOperator, iterationRepository: mission.workspace.repository, gate, candidate: { id: candidateId, digest: result.candidate?.digest } })
    : { adopted: false, reason: gate.result === 'reference' ? 'simulation_only' : 'gate_rejected' };
  const experience = await recordCandidateExperience({
    missionDir: dir,
    candidate: { id: candidateId, digest: result.candidate?.digest },
    gate,
    result,
    failure: gate.result === 'reject' ? gate.failedRules : null,
  });
  const toolStatus = {
    mctracer: result.mctracer || analysis.runs.mctracer?.status || (environment.tools.mctracer.status === 'ok' ? 'available' : 'missing'),
    mcProfiler: result.mcProfiler || analysis.runs.mcProfiler?.status || (environment.tools.mcProfiler.status === 'ok' ? 'available' : 'missing'),
  };
  const roundRecord = {
    round,
    candidate_id: candidateId,
    status: result.status === 'completed' ? 'completed' : 'failed',
    started_at: new Date(started).toISOString(),
    completed_at: nowIso(),
    elapsed_ms: elapsedMs,
    tokens_used: tokensUsed,
    candidate_digest: generated.admission.manifest.digest,
    changed_files: generated.admission.manifest.changedFiles,
    baseline: {
      status: mission.baseline?.status,
      latency_p50_us: mission.baseline?.latency_p50_us,
      measured_before_candidate: mission.baseline?.measured_before_candidate === true,
      completed_before_first_candidate: mission.baseline?.completed_before_first_candidate === true,
    },
    test_result: {
      correctness: result.correctness || 'fail',
      latency_p50_us: Number.isFinite(latency) ? latency : null,
      latency_p95_us: result.latency_p95_us || null,
      speedup,
      mctracer: toolStatus.mctracer,
      mcProfiler: toolStatus.mcProfiler,
    },
    analysis_runs: analysis.runs,
    analysis_artifacts: analysis.artifacts,
    accept_gate: gate,
    adoption,
    experience,
    decision: { accepted, result: gate.result, reason: accepted ? 'Accept Gate passed' : gate.summary || result.error || 'not better than current best' },
    report_dir: roundDir,
  };
  await appendFile(path.join(dir, 'rounds.jsonl'), `${JSON.stringify(roundRecord)}\n`, 'utf8');
  await writeJson(path.join(roundDir, 'result.json'), result);

  mission.elapsed_ms = (mission.elapsed_ms || 0) + elapsedMs;
  mission.rounds_completed = round;
  mission.budget.tokens_used = Number(mission.budget.tokens_used || 0) + tokensUsed;
  mission.iterationStats = {
    ...(mission.iterationStats || {}),
    round,
    lastCountedRunId: candidateId,
    lastRoundOutcome: accepted ? 'adopted' : bestEligible ? 'simulation_reference' : roundRecord.status,
    consecutiveNoAdopt: accepted ? 0 : Number(mission.iterationStats?.consecutiveNoAdopt || 0) + 1,
    researchExhausted: Number(mission.iterationStats?.researchRounds || 0) >= Number(mission.iterationStats?.maxResearch || DEFAULT_MAX_RESEARCH),
    maxResearchStopsMainLoop: false,
    loopStatus: 'running',
  };
  const previousEvaluations = (mission.candidateEvaluations || []).filter((item) => item.status !== 'scheduled');
  mission.candidateEvaluations = [
    ...previousEvaluations,
    {
      candidate_id: candidateId,
      status: roundRecord.status,
      source: 'agent_materialized_candidate',
      platform: 'local-c500',
      metric: mission.metric,
      baseline_measured: mission.baseline?.status === 'complete',
      result: roundRecord.test_result,
      completed_at: roundRecord.completed_at,
    },
  ];
  if (bestEligible) mission.current_best = { candidate_id: candidateId, latency_p50_us: latency, speedup, evidence: gate.publishable ? 'live_hardware' : 'simulation' };
  mission.recent_events = [{ time: nowIso(), message: `Round ${round} ${roundRecord.status}: ${roundRecord.decision.reason}` }, ...(mission.recent_events || [])].slice(0, 20);
  await writeJson(path.join(dir, 'mission.json'), mission);
  await appendWorkflowEvent(dir, mission, 'candidate_round_completed', { round, candidate_id: candidateId, accepted, speedup });
  await writeLoopSummary({ dir, mission, latestRound: roundRecord, analysis });
  return { roundRecord, analysis };
};

const loopStopReason = (mission, startedAt) => {
  const tokenLimit = mission.budget?.token_limit;
  if (Number.isFinite(tokenLimit) && tokenLimit != null && Number(mission.budget.tokens_used || 0) >= tokenLimit) return 'token_budget';
  const timeLimit = mission.budget?.time_limit_ms;
  if (Number.isFinite(timeLimit) && timeLimit != null && Date.now() - startedAt >= timeLimit) return 'time_budget';
  const roundLimit = mission.budget?.round_limit;
  if (Number.isFinite(roundLimit) && roundLimit != null && Number(mission.rounds_completed || 0) >= roundLimit) return 'round_budget';
  if (Number(mission.rounds_completed || 0) >= DEFAULT_MAX_ROUNDS) return 'max_rounds';
  return null;
};

const runIterationLoop = async (flags) => {
  const missionId = await getMissionId(flags);
  const dir = missionDirFor(missionId);
  const missionFile = path.join(dir, 'mission.json');
  const mission = await readJson(missionFile);
  const operatorPath = flags['operator-path'] || mission.workspace?.operator;
  if (!operatorPath) {
    const interrupted = await persistUnexpectedWorkflowStop({ dir, mission, phase: 'initializing', error: Object.assign(new Error('operator path is required'), { code: 'OPERATOR_PATH_REQUIRED' }) });
    printJsonOrText({ status: 'needs_human', mission_id: missionId, stop_reason: interrupted.reason, failure: interrupted.failure, summary: interrupted.summary }, flags, `mission needs_human: ${missionId} (${interrupted.reason})`);
    return;
  }
  const startedAt = Date.now();
  let latestRound = null;
  let latestAnalysis = null;
  let phase = 'initializing';
  try {
  const previousWorkflow = await workflowStateFor(dir);
  const previousAge = Date.now() - Date.parse(previousWorkflow.updated_at || '');
  const previousRunnerDead = previousWorkflow.status === 'running'
    && previousWorkflow.runner_pid
    && Number(previousWorkflow.runner_pid) !== process.pid
    && !processAlive(previousWorkflow.runner_pid);
  const previousRunnerStale = previousWorkflow.status === 'running'
    && Number.isFinite(previousAge)
    && previousAge >= WORKFLOW_RECOVERY_AGE_MS;
  if (previousRunnerDead || previousRunnerStale) {
    const recovery = normalizeWorkflowError({
      code: 'WORKFLOW_PROCESS_INTERRUPTED',
      message: '上一次 workflow 进程未正常完成，已从持久化快照恢复。',
      category: 'internal',
    }, { phase: previousWorkflow.phase || 'unknown', source: 'local-c500-recovery', details: { previousRunnerPid: previousWorkflow.runner_pid || null, previousUpdatedAt: previousWorkflow.updated_at || null } });
    mission.recent_events = [{ time: nowIso(), message: `Recovered interrupted workflow at ${recovery.phase} (${recovery.code})` }, ...(mission.recent_events || [])].slice(0, 20);
    await writeJson(missionFile, mission);
    await appendWorkflowEvent(dir, mission, 'workflow_recovered', { failure: serializeWorkflowError(recovery) });
  }
  mission.status = 'running';
  mission.completed = false;
  mission.stage = 'baseline';
  mission.iterationStats = {
    round: Number(mission.iterationStats?.round || 0),
    consecutiveNoAdopt: Number(mission.iterationStats?.consecutiveNoAdopt || 0),
    researchRounds: Number(mission.iterationStats?.researchRounds || 0),
    maxResearch: Number(mission.iterationStats?.maxResearch || DEFAULT_MAX_RESEARCH),
    researchExhausted: Number(mission.iterationStats?.researchRounds || 0) >= Number(mission.iterationStats?.maxResearch || DEFAULT_MAX_RESEARCH),
    maxResearchStopsMainLoop: false,
    loopStatus: 'running',
    loopStatusReason: null,
    loopStartedAt: mission.iterationStats?.loopStartedAt || nowIso(),
  };
  await writeJson(missionFile, mission);
  await writeWorkflowState(dir, mission, { status: 'running', stalled: false });
  phase = 'baseline';
  await ensureBaselineMeasured({ dir, mission, operatorPath, flags });
  if (mission.baseline?.status !== 'complete') {
    mission.status = 'failed';
    mission.stage = 'baseline_failed';
    mission.completed = false;
    mission.completed_at = nowIso();
    mission.iterationStats.loopStatus = 'failed';
    mission.iterationStats.loopStatusReason = 'baseline_failed';
    await writeJson(missionFile, mission);
    await appendWorkflowEvent(dir, mission, 'loop_failed', { reason: 'baseline_failed' });
    const summary = await writeLoopSummary({ dir, mission, stopReason: 'baseline_failed' });
    printJsonOrText({ status: mission.status, mission_id: missionId, summary }, flags, `mission failed: ${missionId}`);
    return;
  }

  let reason = loopStopReason(mission, startedAt);
  while (!reason && !terminalStatuses.has(mission.status)) {
    phase = `candidate_round_${Number(mission.rounds_completed || 0) + 1}`;
    const executed = await executeCandidateRound({ dir, mission, operatorPath, flags });
    latestRound = executed.roundRecord;
    latestAnalysis = executed.analysis;
    reason = loopStopReason(mission, startedAt);
    if (!reason) await appendWorkflowEvent(dir, mission, 'loop_continued', { next_round: Number(mission.rounds_completed || 0) + 1 });
  }
  // A round may deliberately transition the Mission to needs_human (for example
  // no candidate, an unrecoverable gate, or an operator decision). Never emit a
  // terminal summary without carrying that transition's concrete reason.
  if (!reason && mission.status !== 'running') {
    reason = mission.iterationStats?.loopStatusReason || mission.status || 'workflow_terminal';
  }

  if (reason === 'round_budget' || reason === 'token_budget' || reason === 'time_budget') {
    mission.status = 'budget_exhausted';
    mission.completed = false;
  } else if (reason === 'max_rounds') {
    mission.status = 'needs_human';
    mission.completed = false;
  } else if (!reason && mission.status === 'running') {
    mission.status = 'completed';
    mission.completed = true;
    reason = 'completed';
  }
  mission.stage = mission.status === 'budget_exhausted' ? 'budget_exhausted' : mission.status === 'needs_human' ? 'needs_human' : 'mission_completed';
  mission.client_stage = mission.status === 'needs_human' ? 'evidence' : 'curation';
  mission.completed_at = nowIso();
  mission.iterationStats = {
    ...(mission.iterationStats || {}),
    researchExhausted: Number(mission.iterationStats?.researchRounds || 0) >= Number(mission.iterationStats?.maxResearch || DEFAULT_MAX_RESEARCH),
    maxResearchStopsMainLoop: false,
    loopStatus: mission.status === 'needs_human' ? 'needs_human' : mission.status === 'budget_exhausted' ? 'budget_exhausted' : 'completed',
    loopStatusReason: reason,
  };
  mission.recent_events = [{ time: nowIso(), message: `Iteration loop stopped: ${reason}` }, ...(mission.recent_events || [])].slice(0, 20);
  await writeJson(missionFile, mission);
  await appendWorkflowEvent(dir, mission, 'loop_stopped', { reason, status: mission.status });
  const summary = await writeLoopSummary({ dir, mission, latestRound, analysis: latestAnalysis, stopReason: reason });
  await writeWorkflowState(dir, mission, { status: mission.status, stalled: false });
  printJsonOrText({ status: mission.status, mission_id: missionId, summary }, flags, `mission ${mission.status}: ${missionId}`);
  } catch (error) {
    const interrupted = await persistUnexpectedWorkflowStop({ dir, mission, phase, error, latestRound, latestAnalysis });
    printJsonOrText({ status: 'needs_human', mission_id: missionId, stop_reason: interrupted.reason, failure: interrupted.failure, summary: interrupted.summary }, flags, `mission needs_human: ${missionId} (${interrupted.reason})`);
  }
};

const runMission = async (flags) => {
  const missionId = await getMissionId(flags);
  const dir = missionDirFor(missionId);
  const missionFile = path.join(dir, 'mission.json');
  const mission = await readJson(missionFile);
  let phase = 'initializing';
  let latestRound = null;
  let latestAnalysis = null;
  try {
  const started = Date.now();
  const operatorPath = flags['operator-path'];
  if (!operatorPath) throw Object.assign(new Error('operator path is required'), { code: 'OPERATOR_PATH_REQUIRED' });

  const round = Number(mission.rounds_completed || 0) + 1;
  const candidateId = `candidate-${String(round).padStart(3, '0')}`;
  const roundDir = path.join(dir, 'reports', `round-${String(round).padStart(3, '0')}`);
  const snapshotDir = path.join(dir, 'operator_snapshot');
  const resolvedOperator = path.resolve(operatorPath);
  phase = 'copy_operator';
  await copyOperator(resolvedOperator, snapshotDir);
  await copyOperator(resolvedOperator, path.join(roundDir, 'operator_snapshot'));

  phase = 'prepare_test_cases';
  const environment = buildEnvironment({ mock: Boolean(flags.mock) });
  const testCases = generateTestCases(mission);
  await writeJson(path.join(dir, 'test_cases.json'), testCases);
  await writeJson(path.join(roundDir, 'test_cases.json'), testCases);
  await writeJson(path.join(roundDir, 'environment.json'), environment);

  phase = 'harness';
  const result = runHarness(resolvedOperator, flags);
  phase = 'analysis';
  const analysis = await runAnalysisTools({ result, environment, operatorPath: resolvedOperator, roundDir, flags });
  latestAnalysis = analysis;
  result.analysis_runs = analysis.runs;
  result.analysis_artifacts = analysis.artifacts;
  const elapsedMs = Date.now() - started;
  const tokensUsed = flags.mock ? 12_000 + round * 111 : Number(flags['tokens-used'] || 0);
  const baseline = result.baseline_latency_p50_us || mission.baseline?.latency_p50_us || null;
  const latency = result.latency_p50_us || null;
  const speedup = result.speedup || (baseline && latency ? baseline / latency : null);
  const accepted = result.correctness === 'pass' && Number.isFinite(speedup) && (!mission.current_best || speedup > mission.current_best.speedup);
  const toolStatus = {
    mctracer: result.mctracer || analysis.runs.mctracer?.status || (environment.tools.mctracer.status === 'ok' ? 'available' : 'missing'),
    mcProfiler: result.mcProfiler || analysis.runs.mcProfiler?.status || (environment.tools.mcProfiler.status === 'ok' ? 'available' : 'missing'),
  };
  const roundRecord = {
    round,
    candidate_id: candidateId,
    status: result.status === 'completed' ? 'completed' : 'failed',
    started_at: new Date(started).toISOString(),
    completed_at: nowIso(),
    elapsed_ms: elapsedMs,
    tokens_used: tokensUsed,
    test_result: {
      correctness: result.correctness || 'fail',
      latency_p50_us: latency,
      latency_p95_us: result.latency_p95_us || null,
      speedup,
      mctracer: toolStatus.mctracer,
      mcProfiler: toolStatus.mcProfiler,
    },
    analysis_runs: analysis.runs,
    analysis_artifacts: analysis.artifacts,
    decision: { accepted, reason: accepted ? 'improved current best' : result.error || 'not better than current best' },
  };
  latestRound = roundRecord;
  await appendFile(path.join(dir, 'rounds.jsonl'), `${JSON.stringify(roundRecord)}\n`, 'utf8');
  await writeJson(path.join(roundDir, 'result.json'), result);

  const tokenBudgetExceeded = Number.isFinite(mission.budget.token_limit)
    && mission.budget.token_limit != null
    && Number(mission.budget.tokens_used || 0) + tokensUsed >= mission.budget.token_limit;
  const timeBudgetExceeded = Number.isFinite(mission.budget.time_limit_ms)
    && mission.budget.time_limit_ms != null
    && Number(mission.elapsed_ms || 0) + elapsedMs > mission.budget.time_limit_ms;
  const stopReason = tokenBudgetExceeded ? 'token_budget' : timeBudgetExceeded ? 'time_budget' : result.status === 'completed' ? 'completed' : 'test_failed';
  mission.status = tokenBudgetExceeded || timeBudgetExceeded ? 'budget_exhausted' : result.status === 'completed' ? 'completed' : 'failed';
  mission.stage = mission.status === 'completed' ? 'mission_completed' : mission.status === 'budget_exhausted' ? 'budget_exhausted' : 'diagnosis';
  mission.completed = mission.status === 'completed';
  mission.completed_at = nowIso();
  mission.elapsed_ms = (mission.elapsed_ms || 0) + elapsedMs;
  mission.rounds_completed = round;
  mission.budget.tokens_used = Number(mission.budget.tokens_used || 0) + tokensUsed;
  mission.baseline = {
    ...(mission.baseline || {}),
    latency_p50_us: baseline,
    source: mission.baseline?.source || (flags.mock ? 'mock_local_reference' : 'local_reference'),
    measured_before_candidate: mission.baseline?.measured_before_candidate ?? true,
  };
  mission.candidateEvaluations = (mission.candidateEvaluations || []).map((item) => (
    item.candidate_id === candidateId || item.candidate_id === 'candidate-001'
      ? { ...item, candidate_id: candidateId, status: roundRecord.status, result: roundRecord.test_result, completed_at: roundRecord.completed_at }
      : item
  ));
  if (accepted) mission.current_best = { candidate_id: candidateId, latency_p50_us: latency, speedup };
  mission.recent_events = [{ time: nowIso(), message: `Round ${round} ${roundRecord.status}: ${roundRecord.decision.reason}` }, ...(mission.recent_events || [])].slice(0, 20);
  await writeJson(missionFile, mission);

  const summary = {
    mission_id: missionId,
    status: mission.status,
    mission_completed: mission.completed,
    stop_reason: stopReason,
    repository: mission.repository,
    projectId: mission.projectId,
    agent: mission.agent,
    backend: mission.backend,
    platform: mission.platform,
    hardware: mission.hardware,
    stage: mission.stage,
    elapsed_ms: mission.elapsed_ms,
    tokens_used: mission.budget.tokens_used,
    budget: mission.budget,
    correctness: roundRecord.test_result.correctness,
    baseline: mission.baseline,
    baseline_latency_p50_us: baseline,
    latency_p50_us: latency,
    speedup,
    current_best: mission.current_best,
    candidate_evaluations: mission.candidateEvaluations || [],
    test_tools: analysis.runs,
    analysis_runs: analysis.runs,
    analysis_artifacts: analysis.artifacts,
    report_dir: roundDir,
    context_policy: 'summary_only',
    agent_context: { policy: 'summary_only', allowed_files: ['summary.json'] },
  };
  await writeJson(path.join(dir, 'summary.json'), summary);
  printJsonOrText({ status: mission.status, mission_id: missionId, summary }, flags, `mission ${mission.status}: ${missionId}`);
  } catch (error) {
    const interrupted = await persistUnexpectedWorkflowStop({ dir, mission, phase, error, latestRound, latestAnalysis });
    printJsonOrText({ status: 'needs_human', mission_id: missionId, stop_reason: interrupted.reason, failure: interrupted.failure, summary: interrupted.summary }, flags, `mission needs_human: ${missionId} (${interrupted.reason})`);
  }
};

const renderPanel = async () => {
  await ensureHome();
  const missionFile = path.join(currentMissionDir, 'mission.json');
  if (!existsSync(missionFile)) {
    return [
      'C500 Local Tester',
      'Current Mission Console',
      '  status      idle',
      '  stage       --',
      '  local_step  --',
      '  Agent       --',
      '',
      'Current Mission',
      '  title       No mission published',
      '  goal        --',
      '  Repository  --',
      '  metric      --',
      '  hardware    C500',
      '  budget      0ms / unlimited',
      '',
      'Current Best',
      '  candidate   --',
      '  latency_p50 --',
      '  speedup     --',
      '',
      'Environment',
      '  torch       unknown',
      '  triton      unknown',
      '  mctracer    unknown',
      '  mcProfiler  unknown',
      '',
      'Latest Round',
      '  correctness --',
      '  latency_p50 --',
      '  speedup     --',
      '',
      'Events',
      '  --',
      '',
      '[P] Publish  [D] Doctor  [N] Note  [S] Stop  [E] Export  [Q] Quit',
    ].join('\n');
  }
  const mission = await readJson(missionFile);
  const summaryFile = path.join(currentMissionDir, 'summary.json');
  const summary = existsSync(summaryFile) ? await readJson(summaryFile) : {};
  const budget = mission.budget || {};
  const env = mission.environment || {};
  const best = mission.current_best || {};
  const events = (mission.recent_events || []).slice(0, 6);
  return [
    'C500 Local Tester',
    'Current Mission Console',
    `  status      ${mission.status || 'idle'}`,
    `  stage       ${mission.client_stage || mission.stage || '--'}`,
    `  local_step  ${mission.stage || '--'}`,
    `  Agent       ${mission.agent?.phase || mission.agent?.resolved_by || '--'}`,
    '',
    'Current Mission',
    `  title       ${mission.title || mission.name || 'No mission published'}`,
    `  goal        ${mission.goal || '--'}`,
    `  Repository  ${mission.repository || '--'}`,
    `  metric      ${mission.metric || '--'}`,
    `  hardware    ${mission.hardware?.join(' + ') || 'C500'}`,
    `  budget      ${mission.elapsed_ms || 0}ms / ${budget.time_limit_ms ? `${budget.time_limit_ms}ms` : 'unlimited'}`,
    '',
    'Current Best',
    `  candidate   ${best.candidate_id || '--'}`,
    `  latency_p50 ${best.latency_p50_us ? `${best.latency_p50_us.toFixed(3)} us` : '--'}`,
    `  speedup     ${best.speedup ? `${best.speedup.toFixed(2)}x` : '--'}`,
    '',
    'Environment',
    `  torch       ${env.checks?.torch?.status || 'unknown'}`,
    `  triton      ${env.checks?.triton?.status || 'unknown'}`,
    `  mctracer    ${env.tools?.mctracer?.status || 'unknown'}`,
    `  mcProfiler  ${env.tools?.mcProfiler?.status || 'unknown'}`,
    '',
    'Latest Round',
    `  correctness ${summary.correctness || '--'}`,
    `  latency_p50 ${summary.latency_p50_us ? `${summary.latency_p50_us.toFixed(3)} us` : '--'}`,
    `  speedup     ${summary.speedup ? `${summary.speedup.toFixed(2)}x` : '--'}`,
    '',
    'Events',
    ...(events.length ? events.map((event) => `  ${event.time} ${event.message}`) : ['  --']),
    '',
    '[P] Publish  [D] Doctor  [N] Note  [S] Stop  [E] Export  [Q] Quit',
  ].join('\n');
};

const askLine = (rl, prompt, defaultValue = '') => new Promise((resolve) => {
  const suffix = defaultValue ? ` [${defaultValue}]` : '';
  rl.question(`${prompt}${suffix}: `, (answer) => resolve(answer.trim() || defaultValue));
});

const promptCreateMission = async () => {
  if (process.stdin.isTTY) process.stdin.setRawMode(false);
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    process.stdout.write('\nPublish mission\n');
    const goal = await askLine(rl, 'Goal', 'Run local C500 validation');
    const title = await askLine(rl, 'Title, empty means auto');
    const repository = await askLine(rl, 'Repository', 'local-c500-demo');
    const metric = await askLine(rl, 'Metric', 'latency p50');
    const timeBudget = await askLine(rl, 'Time budget, empty means unlimited');
    const tokenBudget = await askLine(rl, 'Token budget, empty means unlimited');
    const flags = {
      goal,
      title: title || undefined,
      repository,
      metric,
      'time-budget': timeBudget || undefined,
      'token-budget': tokenBudget || undefined,
    };
    await publishMission(flags);
  } finally {
    rl.close();
    if (process.stdin.isTTY) process.stdin.setRawMode(true);
  }
};

const showDoctorInPanel = async () => {
  if (process.stdin.isTTY) process.stdin.setRawMode(false);
  const environment = buildEnvironment();
  process.stdout.write('\nEnvironment doctor\n');
  process.stdout.write(`${JSON.stringify({ status: doctorStatus(environment), environment }, null, 2)}\n`);
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  await new Promise((resolve) => rl.question('Press Enter to return to panel...', resolve));
  rl.close();
  if (process.stdin.isTTY) process.stdin.setRawMode(true);
};

const panel = async (flags) => {
  if (flags.create) {
    await publishMission(flags);
    return;
  }
  if (flags.once) {
    process.stdout.write(`${await renderPanel()}\n`);
    return;
  }
  const draw = async () => {
    readline.cursorTo(process.stdout, 0, 0);
    readline.clearScreenDown(process.stdout);
    process.stdout.write(await renderPanel());
  };
  await draw();
  const timer = setInterval(draw, 2000);
  const shutdown = () => {
    clearInterval(timer);
    if (process.stdin.isTTY) process.stdin.setRawMode(false);
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  if (process.stdin.isTTY) {
    readline.emitKeypressEvents(process.stdin);
    process.stdin.setRawMode(true);
    process.stdin.on('keypress', (_, key) => {
      if (key?.name === 'q' || key?.sequence === '\u0003') shutdown();
      if (key?.name === 'p') promptCreateMission().then(draw).catch((error) => process.stderr.write(`${error.message}\n`));
      if (key?.name === 'd') showDoctorInPanel().then(draw).catch((error) => process.stderr.write(`${error.message}\n`));
      if (key?.name === 'r') updateMissionControl({}, 'resume').then(draw).catch((error) => process.stderr.write(`${error.message}\n`));
      if (key?.name === 's') updateMissionControl({}, 'stop').then(draw).catch((error) => process.stderr.write(`${error.message}\n`));
      if (key?.name === 'e') exportMission({}).then(draw).catch((error) => process.stderr.write(`${error.message}\n`));
      if (key?.name === 'n') {
        process.stdin.setRawMode(false);
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
        rl.question('\nHuman note: ', (answer) => {
          rl.close();
          process.stdin.setRawMode(true);
          addNote({ text: answer }).then(draw).catch((error) => process.stderr.write(`${error.message}\n`));
        });
      }
    });
  }
};

const exportMission = async (flags) => {
  const missionId = await getMissionId(flags);
  const source = missionDirFor(missionId);
  const target = path.join(homeDir, 'exports', `${missionId}-${Date.now()}`);
  await cp(source, target, { recursive: true, force: true });
  printJsonOrText({ status: 'exported', mission_id: missionId, export_dir: target }, flags, `exported ${missionId} to ${target}`);
};

const doctor = async (flags) => {
  await ensureHome();
  const environment = buildEnvironment({ mock: Boolean(flags.mock) });
  printJsonOrText({ status: doctorStatus(environment), environment }, flags);
};

const main = async () => {
  const parsed = parseArgs(process.argv.slice(2));
  const { positional, flags } = normalizeNpmArgs(parsed.positional, parsed.flags);
  const [command, subcommand] = positional;
  try {
    if (!command) return panel({ once: false });
    if (command === 'doctor') return doctor(flags);
    if (command === 'panel' && flags.publish) return publishMission(flags);
    if (command === 'panel') return panel(flags);
    if (command === 'mission' && subcommand === 'create') return createMission(flags);
    if (command === 'mission' && subcommand === 'note') return addNote(flags);
    if (command === 'mission' && subcommand === 'pause') return updateMissionControl(flags, 'pause');
    if (command === 'mission' && subcommand === 'resume') return updateMissionControl(flags, 'resume');
    if (command === 'mission' && subcommand === 'stop') return updateMissionControl(flags, 'stop');
    if (command === 'mission' && subcommand === 'run') return runMission(flags);
    if (command === 'mission' && subcommand === 'loop') return runIterationLoop(flags);
    if (command === 'mission' && subcommand === 'export') return exportMission(flags);
    throw new Error(`unknown command: ${positional.join(' ')}`);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 3;
  }
};

await main();
