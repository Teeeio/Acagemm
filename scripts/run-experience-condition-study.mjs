#!/usr/bin/env node
// Thin nine-slot orchestration for the controlled experience-condition study.
//
// It implements no second driver, scheduler, provider, Gate or acceptance threshold:
// every scheduled slot runs the UNCHANGED existing smoke batch CLI
// (`scripts/run-shared-gpu-regression-batch.mjs --mode smoke --families affine ...`)
// as a child process with a fixed argv (shell:false), which in turn runs the
// unchanged live driver. This runner only fixes the condition/snapshot environment,
// writes the complete nine-slot report before the first process starts, and verifies
// what the retained raw artifacts actually say.
//
// Importing this module has no side effects: no spawn, no filesystem write and no
// provider/GPU/model call. Only the CLI entry point below runs a study.
//
// Contract documentation: scripts/run-experience-condition-study.md
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import {
  mkdir, readFile, readdir, realpath, rename, stat, writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { WIKI_SELECTION_POLICY_VERSION } from '../client-runtime/experience-selection.mjs';
import { classifyAcceptanceRecord, readRunRecord } from './summarize-gpu-agent-runs.mjs';
import { continuationSafety } from './run-shared-gpu-regression-batch.mjs';
import {
  buildConfigFingerprint, canonicalJson, digestJson, hexDigest, normalizeConfigForFingerprint,
} from './shared-gpu-acceptance.mjs';
import {
  EXPERIENCE_STUDY_GOAL_POLICY_VERSION, EXPERIENCE_STUDY_SCHEMA_VERSION, EXPERIENCE_STUDY_SLOTS,
  buildStudySchedule, studySnapshotIdentity, verifyExperienceConditionAudit,
} from './experience-condition-study.mjs';

export const STUDY_RUNNER_SCHEMA_VERSION = 'operator-studio.experience-condition-study-runner/v1';
export const STUDY_FAMILY = 'affine';
export const STUDY_PROFILES = Object.freeze(['primary', 'small']);
const REPORT_FILE = 'study.json';
const BATCH_SCRIPT = path.join('scripts', 'run-shared-gpu-regression-batch.mjs');
const STATE_FILE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*-state\.json$/u;

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const isNonBlank = (value) => typeof value === 'string' && value.trim().length > 0;
const isPlainObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const uniqueStrings = (values) => [...new Set(values)];
const sha256Hex = (bytes) => createHash('sha256').update(bytes).digest('hex');

const usage = () => [
  'Usage: node scripts/run-experience-condition-study.mjs \\',
  '  --snapshot <absolute kernel-wiki snapshot> --artifact-dir <absolute> \\',
  '  --report-dir <absolute> --gpu-python <absolute>',
  '',
  'Read-only verification of a retained report (no process/model/GPU start):',
  '  node scripts/run-experience-condition-study.mjs --verify-report <report dir|study.json>',
  '',
  `The fixed nine-slot schedule (${EXPERIENCE_STUDY_SLOTS} affine smoke invocations) is`,
  'written to report-dir/study.json before the first child process starts.',
  'report-dir must not exist yet; artifact/report dirs must be absolute, must not be',
  'the repository root or one of its ancestors, must not overlap each other, and the',
  'snapshot must stay outside both.',
].join('\n');

const isStrictlyInside = (parentDir, candidate) => {
  const relative = path.relative(parentDir, candidate);
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
};
const isInsideOrSame = (parentDir, candidate) => {
  const relative = path.relative(parentDir, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
};

// Raw study artifacts must never be able to swallow the source tree or its Git state.
const assertExternalDirectory = (value, flag) => {
  if (!isNonBlank(value)) throw new Error(`${flag} is required`);
  if (!path.isAbsolute(value)) throw new Error(`${flag} must be an absolute path`);
  const resolved = path.resolve(value);
  if (isInsideOrSame(resolved, projectRoot)) {
    throw new Error(`${flag} must not be the repository root or one of its ancestors`);
  }
  return resolved;
};

/**
 * Pure argv parser. Missing/unknown/duplicate/invalid arguments throw; it never
 * spawns anything and never touches the filesystem. Filesystem-only facts (does the
 * snapshot exist, is a directory a junction/alias) are validated by
 * `runExperienceStudy` before it creates or spawns anything.
 */
export const parseStudyArguments = (argv = []) => {
  const args = Array.isArray(argv) ? [...argv] : [];
  const values = new Map();
  const known = new Set(['--snapshot', '--artifact-dir', '--report-dir', '--gpu-python', '--verify-report']);
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (typeof token !== 'string' || !token.startsWith('--')) throw new Error(`unexpected argument: ${token}`);
    const separator = token.indexOf('=');
    const [flag, inline] = separator >= 0 ? [token.slice(0, separator), token.slice(separator + 1)] : [token, null];
    if (!known.has(flag)) throw new Error(`unknown argument: ${flag}`);
    if (values.has(flag)) throw new Error(`duplicate argument: ${flag}`);
    const value = inline === null ? args[index += 1] : inline;
    if (!isNonBlank(value)) throw new Error(`${flag} requires a value`);
    values.set(flag, value.trim());
  }

  if (values.has('--verify-report')) {
    if (values.size !== 1) throw new Error('--verify-report accepts no other argument');
    const reportPath = values.get('--verify-report');
    if (!path.isAbsolute(reportPath)) throw new Error('--verify-report must be an absolute path');
    return Object.freeze({ mode: 'verify-report', reportPath: path.resolve(reportPath) });
  }

  if (!values.has('--snapshot')) throw new Error('--snapshot is required');
  if (!values.has('--artifact-dir')) throw new Error('--artifact-dir is required');
  if (!values.has('--report-dir')) throw new Error('--report-dir is required');
  if (!values.has('--gpu-python')) throw new Error('--gpu-python is required');
  const snapshot = values.get('--snapshot');
  if (!path.isAbsolute(snapshot)) throw new Error('--snapshot must be an absolute path');
  const artifactDir = assertExternalDirectory(values.get('--artifact-dir'), '--artifact-dir');
  const reportDir = assertExternalDirectory(values.get('--report-dir'), '--report-dir');
  if (artifactDir === reportDir) throw new Error('--artifact-dir and --report-dir must differ');
  if (isStrictlyInside(artifactDir, reportDir) || isStrictlyInside(reportDir, artifactDir)) {
    throw new Error('--artifact-dir and --report-dir must not overlap');
  }
  if (isInsideOrSame(artifactDir, snapshot) || isInsideOrSame(reportDir, snapshot)) {
    throw new Error('--snapshot must stay outside --artifact-dir and --report-dir');
  }
  const gpuPython = values.get('--gpu-python');
  if (!path.isAbsolute(gpuPython)) throw new Error('--gpu-python must be an absolute path');
  return Object.freeze({ mode: 'study', snapshot: path.resolve(snapshot), artifactDir, reportDir, gpuPython });
};

// ---------------------------------------------------------------------------
// filesystem layout / alias validation (before any effect)
// ---------------------------------------------------------------------------

const realpathIfPresent = async (target) => {
  try { return await realpath(target); } catch { return null; }
};
// Resolve a path that may not exist yet by realpath-ing its deepest existing
// ancestor: a Windows junction/symlink in any existing segment is therefore visible
// before the study creates a single directory.
const realpathProspective = async (target) => {
  const tail = [];
  let current = path.resolve(target);
  for (;;) {
    const resolved = await realpathIfPresent(current);
    if (resolved !== null) return tail.length ? path.join(resolved, ...tail.reverse()) : resolved;
    const parentDir = path.dirname(current);
    if (parentDir === current) return null;
    tail.push(path.basename(current));
    current = parentDir;
  }
};

const assertStudyLayout = async ({ artifactDir, reportDir, snapshot }) => {
  const realArtifact = await realpathProspective(artifactDir);
  const realReport = await realpathProspective(reportDir);
  const realSnapshot = await realpathIfPresent(snapshot);
  assert.ok(realSnapshot !== null, `--snapshot does not exist: ${snapshot}`);
  const realRoot = await realpathIfPresent(projectRoot);
  for (const [flag, resolved] of [['--artifact-dir', realArtifact], ['--report-dir', realReport]]) {
    assert.ok(resolved !== null, `${flag} has no resolvable ancestor directory`);
    if (realRoot && isInsideOrSame(resolved, realRoot)) {
      throw new Error(`${flag} resolves inside the repository (alias/junction): ${resolved}`);
    }
  }
  if (realArtifact === realReport) throw new Error('--artifact-dir and --report-dir resolve to the same directory');
  if (isStrictlyInside(realArtifact, realReport) || isStrictlyInside(realReport, realArtifact)) {
    throw new Error('--artifact-dir and --report-dir must not overlap after alias resolution');
  }
  if (isInsideOrSame(realArtifact, realSnapshot) || isInsideOrSame(realReport, realSnapshot)) {
    throw new Error('--snapshot must stay outside the study outputs after alias resolution');
  }
  const existing = await realpathIfPresent(reportDir);
  if (existing !== null) throw new Error('--report-dir must not exist yet (never overwritten)');
  return { realArtifact, realReport, realSnapshot };
};

// ---------------------------------------------------------------------------
// child process / raw log plumbing
// ---------------------------------------------------------------------------

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

/**
 * Default invocation port (documented public process adapter).
 *
 * Parameters: `{cwd, script}` — the working directory of the child and the absolute
 * path of the unchanged existing smoke batch CLI. Both are fixed by the study CLI
 * (`projectRoot` and `scripts/run-shared-gpu-regression-batch.mjs`); the CLI exposes
 * no flag, environment override or alternate script for either.
 *
 * Returns the async invocation port receiving `{index, condition, artifactDir,
 * reportDir, snapshot, gpuPython}` — the slot's own exclusive directory pair plus the
 * fixed condition and snapshot. It spawns the unchanged smoke CLI with a fixed argv
 * and `shell:false`, streams stdout/stderr byte-exactly into one raw log, and returns
 * `{exitCode, signal, issues, logPath}` with the REAL child exit code; a nonzero exit
 * can never be masked by stdout.
 *
 * Side effects: it creates `<artifactDir>/logs` and appends `<artifactDir>/logs/
 * slot-NN.log` — exactly the `logPath` the schedule retains. It NEVER creates or
 * writes into `reportDir`: the smoke child creates its own `--report-dir`
 * non-recursively and refuses an existing one.
 */
export const createDefaultInvokeSmoke = ({ cwd, script }) => async ({
  index, condition, artifactDir, reportDir, snapshot, gpuPython,
}) => {
  // The retained slot log lives in the slot's own ARTIFACT directory, exactly matching
  // slotDirectories().logPath; reportDir stays untouched for the child to create.
  const logPath = path.join(artifactDir, 'logs', `slot-${String(index).padStart(2, '0')}.log`);
  await mkdir(path.dirname(logPath), { recursive: true });
  let stream;
  try { stream = await openLogStream(logPath); }
  catch (error) { return { exitCode: null, signal: null, issues: [`log_open_failed: ${error.message}`] }; }
  const issues = [];
  let logWriteError = null;
  stream.on('error', (error) => { logWriteError ??= error.message; });
  let child;
  try {
    child = spawn(process.execPath, [script,
      '--mode', 'smoke', '--families', STUDY_FAMILY,
      '--artifact-dir', artifactDir, '--report-dir', reportDir, '--gpu-python', gpuPython,
    ], {
      cwd, windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'],
      // Only the fixed condition and the fixed snapshot enter the child; no credential
      // value is copied into any artifact.
      env: { ...process.env, E2E_EXPERIENCE_CONDITION: condition, E2E_KERNEL_WIKI_SNAPSHOT: snapshot },
    });
  } catch (error) {
    await closeLogStream(stream);
    return { exitCode: null, signal: null, issues: [`smoke spawn failed: ${error.message}`] };
  }
  const writeChunk = (chunk) => {
    if (stream.destroyed || logWriteError) return;
    stream.write(chunk);
  };
  child.stdout.on('data', writeChunk);
  child.stderr.on('data', writeChunk);
  const outcome = await new Promise((resolve) => {
    let settled = false;
    const finish = (value) => { if (!settled) { settled = true; resolve(value); } };
    child.on('error', (error) => finish({ exitCode: null, signal: null, error: error.message }));
    child.on('close', (code, signal) => finish({ exitCode: code, signal: signal || null, error: null }));
  });
  await closeLogStream(stream);
  if (outcome.error) issues.push(`smoke process error: ${outcome.error}`);
  if (logWriteError) issues.push(`log_write_failed: ${logWriteError}`);
  return { exitCode: outcome.exitCode, signal: outcome.signal, issues, logPath };
};

// ---------------------------------------------------------------------------
// raw evidence readers (shared by the live runner and the read-only verifier)
// ---------------------------------------------------------------------------

const readJsonFile = async (target, label) => {
  let raw;
  try { raw = await readFile(target); }
  catch (error) { throw new Error(`${label} is unreadable: ${error.message}`); }
  try { return { value: JSON.parse(raw.toString('utf8')), bytes: raw }; }
  catch (error) { throw new Error(`${label} is not valid JSON: ${error.message}`); }
};

const latestRecords = (records) => {
  const byId = new Map();
  for (const record of Array.isArray(records) ? records : []) {
    if (!isPlainObject(record) || !isNonBlank(record.id)) continue;
    const head = byId.get(record.id);
    if (!head || (Number.isInteger(record.version) && record.version > head.version)) byId.set(record.id, record);
  }
  return [...byId.values()];
};

const candidateDigestOf = (task) => hexDigest(task?.payload?.candidate?.digest
  || task?.result?.environment?.candidateDigest);
const orderCompleted = (tasks) => [...tasks].sort((left, right) => {
  const at = Date.parse(left?.completedAt || '') || 0;
  const bt = Date.parse(right?.completedAt || '') || 0;
  return at - bt || String(left?.taskId || '').localeCompare(String(right?.taskId || ''));
});

// The retained pre-send audit for exactly the frozen target round of the verified
// candidate's own archived round: never the newest file, never a same-round
// recovery run.
const findRetainedAudit = async ({ auditDir, missionId, roundId, sourceRunId }) => {
  let names = [];
  try { names = await readdir(auditDir); } catch { return { audit: null, path: null, matched: [] }; }
  const matched = [];
  for (const name of names.filter((item) => item.endsWith('.json')).sort()) {
    const full = path.join(auditDir, name);
    let parsed;
    try { parsed = JSON.parse(await readFile(full, 'utf8')); } catch { continue; }
    if (parsed?.missionId !== missionId || parsed?.roundId !== roundId
      || parsed?.deliveryStage !== 'prepared-before-send') continue;
    matched.push({ path: full, runId: parsed.runId || null, createdAt: parsed.createdAt || null, audit: parsed });
  }
  const candidates = matched.filter((item) => item.runId && item.runId !== sourceRunId)
    .sort((left, right) => String(left.createdAt || '').localeCompare(String(right.createdAt || ''))
      || String(left.runId).localeCompare(String(right.runId)));
  return { audit: candidates[0]?.audit ?? null, path: candidates[0]?.path ?? null,
    matched: matched.map((item) => item.runId) };
};

const profileRows = (task) => Object.fromEntries((Array.isArray(task?.result?.benchmark) ? task.result.benchmark : [])
  .filter((row) => isNonBlank(row?.profile))
  .map((row) => [row.profile, {
    value: Number.isFinite(row.value) ? row.value : null,
    unit: isNonBlank(row.unit) ? row.unit : null,
    samples: Number.isFinite(row.samples) ? row.samples : null,
    correctnessPassed: row.correctness?.passed === true,
    correctnessCases: Number.isFinite(row.correctness?.passedCases) ? row.correctness.passedCases : null,
    correctnessTotal: Number.isFinite(row.correctness?.total) ? row.correctness.total : null,
  }]));

// Per-invocation result metrics, recomputed from the retained raw state/task
// benchmark and the driver's terminal summary/attempt. Only fields the real
// producer writes are read (`summary.summaries[]` is the driver DTO that carries
// `missionId`/`workflowWritesAfterStart`; `attempt.familyOutcomes[]` carries the
// same family/mission binding). Missing values stay null: nothing is invented, and
// profiles are never pooled.
const extractMetrics = ({ rawState, attempt, summary }) => {
  const state = isPlainObject(rawState?.state) ? rawState.state : {};
  const tasks = Array.isArray(rawState?.tasks) ? rawState.tasks : [];
  const familySummary = isPlainObject(summary?.summaries?.[0]) ? summary.summaries[0]
    : (isPlainObject(attempt?.familyOutcomes?.[0]) ? attempt.familyOutcomes[0] : {});
  const family = familySummary.family ?? STUDY_FAMILY;
  const missionId = familySummary.missionId ?? null;
  const missionTasks = tasks.filter((task) => task?.payload?.missionId === missionId);
  const baselineTask = [...missionTasks].filter((task) => task.payload?.purpose === 'baseline'
    && task.status === 'completed').pop() ?? null;
  const candidateTasks = orderCompleted(missionTasks.filter((task) => task.payload?.purpose === 'candidate'
    && task.status === 'completed'));
  const startedAt = isNonBlank(attempt?.startedAt) ? attempt.startedAt : null;
  const endedAt = isNonBlank(attempt?.endedAt) ? attempt.endedAt : null;
  const elapsedMs = startedAt && endedAt ? Date.parse(endedAt) - Date.parse(startedAt) : null;
  const requiredRuns = Array.isArray(attempt?.modelObservationRequiredRuns) ? attempt.modelObservationRequiredRuns : null;
  const observations = Array.isArray(attempt?.modelObservations) ? attempt.modelObservations : null;
  return {
    family,
    missionId,
    baseline: baselineTask ? {
      taskId: baselineTask.taskId ?? null,
      startedAt: baselineTask.startedAt ?? null,
      completedAt: baselineTask.completedAt ?? null,
      durationMs: Number.isFinite(baselineTask.durationMs) ? baselineTask.durationMs : null,
      profiles: profileRows(baselineTask),
      releaseConfirmed: baselineTask.resourceRelease?.confirmed === true,
    } : null,
    candidates: candidateTasks.map((task) => ({
      taskId: task.taskId ?? null,
      candidateId: task.payload?.candidate?.id ?? null,
      candidateDigest: candidateDigestOf(task),
      queueRequestId: task.payload?.requestId ?? null,
      packageDigest: task.payload?.packageDigest ?? null,
      startedAt: task.startedAt ?? null,
      completedAt: task.completedAt ?? null,
      durationMs: Number.isFinite(task.durationMs) ? task.durationMs : null,
      profiles: profileRows(task),
      correctnessPassed: (Array.isArray(task.result?.benchmark) ? task.result.benchmark : [])
        .every((row) => row?.correctness?.passed === true),
      releaseConfirmed: task.resourceRelease?.confirmed === true,
      executionSource: task.result?.environment?.source ?? null,
      liveHardware: task.result?.environment?.liveHardware === true,
    })),
    attempts: {
      roundCount: Number.isFinite(state.iterationStats?.round) ? state.iterationStats.round : null,
      completedRounds: Array.isArray(state.runHistory) ? state.runHistory.length : null,
    },
    elapsedMs: Number.isFinite(elapsedMs) ? elapsedMs : null,
    startedAt,
    endedAt,
    model: {
      status: attempt?.modelObservationSummary?.status ?? null,
      observedModel: isNonBlank(attempt?.modelObservationSummary?.model) ? attempt.modelObservationSummary.model : null,
      // Each started agent run is one provider model request; a run whose response
      // was never retained still counts, so the number never looks better than reality.
      requestCount: requiredRuns ? requiredRuns.length : null,
      observedResponses: observations ? observations.length : null,
    },
    workflow: {
      outcome: familySummary.outcome ?? null,
      fullSuccess: familySummary.fullSuccess === true,
      // Written by the driver's retained family summary (`summary.summaries[]`), not
      // by the narrower attempt.familyOutcomes projection.
      workflowWritesAfterStart: Number.isFinite(familySummary.workflowWritesAfterStart)
        ? familySummary.workflowWritesAfterStart : null,
    },
  };
};

// The retained report of the one smoke batch this slot ran. It is the independent
// record of the REAL child exit: a slot may only be recomputed when its own batch
// report says the smoke invocation completed with exit code 0, was comparable and
// fully successful. `reportDir` is the slot's own exclusive directory (the same one
// the runner handed to invokeSmoke) — a parent directory is never borrowed.
const readSmokeBatchReport = async ({ index, reportDir, artifactDir }) => {
  const batch = await readJsonFile(path.join(reportDir, 'batch.json'), `slot ${index} batch report`);
  const value = batch.value;
  assert.ok(isPlainObject(value), `slot ${index} batch report must be a JSON object`);
  assert.equal(value.mode, 'smoke', `slot ${index} batch report is not a smoke invocation`);
  assert.deepEqual(value.families, [STUDY_FAMILY], `slot ${index} batch report ran a different family set`);
  assert.equal(value.requestedRuns, 1, `slot ${index} batch report did not request exactly one smoke attempt`);
  assert.equal(value.strictN20Passed, false, `slot ${index} batch report claims strict N20`);
  assert.equal(value.status, 'passed', `slot ${index} smoke batch status is ${value.status ?? 'missing'}, not passed`);
  const invocation = Array.isArray(value.invocations) ? value.invocations[0] : null;
  assert.ok(isPlainObject(invocation), `slot ${index} batch report has no invocation record`);
  assert.equal(invocation.index, 0, `slot ${index} batch report invocation index is not 0`);
  assert.equal(invocation.status, 'completed', `slot ${index} smoke invocation status is ${invocation.status ?? 'missing'}`);
  assert.equal(invocation.exitCode, 0, `slot ${index} smoke invocation exit code is ${invocation.exitCode ?? 'missing'}`);
  assert.equal(invocation.outcome, 'full_success', `slot ${index} smoke invocation outcome is ${invocation.outcome ?? 'missing'}`);
  assert.equal(invocation.comparable, true, `slot ${index} smoke invocation is not comparable`);
  const runRoot = isNonBlank(invocation.runRoot) ? path.resolve(invocation.runRoot) : null;
  assert.ok(runRoot, `slot ${index} batch report retained no run root`);
  assert.ok(isStrictlyInside(artifactDir, runRoot),
    `slot ${index} retained run root is outside the slot artifact directory`);
  return {
    runRoot,
    status: value.status,
    stopReason: value.stopReason ?? null,
    exitCode: invocation.exitCode,
    outcome: invocation.outcome,
    comparable: invocation.comparable === true,
    configFingerprint: invocation.configFingerprint ?? null,
    issues: Array.isArray(invocation.issues) ? [...invocation.issues] : [],
  };
};

// The retained batch verdict of a slot WITHOUT requiring a pass, used by the
// read-only verifier to prove that a non-zero study exit is not contradicted by a
// batch report that claims success. An unreadable report stays unknown (null).
//
// Three process layers meet in this one file and they carry separate exit meanings:
// the smoke batch child exit is the STUDY slot's `exitCode`, while
// `invocations[0].exitCode` is the nested live-driver exit. The nested record is
// therefore read as evidence of what the driver really did (its own status,
// comparability and issues), never as a second copy of the same number.
const readRetainedBatchStatus = async (reportDir) => {
  try {
    const parsed = await readJsonFile(path.join(reportDir, 'batch.json'), 'slot batch report');
    const value = parsed.value;
    if (!isPlainObject(value)) return null;
    const invocations = Array.isArray(value.invocations) ? value.invocations : null;
    const invocation = isPlainObject(invocations?.[0]) ? invocations[0] : null;
    return {
      status: value.status ?? null,
      requestedRuns: Number.isInteger(value.requestedRuns) ? value.requestedRuns : null,
      invocationCount: invocations ? invocations.length : null,
      invocationStatus: invocation?.status ?? null,
      invocationExitCode: invocation?.exitCode ?? null,
      invocationComparable: invocation?.comparable ?? null,
      invocationIssues: Array.isArray(invocation?.issues) ? [...invocation.issues] : null,
    };
  } catch { return null; }
};

// Everything relevant that a slot can only learn by reading its own retained raw
// files. The live runner stores this in study.json; the read-only verifier
// recomputes it from the same originals and refuses a changed artifact or a report
// that disagrees with them.
const readSlotEvidence = async ({ index, condition, artifactDir, reportDir, snapshot }) => {
  const snapshotParsed = await readJsonFile(snapshot, 'kernel wiki snapshot');
  const snapshotIdentity = studySnapshotIdentity(snapshotParsed.value);
  const batch = await readSmokeBatchReport({ index, reportDir, artifactDir });
  const runRoot = batch.runRoot;

  const record = await readRunRecord(runRoot);
  const attempt = record.attempt;
  assert.ok(isPlainObject(attempt), `slot ${index} retained no attempt.json`);

  const stateName = (await readdir(runRoot)).find((name) => STATE_FILE_PATTERN.test(name)) ?? null;
  assert.ok(stateName, `slot ${index} retained no per-family state file`);
  const stateFile = path.join(runRoot, stateName);
  const rawState = await readJsonFile(stateFile, `slot ${index} state file`);

  const missionId = attempt?.familyOutcomes?.[0]?.missionId ?? null;
  assert.ok(isNonBlank(missionId), `slot ${index} attempt has no Mission id`);
  const completed = orderCompleted((Array.isArray(rawState.value?.tasks) ? rawState.value.tasks : [])
    .filter((task) => task?.payload?.missionId === missionId && task.payload?.purpose === 'candidate'
      && task.status === 'completed'));
  const verifiedTask = completed[0] ?? null;
  assert.ok(verifiedTask, `slot ${index} retained no completed candidate task`);

  const digest = candidateDigestOf(verifiedTask);
  const queueRequestId = verifiedTask.payload?.requestId ?? null;
  assert.ok(digest && queueRequestId, `slot ${index} verified candidate is missing its digest / queue request id`);
  const matches = (Array.isArray(rawState.value?.state?.runHistory) ? rawState.value.state.runHistory : [])
    .filter((round) => hexDigest(round?.candidateDigest) === digest && round?.queueRequestId === queueRequestId);
  assert.equal(matches.length, 1,
    `slot ${index} verified candidate must match exactly one archived round (found ${matches.length})`);
  const sourceRound = matches[0];
  const targetRoundId = sourceRound.roundFacts?.target?.roundId;
  assert.ok(isNonBlank(targetRoundId), `slot ${index} source round archive has no frozen target roundId`);

  const auditScan = await findRetainedAudit({
    auditDir: path.join(runRoot, 'bridge', 'prompt-audits'),
    missionId, roundId: targetRoundId, sourceRunId: sourceRound.runId,
  });
  assert.ok(auditScan.audit?.prompt, `slot ${index} retained no prepared-before-send audit for ${targetRoundId}`);

  const state = rawState.value?.state ?? {};
  const projectId = isNonBlank(state.activeProjectId) ? state.activeProjectId
    : (isNonBlank(state.projects?.[0]?.id) ? state.projects[0].id : null);
  assert.ok(projectId, `slot ${index} retained state has no active project id`);
  assert.equal(auditScan.audit.projectId, projectId,
    `slot ${index} audited project does not match the retained active project`);

  // The production experience store this driver run actually used
  // (`OPERATOR_RUNTIME_DIR` = runRoot/runtime, repository file
  // `runtime/experiences/experiences.json`). It is required: every study condition
  // needs the durable collection record, so a missing store is an unreadable slot,
  // never "zero selected experience".
  const experiencesFile = path.join(runRoot, 'runtime', 'experiences', 'experiences.json');
  const parsedExperiences = await readJsonFile(experiencesFile, `slot ${index} experience store`);
  assert.ok(Array.isArray(parsedExperiences.value?.records),
    `slot ${index} experience store has no records array`);
  const experiences = latestRecords(parsedExperiences.value.records);

  const receipt = verifyExperienceConditionAudit({
    condition, audit: auditScan.audit, sourceRound, experiences, missionId, projectId,
    snapshot: snapshotParsed.value,
  });
  assert.equal(receipt.snapshot.snapshotDigest, snapshotIdentity.snapshotDigest,
    `slot ${index} verified snapshot identity changed while the study ran`);

  // The driver's own study-audit.json is a sidecar: it must agree with what the raw
  // artifacts recomputed above, and it is never the authority.
  const driverAuditPath = path.join(runRoot, 'study-audit.json');
  let driverAudit = null;
  try { driverAudit = JSON.parse(await readFile(driverAuditPath, 'utf8')); } catch { driverAudit = null; }
  assert.ok(isPlainObject(driverAudit), `slot ${index} retained no driver study-audit.json`);
  assert.equal(driverAudit.condition, condition, `slot ${index} driver study audit records a different condition`);
  assert.equal(driverAudit.snapshot?.snapshotDigest, snapshotIdentity.snapshotDigest,
    `slot ${index} driver study audit records a different snapshot digest`);
  assert.deepEqual(driverAudit.continuationAudit, receipt,
    `slot ${index} driver study audit disagrees with the recomputed condition receipt`);

  const metrics = extractMetrics({ rawState: rawState.value, attempt, summary: record.summary });
  const originalFiles = [
    ['batchReport', path.join(reportDir, 'batch.json')],
    ['attempt', record.attemptPath],
    ['summary', record.summaryPath],
    ['state', stateFile],
    ['promptAudit', auditScan.path],
    ['driverStudyAudit', driverAuditPath],
    ['experiences', experiencesFile],
  ];
  const originals = [];
  for (const [role, file] of originalFiles) {
    const bytes = await readFile(file);
    originals.push({ role, path: file, sha256: sha256Hex(bytes), bytes: bytes.length });
  }

  return {
    runRoot,
    stateFile,
    record,
    conditionAudit: receipt,
    driverStudyAudit: driverAudit,
    batch,
    metrics,
    originals,
    sourceRound: {
      roundId: sourceRound.roundId ?? null,
      targetRoundId,
      runId: sourceRound.runId ?? null,
      candidateId: sourceRound.candidateId ?? null,
      candidateDigest: digest,
      queueRequestId,
    },
    auditPath: auditScan.path,
    matchedAuditsForTargetRound: auditScan.matched,
  };
};

// Release/terminal safety for one retained slot. It reuses the EXACT existing
// smoke batch semantics (`continuationSafety`): every required stop receipt, the
// teardown stop and the runtime exit are checked separately — a confirmed teardown
// never masks an unconfirmed per-family receipt, a missing field stays unknown and
// a spawned runtime without a retained exit is unsafe. Full success additionally
// requires the frozen classification to agree, so a release-confirmed failure can
// never be promoted.
const slotSafety = (record) => {
  const safety = continuationSafety(record);
  const classified = classifyAcceptanceRecord(record);
  const attempt = record?.attempt ?? null;
  const summary = record?.summary ?? null;
  return {
    safe: safety.safe,
    issues: uniqueStrings(safety.issues),
    outcome: classified.outcome,
    fullSuccess: safety.safe && classified.outcome === 'full_success'
      && attempt?.fullSuccess === true && summary?.fullSuccess === true,
  };
};

// Study-only configuration constraints. The recorded prompt policy must describe
// the scheduled condition and the fixed snapshot, the current D selection policy
// and the fixed study goal policy; a slot configured for another condition,
// another snapshot or the obsolete retrieve-only constant is never accepted.
const studyConfigIssues = ({ config, condition, snapshotIdentity }) => {
  if (!isPlainObject(config) || !isPlainObject(config.promptPolicy)) return ['study_config_missing'];
  const policy = config.promptPolicy;
  const mismatched = [];
  if (policy.experienceCondition !== condition) mismatched.push('experienceCondition');
  if (policy.wikiSnapshotDigest !== snapshotIdentity.snapshotDigest) mismatched.push('wikiSnapshotDigest');
  if (policy.studyGoalPolicyVersion !== EXPERIENCE_STUDY_GOAL_POLICY_VERSION) mismatched.push('studyGoalPolicyVersion');
  if (policy.experienceSelectionPolicyVersion !== WIKI_SELECTION_POLICY_VERSION) {
    mismatched.push('experienceSelectionPolicyVersion');
  }
  return mismatched.length === 0 ? [] : [`study_config_mismatch: ${mismatched.join(', ')}`];
};

// The single per-slot evaluation over already-read raw evidence, shared by the live
// runner and the read-only verifier. Both call it with the same inputs so a
// retained report can only be accepted when the reader recomputes exactly the same
// issues and the same verdict from the originals. `reference` is the first started
// slot's observed model/source/design identity (null until then).
const evaluateSlotEvidence = ({ condition, snapshotIdentity, evidence, reference }) => {
  const issues = [];
  const record = evidence?.record ?? null;
  const safety = slotSafety(record);
  if (!safety.safe) issues.push(`unsafe_continuation: ${safety.issues.join(', ')}`);
  if (!safety.fullSuccess) issues.push(`not_full_success: ${safety.outcome}`);

  const attempt = record?.attempt ?? null;
  const summary = record?.summary ?? null;
  const config = attempt?.config ?? summary?.config ?? null;
  if (!isPlainObject(config)) issues.push('config_missing');
  if (evidence?.conditionAudit?.condition !== condition) issues.push('condition_mismatch');
  if (evidence?.conditionAudit?.snapshot?.snapshotDigest !== snapshotIdentity.snapshotDigest) {
    issues.push('snapshot_digest_mismatch');
  }

  const metrics = isPlainObject(evidence?.metrics) ? evidence.metrics : null;
  const baselineProfiles = metrics?.baseline?.profiles ?? null;
  for (const profile of STUDY_PROFILES) {
    if (!Number.isFinite(baselineProfiles?.[profile]?.value)) issues.push(`baseline_profile_missing:${profile}`);
  }
  if (!(metrics?.candidates?.length >= 2)) issues.push('fewer_than_two_candidates');
  if (new Set((metrics?.candidates ?? []).map((candidate) => candidate.candidateDigest)).size
    !== (metrics?.candidates ?? []).length) issues.push('candidates_not_distinct');
  for (const candidate of metrics?.candidates ?? []) {
    if (candidate.correctnessPassed !== true) issues.push('candidate_correctness_failed');
    if (candidate.releaseConfirmed !== true) issues.push('candidate_release_unconfirmed');
    if (candidate.liveHardware !== true) issues.push('candidate_not_live_hardware');
    for (const profile of STUDY_PROFILES) {
      if (!Number.isFinite(candidate.profiles?.[profile]?.value)) issues.push(`candidate_profile_missing:${profile}`);
    }
  }

  // The responding model must be fully observed (provider-reported, under the
  // frozen observation schema); a declared/probe/env label or a missing schema
  // version stays unknown and is rejected.
  const model = observedModelOf(config);
  if (!model) issues.push('observed_model_missing');
  const source = { commit: config?.code?.commit ?? null, contentDigest: config?.code?.contentDigest ?? null };
  if (!source.commit || !source.contentDigest) issues.push('source_identity_missing');
  issues.push(...studyConfigIssues({ config, condition, snapshotIdentity }));

  // The complete standard fingerprint must be comparable: any unknown required
  // field (hardware, device, driver, matrix, budgets, policy, model observation
  // schema) keeps the slot out of the shared design identity instead of being
  // silently dropped.
  const standard = isPlainObject(config) ? buildConfigFingerprint(config, { code: config.code }) : null;
  if (!standard) issues.push('standard_fingerprint_missing');
  else if (!standard.comparable) {
    issues.push(`standard_fingerprint_not_comparable: ${standard.unknownFields.join(', ')}`);
  }
  const designIdentity = isPlainObject(config) ? sharedDesignIdentity(config) : null;

  let nextReference = reference;
  if (reference === null) {
    // Only a fully observed identity becomes the study reference: a slot that never
    // produced one leaves the reference unset instead of making every later slot look
    // like a drift against nulls.
    nextReference = model && source.commit && source.contentDigest && designIdentity
      ? { model, source, sharedDesignIdentity: designIdentity } : null;
  } else {
    if (reference.model !== model) issues.push(`observed_model_drift: ${reference.model} vs ${model}`);
    if (reference.source.commit !== source.commit
      || reference.source.contentDigest !== source.contentDigest) issues.push('source_or_config_drift');
    if (reference.sharedDesignIdentity !== designIdentity) issues.push('shared_design_identity_drift');
  }

  const unique = uniqueStrings(issues);
  return {
    issues: unique,
    status: unique.length === 0 ? 'completed' : 'failed',
    model,
    source,
    standard: standard?.fingerprint ?? null,
    standardUnknownFields: standard?.unknownFields ?? null,
    designIdentity,
    reference: nextReference,
  };
};

const isPlainRecord = (value) => isPlainObject(value)
  && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);

// The documented `readInvocation` port shape. An Error — or any class instance that
// merely looks object-shaped — can never be accepted as evidence: nothing was read
// from a real artifact, so accepting it would turn a failed read into a green slot.
const assertEvidenceShape = (evidence, index) => {
  assert.ok(isPlainRecord(evidence),
    `slot ${index} readInvocation must return a plain evidence object, not ${evidence?.constructor?.name ?? typeof evidence}`);
  assert.ok(isPlainRecord(evidence.record), `slot ${index} readInvocation returned no run record`);
};

// Shared design identity: the standard fingerprint with ONLY the explicit study
// condition removed. Model, source, snapshot, matrix, budget and goal-policy fields
// all stay in, so a drift in any of them still splits the identity.
const sharedDesignIdentity = (config) => {
  const normalized = normalizeConfigForFingerprint(config);
  if (isPlainObject(normalized?.promptPolicy)) delete normalized.promptPolicy.experienceCondition;
  return digestJson(normalized);
};

const observedModelOf = (config) => {
  const provider = config?.provider;
  if (provider?.modelSource !== 'observed' || provider?.modelObservationStatus !== 'observed') return null;
  return isNonBlank(provider?.model) ? provider.model.trim() : null;
};

// Study-level design accumulator. The live runner and the read-only verifier both
// drive it over the recomputed per-slot evaluations in schedule order, so
// `report.design` is a deterministic projection of the retained raw evidence instead
// of a value that has to be trusted. The first slot with a COMPLETE observed identity
// defines the shared design; later slots are compared against it, and a slot that
// never produced a usable identity leaves the reference unset rather than poisoning
// every following slot with a drift against nulls.
const createDesignAccumulator = () => ({
  reference: null,
  design: { sharedDesignIdentity: null, standardFingerprints: {}, source: null, model: null },
  observe(evaluation, condition) {
    this.reference = evaluation.reference;
    if (this.design.sharedDesignIdentity === null && evaluation.reference !== null) {
      this.design = {
        sharedDesignIdentity: evaluation.designIdentity,
        standardFingerprints: {},
        source: evaluation.source,
        model: evaluation.model,
      };
    }
    if (evaluation.standard) this.design.standardFingerprints[condition] = evaluation.standard;
    return this.design;
  },
});

const writeAtomic = async (file, value) => {
  const temporary = `${file}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(temporary, JSON.stringify(value, null, 2));
  await rename(temporary, file);
};

const defaultEmit = (payload) => { console.log('DISPATCH_PROGRESS ' + JSON.stringify(payload)); };

// Each scheduled slot owns an EXCLUSIVE artifact/report directory pair named by its
// frozen index. The very same pair is handed to the smoke child and to the raw
// evidence reader, so the reader never borrows a parent or another slot's originals.
// The child's raw stdout/stderr log lives in the slot's own ARTIFACT directory: the
// child creates its `--report-dir` non-recursively and refuses an existing one, so
// the runner must not pre-create it, while the artifact directory may already exist.
const slotDirectories = (artifactDir, reportDir, index) => {
  const name = `slot-${String(index).padStart(2, '0')}`;
  const slotArtifactDir = path.join(artifactDir, name);
  return {
    name,
    artifactDir: slotArtifactDir,
    reportDir: path.join(reportDir, name),
    logPath: path.join(slotArtifactDir, 'logs', `${name}.log`),
  };
};

const comparisonOf = (invocations) => {
  const byCondition = {};
  for (const condition of ['facts-only', 'local-only', 'local-and-wiki']) {
    const verified = invocations.filter((item) => item.condition === condition && item.status === 'completed');
    // Descriptive only: a three-per-condition exploratory comparison, never a
    // significance claim, and never pooled across profiles.
    const perProfile = {};
    for (const profile of STUDY_PROFILES) {
      const baselineRows = verified.map((item) => item.metrics?.baseline?.profiles?.[profile])
        .filter((row) => Number.isFinite(row?.value));
      const candidateRows = verified.flatMap((item) => (item.metrics?.candidates ?? [])
        .map((candidate) => candidate.profiles?.[profile]).filter((row) => Number.isFinite(row?.value)));
      const baseline = baselineRows.map((row) => row.value);
      const candidates = candidateRows.map((row) => row.value);
      // Units come from the retained task benchmark rows. A profile whose retained
      // rows disagree about their unit is never silently averaged into one number.
      const units = [...new Set([...baselineRows, ...candidateRows].map((row) => row.unit ?? null))];
      perProfile[profile] = {
        units,
        comparableUnits: units.length === 1 && units[0] !== null,
        baselineValues: baseline,
        baselineMean: baseline.length ? baseline.reduce((sum, value) => sum + value, 0) / baseline.length : null,
        candidateValues: candidates,
        candidateMean: candidates.length ? candidates.reduce((sum, value) => sum + value, 0) / candidates.length : null,
        sampleCount: verified.length,
      };
    }
    byCondition[condition] = {
      verifiedSlots: verified.length,
      candidateIdentities: verified.flatMap((item) => (item.metrics?.candidates ?? [])
        .map((candidate) => candidate.candidateDigest)),
      candidateCorrectness: verified.flatMap((item) => (item.metrics?.candidates ?? [])
        .map((candidate) => candidate.correctnessPassed === true)),
      elapsedMs: verified.map((item) => item.metrics?.elapsedMs ?? null),
      observedModels: verified.map((item) => item.metrics?.model?.observedModel ?? null),
      modelRequestCounts: verified.map((item) => item.metrics?.model?.requestCount ?? null),
      profiles: perProfile,
    };
  }
  return { descriptiveOnly: true, significanceClaimed: false, byCondition };
};

/**
 * Run the frozen nine-slot schedule. Every slot runs the unchanged smoke CLI through
 * the `invokeSmoke` port (default: a real child process). The complete report with
 * all nine slots is written BEFORE the first process starts; nothing is replaced,
 * topped up or re-run, and a stop condition leaves the remaining slots unstarted.
 */
export const runExperienceStudy = async (options, ports = {}) => {
  const parsed = isPlainObject(options) && options.mode ? options : parseStudyArguments(options?.argv ?? []);
  if (parsed.mode === 'verify-report') {
    throw new Error('runExperienceStudy runs the nine-slot study; use verifyStudyReport for the read-only mode');
  }
  const schedule = buildStudySchedule();
  const now = typeof ports.now === 'function' ? ports.now : (() => new Date().toISOString());
  const emit = typeof ports.emit === 'function' ? ports.emit : defaultEmit;
  const invokeSmoke = typeof ports.invokeSmoke === 'function'
    ? ports.invokeSmoke : createDefaultInvokeSmoke({ cwd: projectRoot, script: path.join(projectRoot, BATCH_SCRIPT) });
  const readInvocation = typeof ports.readInvocation === 'function' ? ports.readInvocation : readSlotEvidence;
  const snapshotPath = path.resolve(parsed.snapshot);
  const artifactDir = path.resolve(parsed.artifactDir);
  const reportDir = path.resolve(parsed.reportDir);
  const gpuPython = path.resolve(parsed.gpuPython);

  // Validate the fixed snapshot source before anything is created or spawned.
  const snapshotFile = await readJsonFile(snapshotPath, 'kernel wiki snapshot');
  const snapshotIdentity = studySnapshotIdentity(snapshotFile.value);
  assert.ok(snapshotIdentity.reviewedSm86UnitIds.length >= 1,
    'the study snapshot must contain at least one reviewed sm86 KernelWiki unit');
  await assertStudyLayout({ artifactDir, reportDir, snapshot: snapshotPath });

  // Exclusive report directory: the parent may not exist yet, but the report
  // directory itself is created non-recursively so an existing one is refused.
  await mkdir(path.dirname(reportDir), { recursive: true });
  await mkdir(reportDir, { recursive: false });
  await mkdir(artifactDir, { recursive: true });

  const reportPath = path.join(reportDir, REPORT_FILE);
  const invocations = schedule.map((slot) => {
    const directories = slotDirectories(artifactDir, reportDir, slot.index);
    return {
      index: slot.index,
      block: slot.block,
      condition: slot.condition,
      status: 'pending',
      startedAt: null,
      finishedAt: null,
      exitCode: null,
      signal: null,
      artifactDir: directories.artifactDir,
      reportDir: directories.reportDir,
      logPath: directories.logPath,
      runRoot: null,
      conditionAudit: null,
      designIdentity: null,
      standardFingerprint: null,
      metrics: null,
      originals: [],
      issues: [],
    };
  });
  const report = {
    schemaVersion: EXPERIENCE_STUDY_SCHEMA_VERSION,
    runnerSchemaVersion: STUDY_RUNNER_SCHEMA_VERSION,
    status: 'running',
    strictN20Passed: false,
    startedAt: now(),
    finishedAt: null,
    stopReason: null,
    requestedSlots: EXPERIENCE_STUDY_SLOTS,
    snapshot: { path: snapshotPath, ...snapshotIdentity },
    goalPolicyVersion: EXPERIENCE_STUDY_GOAL_POLICY_VERSION,
    schedule,
    invocations,
    design: {
      sharedDesignIdentity: null,
      standardFingerprints: {},
      source: null,
      model: null,
    },
    comparison: null,
  };
  // The complete nine-slot denominator is on disk before the first spawn.
  await writeAtomic(reportPath, report);
  emit({ phase: 'start', completed: 0, total: EXPERIENCE_STUDY_SLOTS, message: 'experience-condition study started' });

  let stopReason = null;
  const design = createDesignAccumulator();
  const observations = [];
  for (const slot of invocations) {
    const directories = { artifactDir: slot.artifactDir, reportDir: slot.reportDir };
    if (stopReason) {
      slot.status = 'stopped';
      slot.issues = uniqueStrings([...slot.issues, 'study_stopped']);
      report.stopReason = stopReason;
      await writeAtomic(reportPath, report);
      continue;
    }
    slot.status = 'running';
    slot.startedAt = now();
    await writeAtomic(reportPath, report);
    emit({ phase: 'run', completed: slot.index - 1, total: EXPERIENCE_STUDY_SLOTS,
      message: `slot ${slot.index}/${EXPERIENCE_STUDY_SLOTS} (${slot.condition}) started` });

    let result;
    try {
      result = await invokeSmoke({ index: slot.index, condition: slot.condition,
        artifactDir: directories.artifactDir, reportDir: directories.reportDir,
        snapshot: snapshotPath, gpuPython });
    } catch (error) {
      result = { exitCode: null, signal: null, issues: [`invokeSmoke threw: ${error.message}`] };
    }
    slot.finishedAt = now();
    slot.exitCode = Number.isInteger(result?.exitCode) ? result.exitCode : null;
    slot.signal = isNonBlank(result?.signal) ? result.signal : null;
    const issues = [...(result?.issues || [])];
    // The raw log belongs to this slot's own artifact directory; a port that reports
    // any other location does not move the retained slot log.
    if (isNonBlank(result?.logPath) && isStrictlyInside(slot.artifactDir, path.resolve(result.logPath))) {
      slot.logPath = path.resolve(result.logPath);
    }
    // The real exit code is the authority: a zero-exit stdout claim never overrides it.
    if (slot.exitCode !== 0) issues.push(`smoke_exit_code:${slot.exitCode === null ? 'null' : slot.exitCode}`);

    if (issues.length === 0) {
      let evidence = null;
      try {
        evidence = await readInvocation({ index: slot.index, condition: slot.condition,
          artifactDir: directories.artifactDir, reportDir: directories.reportDir, snapshot: snapshotPath });
        assertEvidenceShape(evidence, slot.index);
      } catch (error) {
        evidence = null;
        issues.push(`raw_evidence_invalid: ${error.message}`);
      }
      if (evidence) {
        // The SAME evaluation the read-only verifier recomputes: release/terminal
        // safety, condition/snapshot binding, per-profile metrics, full model
        // observation, source identity, study configuration and the comparable
        // standard fingerprint, plus model/source/design drift against the first
        // started slot (only the explicit condition may differ).
        const evaluation = evaluateSlotEvidence({ condition: slot.condition, snapshotIdentity, evidence,
          reference: design.reference });
        design.observe(evaluation, slot.condition);
        issues.push(...evaluation.issues);
        slot.runRoot = evidence.runRoot ?? null;
        slot.conditionAudit = evidence.conditionAudit ?? null;
        slot.designIdentity = evaluation.designIdentity;
        slot.standardFingerprint = evaluation.standard;
        slot.metrics = evidence.metrics ?? null;
        slot.originals = evidence.originals ?? [];
        observations.push({ index: slot.index, condition: slot.condition,
          candidateDigest: evidence.metrics?.candidates?.[0]?.candidateDigest ?? null });
      }
    }

    slot.issues = uniqueStrings([...slot.issues, ...issues]);
    slot.status = issues.length === 0 ? 'completed' : 'failed';
    if (issues.length > 0) stopReason ??= `slot_${slot.index}: ${uniqueStrings(issues).join(', ')}`;
    report.stopReason = stopReason;
    report.design = design.design;
    await writeAtomic(reportPath, report);
    emit({ phase: 'run', completed: slot.index, total: EXPERIENCE_STUDY_SLOTS,
      message: `slot ${slot.index}/${EXPERIENCE_STUDY_SLOTS} (${slot.condition}) finished: ${slot.status}` });
  }

  report.stopReason = stopReason;
  report.finishedAt = now();
  report.design = design.design;
  report.comparison = comparisonOf(invocations);
  report.status = stopReason === null
    && invocations.every((slot) => slot.status === 'completed') ? 'completed' : 'stopped';
  report.strictN20Passed = false;
  await writeAtomic(reportPath, report);
  const completed = invocations.filter((slot) => slot.status === 'completed').length;
  emit({ phase: 'finish', completed, total: EXPERIENCE_STUDY_SLOTS,
    message: `experience-condition study ${report.status}${stopReason ? ` (${stopReason})` : ''}` });

  return {
    schemaVersion: EXPERIENCE_STUDY_SCHEMA_VERSION,
    status: report.status,
    strictN20Passed: false,
    stopReason,
    exitCode: report.status === 'completed' ? 0 : 1,
    reportPath,
    report,
  };
};

// ---------------------------------------------------------------------------
// read-only verification
// ---------------------------------------------------------------------------

const resolveReportFile = async (reportPath) => {
  const resolved = path.resolve(reportPath);
  let info;
  try { info = await stat(resolved); } catch { throw new Error(`report path does not exist: ${resolved}`); }
  return info.isDirectory() ? path.join(resolved, REPORT_FILE) : resolved;
};

const SLOT_DIRECTORY_PATTERN = /^slot-(\d{2})$/u;
// Child-process/log problems the runner can record but a reader cannot recompute
// from the retained artifacts. Every other recorded issue must be one the reader
// recomputes itself, so a dropped or invented verdict is always caught.
const PORT_ISSUE_PATTERNS = Object.freeze([
  /^log_open_failed: /u,
  /^smoke spawn failed: /u,
  /^smoke process error: /u,
  /^log_write_failed: /u,
  /^invokeSmoke threw: /u,
  /^raw_evidence_invalid: /u,
]);
const isPortIssue = (issue) => isNonBlank(issue) && PORT_ISSUE_PATTERNS.some((pattern) => pattern.test(issue));

// Compare a freshly recomputed value with the form retained in the JSON report. The
// report is JSON, so an `undefined` field can never be told apart from an absent one;
// both sides are compared in canonical JSON, which is also key-order independent and
// therefore never reports a spurious difference for a re-serialized artifact.
const assertSameAsRetained = (recomputed, retained, message) => {
  assert.equal(canonicalJson(recomputed), canonicalJson(retained), message);
};

// Slot directory layout shared by all nine invocations: one exclusive `slot-NN` pair
// per slot, one common (distinct, non-overlapping) artifact and report root, both
// outside the repository, with the imported snapshot outside both.
const verifyReportLayout = async ({ report, reportFile, snapshotPath }) => {
  const artifactRoots = new Set();
  const reportRoots = new Set();
  const seenPairs = new Set();
  for (const [position, slot] of report.invocations.entries()) {
    // The frozen schedule order is part of the identity: a reordered, duplicated or
    // re-labeled slot can never describe the same nine invocations.
    assert.equal(slot.index, position + 1,
      `retained invocation ${position + 1} carries index ${String(slot.index)}`);
    const scheduled = report.schedule[slot.index - 1];
    assert.ok(isPlainObject(scheduled), `slot ${slot.index} has no scheduled position`);
    assert.equal(slot.block, scheduled.block, `slot ${slot.index} is not in its scheduled block`);
    assert.equal(slot.condition, scheduled.condition,
      `slot ${slot.index} did not run its scheduled condition`);
    assert.ok(isNonBlank(slot.artifactDir) && isNonBlank(slot.reportDir),
      `slot ${slot.index} retained no exclusive directory pair`);
    const artifactDir = path.resolve(slot.artifactDir);
    const slotReportDir = path.resolve(slot.reportDir);
    for (const [label, directory] of [['artifact', artifactDir], ['report', slotReportDir]]) {
      const named = SLOT_DIRECTORY_PATTERN.exec(path.basename(directory));
      assert.ok(named && Number(named[1]) === slot.index,
        `slot ${slot.index} must use its own slot-${String(slot.index).padStart(2, '0')} ${label} directory`);
    }
    const pair = `${artifactDir}\n${slotReportDir}`;
    assert.ok(!seenPairs.has(pair), `slot ${slot.index} reuses another slot's directory pair`);
    seenPairs.add(pair);
    artifactRoots.add(path.dirname(artifactDir));
    reportRoots.add(path.dirname(slotReportDir));
    if (isNonBlank(slot.logPath)) {
      // The child's raw stdout/stderr log is retained in the slot's own artifact
      // directory (the child's `--report-dir` is created non-recursively by the child
      // itself, so the runner never writes into it).
      assert.ok(isStrictlyInside(artifactDir, path.resolve(slot.logPath)),
        `slot ${slot.index} log path is outside its own artifact directory`);
    }
  }
  assert.equal(artifactRoots.size, 1, 'the nine slots do not share exactly one artifact root');
  assert.equal(reportRoots.size, 1, 'the nine slots do not share exactly one report root');
  const [artifactRoot] = [...artifactRoots];
  const [reportRoot] = [...reportRoots];
  assert.notEqual(artifactRoot, reportRoot, 'the artifact root and the report root must differ');
  assert.ok(!isStrictlyInside(artifactRoot, reportRoot) && !isStrictlyInside(reportRoot, artifactRoot),
    'the artifact root and the report root must not overlap');
  const resolvedSnapshot = path.resolve(snapshotPath);
  for (const directory of [artifactRoot, reportRoot]) {
    assert.ok(!isInsideOrSame(directory, resolvedSnapshot),
      'the imported snapshot must stay outside the study outputs');
  }
  const repositoryRoot = await realpathIfPresent(projectRoot);
  for (const [label, directory] of [['artifact', artifactRoot], ['report', reportRoot]]) {
    const resolved = await realpathProspective(directory);
    if (repositoryRoot && resolved !== null && isInsideOrSame(resolved, repositoryRoot)) {
      throw new Error(`the retained ${label} root resolves inside the repository: ${resolved}`);
    }
  }
  assert.equal(path.resolve(reportFile), path.join(reportRoot, REPORT_FILE),
    'the verified report is not the study.json of the retained report root');
};

/**
 * Read-only counterpart of the study runner.
 *
 * It re-reads the imported snapshot, every slot's OWN raw originals (prompt audit,
 * state/task benchmark, run record, experience store and hash manifest), recomputes
 * the condition receipt, the per-slot release/terminal safety, the observed model,
 * the comparable standard fingerprint, the shared design identity, the per-profile
 * metrics and the descriptive comparison, and refuses a report whose artifacts
 * changed, whose slot identity was reordered/duplicated, or whose summary claims a
 * verdict the originals do not support (a false green is never accepted). A slot that
 * genuinely failed stays readable: its failure is recomputed and verified rather
 * than treated as unreadable, so real model/source drift in one slot is retained as
 * a verified failure. It starts no Runtime, CLI, model, GPU or other process and
 * writes nothing.
 */
export const verifyStudyReport = async (reportPath) => {
  const reportFile = await resolveReportFile(reportPath);
  const reportParsed = await readJsonFile(reportFile, 'study report');
  const report = reportParsed.value;
  assert.ok(isPlainObject(report), 'study report must be a JSON object');
  assert.equal(report.schemaVersion, EXPERIENCE_STUDY_SCHEMA_VERSION,
    'unsupported study report schemaVersion');
  assert.equal(report.runnerSchemaVersion, STUDY_RUNNER_SCHEMA_VERSION,
    'unsupported study runner schemaVersion');
  // A report that is still running (or crashed mid-slot) is never a verified study.
  assert.notEqual(report.status, 'running', 'the study report is still running');
  assert.ok(report.status === 'completed' || report.status === 'stopped',
    `unknown retained study status: ${String(report.status)}`);
  // The frozen denominator: nine scheduled slots, never topped up and never pooled
  // into a strict N20 sample.
  assert.equal(report.requestedSlots, EXPERIENCE_STUDY_SLOTS,
    'the retained requestedSlots is not the frozen nine-slot denominator');
  assert.equal(report.strictN20Passed, false, 'a study report can never claim strict N20');
  assert.equal(report.goalPolicyVersion, EXPERIENCE_STUDY_GOAL_POLICY_VERSION,
    'the retained report used a different study goal policy');
  assert.ok(isNonBlank(report.startedAt) && isNonBlank(report.finishedAt),
    'the retained report has no start/finish timestamp');
  assert.deepEqual(report.schedule, buildStudySchedule(),
    'retained schedule is not the frozen nine-slot balanced schedule');
  assert.equal(report.invocations?.length, EXPERIENCE_STUDY_SLOTS,
    'retained report must keep all nine slots');

  const snapshotPath = report.snapshot?.path;
  assert.ok(isNonBlank(snapshotPath) && path.isAbsolute(snapshotPath),
    'retained report has no absolute snapshot path');
  const snapshotFile = await readJsonFile(snapshotPath, 'kernel wiki snapshot');
  const snapshotIdentity = studySnapshotIdentity(snapshotFile.value);
  const { path: retainedSnapshotPath, ...retainedSnapshotIdentity } = report.snapshot;
  assert.equal(path.resolve(retainedSnapshotPath), path.resolve(snapshotPath),
    'retained snapshot path changed');
  assert.deepEqual(retainedSnapshotIdentity, snapshotIdentity,
    'the snapshot on disk no longer matches the retained study identity');
  await verifyReportLayout({ report, reportFile, snapshotPath });

  const design = createDesignAccumulator();
  const recomputedIssues = new Map();
  const verified = [];
  for (const slot of report.invocations) {
    const artifactDir = path.resolve(slot.artifactDir);
    const slotReportDir = path.resolve(slot.reportDir);
    assert.ok(['completed', 'failed', 'stopped'].includes(slot.status),
      `slot ${slot.index} has non-final status ${String(slot.status)}`);
    const issues = Array.isArray(slot.issues) ? [...slot.issues] : null;
    assert.ok(issues, `slot ${slot.index} retained no issue list`);

    if (slot.status === 'stopped') {
      // The study stopped before this slot started: nothing may be retained for it.
      assert.equal(slot.startedAt, null, `unstarted slot ${slot.index} retained a start time`);
      assert.equal(slot.finishedAt, null, `unstarted slot ${slot.index} retained a finish time`);
      assert.equal(slot.exitCode, null, `unstarted slot ${slot.index} retained an exit code`);
      assert.equal(slot.runRoot, null, `unstarted slot ${slot.index} retained a run root`);
      assert.equal(slot.conditionAudit, null, `unstarted slot ${slot.index} retained a condition receipt`);
      assert.equal(slot.metrics, null, `unstarted slot ${slot.index} retained metrics`);
      assert.equal(slot.designIdentity, null, `unstarted slot ${slot.index} retained a design identity`);
      assert.equal(slot.standardFingerprint, null, `unstarted slot ${slot.index} retained a standard fingerprint`);
      assert.deepEqual(slot.originals, [], `unstarted slot ${slot.index} retained originals`);
      assert.deepEqual(issues, ['study_stopped'], `stopped slot ${slot.index} must only record that the study stopped`);
      recomputedIssues.set(slot.index, []);
      verified.push({ index: slot.index, condition: slot.condition, status: slot.status,
        runRoot: null, exitCode: null, observedModel: null, standardFingerprint: null,
        selectedWiki: null, candidates: null });
      continue;
    }

    const exitCode = slot.exitCode;
    assert.ok(exitCode === null || Number.isInteger(exitCode),
      `slot ${slot.index} retained a non-integer exit code`);
    assert.ok(isNonBlank(slot.startedAt) && isNonBlank(slot.finishedAt),
      `started slot ${slot.index} retained no start/finish time`);
    const retainedOriginals = Array.isArray(slot.originals) ? slot.originals : null;
    assert.ok(retainedOriginals, `slot ${slot.index} retained no original list`);
    for (const original of retainedOriginals) {
      assert.ok(isPlainObject(original) && isNonBlank(original.path),
        `slot ${slot.index} retained an original without a path`);
      const bytes = await readFile(original.path);
      assert.equal(sha256Hex(bytes), original.sha256,
        `retained raw artifact changed on disk: ${original.path}`);
      assert.equal(bytes.length, original.bytes,
        `retained raw artifact size changed: ${original.path}`);
    }

    let evaluation = null;
    let derived = [];
    if (retainedOriginals.length > 0) {
      assert.equal(exitCode, 0,
        `slot ${slot.index} retained raw evidence although the smoke child exited with ${String(exitCode)}`);
      // The reader reads the slot's OWN directory pair — never a parent directory
      // borrowed from another slot (that would let one slot's originals stand in
      // for nine).
      let evidence = null;
      let evidenceError = null;
      try {
        evidence = await readSlotEvidence({ index: slot.index, condition: slot.condition,
          artifactDir, reportDir: slotReportDir, snapshot: snapshotPath });
      } catch (error) { evidenceError = error; }
      assert.ok(evidence,
        `slot ${slot.index} retained evidence can no longer be recomputed: ${evidenceError?.message}`);
      assert.equal(evidence.runRoot, slot.runRoot, `slot ${slot.index} run root changed`);
      assertSameAsRetained(evidence.conditionAudit, slot.conditionAudit,
        `slot ${slot.index} condition receipt no longer matches the retained originals`);
      assertSameAsRetained(evidence.metrics, slot.metrics,
        `slot ${slot.index} result metrics no longer match the retained originals`);
      assertSameAsRetained(evidence.originals, retainedOriginals,
        `slot ${slot.index} retained original list changed`);
      evaluation = evaluateSlotEvidence({ condition: slot.condition, snapshotIdentity, evidence,
        reference: design.reference });
      design.observe(evaluation, slot.condition);
      assert.equal(slot.designIdentity, evaluation.designIdentity,
        `slot ${slot.index} shared design identity changed`);
      assert.equal(slot.standardFingerprint, evaluation.standard,
        `slot ${slot.index} standard fingerprint changed`);
      derived = [...evaluation.issues];
    } else {
      // A slot that stopped before retaining usable raw evidence (nonzero smoke exit
      // or an unreadable invocation) is a valid diagnostic result and stays readable,
      // but it may never be presented as a verified success and must say why.
      assert.equal(slot.runRoot, null, `slot ${slot.index} retained a run root without raw evidence`);
      assert.equal(slot.conditionAudit, null, `slot ${slot.index} retained a condition receipt without raw evidence`);
      assert.equal(slot.metrics, null, `slot ${slot.index} retained metrics without raw evidence`);
      assert.equal(slot.designIdentity, null, `slot ${slot.index} retained a design identity without raw evidence`);
      assert.equal(slot.standardFingerprint, null,
        `slot ${slot.index} retained a standard fingerprint without raw evidence`);
      assert.ok(issues.length > 0, `slot ${slot.index} retained no raw evidence and no recorded issue`);
      if (exitCode !== 0) {
        derived = [`smoke_exit_code:${exitCode === null ? 'null' : exitCode}`];
        // The retained batch report is the child's own record: it may not claim the
        // pass the study exit code denies.
        const batch = await readRetainedBatchStatus(slotReportDir);
        if (batch) {
          assert.notEqual(batch.status, 'passed',
            `slot ${slot.index} exited with ${String(exitCode)} while its retained batch report claims success`);
          // The nested driver exit is a DIFFERENT process layer and is never required
          // to equal the smoke batch child exit. A driver that itself exited 0 under a
          // failed batch is the observed truthful non-comparable failure, and it stays
          // readable only when the retained one-invocation record proves it: the batch
          // really failed, the single smoke invocation really completed with exit 0,
          // it is explicitly NOT comparable, and it kept the issues that made it so.
          // An "all green" nested record is an invented success and is refused.
          if (batch.invocationExitCode === 0) {
            assert.equal(batch.status, 'failed',
              `slot ${slot.index} nested driver exited 0 although its retained batch status is ${String(batch.status)}, not failed`);
            assert.equal(batch.requestedRuns, 1,
              `slot ${slot.index} nested driver exited 0 although its retained batch requested ${String(batch.requestedRuns)} runs, not one`);
            assert.equal(batch.invocationCount, 1,
              `slot ${slot.index} nested driver exited 0 although its retained batch kept ${String(batch.invocationCount)} invocations, not one`);
            assert.equal(batch.invocationStatus, 'completed',
              `slot ${slot.index} nested driver exited 0 although its retained invocation status is ${String(batch.invocationStatus)}, not completed`);
            assert.equal(batch.invocationComparable, false,
              `slot ${slot.index} nested driver exited 0 under a failed batch although its retained invocation claims comparability`);
            assert.ok(Array.isArray(batch.invocationIssues) && batch.invocationIssues.length > 0,
              `slot ${slot.index} nested driver exited 0 under a failed batch without retaining the issues that made it non-comparable`);
          }
        }
      } else {
        // A zero exit without retained evidence is only readable when the slot names
        // the child/port failure that prevented the read.
        assert.ok(issues.some(isPortIssue),
          `slot ${slot.index} retained no evidence after a zero smoke exit without naming the failure`);
      }
    }

    // A report may not drop, soften or invent a verdict: every recomputed issue must
    // be retained, and every extra retained issue must be a named child/port failure.
    const extra = issues.filter((issue) => !derived.includes(issue));
    for (const issue of extra) {
      assert.ok(isPortIssue(issue),
        `slot ${slot.index} recorded an issue the reader cannot recompute: ${issue}`);
    }
    const missing = derived.filter((issue) => !issues.includes(issue));
    assert.deepEqual(missing, [],
      `slot ${slot.index} dropped recomputed issues: ${missing.join(', ')}`);
    assert.equal(slot.status, issues.length === 0 ? 'completed' : 'failed',
      `slot ${slot.index} status contradicts its own issues`);
    recomputedIssues.set(slot.index, extra.length === 0 ? derived : null);
    verified.push({ index: slot.index, condition: slot.condition, status: slot.status,
      runRoot: slot.runRoot, exitCode,
      observedModel: evaluation?.model ?? null,
      standardFingerprint: slot.standardFingerprint ?? null,
      selectedWiki: (slot.conditionAudit?.selectedWiki ?? []).map((item) => item.recordId),
      candidates: (slot.metrics?.candidates ?? []).map((candidate) => ({
        candidateDigest: candidate.candidateDigest,
        durationMs: candidate.durationMs,
        profiles: candidate.profiles,
      })) });
  }

  // The study-level verdicts are recomputed from the per-slot originals, never read
  // back from the summary.
  assertSameAsRetained(design.design, report.design,
    'the retained study design identity no longer matches the retained per-slot evidence');
  let firstFailure = null;
  let unrecomputableFailure = null;
  for (const slot of report.invocations) {
    if (slot.status === 'stopped') continue;
    const recomputed = recomputedIssues.get(slot.index);
    if (recomputed === null) { unrecomputableFailure = slot.index; break; }
    if (recomputed.length > 0) {
      firstFailure = { index: slot.index, issues: recomputed };
      break;
    }
  }
  if (firstFailure) {
    assert.equal(report.stopReason ?? null, `slot_${firstFailure.index}: ${firstFailure.issues.join(', ')}`,
      'the retained stop reason is not the first recomputed failure');
  } else if (unrecomputableFailure !== null) {
    assert.ok(isNonBlank(report.stopReason) && report.stopReason.startsWith(`slot_${unrecomputableFailure}: `),
      `slot ${unrecomputableFailure} failed for a reason the reader cannot recompute; the retained stop reason must name it`);
  } else {
    assert.ok(report.stopReason === null || report.stopReason === undefined,
      'the retained report stopped although every slot recomputes clean');
  }
  const recomputedStatus = firstFailure === null && unrecomputableFailure === null
    && report.invocations.every((slot) => slot.status === 'completed') ? 'completed' : 'stopped';
  assert.equal(report.status, recomputedStatus,
    'the retained study status contradicts the recomputed per-slot verdicts');
  assertSameAsRetained(comparisonOf(report.invocations), report.comparison,
    'retained comparison no longer matches the retained originals');

  // `ok` means "this retained report matches its originals", never "the study
  // succeeded": a stopped/failed pilot is verified and reported as such.
  const slotCounts = {};
  for (const slot of report.invocations) slotCounts[slot.status] = (slotCounts[slot.status] ?? 0) + 1;
  return {
    ok: true,
    reportFile,
    status: report.status,
    stopReason: report.stopReason ?? null,
    strictN20Passed: false,
    requestedSlots: report.requestedSlots,
    slotCounts,
    verifiedSlots: verified,
    design: design.design,
    schedule: report.schedule,
    snapshot: snapshotIdentity,
  };
};

const main = async () => {
  let options;
  try {
    options = parseStudyArguments(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    console.error(usage());
    process.exitCode = 1;
    return;
  }
  try {
    if (options.mode === 'verify-report') {
      const result = await verifyStudyReport(options.reportPath);
      console.log(JSON.stringify(result, null, 2));
      process.exitCode = 0;
      return;
    }
    const result = await runExperienceStudy(options);
    process.exitCode = result.exitCode;
  } catch (error) {
    console.error(`study setup failed: ${error.message}`);
    process.exitCode = 1;
  }
};

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  await main();
}
