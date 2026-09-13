import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { resolvePythonExecutable } from '../client-runtime/platform-runtime.mjs';
import { EXPERIENCE_SELECTION_POLICY_VERSION } from '../client-runtime/experience-contract.mjs';
import {
  GPU_ATTEMPT_SCHEMA_VERSION, GPU_SUMMARY_SCHEMA_VERSION, ROUND_FACTS_SCHEMA_VERSION,
  budgetTerminalEvidence, buildConfigFingerprint, collectModelObservationEvidence, combineAttemptOutcome, digestJson,
  evaluateFamilyOutcome, evaluateMissionStopReceipt, hexDigest, verifyContinuationAudit,
} from './shared-gpu-acceptance.mjs';

// Acceptance driver only: setup commands, then read-only observation of the
// production autopilot. No candidate injection, fake provider, Gate override,
// second scheduler or direct Runtime state mutation.
//
// Default provider is claude-code so the GPU harness matches the main acceptance
// wording (TEAM_HANDOFF §3.3/§10.3); codex-cli is an explicit override.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const exec = promisify(execFile);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const mode = process.env.E2E_AGENT_RUNTIME || 'claude-code';
// Codex-only model tier; ignored by other providers so the recorded config never
// claims a model the provider does not use.
const codexModel = process.env.OPERATOR_CODEX_MODEL || 'gpt-5.6-sol';
// The model is not exposed by the Runtime descriptor, so an env/configured
// value stays "declared" (non-comparable) and an absent one stays "unknown".
const declaredModelValue = String(process.env.E2E_AGENT_MODEL || '').trim();
const declaredModel = declaredModelValue || (mode === 'codex-cli' ? codexModel : 'unknown');
const declaredModelSource = declaredModelValue
  ? 'declared'
  : (mode === 'codex-cli' ? 'configured-default' : 'unknown');
const limit = Number(process.env.E2E_GPU_TIMEOUT_MS || 12 * 60_000);
const families = (process.env.E2E_GPU_FAMILIES || 'affine,reduction,normalization').split(',');
const desiredTasks = Number(process.env.E2E_GPU_CANDIDATE_TASKS || 2);
assert.ok(Number.isFinite(limit) && limit >= 30_000 && limit <= 30 * 60_000);
assert.ok(Number.isInteger(desiredTasks) && desiredTasks >= 1 && desiredTasks <= 3);
const mainAgentBudgetMs = Number(process.env.OPERATOR_MAIN_AGENT_BUDGET_MS || 180_000);
const logicalCleanupMs = Number(process.env.OPERATOR_CODEX_LOGICAL_CLEANUP_MS || 60_000);

const matrix = {
  environments: ['local-shared-gpu'], stages: ['Correctness', 'Full Benchmark'], correctnessCases: 4, warmup: 3, repeats: 10,
  testSpec: { schemaVersion: 'operator-studio.test-spec/v1',
    correctness: { requestedCases: 4, requiredCategories: ['minimal', 'representative', 'boundary', 'ragged'], atol: 1e-5, rtol: 1e-5, requireNamedCases: true },
    benchmark: { requiredProfiles: ['primary', 'small'], primaryProfile: 'primary', warmup: 3, repeats: 10 } },
};
const expressions = {
  affine: "torch.relu(inputs['x'] * 1.25 + inputs['y'] * 0.75 - 0.125)",
  reduction: "(inputs['x'] * inputs['y']).sum(dim=-1)",
  normalization: "inputs['x'] * torch.rsqrt((inputs['x'] * inputs['x']).mean(dim=-1, keepdim=True) + 1e-5)",
};
const sourceFor = (family) => `import torch\n\ndef inputs_for(rows, cols):\n    x = torch.linspace(-2, 2, rows * cols, device='cuda', dtype=torch.float32).reshape(rows, cols)\n    return {'x': x, 'y': x.flip(-1)}\n\ndef get_inputs():\n    return inputs_for(32, 256)\n\ndef get_test_cases():\n    return [\n        {'name': 'minimal', 'category': 'minimal', 'inputs': inputs_for(1, 1)},\n        {'name': 'representative', 'category': 'representative', 'inputs': get_inputs()},\n        {'name': 'boundary', 'category': 'boundary', 'inputs': inputs_for(2, 32)},\n        {'name': 'ragged', 'category': 'ragged', 'inputs': inputs_for(3, 17)},\n    ]\n\ndef get_benchmark_inputs():\n    return [{'name': 'primary', 'inputs': get_inputs()}, {'name': 'small', 'inputs': inputs_for(2, 32)}]\n\ndef reference(inputs):\n    return ${expressions[family]}\n\ndef run(inputs):\n    # Initial implementation deliberately does one redundant device copy.\n    value = ${expressions[family]}\n    return value.clone()\n`;

// Artifact parent override (E2E_GPU_ARTIFACT_DIR). The batch runner keeps the
// large raw run directories outside the repository/scratch snapshot; without the
// override the historical in-repo default is unchanged. Only the parent directory
// is overridden: every run still gets its own mkdtemp runRoot below it, and no
// other driver behavior (matrix, budgets, timeout, families, tasks) is affected.
const artifactParentOverride = String(process.env.E2E_GPU_ARTIFACT_DIR || '').trim();
const parent = artifactParentOverride ? path.resolve(artifactParentOverride) : path.join(root, '.tmp-real-agent');
await mkdir(parent, { recursive: true });
const runRoot = await mkdtemp(path.join(parent, 'shared-gpu-'));
const attemptPath = path.join(runRoot, 'attempt.json');
const summaryPath = path.join(runRoot, 'summary.json');
const promptAuditDir = path.join(runRoot, 'bridge', 'prompt-audits');
const runtimeLogPath = path.join(runRoot, 'runtime.log');
console.log('[gpu-agent-e2e] retained artifacts: ' + runRoot);
const reservePort = () => new Promise((resolve, reject) => {
  const server = createServer(); server.on('error', reject);
  server.listen(0, '127.0.0.1', () => { const port = server.address().port; server.close(() => resolve(port)); });
});
const port = await reservePort();
const base = `http://127.0.0.1:${port}`;
let exit = null;
let runtimeSpawned = false;
let child = null;
const logs = [];
const writes = [];
const teardownWrites = [];
const summaries = [];
const familyTargets = [];
const familyStopReceipts = [];
let teardownStop = null;

// --- read-only response-model observation ---------------------------------
// The responding model is provider-reported `assistant.message.model`, never an
// init/config/env label. This driver only reads the current attempt's own runRoot
// bridge records and the live state projection; the frozen pure helpers in
// scripts/shared-gpu-acceptance.mjs own the binding/summary semantics. Nothing
// here writes workflow state or searches host/history directories.
const providerLabel = mode === 'codex-cli' ? 'codex-cli' : 'claude-code';
const providerRunsDirName = mode === 'codex-cli' ? 'codex-runs' : 'claude-runs';
const modelRunsDir = path.join(runRoot, 'bridge', providerRunsDirName);
const SAFE_RUN_FILE = /^[A-Za-z0-9][A-Za-z0-9._-]*\.json$/u;
const isNonBlank = (value) => typeof value === 'string' && value.trim().length > 0;
// Missions this attempt created. A bridge record for any other Mission is
// historical/foreign and never observed.
const expectedMissionIds = new Set();
// Independently observed start identities, keyed by provider/run. Every distinct
// observed snapshot is retained (never merged first-wins), so the frozen pure
// helper can see a concrete contradiction instead of the driver pre-filtering it.
// The expected session comes only from the real runtime thread identity or the
// final record — never from a DTO, and never relabeled with activeMissionId.
const knownModelRuns = new Map();
const rememberKnownRun = ({ runId, missionId, sessionId }) => {
  if (!isNonBlank(runId)) return;
  const key = providerLabel + ' ' + runId;
  const snapshot = { provider: providerLabel, runId,
    missionId: isNonBlank(missionId) ? missionId : '',
    sessionId: isNonBlank(sessionId) ? sessionId : '' };
  const list = knownModelRuns.get(key) || [];
  if (!list.some((item) => item.missionId === snapshot.missionId && item.sessionId === snapshot.sessionId)) {
    list.push(snapshot);
  }
  knownModelRuns.set(key, list);
};
// Observe every Agent run the live state exposes, including a started run whose
// observation is still unknown: the run identity is retained so a failed,
// recovery or zero-candidate run is never dropped from the required set. This is
// called on every poll AND on the stop receipt / read-only final states.
const observeStateModelRuns = (state) => {
  if (!state || typeof state !== 'object') return;
  const agent = state.agent;
  if (agent?.runId && agent?.runtimeKind === providerLabel) {
    // agent.missionId is the run's own binding; state.activeMissionId is never
    // used to relabel a historical run.
    rememberKnownRun({ runId: agent.runId, missionId: agent.missionId || null, sessionId: agent.threadId || null });
  }
  for (const round of Array.isArray(state.runHistory) ? state.runHistory : []) {
    if (!round?.runId || round?.runtimeKind !== providerLabel) continue;
    // An archived round carries no Mission field of its own; it is left blank so
    // the collector completes it from this attempt's final record instead of
    // relabeling it with the currently active Mission.
    rememberKnownRun({ runId: round.runId, missionId: round.missionId || null, sessionId: round.threadId || null });
  }
};
// Physical final bridge records for the current attempt runRoot only. Every sweep
// REBUILDS the record set from the latest physical reads: a discovered file that
// disappeared, a read/parse failure, or a directory enumeration failure becomes
// an explicit error entry — an earlier successful DTO is never kept as fallback,
// so a run started between two polls cannot be silently dropped and a lost final
// state can never masquerade as observed.
const discoveredRunFiles = new Set();
const bridgeRecords = new Map();
let bridgeEnumerationError = null;
const collectBridgeRecords = async () => {
  let names = null;
  try { names = await readdir(modelRunsDir); bridgeEnumerationError = null; }
  catch (error) { bridgeEnumerationError = `readdir failed: ${error.message}`; }
  const present = new Set();
  if (names) {
    for (const name of names) {
      if (!SAFE_RUN_FILE.test(name) || path.basename(name) !== name) continue;
      present.add(name);
      discoveredRunFiles.add(name);
    }
  }
  for (const name of discoveredRunFiles) {
    if (!names) {
      bridgeRecords.set(name, { fileName: name, record: null,
        error: bridgeEnumerationError || 'run directory enumeration failed' });
      continue;
    }
    if (!present.has(name)) {
      bridgeRecords.set(name, { fileName: name, record: null,
        error: 'run file is missing from the current runRoot' });
      continue;
    }
    const full = path.join(modelRunsDir, name);
    let raw;
    try { raw = await readFile(full, 'utf8'); }
    catch (error) { bridgeRecords.set(name, { fileName: name, record: null, error: `unreadable: ${error.message}` }); continue; }
    try { bridgeRecords.set(name, { fileName: name, record: JSON.parse(raw), error: null }); }
    catch (error) { bridgeRecords.set(name, { fileName: name, record: null, error: `invalid JSON: ${error.message}` }); }
  }
  return { enumerationError: bridgeEnumerationError, discoveredFiles: [...discoveredRunFiles] };
};
// Frozen pure consumer helper: binds each final record DTO to its exact run
// identity and summarizes. Never guesses a session/Mission from a DTO.
const collectModelEvidence = () => collectModelObservationEvidence({
  provider: providerLabel,
  missionIds: [...expectedMissionIds],
  knownRuns: [...knownModelRuns.values()].flat(),
  records: [...bridgeRecords.values()],
});

// --- code/config provenance (read-only) -----------------------------------
const gitText = async (args) => {
  try { const { stdout } = await exec('git', args, { cwd: root, windowsHide: true }); return String(stdout).trim(); }
  catch { return null; }
};
// Observable provider CLI version. An env/self-reported value is only
// "declared" — it never proves what ran and never makes a group N-comparable. If
// it cannot be probed, record "unknown" — never guess.
const probeCliVersion = async (runtime) => {
  const explicit = String(process.env.E2E_AGENT_CLI_VERSION || '').trim();
  if (explicit) return { version: explicit, source: 'declared' };
  const bin = runtime === 'codex-cli' ? (process.env.OPERATOR_CODEX_BIN || 'codex')
    : runtime === 'claude-code' ? (process.env.OPERATOR_CLAUDE_BIN || 'claude') : null;
  if (!bin) return { version: 'unknown', source: 'unknown' };
  try {
    const { stdout } = await exec(bin, ['--version'], { cwd: root, windowsHide: true, timeout: 5_000, shell: process.platform === 'win32' });
    const version = String(stdout).split(/\r?\n/u).map((line) => line.trim()).filter(Boolean)[0] || '';
    return version ? { version, source: 'probe' } : { version: 'unknown', source: 'unknown' };
  } catch {
    return { version: 'unknown', source: 'unknown' };
  }
};
// Actual content digest of the source tree that participates in the run
// (driver/observer, Runtime, round services, Gate, experience contract). This is
// what makes an uncommitted edit change the fingerprint, not just the commit id.
const SOURCE_DIGEST_FILES = [
  'scripts/e2e-shared-gpu-agent-iteration.mjs',
  'scripts/shared-gpu-acceptance.mjs',
  'scripts/summarize-gpu-agent-runs.mjs',
  'client-runtime/agent-runtime.mjs',
  'client-runtime/mission-project-state.mjs',
  'client-runtime/application/agent-round-service.mjs',
  'client-runtime/application/round-experience-service.mjs',
  'client-runtime/experience-contract.mjs',
  'client-runtime/application/benchmark-command.mjs',
];
const collectCodeManifest = async () => {
  const commit = await gitText(['rev-parse', 'HEAD']);
  const porcelain = await gitText(['status', '--porcelain']);
  const dirtyFiles = porcelain ? porcelain.split(/\r?\n/u).filter(Boolean) : [];
  const sourceDigests = [];
  const indexed = await gitText(['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--',
    'client-runtime', 'tools', 'scripts', 'package.json', 'package-lock.json']);
  const sources = [...new Set([...SOURCE_DIGEST_FILES, ...(indexed ? indexed.split('\0').filter(Boolean) : [])])].sort();
  for (const relative of sources) {
    try {
      const bytes = await readFile(path.join(root, relative));
      sourceDigests.push({ path: relative, sha256: `sha256:${createHash('sha256').update(bytes).digest('hex')}` });
    } catch {
      sourceDigests.push({ path: relative, sha256: null });
    }
  }
  return {
    commit,
    dirty: porcelain === null ? null : dirtyFiles.length > 0,
    dirtyFileCount: porcelain === null ? null : dirtyFiles.length,
    contentDigest: indexed !== null && sourceDigests.every((entry) => entry.sha256) ? digestJson(sourceDigests) : null,
    sourceDigests,
  };
};

const cliVersion = await probeCliVersion(mode);
const codeManifest = await collectCodeManifest();
const config = {
  driver: { schemaVersion: GPU_ATTEMPT_SCHEMA_VERSION, script: 'scripts/e2e-shared-gpu-agent-iteration.mjs' },
  provider: {
    runtime: mode,
    cliVersion: cliVersion.version,
    cliVersionSource: cliVersion.source,
    model: declaredModel,
    modelSource: declaredModelSource,
  },
  backend: { kind: 'local-shared-gpu', executionMode: 'gpu', publishable: false },
  // Requested target; the terminal attempt replaces these with the target the
  // real runner actually reported (resolvedTarget from production evidence).
  // Per-run identifiers such as sourceRunId stay OUT of config (observability
  // only, in attempt.observedTargets) so they can never enter the fingerprint.
  hardware: ['nvidia-gpu'],
  architecture: [],
  device: null,
  driverVersion: null,
  families: [...families],
  candidateTasks: desiredTasks,
  matrix: structuredClone(matrix),
  promptPolicy: {
    experienceSelectionPolicyVersion: EXPERIENCE_SELECTION_POLICY_VERSION,
    roundFactsSchemaVersion: ROUND_FACTS_SCHEMA_VERSION,
  },
  budgets: { missionBudgetMs: limit, mainAgentBudgetMs, logicalCleanupMs, taskTimeoutSeconds: 120 },
  code: codeManifest,
};
const baseAttempt = {
  schemaVersion: GPU_ATTEMPT_SCHEMA_VERSION,
  attemptId: path.basename(runRoot),
  runRoot,
  phase: 'running',
  status: 'running',
  startedAt: new Date().toISOString(),
  endedAt: null,
  outcome: null,
  fullSuccess: null,
  runtime: mode,
  provider: config.provider,
  backend: config.backend,
  config,
  families: [...families],
  candidateTasks: desiredTasks,
  code: codeManifest,
  observedTargets: [],
  completedFamilies: [],
  unfinishedFamilies: [...families],
  familyOutcomes: [],
  failure: null,
  cleanup: { runtimeSpawned: false, runtimeExit: null, artifactsRetained: true, artifactsRoot: runRoot },
  evidence: { runRoot, attemptPath, summaryPath, promptAuditDir, runtimeLog: runtimeLogPath },
};
// Write "running" BEFORE the Runtime starts so a killed/interrupted attempt is
// still visible in the ledger instead of vanishing.
await writeFile(attemptPath, JSON.stringify(baseAttempt, null, 2));

let missionId;
let failure;
let terminalOutcome = 'failure';
let terminalFullSuccess = false;

// The request/stop helpers are declared OUTSIDE the try so the `finally` cleanup
// (error/timeout path) can reach them lexically. Defining them inside try made
// the finally `stopMissionNow` reference a ReferenceError, so an errored run
// killed its Runtime without ever issuing the production stop.
const request = async (pathname, body) => {
  const method = body === undefined ? 'GET' : 'POST';
  if (method === 'POST') writes.push({ pathname, at: new Date().toISOString() });
  const response = await fetch(base + pathname, { method, headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(120_000) });
  const value = await response.json();
  if (!response.ok) throw Object.assign(new Error(`${pathname}: ${response.status} ${JSON.stringify(value)}`), { code: value.code });
  return value;
};
// Teardown stop. This is NOT a workflow write: it is recorded separately and
// never touches the `writes` counter, so it cannot advance the loop or inject a
// candidate. It retains the ORIGINAL HTTP status + body `{state}` in
// `initialReceipt` (never replaced by a later poll) plus every later bounded
// read-only observation/final state. A 202 is only confirmed after one of those
// read-only states proves resource release (never by elapsed time or terminal
// status). It observes the independent start identities in every state it reads.
const stopMissionNow = async (ownedMissionId) => {
  let initialReceipt = null;
  let evaluation;
  try {
    const response = await fetch(base + '/api/actions/stop-mission', { method: 'POST',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({}), signal: AbortSignal.timeout(120_000) });
    const body = await response.json().catch(() => null);
    teardownWrites.push({ pathname: '/api/actions/stop-mission', statusCode: response.status, at: new Date().toISOString() });
    initialReceipt = { statusCode: response.status, body };
    observeStateModelRuns(body?.state);
    evaluation = evaluateMissionStopReceipt({ missionId: ownedMissionId, receipt: body });
  } catch (error) {
    // A request failure is retained separately from any cleanup failure; nothing
    // is reported as stopped without a real production response.
    return { missionId: ownedMissionId, statusCode: null, confirmed: false,
      reasons: [`stop request failed: ${error.message}`], error: error.message,
      initialReceipt: null, observations: [], finalState: null };
  }
  const observations = [];
  let finalState = null;
  const deadline = Date.now() + 15_000;
  while (!evaluation.confirmed && Date.now() < deadline) {
    await sleep(500);
    let observed;
    try { observed = (await request('/api/state')).state; } catch { break; }
    finalState = observed;
    observeStateModelRuns(observed);
    evaluation = evaluateMissionStopReceipt({ missionId: ownedMissionId, receipt: { state: observed } });
    observations.push({ at: new Date().toISOString(), confirmed: evaluation.confirmed, reasons: evaluation.reasons });
  }
  return { missionId: ownedMissionId, statusCode: initialReceipt.statusCode,
    confirmed: evaluation.confirmed, reasons: evaluation.reasons,
    initialReceipt, observations, finalState };
};

try {
child = spawn(process.execPath, ['client-runtime/local-server.mjs'], {
  cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, API_PORT: String(port), SERVE_WEB: 'false', OPERATOR_RUNTIME_MODE: mode,
    OPERATOR_CODEX_MODEL: codexModel,
    OPERATOR_AUTO_TICK: '1', OPERATOR_AUTO_TICK_INTERVAL_MS: '5000',
    OPERATOR_CODEX_LOGICAL_CLEANUP_MS: String(logicalCleanupMs),
    OPERATOR_MAIN_AGENT_BUDGET_MS: String(mainAgentBudgetMs), OPERATOR_TEST_BACKEND: 'local-shared-gpu',
    OPERATOR_GPU_PYTHON: resolvePythonExecutable({ rootDir: root }),
    OPERATOR_LOCAL_CPU: '0', OPERATOR_LOCAL_C500_MOCK: '0', OPERATOR_LOCAL_C500_SIMULATION: '0',
    OPERATOR_LOCAL_C500_COMMAND: '', OPERATOR_LOCAL_C500_TIMEOUT_SECONDS: '120',
    OPERATOR_DATA_DIR: path.join(runRoot, 'data'), OPERATOR_RUNTIME_DIR: path.join(runRoot, 'runtime'),
    OPERATOR_LOCAL_C500_DIR: path.join(runRoot, 'tasks'), OPERATOR_EXECUTION_PACKAGE_DIR: path.join(runRoot, 'packages'),
    OPERATOR_BRIDGE_DIR: path.join(runRoot, 'bridge'),
  },
});
runtimeSpawned = true;
child.stdout.on('data', (value) => logs.push(String(value)));
child.stderr.on('data', (value) => logs.push(String(value)));
child.on('error', (error) => { exit = { error: error.message }; });
child.on('exit', (code, signal) => { exit = { code, signal }; });

// --- read-only observation helpers ----------------------------------------
const candidateDigestOf = (task) => hexDigest(task?.payload?.candidate?.digest || task?.result?.environment?.candidateDigest);
const candidateSourceRunIdOf = (task) => task?.payload?.candidate?.sourceRunId
  || task?.payload?.candidateSourceRunId || null;
const queueRequestIdOf = (task) => task?.payload?.requestId || null;
const orderCompleted = (completedTasks) => [...completedTasks].sort((a, b) => {
  const at = Date.parse(a?.completedAt || '') || 0;
  const bt = Date.parse(b?.completedAt || '') || 0;
  return at - bt || String(a?.taskId || a?.id || '').localeCompare(String(b?.taskId || b?.id || ''));
});
// The verified candidate's own archive, bound by candidate digest AND the durable
// queue request id. Never by "the run this harness happened to start first".
const archivedRoundsForTask = (state, task) => {
  const digest = candidateDigestOf(task);
  const queueRequestId = queueRequestIdOf(task);
  if (!digest || !queueRequestId) return [];
  return (state?.runHistory || []).filter((round) => hexDigest(round?.candidateDigest) === digest
    && round?.queueRequestId === queueRequestId);
};
// Select the retained pre-send audit for exactly the frozen target round. Never
// the newest file and never state.agent.runId (which may be a third round or a
// same-round recovery attempt).
const findRetainedAudit = async ({ auditDir, missionId, roundId, sourceRunId }) => {
  let names = [];
  try { names = await readdir(auditDir); } catch { return { audit: null, path: null, matched: [] }; }
  const matched = [];
  for (const name of names.filter((item) => item.endsWith('.json')).sort()) {
    const full = path.join(auditDir, name);
    let parsed;
    try { parsed = JSON.parse(await readFile(full, 'utf8')); } catch { continue; }
    if (parsed?.missionId !== missionId || parsed?.roundId !== roundId || parsed?.deliveryStage !== 'prepared-before-send') continue;
    matched.push({ path: full, runId: parsed.runId || null, createdAt: parsed.createdAt || null, audit: parsed });
  }
  const candidates = matched.filter((item) => item.runId && item.runId !== sourceRunId)
    .sort((a, b) => String(a.createdAt || '').localeCompare(String(b.createdAt || ''))
      || String(a.runId).localeCompare(String(b.runId)));
  return { audit: candidates[0]?.audit || null, path: candidates[0]?.path || null, matched };
};

  let health;
  for (let attempt = 0; attempt < 120; attempt++) {
    try { health = await request('/api/health'); break; } catch { if (exit) break; await sleep(250); }
  }
  assert.ok(health, 'Runtime did not start: ' + logs.join(''));
  assert.equal(health.runtime.mode, mode);
  assert.equal(health.runtime.connected, true, JSON.stringify(health.runtime));
  assert.equal(health.testBackend.kind, 'local-shared-gpu');
  // The live Runtime descriptor is a real observation of the provider CLI
  // version; it outranks an env declaration or a bare --version probe.
  const descriptorVersion = typeof health.runtime?.version === 'string' && health.runtime.version.trim()
    ? health.runtime.version.trim() : null;
  if (descriptorVersion) {
    config.provider.cliVersion = descriptorVersion;
    config.provider.cliVersionSource = 'runtime-descriptor';
  }
  for (const family of families) {
    assert.ok(Object.hasOwn(expressions, family), 'Unknown family: ' + family);
    const source = sourceFor(family).replace(
      "x = torch.linspace(-2, 2, rows * cols, device='cuda', dtype=torch.float32).reshape(rows, cols)",
      "x = (torch.linspace(-2, 2, rows * cols, device='cuda', dtype=torch.float32) + 3).reshape(rows, cols)",
    );
    const project = (await request('/api/projects', { name: `gpu-${family}`, root: path.join(runRoot, 'projects', family), initializeGit: true })).project;
    await writeFile(path.join(project.repository, 'run.py'), source, 'utf8');
    await exec('git', ['add', 'run.py'], { cwd: project.repository, windowsHide: true });
    await exec('git', ['-c', 'user.name=Operator Studio E2E', '-c', 'user.email=e2e@operator.studio', 'commit', '-m', 'Add independent GPU baseline'], { cwd: project.repository, windowsHide: true });
    const goal = `优化 ${family} GPU 算子 run.py 的 run(inputs)，FP32，shape=32x256，latency p50 相对 baseline 提升至少 99.9999%，通过 4/4 Correctness 和 Full Benchmark。只修改 run.py 中的实现，不改 reference/get_test_cases/get_benchmark_inputs，不改测试矩阵；禁止本地跑测试、安装依赖、使用网络、修改工作区外文件。候选必须是有界真实 Diff，立即完成一个小优化（例如消除冗余 copy），由系统统一 GPU 队列验证。后续轮次根据真实反馈尝试另一个不同 Diff，不能只给分析。`;
    const created = await request('/api/missions', { projectId: project.id, title: `${family} generic GPU iteration`, operator: `generic_${family}`, goal,
      hardware: ['local-shared-gpu'], implementation: 'pytorch-python', metric: 'latency p50', testMatrix: matrix, missionBudgetMs: limit,
      objective: { mode: 'threshold', metric: 'latency p50', direction: 'minimize', targetRelativeImprovement: 0.999999 } });
    missionId = created.state.activeMissionId;
    // The expected Mission set is fixed when the Mission is created: only runs
    // bound to one of these Missions may ever contribute model evidence.
    if (isNonBlank(missionId)) expectedMissionIds.add(missionId);
    await request('/api/actions/start-benchmark', { purpose: 'baseline', baselineKind: 'naive_v0', runPy: source, operator: `generic_${family}`, matrix, timeoutSeconds: 120,
      baselineSource: { authority: 'generated', kind: 'naive_v0', type: 'naive_v0', repository: 'mission-workspace', commit: `gpu-${family}-v0`, path: 'run.py', operator: `generic_${family}`, expandedSingleFile: true, basedOn: 'v0' } });
    let state;
    const baselineDeadline = Date.now() + 150_000;
    while (Date.now() < baselineDeadline) {
      state = (await request('/api/state')).state;
      observeStateModelRuns(state);
      if (state.baseline?.status === 'complete' && state.benchmark?.status === 'idle') break;
      if (state.benchmark?.status === 'failed') throw new Error('Baseline failed: ' + JSON.stringify(state.benchmark));
      await sleep(500);
    }
    assert.equal(state.baseline?.status, 'complete', 'Baseline stalled: ' + JSON.stringify(state.benchmark));
    // Record the target the real runner actually probed, not a declaration.
    const observedTarget = state.iterationStats?.resolvedTarget || null;
    if (observedTarget) familyTargets.push({ family, ...structuredClone(observedTarget) });
    console.log(`[gpu-agent-e2e] ${family}: GPU baseline complete`);
    // Auto-tick may start the Agent immediately after baseline completion. Make
    // this acceptance driver idempotent: reuse that run instead of turning a
    // harmless start race into a terminal 409 failure.
    let started;
    const observedBeforeStart = (await request('/api/state')).state;
    observeStateModelRuns(observedBeforeStart);
    if (observedBeforeStart.agent?.status === 'running' && observedBeforeStart.agent?.missionId === missionId) {
      started = { state: observedBeforeStart };
    } else {
      try {
        started = await request(`/api/missions/${missionId}/runs`, { goal });
      } catch (error) {
        if (error.code !== 'AGENT_RUN_ALREADY_ACTIVE') throw error;
        const recovered = (await request('/api/state')).state;
        assert.equal(recovered.agent?.missionId, missionId, '409 active run belongs to another Mission');
        assert.equal(recovered.agent?.status, 'running', '409 active run is not running');
        started = { state: recovered };
      }
    }
    observeStateModelRuns(started.state);
    const firstRun = started.state.agent.runId;
    const writesAtStart = writes.length;
    const deadline = Date.now() + limit;
    let commandRecoveryStartedAt = null;
    let completed = [];
    let tasks = [];
    let progress = '';
    let budgetTerminalAccepted = false;
    let acceptedBudgetEvidence = null;
    let loopBroke = false;
    while (Date.now() < deadline) {
      state = (await request('/api/state')).state;
      observeStateModelRuns(state);
      tasks = (await request('/api/operator-tests')).tasks.filter((task) => task.payload?.missionId === missionId);
      completed = tasks.filter((task) => task.payload?.purpose === 'candidate' && task.status === 'completed');
      const next = JSON.stringify({ family, stage: state.stage, agent: state.agent?.status, runId: state.agent?.runId, test: state.benchmark?.status, round: state.iterationStats?.round, completed: completed.length, experience: state.iterationStats?.experienceCollection, failure: state.workflowFailure?.code });
      if (next !== progress) { console.log('[gpu-agent-e2e] ' + next); progress = next; }
      await writeFile(path.join(runRoot, family + '-state.json'), JSON.stringify({ state, tasks }, null, 2));
      // Do not stop at the first completed task: the P2 acceptance must prove that
      // a rejected/reference Candidate is archived and the production loop
      // automatically resumes a fresh Agent round. A multi-round run is mandatory
      // whenever the default (two tasks) is used.
      const firstVerifiedTask = orderCompleted(completed)[0] || null;
      const firstMatches = firstVerifiedTask ? archivedRoundsForTask(state, firstVerifiedTask) : [];
      const firstSourceRound = firstMatches.length === 1 ? firstMatches[0] : null;
      const firstProducingRunId = firstVerifiedTask
        ? (candidateSourceRunIdOf(firstVerifiedTask) || firstSourceRound?.runId || null) : null;
      const continuedRound = Boolean(state.agent?.runId && firstProducingRunId && state.agent.runId !== firstProducingRunId);
      const enoughRounds = desiredTasks < 2 || (Boolean(firstSourceRound) && continuedRound);
      if (completed.length >= desiredTasks && state.iterationStats?.experienceCollection?.recorded > 0 && enoughRounds) { loopBroke = true; break; }
      // A bounded provider/round budget may legitimately stop the loop before a
      // second Candidate. Only accept that terminal with a recorded budget reason
      // AND confirmed resource release; needs_human alone is never enough.
      const budget = budgetTerminalEvidence(state, { missionId, runId: state.agent?.runId ?? null });
      const safeBudgetTerminal = desiredTasks >= 2 && budget.safe && Boolean(firstSourceRound) && continuedRound
        && completed.length >= 1
        && ((state.iterationStats?.experienceCollection?.recorded || 0)
          + (state.iterationStats?.experienceCollection?.existing || 0) > 0);
      if (safeBudgetTerminal) {
        budgetTerminalAccepted = true;
        acceptedBudgetEvidence = budget;
        loopBroke = true;
        break;
      }
      if (['needs_human', 'failed', 'budget_exhausted'].includes(state.iterationStats?.loopStatus)) {
        // A command effect may have committed its state just after this
        // read-only projection. Give the production auto-tick a bounded
        // recovery window before treating the blocker as terminal.
        if (state.workflowFailure?.code === 'COMMAND_PENDING_RECOVERY') {
          commandRecoveryStartedAt ??= Date.now();
        }
        if (state.workflowFailure?.code === 'COMMAND_PENDING_RECOVERY' && Date.now() < commandRecoveryStartedAt + 30_000) {
          await sleep(1000);
          continue;
        }
        throw new Error('Iteration stopped: ' + JSON.stringify({
          iterationStats: state.iterationStats,
          workflowFailure: state.workflowFailure,
          budgetEvidence: budget,
        }));
      }
      commandRecoveryStartedAt = null;
      if (exit) throw new Error('Runtime exited: ' + JSON.stringify(exit));
      await sleep(1000);
    }
    if (!loopBroke && Date.now() >= deadline) {
      throw Object.assign(new Error(`GPU acceptance timed out for ${family} before the two-round path completed`), { code: 'E2E_TIMEOUT' });
    }
    assert.ok(completed.length >= (budgetTerminalAccepted ? 1 : desiredTasks), 'Insufficient completed real Candidate tasks');
    assert.equal(writes.length, writesAtStart, 'Harness must not drive automatic iterations');
    const experiences = (await request(`/api/projects/${project.id}/experiences`)).experiences;
    let sourceRound = null;
    let candidateSourceRunId = null;
    let rollbackEvents = [];
    let continuationAudit = null;
    if (desiredTasks >= 2) {
      const ordered = orderCompleted(completed);
      const verifiedTask = ordered[0];
      assert.ok(verifiedTask, 'no completed real Candidate task to bind the continuation audit to');
      const verifiedDigest = candidateDigestOf(verifiedTask);
      const verifiedQueueRequestId = queueRequestIdOf(verifiedTask);
      assert.ok(verifiedDigest && verifiedQueueRequestId, 'first verified candidate is missing its candidate digest / queue request id');
      const matches = archivedRoundsForTask(state, verifiedTask);
      assert.equal(matches.length, 1, `first verified candidate must match exactly one archived round (found ${matches.length})`);
      sourceRound = matches[0];
      assert.ok(sourceRound.roundId, 'verified candidate archive has no roundId');
      candidateSourceRunId = candidateSourceRunIdOf(verifiedTask)
        || sourceRound.candidateSourceRunId || sourceRound.roundFacts?.previous?.candidateSourceRunId || sourceRound.runId;
      // Same-round recovery: attribute the evidence to the candidate's persisted
      // sourceRunId, never to the fixed first Agent run of the harness.
      const archivedSourceRunId = sourceRound.candidateSourceRunId
        || sourceRound.roundFacts?.previous?.candidateSourceRunId || null;
      if (archivedSourceRunId && candidateSourceRunId) {
        assert.equal(archivedSourceRunId, candidateSourceRunId,
          'archived candidate source run must equal the persisted candidate.sourceRunId (recovery attempts are not re-attributed)');
      }
      const firstOutcome = sourceRound.decisionReview?.resolution?.outcome;
      assert.ok(['reference', 'reject'].includes(firstOutcome), `verified Candidate unexpectedly resolved as ${firstOutcome}`);
      assert.ok(state.agent?.runId && state.agent.runId !== candidateSourceRunId, 'unmet target did not automatically start the next Agent round');
      rollbackEvents = (state.runtimeEvents || []).filter((event) => event.type === 'workflow.round_rolled_back');
      assert.ok(rollbackEvents.length >= 1, 'automatic next round did not record a workspace rollback');
      assert.ok(rollbackEvents.every((event) => event.payload?.workspaceClean === true), 'rollback evidence must confirm a clean workspace');

      // §14.5 continuation observation point, hardened for P2: the audit must be
      // the actual pre-send artifact of the round FROZEN in the verified
      // candidate's own archive target (sourceRound.roundFacts.target.roundId),
      // never the newest retained audit or the current state.agent.runId.
      const targetRoundId = sourceRound.roundFacts?.target?.roundId;
      assert.ok(targetRoundId, 'verified candidate archive has no frozen target roundId');
      const auditScan = await findRetainedAudit({ auditDir: promptAuditDir, missionId, roundId: targetRoundId, sourceRunId: sourceRound.runId });
      if (auditScan.audit) {
        continuationAudit = {
          path: auditScan.path,
          matchedAuditsForTargetRound: auditScan.matched.map((item) => item.runId),
          selectedBy: 'sourceRound.roundFacts.target.roundId',
          ...verifyContinuationAudit({ audit: auditScan.audit, sourceRound, experiences, missionId, projectId: project.id }),
        };
      } else {
        // A budget-safe terminal may stop before the continuation audit exists;
        // full two-round success can never pass without it.
        assert.ok(budgetTerminalAccepted, `no retained pre-send audit for the actual continuation round ${targetRoundId}`);
      }
    }
    for (const task of completed) {
      assert.equal(task.resourceRelease.confirmed, true);
      assert.equal(task.result.environment.source, 'local-shared-gpu');
      assert.equal(task.result.environment.publishable, false);
      assert.equal(task.payload.candidate.digest, task.result.environment.candidateDigest);
      assert.ok(task.result.benchmark.every((row) => row.correctness.passed));
      assert.deepEqual(task.result.benchmark.map((row) => row.profile), ['primary', 'small']);
      assert.ok(task.payload.packageDigest && task.payload.admissionId);
    }
    assert.equal(new Set(completed.map((task) => task.payload.candidate.digest)).size, completed.length);
    assert.ok(experiences?.some((item) => item.source === 'execution' && item.verification.publishable === false), 'No trusted experience observation');
    const familyOutcome = evaluateFamilyOutcome({
      desiredTasks, completedTasks: completed,
      // Only the evidence object from budgetTerminalEvidence() may mark a safe
      // terminal; a bare flag can never be promoted to budget_terminal.
      budgetTerminal: acceptedBudgetEvidence,
      continuationAudit, rollbackEvents,
    });
    const budgetEvidence = acceptedBudgetEvidence;
    summaries.push({
      family, missionId, firstRun, sourceRunId: candidateSourceRunId, sourceRoundId: sourceRound?.roundId || null,
      sourceRoundTargetRoundId: sourceRound?.roundFacts?.target?.roundId || null,
      firstRoundOutcome: sourceRound?.decisionReview?.resolution?.outcome || null,
      outcome: familyOutcome.outcome, fullSuccess: familyOutcome.fullSuccess, outcomeReasons: familyOutcome.reasons,
      budgetTerminalAccepted, budgetTerminalEvidence: budgetEvidence,
      continuationAudit, continuedRun: state.agent?.runId || null, rollbackCount: rollbackEvents.length,
      completed: completed.map((task) => ({ taskId: task.taskId, candidateDigest: task.payload.candidate.digest,
        candidateSourceRunId: candidateSourceRunIdOf(task), queueRequestId: queueRequestIdOf(task), packageDigest: task.payload.packageDigest })),
      workflowWritesAfterStart: writes.length - writesAtStart, experienceCount: experiences.length,
      observedTarget: observedTarget ? { hardware: observedTarget.hardware || [], architecture: observedTarget.architecture || [],
        device: observedTarget.device || null, driverVersion: observedTarget.driverVersion || null, backend: observedTarget.backend || null } : null,
    });
    assert.notEqual(familyOutcome.outcome, 'failure', `GPU family acceptance failed: ${familyOutcome.reasons.join(', ')}`);
    // Teardown of the owned Mission through the real production API, before the
    // Runtime is killed. An unconfirmed release can never be a full_success and
    // forbids starting the next Mission.
    const stopReceipt = await stopMissionNow(missionId);
    familyStopReceipts.push({ family, ...stopReceipt });
    summaries.at(-1).stopReceipt = familyStopReceipts.at(-1);
    // Read the current Mission's retained bridge records after the production stop
    // but before the Runtime is torn down: a run started between two polls (or a
    // teardown/recovery run) must not be lost. Read-only; expected Mission gate.
    await collectBridgeRecords();
    if (!stopReceipt.confirmed) {
      throw Object.assign(new Error(`Mission stop for ${family} was not confirmed: ${stopReceipt.reasons.join(', ')}`),
        { code: 'MISSION_STOP_UNCONFIRMED' });
    }
    missionId = null;
  }
} catch (error) { failure = { message: error.message, code: error.code || null, stack: error.stack }; }
finally {
  // Teardown: stop the still-owned current Mission through the same production
  // API before terminating the Runtime, on error/timeout as well as on the normal
  // path. The original failure is preserved separately; a stop failure never
  // replaces it. Teardown never advances the loop or injects a candidate.
  if (missionId && runtimeSpawned && !exit) {
    try {
      teardownStop = await stopMissionNow(missionId);
      await collectBridgeRecords();
    } catch (error) {
      teardownStop = { missionId, confirmed: false, statusCode: null,
        reasons: [`stop request failed: ${error.message}`], error: error.message };
    }
    missionId = null;
  }
  // Preserve the entire disposable acceptance project and receipts for audit.
  if (!exit && runtimeSpawned) child.kill();
  if (runtimeSpawned) await Promise.race([new Promise((resolve) => child.once('exit', resolve)), sleep(3000)]);
  // Physical final records: a run begun between the last poll and teardown is
  // still enumerated here (safe filenames, current attempt runRoot only). The
  // sweep rebuilds from the latest reads, so a vanished file or an enumeration
  // failure becomes an explicit error instead of a stale observed DTO.
  const modelSweep = await collectBridgeRecords();
  const observedHardware = [...new Set(familyTargets.flatMap((target) => Array.isArray(target.hardware) ? target.hardware : []).filter(Boolean))].sort();
  const observedArchitecture = [...new Set(familyTargets.flatMap((target) => Array.isArray(target.architecture) ? target.architecture : []).filter(Boolean))].sort();
  // Only the target the real runner reported enters the stable config; if it was
  // never observed the field stays empty (= unknown, never a declared fallback).
  const observedDevice = familyTargets.find((target) => target.device)?.device || null;
  const observedDriverVersion = familyTargets.find((target) => target.driverVersion)?.driverVersion || null;
  // The final provider model/status/source/version are DERIVED from the frozen
  // pure summary over the retained per-run DTOs. The declared env/configured value
  // stays a separate requested-configuration field and never upgrades the proof.
  const modelObservation = collectModelEvidence();
  const modelSummary = modelObservation.summary;
  const modelObserved = modelSummary.status === 'observed';
  const finalConfig = {
    ...config,
    provider: {
      ...config.provider,
      model: modelObserved ? modelSummary.model : 'unknown',
      modelSource: modelObserved ? 'observed' : 'unknown',
      modelObservationStatus: modelSummary.status,
      modelObservationVersion: modelSummary.schemaVersion,
    },
    hardware: observedHardware,
    architecture: observedArchitecture,
    device: observedDevice,
    driverVersion: observedDriverVersion,
    observedTarget: {
      hardware: observedHardware, architecture: observedArchitecture,
      device: observedDevice, driverVersion: observedDriverVersion,
    },
  };
  const fingerprint = buildConfigFingerprint(finalConfig, { code: codeManifest });
  const timedOut = failure?.code === 'E2E_TIMEOUT';
  const outcome = combineAttemptOutcome({ failure, timedOut, familyOutcomes: summaries.map((item) => item.outcome) });
  terminalOutcome = outcome;
  // An unknown/unconfirmed stop release can never produce a full_success, even if
  // a family otherwise evaluated successfully.
  const stopConfirmed = familyStopReceipts.every((item) => item.confirmed)
    && (teardownStop === null || teardownStop.confirmed === true);
  const fullSuccess = outcome === 'full_success' && !failure && stopConfirmed;
  terminalFullSuccess = fullSuccess;
  const completedFamilies = summaries.filter((item) => item.fullSuccess).map((item) => item.family);
  const unfinishedFamilies = families.filter((family) => !completedFamilies.includes(family));
  const evidence = { runRoot, attemptPath, summaryPath, promptAuditDir, runtimeLog: runtimeLogPath,
    stateFiles: families.map((family) => path.join(runRoot, family + '-state.json')) };
  const terminalAttempt = {
    ...baseAttempt,
    phase: 'terminal',
    status: 'terminal',
    endedAt: new Date().toISOString(),
    outcome,
    fullSuccess,
    runtime: mode,
    config: finalConfig,
    // Never inherit the running attempt's declared provider copy; the terminal
    // provider is the final, summary-derived one.
    provider: finalConfig.provider,
    configFingerprint: fingerprint.fingerprint,
    fingerprintUnknownFields: fingerprint.unknownFields,
    comparable: fingerprint.comparable,
    // Per-run response-model evidence stays at top level, OUTSIDE the config hash
    // (so run/session ids cannot split a same-configuration fingerprint).
    modelObservations: modelObservation.observations,
    modelObservationRequiredRuns: modelObservation.requiredRuns,
    modelObservationSummary: modelSummary,
    modelObservationUnboundRuns: modelObservation.unboundRuns,
    // Physical sweep result of the current attempt runRoot: which safe files were
    // discovered and whether directory enumeration itself failed. Audit only; it
    // is outside the config hash and never supplies an identity.
    modelObservationSweep: modelSweep,
    // Requested (env/configured) model labels stay a separate, non-authoritative
    // field: they are never promoted and never enter the config fingerprint.
    declaredModel,
    declaredModelSource,
    // Per-family observation detail (includes the per-run sourceRunId). Kept for
    // audit only; it is deliberately excluded from the config fingerprint.
    observedTargets: familyTargets.map((target) => ({
      family: target.family || null,
      hardware: target.hardware || [], architecture: target.architecture || [],
      device: target.device || null, driverVersion: target.driverVersion || null,
      backend: target.backend || null, sourceRunId: target.sourceRunId || null,
    })),
    completedFamilies,
    unfinishedFamilies,
    familyOutcomes: summaries.map((item) => ({
      family: item.family, outcome: item.outcome, fullSuccess: item.fullSuccess, reasons: item.outcomeReasons,
      missionId: item.missionId, firstRun: item.firstRun, sourceRunId: item.sourceRunId,
      sourceRoundId: item.sourceRoundId, continuedRun: item.continuedRun,
      budgetTerminalAccepted: item.budgetTerminalAccepted, completedCandidates: item.completed.length,
    })),
    failure: failure ? { message: failure.message, code: failure.code || null } : null,
    cleanup: { runtimeSpawned, runtimeExit: exit, artifactsRetained: true, artifactsRoot: runRoot,
      // Teardown evidence: per-family confirmed stop receipts plus the finally
      // stop of a still-owned Mission after an error/timeout. Separate from
      // workflowWritesAfterStart; never a loop advance.
      stopReceipts: familyStopReceipts, teardownStop, teardownWrites },
    evidence,
  };
  await writeFile(runtimeLogPath, logs.join(''));
  await writeFile(attemptPath, JSON.stringify(terminalAttempt, null, 2));
  await writeFile(summaryPath, JSON.stringify({
    schemaVersion: GPU_SUMMARY_SCHEMA_VERSION,
    status: outcome === 'full_success' ? 'passed' : outcome === 'budget_terminal' ? 'budget_terminal' : 'failed',
    outcome,
    fullSuccess,
    runtime: mode,
    config: finalConfig,
    configFingerprint: fingerprint.fingerprint,
    fingerprintUnknownFields: fingerprint.unknownFields,
    comparable: fingerprint.comparable,
    provider: finalConfig.provider,
    families: [...families],
    completedFamilies,
    unfinishedFamilies,
    code: codeManifest,
    attemptPath,
    summaryPath,
    evidence,
    summaries,
    // Same top-level model evidence as the attempt, retained in every branch
    // (success/budget_terminal/failure/timeout) so the ledger can cross-check both.
    modelObservations: modelObservation.observations,
    modelObservationRequiredRuns: modelObservation.requiredRuns,
    modelObservationSummary: modelSummary,
    modelObservationUnboundRuns: modelObservation.unboundRuns,
    modelObservationSweep: modelSweep,
    declaredModel,
    declaredModelSource,
    // Teardown evidence retained in every branch (success/budget_terminal/
    // failure/timeout), separate from workflow writes.
    stopReceipts: familyStopReceipts,
    teardownStop,
    teardownWrites,
    failure,
    writes,
  }, null, 2));
}
if (failure) throw new Error(failure.message + '\nArtifacts: ' + runRoot);
console.log(JSON.stringify({ status: terminalOutcome, fullSuccess: terminalFullSuccess, runRoot, summaries }, null, 2));
