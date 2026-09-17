#!/usr/bin/env node
// Thin batch entry point for the real shared-GPU Agent E2E driver.
//
// It does NOT implement a second driver, scheduler, provider or Gate: every
// invocation runs the unchanged existing driver
// (`scripts/e2e-shared-gpu-agent-iteration.mjs`) as a child process and the
// existing read-only ledger (`readRunRecord` / `classifyAcceptanceRecord` /
// `summarizeAcceptanceRuns`) classifies what that driver retained. The only
// driver change this tool relies on is the artifact-parent override
// (`E2E_GPU_ARTIFACT_DIR`), so large raw run directories/logs can live in a
// private scratch directory instead of the repository snapshot.
//
// Importing this module has no side effects: no spawn, no filesystem write and no
// provider/GPU/model call. Only the CLI entry point below executes a batch.
//
// Contract documentation: scripts/run-shared-gpu-regression-batch.md
import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  buildConfigFingerprint, normalizeConfigForFingerprint, digestJson,
} from './shared-gpu-acceptance.mjs';
import {
  classifyAcceptanceRecord, readRunRecord, summarizeAcceptanceRuns,
} from './summarize-gpu-agent-runs.mjs';

export const BATCH_SCHEMA_VERSION = 'operator-studio.shared-gpu-regression-batch/v1';
export const BATCH_MODES = Object.freeze(['smoke', 'n20']);
export const BATCH_FAMILIES = Object.freeze(['affine', 'reduction', 'normalization']);
// Fixed batch contract: smoke is exactly one two-round attempt, n20 is exactly 20
// independent attempts. Nothing is reused, re-run as a substitute or topped up.
export const SMOKE_RUNS = 1;
export const N20_RUNS = 20;
// Frozen environment overrides. Everything else is inherited (provider CLI
// configuration, PATH, ...). The driver matrix/testSpec/task timeout are NOT set
// here, so the frozen production matrix and budgets are unchanged.
export const FIXED_ENV = Object.freeze({
  E2E_AGENT_RUNTIME: 'claude-code',
  E2E_GPU_CANDIDATE_TASKS: '2',
  E2E_GPU_TIMEOUT_MS: '720000',
  OPERATOR_MAIN_AGENT_BUDGET_MS: '180000',
  OPERATOR_CODEX_LOGICAL_CLEANUP_MS: '60000',
});
const PROVIDER_MODEL_KEYS = Object.freeze([
  'model', 'modelSource', 'modelObservationStatus', 'modelObservationVersion',
]);
const RETAINED_ARTIFACTS_PATTERN = /\[gpu-agent-e2e\] retained artifacts:\s*(.+?)\s*$/u;

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const driverScript = path.join(projectRoot, 'scripts', 'e2e-shared-gpu-agent-iteration.mjs');

const isNonBlank = (value) => typeof value === 'string' && value.trim().length > 0;
const uniqueStrings = (values) => [...new Set(values)];

const usage = () => [
  'Usage: node scripts/run-shared-gpu-regression-batch.mjs \\',
  '  --mode smoke|n20 --families affine|reduction,normalization \\',
  '  --artifact-dir <absolute> --report-dir <absolute> --gpu-python <absolute>',
  '',
  'smoke runs exactly 1 attempt; n20 runs exactly 20 independent affine attempts.',
  'Both directories must be absolute and must not be the repository root or one of',
  'its ancestors; a repository subdirectory (e.g. an ignored report dir) is allowed.',
  'report-dir must not exist yet (never overwritten; its parent is created).',
].join('\n');

// A directory is an acceptable external target only when it is absolute and is
// neither the repository root nor one of its ancestors: raw batch artifacts must
// never be able to swallow the source tree or its Git state.
const assertExternalDirectory = (value, flag) => {
  if (!isNonBlank(value)) throw new Error(`${flag} is required`);
  if (!path.isAbsolute(value)) throw new Error(`${flag} must be an absolute path`);
  const resolved = path.resolve(value);
  const relative = path.relative(resolved, projectRoot);
  if (relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))) {
    throw new Error(`${flag} must not be the repository root or one of its ancestors`);
  }
  return resolved;
};

const parseFamilies = (value) => {
  if (!isNonBlank(value)) throw new Error('--families is required');
  const families = value.split(',').map((item) => item.trim()).filter(Boolean);
  if (!families.length) throw new Error('--families must not be empty');
  for (const family of families) {
    if (!BATCH_FAMILIES.includes(family)) throw new Error(`unknown family: ${family}`);
  }
  if (new Set(families).size !== families.length) throw new Error('--families must not repeat a family');
  return families;
};

// Pure argv parser. Missing/unknown/duplicate/invalid arguments throw; it never
// spawns anything and never touches the filesystem.
export const parseBatchArguments = (argv = []) => {
  const args = Array.isArray(argv) ? [...argv] : [];
  const values = new Map();
  const known = new Set(['--mode', '--families', '--artifact-dir', '--report-dir', '--gpu-python']);
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (typeof token !== 'string' || !token.startsWith('--')) {
      throw new Error(`unexpected argument: ${token}`);
    }
    const [flag, inline] = token.includes('=') ? [token.slice(0, token.indexOf('=')), token.slice(token.indexOf('=') + 1)] : [token, null];
    if (!known.has(flag)) throw new Error(`unknown argument: ${flag}`);
    if (values.has(flag)) throw new Error(`duplicate argument: ${flag}`);
    const value = inline === null ? args[index += 1] : inline;
    if (!isNonBlank(value)) throw new Error(`${flag} requires a value`);
    values.set(flag, value.trim());
  }

  if (!values.has('--mode')) throw new Error('--mode is required');
  const mode = values.get('--mode');
  if (!BATCH_MODES.includes(mode)) throw new Error(`--mode must be one of: ${BATCH_MODES.join(', ')}`);

  const families = parseFamilies(values.get('--families'));
  // Only the affine family is a frozen N20 configuration; a coverage family set
  // can never be pooled into the affine denominator.
  if (mode === 'n20' && (families.length !== 1 || families[0] !== 'affine')) {
    throw new Error('n20 supports only --families affine');
  }
  if (!values.has('--artifact-dir')) throw new Error('--artifact-dir is required');
  if (!values.has('--report-dir')) throw new Error('--report-dir is required');
  if (!values.has('--gpu-python')) throw new Error('--gpu-python is required');
  const artifactDir = assertExternalDirectory(values.get('--artifact-dir'), '--artifact-dir');
  const reportDir = assertExternalDirectory(values.get('--report-dir'), '--report-dir');
  if (artifactDir === reportDir) throw new Error('--artifact-dir and --report-dir must differ');
  const gpuPython = values.get('--gpu-python');
  if (!path.isAbsolute(gpuPython)) throw new Error('--gpu-python must be an absolute path');

  return Object.freeze({ mode, families, artifactDir, reportDir, gpuPython });
};

const isStrictlyInside = (parentDir, candidate) => {
  const relative = path.relative(parentDir, candidate);
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
};

const writeAtomic = async (file, value) => {
  const temporary = `${file}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(temporary, JSON.stringify(value, null, 2));
  await rename(temporary, file);
};

const defaultEmit = (payload) => {
  console.log('DISPATCH_PROGRESS ' + JSON.stringify(payload));
};

// Open (and wait for) the raw log before the child exists: an unwritable log
// must fail the invocation instead of letting a child run with nowhere to stream
// its output. Any later stream error is captured, never left unhandled.
const openLogStream = async (logPath) => {
  const stream = createWriteStream(logPath, { flags: 'a' });
  await new Promise((resolve, reject) => {
    const onOpen = () => { stream.off('error', onError); resolve(); };
    const onError = (error) => { stream.off('open', onOpen); reject(error); };
    stream.once('open', onOpen);
    stream.once('error', onError);
  });
  return stream;
};

const closeLogStream = (stream) => new Promise((resolve) => {
  if (stream.destroyed) { resolve(); return; }
  let settled = false;
  const finish = () => { if (!settled) { settled = true; resolve(); } };
  stream.once('close', finish);
  stream.once('error', finish);
  stream.end(finish);
});

// Default invocation port: spawn the unchanged driver with shell:false, stream
// stdout/stderr chunk-by-chunk into one merged raw log (never accumulated
// unbounded in memory) and parse retained-artifacts lines for the runRoot. Raw
// chunks are written undecoded; only the stdout parse uses a StringDecoder so a
// multi-byte sequence split across chunks is never corrupted. It never spawns
// anything by itself; only runRegressionBatch calls it.
const createDefaultInvokeDriver = ({ cwd, script }) => async ({ env, logPath }) => {
  await mkdir(path.dirname(logPath), { recursive: true });
  let stream;
  try {
    stream = await openLogStream(logPath);
  } catch (error) {
    return { exitCode: null, signal: null, runRoot: null, issues: [`log_open_failed: ${error.message}`] };
  }
  const issues = [];
  let logWriteError = null;
  stream.on('error', (error) => { logWriteError ??= error.message; });
  let child;
  try {
    child = spawn(process.execPath, [script], {
      cwd, windowsHide: true, shell: false,
      stdio: ['ignore', 'pipe', 'pipe'], env,
    });
  } catch (error) {
    await closeLogStream(stream);
    return { exitCode: null, signal: null, runRoot: null, issues: [`driver spawn failed: ${error.message}`] };
  }
  const retainedRoots = [];
  const stdoutDecoder = new StringDecoder('utf8');
  let pendingLine = '';
  const collect = (line) => {
    const match = RETAINED_ARTIFACTS_PATTERN.exec(line);
    // Every occurrence is retained, including a repeated line naming the same
    // path: a duplicate line is never silently collapsed by a Set.
    if (match) retainedRoots.push(match[1].trim());
  };
  const writeChunk = (chunk) => {
    if (stream.destroyed || logWriteError) return;
    stream.write(chunk);
  };
  child.stdout.on('data', (chunk) => {
    writeChunk(chunk);
    pendingLine += stdoutDecoder.write(chunk);
    let newline = pendingLine.indexOf('\n');
    while (newline >= 0) {
      collect(pendingLine.slice(0, newline));
      pendingLine = pendingLine.slice(newline + 1);
      newline = pendingLine.indexOf('\n');
    }
    // Keep memory bounded: a pathological unterminated line is inspected once
    // and then dropped instead of growing without limit.
    if (pendingLine.length > 1_000_000) { collect(pendingLine); pendingLine = ''; }
  });
  child.stderr.on('data', (chunk) => { writeChunk(chunk); });
  const outcome = await new Promise((resolve) => {
    let settled = false;
    const finish = (value) => { if (!settled) { settled = true; resolve(value); } };
    child.on('error', (error) => finish({ exitCode: null, signal: null, error: error.message }));
    child.on('close', (code, signal) => finish({ exitCode: code, signal: signal || null, error: null }));
  });
  pendingLine += stdoutDecoder.end();
  if (pendingLine) collect(pendingLine);
  await closeLogStream(stream);
  if (outcome.error) issues.push(`driver process error: ${outcome.error}`);
  if (logWriteError) issues.push(`log_write_failed: ${logWriteError}`);
  let runRoot = null;
  if (retainedRoots.length === 1) runRoot = retainedRoots[0];
  else if (retainedRoots.length === 0) issues.push('retained_artifacts_line_missing');
  else issues.push('retained_artifacts_line_duplicated');
  return { exitCode: outcome.exitCode, signal: outcome.signal, runRoot, issues };
};

// Every started attempt gets a read-only ledger record. An attempt that started
// but retained no usable run root is represented explicitly with an empty record
// so it stays in the denominator instead of being silently dropped.
const emptyRecord = (reason) => ({ runDir: null, attemptPath: null, summaryPath: null,
  attempt: null, summary: null, errors: [reason] });

// Release/terminal safety needed before another invocation may be spawned. Both
// the attempt and the summary must be present, schema-valid, terminal and
// outcome-compatible; only the existing driver stop-receipt fields are read, and
// no release proof is invented: an absent cleanup block is never treated as safe.
//
// Exported so the experience-condition study verifies a retained slot with the
// EXACT same smoke release/observation semantics instead of a weaker copy: every
// required stop receipt AND the teardown stop AND the runtime exit must be real,
// and a missing field stays unknown (= unsafe) rather than being masked by
// whichever other field happens to be confirmed.
export const continuationSafety = (record) => {
  const attempt = record?.attempt || null;
  const summary = record?.summary || null;
  const cleanup = attempt?.cleanup || null;
  const classified = classifyAcceptanceRecord(record);
  const issues = [];
  if (!attempt) issues.push('attempt_missing');
  else {
    if (!classified.attemptSchemaValid) issues.push('attempt_schema_invalid');
    if (!classified.attemptTerminal) issues.push('attempt_not_terminal');
  }
  // A missing or non-terminal summary is not a safe terminal state, even when the
  // attempt itself claims to be terminal.
  if (!summary) issues.push('summary_missing');
  else {
    if (!classified.summarySchemaValid) issues.push('summary_schema_invalid');
    if (classified.summaryOutcome === null) issues.push('summary_not_terminal');
    if (classified.attemptOutcome !== null && classified.summaryOutcome !== null
      && classified.attemptOutcome !== classified.summaryOutcome) {
      issues.push('attempt_summary_outcome_mismatch');
    }
  }
  const receipts = Array.isArray(cleanup?.stopReceipts) ? cleanup.stopReceipts : [];
  const receiptsConfirmed = receipts.length > 0 && receipts.every((receipt) => receipt?.confirmed === true);
  const teardownConfirmed = cleanup?.teardownStop?.confirmed === true;
  // Skipping release proof is only allowed when the driver never spawned a
  // runtime (nothing to release). A spawned runtime without a confirmed stop
  // receipt is always unsafe.
  const releaseConfirmed = Boolean(cleanup) && (receiptsConfirmed || teardownConfirmed
    || (receipts.length === 0 && cleanup.runtimeSpawned !== true && !cleanup.teardownStop));
  if (!cleanup) issues.push('cleanup_missing');
  else {
    if (!releaseConfirmed) issues.push('resource_release_unconfirmed');
    if (cleanup.teardownStop && cleanup.teardownStop.confirmed !== true) issues.push('teardown_stop_unconfirmed');
    if (cleanup.runtimeSpawned === true && !cleanup.runtimeExit) issues.push('runtime_exit_missing');
  }
  return { safe: issues.length === 0, issues: uniqueStrings(issues) };
};

const modelIndependentConfigDigest = (config) => {
  if (!config || typeof config !== 'object' || Array.isArray(config)) return null;
  const clone = structuredClone(config);
  if (clone.provider && typeof clone.provider === 'object' && !Array.isArray(clone.provider)) {
    for (const key of PROVIDER_MODEL_KEYS) delete clone.provider[key];
  }
  return digestJson(normalizeConfigForFingerprint(clone));
};

const observedModelOf = (config) => {
  const provider = config?.provider;
  if (provider?.modelSource !== 'observed' || provider?.modelObservationStatus !== 'observed') return null;
  return isNonBlank(provider?.model) ? provider.model.trim() : null;
};

// Per-invocation classification for the continuously persisted batch report. The
// final end-of-batch ledger entry overwrites these fields authoritatively; this is
// only so an in-progress report already shows a useful outcome.
const classifyInvocationRecord = (record) => {
  const classified = classifyAcceptanceRecord(record);
  const attempt = record?.attempt || null;
  const summary = record?.summary || null;
  const config = attempt?.config || summary?.config || null;
  const code = attempt?.code || summary?.code || null;
  let computed = null;
  try {
    computed = config && typeof config === 'object' && Object.keys(config).length
      ? buildConfigFingerprint(config, { code }) : null;
  } catch {
    computed = { fingerprint: null, comparable: false, unknownFields: ['config'] };
  }
  return {
    outcome: classified.outcome,
    configFingerprint: computed?.fingerprint || null,
    comparable: Boolean(computed) && computed.comparable === true && classified.attemptTerminal === true,
    issues: uniqueStrings([...classified.issues]),
    config,
  };
};

export const runRegressionBatch = async (options, ports = {}) => {
  const parsed = options && options.mode && options.artifactDir && options.reportDir && options.gpuPython
    ? options
    : parseBatchArguments(options?.argv ?? []);
  const mode = parsed.mode;
  if (!BATCH_MODES.includes(mode)) throw new Error(`--mode must be one of: ${BATCH_MODES.join(', ')}`);
  const families = Array.isArray(parsed.families) ? [...parsed.families] : [];
  if (!families.length || families.some((family) => !BATCH_FAMILIES.includes(family))) {
    throw new Error(`families must be one of: ${BATCH_FAMILIES.join(', ')}`);
  }
  if (mode === 'n20' && (families.length !== 1 || families[0] !== 'affine')) {
    throw new Error('n20 supports only --families affine');
  }
  const artifactDir = assertExternalDirectory(parsed.artifactDir, '--artifact-dir');
  const reportDir = assertExternalDirectory(parsed.reportDir, '--report-dir');
  if (artifactDir === reportDir) throw new Error('--artifact-dir and --report-dir must differ');
  if (!path.isAbsolute(parsed.gpuPython)) throw new Error('--gpu-python must be an absolute path');

  // A controlled experiment condition must never be silently labeled as a strict
  // N=20 regression observation. This is checked before any directory is created or
  // any driver is spawned; the study runs through its own smoke-only runner.
  const studyEnvPresent = isNonBlank(process.env.E2E_EXPERIENCE_CONDITION)
    || isNonBlank(process.env.E2E_KERNEL_WIKI_SNAPSHOT);
  if (mode === 'n20' && studyEnvPresent) {
    throw new Error('n20 rejects the experience-condition study environment: study results are never strict N20 evidence');
  }

  const invokeDriver = typeof ports.invokeDriver === 'function'
    ? ports.invokeDriver : createDefaultInvokeDriver({ cwd: projectRoot, script: driverScript });
  const readRecord = typeof ports.readRunRecord === 'function' ? ports.readRunRecord : readRunRecord;
  const emit = typeof ports.emit === 'function' ? ports.emit : defaultEmit;
  const now = typeof ports.now === 'function' ? ports.now : (() => new Date().toISOString());
  const fixedEnv = {
    ...process.env,
    ...FIXED_ENV,
    E2E_GPU_FAMILIES: families.join(','),
    E2E_GPU_ARTIFACT_DIR: artifactDir,
    OPERATOR_GPU_PYTHON: parsed.gpuPython,
  };

  // report-dir must be new: an existing directory is never overwritten. Its
  // parent may not exist yet in a fresh snapshot, so the parent is created
  // recursively first and only then is report-dir created non-recursively, which
  // still refuses an existing report-dir. This happens before any spawn.
  await mkdir(path.dirname(reportDir), { recursive: true });
  await mkdir(reportDir, { recursive: false });
  await mkdir(artifactDir, { recursive: true });
  const logsDir = path.join(artifactDir, 'logs');
  await mkdir(logsDir, { recursive: true });
  const batchPath = path.join(reportDir, 'batch.json');
  const ledgerPath = path.join(reportDir, 'ledger.json');

  const requestedRuns = mode === 'n20' ? N20_RUNS : SMOKE_RUNS;
  const invocations = Array.from({ length: requestedRuns }, (_, index) => ({
    index,
    status: 'pending',
    startedAt: null,
    finishedAt: null,
    exitCode: null,
    signal: null,
    runRoot: null,
    logPath: path.join(logsDir, `run-${String(index + 1).padStart(2, '0')}.log`),
    outcome: null,
    comparable: null,
    configFingerprint: null,
    issues: [],
  }));
  const batch = {
    schemaVersion: BATCH_SCHEMA_VERSION,
    mode,
    families,
    requestedRuns,
    startedAt: now(),
    finishedAt: null,
    status: 'running',
    invocations,
    stopReason: null,
    strictN20Passed: false,
  };
  // First report write happens before any spawn so an interrupted batch is still
  // visible with its full original denominator.
  await writeAtomic(batchPath, batch);
  emit({ phase: 'start', completed: 0, total: requestedRuns, message: `batch ${mode} started` });

  const records = [];
  const observedModels = new Set();
  let referenceConfigDigest = null;
  let stopReason = null;

  for (let index = 0; index < requestedRuns; index += 1) {
    const invocation = invocations[index];
    if (stopReason) {
      invocation.status = 'stopped';
      invocation.issues = uniqueStrings([...invocation.issues, 'batch_stopped']);
      batch.stopReason = stopReason;
      await writeAtomic(batchPath, batch);
      continue;
    }
    invocation.status = 'running';
    invocation.startedAt = now();
    await writeAtomic(batchPath, batch);
    emit({ phase: 'run', completed: index, total: requestedRuns, message: `invocation ${index + 1}/${requestedRuns} started` });

    let result;
    try {
      result = await invokeDriver({ index, env: fixedEnv, logPath: invocation.logPath });
    } catch (error) {
      result = { exitCode: null, signal: null, runRoot: null, issues: [`driver invocation threw: ${error.message}`] };
    }
    invocation.finishedAt = now();
    invocation.exitCode = Number.isInteger(result?.exitCode) ? result.exitCode : null;
    invocation.signal = isNonBlank(result?.signal) ? result.signal : null;
    const issues = [...(result?.issues || [])];
    let runRoot = isNonBlank(result?.runRoot) ? path.resolve(result.runRoot) : null;
    if (!runRoot) issues.push('run_root_missing');
    else if (!isStrictlyInside(artifactDir, runRoot)) {
      // Never guess an original artifact outside the declared external directory.
      issues.push('run_root_out_of_scope');
      runRoot = null;
    }
    invocation.runRoot = runRoot;
    // A reader/port failure still yields an explicit missing record and a
    // terminal batch write below; it never aborts the loop with a live "running"
    // entry left behind.
    let record;
    if (runRoot) {
      try {
        record = await readRecord(runRoot);
      } catch (error) {
        record = emptyRecord(`run record read failed: ${error.message}`);
        issues.push('run_record_read_failed');
      }
    } else {
      record = emptyRecord('no run root was retained for this invocation');
    }
    records.push(record);

    const classified = classifyInvocationRecord(record);
    invocation.outcome = classified.outcome;
    invocation.configFingerprint = classified.configFingerprint;
    invocation.comparable = classified.comparable;
    invocation.issues = uniqueStrings([...issues, ...classified.issues]);
    invocation.status = invocation.exitCode === 0 && runRoot !== null ? 'completed' : 'failed';

    // Any invoker/retained-artifact problem is a batch-level stop condition and
    // forces the final status to failed; it is never silently absorbed.
    if (issues.length > 0) stopReason ??= `invoker_issue: ${uniqueStrings(issues).join(', ')}`;

    const safety = continuationSafety(record);
    if (!safety.safe) stopReason ??= `unsafe_continuation: ${safety.issues.join(', ')}`;

    const config = classified.config;
    const observedModel = observedModelOf(config);
    if (observedModel) {
      if (observedModels.size > 0 && !observedModels.has(observedModel)) {
        stopReason ??= `observed_model_drift: ${[...observedModels].join(', ')} vs ${observedModel}`;
      }
      observedModels.add(observedModel);
    }
    const configDigest = modelIndependentConfigDigest(config);
    if (configDigest) {
      if (referenceConfigDigest === null) referenceConfigDigest = configDigest;
      else if (referenceConfigDigest !== configDigest) stopReason ??= 'config_or_source_drift';
    }

    if (mode === 'smoke' && (invocation.exitCode !== 0 || classified.outcome !== 'full_success')) {
      stopReason ??= `smoke_not_full_success: ${classified.outcome}`;
    }

    batch.stopReason = stopReason;
    await writeAtomic(batchPath, batch);
    emit({ phase: 'run', completed: index + 1, total: requestedRuns,
      message: `invocation ${index + 1}/${requestedRuns} finished: ${invocation.status}/${classified.outcome}` });
  }

  batch.stopReason = stopReason;
  batch.finishedAt = now();
  const ledger = summarizeAcceptanceRuns(records);
  await writeAtomic(ledgerPath, ledger);

  // The end-of-batch ledger is authoritative for the per-invocation comparison
  // fields: it independently recomputes fingerprint, comparability and model
  // proof over the retained records, in the original invocation order.
  for (const group of ledger.groups) {
    for (const entry of group.runs) {
      const invocation = invocations[entry.index];
      if (!invocation) continue;
      invocation.outcome = entry.outcome;
      invocation.comparable = entry.comparable;
      invocation.configFingerprint = entry.configFingerprint;
      invocation.issues = uniqueStrings([
        ...invocation.issues, ...entry.issues, ...entry.comparabilityIssues, ...entry.modelObservationIssues,
      ]);
    }
  }

  const allRunsFullSuccess = invocations.length === requestedRuns
    && invocations.every((invocation) => invocation.status === 'completed'
      && invocation.exitCode === 0 && invocation.outcome === 'full_success');
  const eligibleGroup = ledger.groups.find((group) => group.n20.eligible && group.counts.runs >= requestedRuns) || null;
  // A pass requires more than a good outcome count: no stop reason may have been
  // recorded (so every started attempt reached a safe, release-confirmed terminal
  // state with no invoker issue) and the ledger group must independently classify
  // all requested runs as comparable full successes.
  const strictN20Passed = mode === 'n20' && requestedRuns === N20_RUNS && allRunsFullSuccess
    && stopReason === null && Boolean(eligibleGroup)
    && eligibleGroup.counts.full_success === requestedRuns;
  // smoke additionally requires the single attempt to be comparable (an unknown
  // response model keeps its full_success workflow outcome but fails the batch).
  const smokePassed = mode === 'smoke' && allRunsFullSuccess && stopReason === null
    && invocations[0]?.comparable === true;
  batch.strictN20Passed = strictN20Passed;
  batch.status = (mode === 'smoke' ? smokePassed : strictN20Passed) ? 'passed' : 'failed';
  await writeAtomic(batchPath, batch);
  emit({ phase: 'finish', completed: invocations.filter((invocation) => invocation.status !== 'pending' && invocation.status !== 'stopped').length,
    total: requestedRuns, message: `batch ${batch.status}${stopReason ? ` (${stopReason})` : ''}` });

  return {
    schemaVersion: BATCH_SCHEMA_VERSION,
    mode,
    families,
    status: batch.status,
    strictN20Passed,
    stopReason,
    exitCode: batch.status === 'passed' ? 0 : 1,
    batchPath,
    ledgerPath,
    batch,
    ledger,
  };
};

const main = async () => {
  let options;
  try {
    options = parseBatchArguments(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    console.error(usage());
    process.exitCode = 1;
    return;
  }
  try {
    const result = await runRegressionBatch(options);
    process.exitCode = result.exitCode;
  } catch (error) {
    console.error(`batch setup failed: ${error.message}`);
    process.exitCode = 1;
  }
};

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  await main();
}
