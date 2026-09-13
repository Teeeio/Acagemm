#!/usr/bin/env node
// Offline, read-only acceptance reader for retained real shared-GPU Agent runs.
//
// It is explicitly invoked with the complete machine runRoot(s); it never scans
// historical host directories, never reads credentials, starts no Runtime,
// provider, GPU or N=20 batch, performs no network access and writes no sample
// files. The only bytes it produces are the single JSON document on stdout.
//
// Usage:
//   node docs/development/evidence/live-regression-20260913/verify-retained-runs.mjs \
//     --repo <absolute repo> <explicit runRoot> [runRoot...]
//
// stdout is one JSON document. Exit 0 means every explicitly passed run is a
// retained real `full_success` AND passed this reader's independent recheck.
// A group with fewer than 20 same-fingerprint attempts keeps `strictN20=false`
// even when every individual run passes; coverage is reported separately.
//
// Frozen helpers are imported read-only from `--repo`
// (`scripts/shared-gpu-acceptance.mjs`, `scripts/summarize-gpu-agent-runs.mjs`,
// `client-runtime/model-observation.mjs`) so this tool re-uses the accepted
// outcome / fingerprint / audit / stop / model-observation semantics instead of
// re-implementing (or second-guessing) them.
//
// Evidence classification used throughout:
//   * `reasons` -> blocking contradictions: evidence that was PROVIDED but is
//     malformed, mis-bound, foreign or self-contradictory. Blocking.
//   * `gaps`    -> evidence that is MISSING (no record, no raw stream, an
//     undeclared run the summary never accounted for). Kept and reported, never
//     silently dropped; a run with any gap is not a verified run.
//   * `comparabilityNotes` -> unknown/conflict model status. It never rewrites
//     the retained workflow outcome, but it keeps the group out of strict N20.
import { createHash } from 'node:crypto';
import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const SCHEMA = 'operator-studio.retained-runs-verification/v1';
const REQUIRED_PROFILES = Object.freeze(['primary', 'small']);
const FIXED_CORRECTNESS_TOTAL = 4;
const STRICT_N20_REQUIRED_RUNS = 20;
const PROVIDER_ARTIFACT_DIRS = Object.freeze({ 'claude-code': 'claude-runs', 'codex-cli': 'codex-runs' });
// A safe artifact basename: one path segment, no separator, no traversal.
const SAFE_ARTIFACT_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u;
// A safe bridge run file: a single basename ending in `.json`.
const SAFE_RUN_FILE = /^[A-Za-z0-9][A-Za-z0-9._-]*\.json$/u;

// Claude Code production collects `assistant.message.model` metadata before its
// telemetry filter drops thinking-only events. The retained DTO is therefore a
// SUPERSET of the assistant events still visible in the raw .jsonl: the raw
// visible count may be smaller than the retained observation count, but it can
// never be larger, and the two arrays are NOT deep-equal. Only visible model
// labels, session identity and counts are inspected — never thinking or tool
// text. The retained `eventIndex` is a position in the metadata stream and is
// deliberately NOT compared with a position in the raw JSONL stream.
const METADATA_BOUNDARY = 'Claude Code collects assistant.message.model metadata before telemetry filtering; the retained DTO observations include thinking-only events and are a superset of the visible assistant.message events remaining in the raw .jsonl. This reader verifies visible model/session identity, requires rawVisible <= retained observations, never requires observation-array equality, never compares metadata eventIndex with JSONL line position, and never emits thinking or tool content.';

const isNonBlank = (value) => typeof value === 'string' && value.trim().length > 0;
const trimmed = (value) => (typeof value === 'string' ? value.trim() : '');
const SENTINEL_MODELS = new Set(['unknown', 'null', 'undefined', '<synthetic>']);
const isValidModelLabel = (value) => {
  const model = trimmed(value);
  return model.length > 0 && !SENTINEL_MODELS.has(model.toLowerCase());
};
const canonical = (value) => JSON.stringify(value ?? null);
const isSafeArtifactName = (value) => typeof value === 'string' && value.length > 0
  && path.basename(value) === value && SAFE_ARTIFACT_NAME.test(value) && !value.includes('..');

const sha256Hex = (buffer) => createHash('sha256').update(buffer).digest('hex');

const readJsonFile = async (file) => {
  try {
    const buffer = await readFile(file);
    return { value: JSON.parse(buffer.toString('utf8')), bytes: buffer.length, sha256: sha256Hex(buffer), error: null };
  } catch (error) {
    return { value: null, bytes: null, sha256: null, error: error?.code === 'ENOENT' ? 'missing' : `unreadable: ${error?.message || error}` };
  }
};

const readTextFile = async (file) => {
  try {
    const buffer = await readFile(file);
    return { text: buffer.toString('utf8'), bytes: buffer.length, sha256: sha256Hex(buffer), error: null };
  } catch (error) {
    return { text: null, bytes: null, sha256: null, error: error?.code === 'ENOENT' ? 'missing' : `unreadable: ${error?.message || error}` };
  }
};

const safeReaddir = async (dir) => {
  try {
    return { entries: await readdir(dir, { withFileTypes: true }), error: null };
  } catch (error) {
    return { entries: [], error: error?.code === 'ENOENT' ? 'missing' : `unreadable: ${error?.message || error}` };
  }
};

const parseArgs = (argv) => {
  let repo = null;
  let help = false;
  const runRoots = [];
  const errors = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--repo') {
      repo = argv[index + 1] ?? null;
      index += 1;
      if (!repo) errors.push('--repo requires a value');
    } else if (arg.startsWith('--repo=')) {
      repo = arg.slice('--repo='.length);
    } else if (arg === '--help' || arg === '-h') {
      help = true;
    } else if (arg === '--json') {
      // stdout is always a single JSON document.
    } else if (arg.startsWith('--')) {
      errors.push(`unknown option ${arg}`);
    } else {
      runRoots.push(arg);
    }
  }
  return { repo, runRoots, errors, help };
};

// ---------------------------------------------------------------------------
// Real driver semantics re-derived read-only from the retained artifacts.
// ---------------------------------------------------------------------------
const candidateDigestOf = (task, hexDigest) => hexDigest(task?.payload?.candidate?.digest || task?.result?.environment?.candidateDigest);
const queueRequestIdOf = (task) => task?.payload?.requestId || null;
const candidateSourceRunIdOf = (task) => task?.payload?.candidate?.sourceRunId
  || task?.payload?.candidateSourceRunId || null;
const orderCompleted = (completedTasks) => [...completedTasks].sort((a, b) => {
  const at = Date.parse(a?.completedAt || '') || 0;
  const bt = Date.parse(b?.completedAt || '') || 0;
  return at - bt || String(a?.taskId || a?.id || '').localeCompare(String(b?.taskId || b?.id || ''));
});
// Same rule as the production driver: the verified candidate's own archive is
// bound by candidate digest AND the durable queue request id, never by "the run
// this harness happened to start first".
const archivedRoundsForTask = (state, task, hexDigest) => {
  const digest = candidateDigestOf(task, hexDigest);
  const queueRequestId = queueRequestIdOf(task);
  if (!digest || !queueRequestId) return [];
  return (Array.isArray(state?.runHistory) ? state.runHistory : []).filter((round) => hexDigest(round?.candidateDigest) === digest
    && round?.queueRequestId === queueRequestId);
};
// Same selection as the production driver: exactly the frozen target round, a
// continuation run (runId != source round run), earliest by createdAt then
// runId. Several same-round recovery audits are legitimate; the reader never
// requires exactly one and never requires the audit run to be the newest run.
const findRetainedAudit = async ({ auditDir, missionId, roundId, sourceRunId }) => {
  const { entries, error } = await safeReaddir(auditDir);
  if (error) return { error, matched: [], selected: null };
  const matched = [];
  const names = entries.filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
    .map((entry) => entry.name).sort((a, b) => a.localeCompare(b));
  for (const name of names) {
    if (!SAFE_RUN_FILE.test(name) || path.basename(name) !== name) continue;
    const read = await readJsonFile(path.join(auditDir, name));
    const audit = read.value;
    if (!audit || typeof audit !== 'object' || Array.isArray(audit)) continue;
    if (audit.missionId !== missionId || audit.roundId !== roundId || audit.deliveryStage !== 'prepared-before-send') continue;
    matched.push({ file: name, runId: isNonBlank(audit.runId) ? audit.runId : null, createdAt: isNonBlank(audit.createdAt) ? audit.createdAt : null, audit });
  }
  const candidates = matched.filter((item) => item.runId && item.runId !== sourceRunId)
    .sort((a, b) => String(a.createdAt || '').localeCompare(String(b.createdAt || ''))
      || String(a.runId).localeCompare(String(b.runId)));
  return { error: null, matched, candidates, selected: candidates[0] || null };
};

const eventMissionId = (event) => event?.payload?.missionId ?? event?.missionId ?? null;

// ---------------------------------------------------------------------------
// Candidate task recheck (frozen matrix is never relaxed).
// ---------------------------------------------------------------------------
const verifyCandidateTask = (task) => {
  const reasons = [];
  const environment = task?.result?.environment;
  const payloadDigest = task?.payload?.candidate?.digest ?? null;
  const resultDigest = environment?.candidateDigest ?? null;
  const normalizedPayload = isNonBlank(payloadDigest) ? payloadDigest.trim().toLowerCase().replace(/^sha256:/u, '') : null;
  const normalizedResult = isNonBlank(resultDigest) ? resultDigest.trim().toLowerCase().replace(/^sha256:/u, '') : null;
  if (task?.status !== 'completed') reasons.push('task is not completed');
  if (task?.payload?.purpose !== 'candidate') reasons.push('task payload purpose is not candidate');
  if (environment?.source !== 'local-shared-gpu') reasons.push('result environment source is not local-shared-gpu');
  if (environment?.executionMode !== 'gpu') reasons.push('result environment executionMode is not gpu');
  if (environment?.liveHardware !== true) reasons.push('result environment liveHardware is not true');
  if (environment?.simulated === true || environment?.mock === true || task?.result?.simulated === true) reasons.push('result environment is marked simulated/mock');
  if (environment?.publishable !== false || task?.result?.publishable !== false) reasons.push('result is not explicitly non-publishable');
  if (!normalizedPayload || !normalizedResult || normalizedPayload !== normalizedResult) reasons.push('payload candidate digest is not bound to the result environment digest');
  if (environment?.runId && queueRequestIdOf(task) && environment.runId !== queueRequestIdOf(task)) reasons.push('result environment runId is not bound to the queue request id');
  if (!isNonBlank(task?.payload?.candidate?.id)) reasons.push('candidate payload has no candidate id');
  if (!isNonBlank(queueRequestIdOf(task))) reasons.push('candidate payload has no durable queue request id');
  if (task?.resourceRelease?.confirmed !== true || task?.resourceRelease?.status !== 'confirmed') reasons.push('task execution resource release is not confirmed');

  const matrix = task?.payload?.matrix;
  if (matrix?.testSpec?.correctness?.requestedCases !== FIXED_CORRECTNESS_TOTAL) reasons.push('payload matrix correctness case count is not the fixed 4');
  if (!Array.isArray(matrix?.testSpec?.correctness?.requiredCategories) || matrix.testSpec.correctness.requiredCategories.length !== FIXED_CORRECTNESS_TOTAL) reasons.push('payload matrix required correctness categories are not the fixed 4');
  if (!Array.isArray(matrix?.testSpec?.benchmark?.requiredProfiles)
    || !REQUIRED_PROFILES.every((profile) => matrix.testSpec.benchmark.requiredProfiles.includes(profile))) reasons.push('payload matrix required profiles are not primary+small');

  const rows = Array.isArray(task?.result?.benchmark) ? task.result.benchmark : [];
  if (rows.length !== REQUIRED_PROFILES.length) reasons.push(`result benchmark profiles are not exactly primary+small (got ${rows.length})`);
  for (const profile of REQUIRED_PROFILES) {
    const matches = rows.filter((row) => row?.profile === profile);
    if (matches.length !== 1) { reasons.push(`profile ${profile} is not present exactly once`); continue; }
    const correctness = matches[0]?.correctness;
    if (!correctness || typeof correctness !== 'object') { reasons.push(`profile ${profile} has no correctness block`); continue; }
    if (correctness.total !== FIXED_CORRECTNESS_TOTAL || correctness.passedCases !== FIXED_CORRECTNESS_TOTAL) reasons.push(`profile ${profile} correctness total/passedCases is not 4/4`);
    if (correctness.passed !== true) reasons.push(`profile ${profile} correctness is not passed`);
    if (!Array.isArray(correctness.caseResults) || correctness.caseResults.length !== FIXED_CORRECTNESS_TOTAL) reasons.push(`profile ${profile} caseResults length is not 4`);
    else if (!correctness.caseResults.every((entry) => entry?.passed === true)) reasons.push(`profile ${profile} has a non-passing case`);
  }
  return {
    taskId: task?.taskId ?? null,
    status: task?.status ?? null,
    candidateId: task?.payload?.candidate?.id ?? null,
    digest: isNonBlank(payloadDigest) ? payloadDigest : null,
    queueRequestId: queueRequestIdOf(task),
    candidateSourceRunId: candidateSourceRunIdOf(task),
    releaseConfirmed: task?.resourceRelease?.confirmed === true,
    profiles: rows.map((row) => ({
      profile: row?.profile ?? null,
      total: row?.correctness?.total ?? null,
      passedCases: row?.correctness?.passedCases ?? null,
      caseResults: Array.isArray(row?.correctness?.caseResults) ? row.correctness.caseResults.length : null,
      allPassed: Array.isArray(row?.correctness?.caseResults) ? row.correctness.caseResults.every((entry) => entry?.passed === true) : false,
    })),
    passed: reasons.length === 0,
    reasons: [...new Set(reasons)],
  };
};

// ---------------------------------------------------------------------------
// Mission stop receipts: the declared boolean is never the evidence; the
// retained initial HTTP receipt (and any later read-only state) is re-evaluated.
// ---------------------------------------------------------------------------
const verifyStopReceipt = ({ source, receipt, missionId, helpers }) => {
  const entry = {
    source,
    family: receipt?.family ?? null,
    missionId: receipt?.missionId ?? null,
    declaredStatusCode: receipt?.statusCode ?? null,
    declaredConfirmed: receipt?.confirmed === true,
    initialStatusCode: null,
    usedFinalState: receipt?.finalState != null,
    evaluatedConfirmed: false,
    reasons: [],
  };
  const initial = receipt?.initialReceipt;
  if (!initial || typeof initial.statusCode !== 'number' || !initial.body || typeof initial.body.state !== 'object' || initial.body.state === null) {
    entry.reasons.push('initialReceipt is not a retained {statusCode, body:{state}} HTTP body');
    return entry;
  }
  entry.initialStatusCode = initial.statusCode;
  // The original HTTP status is preserved. A 202 may only become confirmed
  // through a later bounded read-only proving state, never by elapsed time.
  if (initial.statusCode === 202 && receipt.finalState == null
    && !(Array.isArray(receipt.observations) && receipt.observations.length > 0)) {
    entry.reasons.push('initial HTTP 202 is retained but no later read-only state proves release');
  }
  const chosen = receipt.finalState != null ? { state: receipt.finalState } : initial.body;
  const verdict = helpers.evaluateMissionStopReceipt({ missionId, receipt: chosen });
  entry.evaluatedConfirmed = verdict.confirmed === true;
  if (!verdict.confirmed) entry.reasons.push(`evaluateMissionStopReceipt rejected: ${verdict.reasons.join(', ') || 'unknown'}`);
  if (receipt.confirmed === true && verdict.confirmed !== true) entry.reasons.push('declared confirmed boolean is contradicted by the actual receipt re-evaluation');
  return entry;
};

// Every raw state a retained stop/teardown receipt carries: the ORIGINAL HTTP
// body `{state}` is never replaced, and a later bounded read-only `finalState` is
// a separate observation. Both are collected (never invented) and observed for
// run identity only; the driver's `observations[]` entries hold
// `{at, confirmed, reasons}` and deliberately carry no `state`.
const collectStopStates = (receipt, out) => {
  if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)) return;
  const initialBody = receipt.initialReceipt?.body;
  const initialState = initialBody && typeof initialBody === 'object' && !Array.isArray(initialBody)
    && initialBody.state && typeof initialBody.state === 'object' && !Array.isArray(initialBody.state)
    ? initialBody.state : null;
  if (initialState) out.push(initialState);
  if (receipt.finalState && typeof receipt.finalState === 'object' && !Array.isArray(receipt.finalState)) out.push(receipt.finalState);
};

// A provided teardown stop (`summary.teardownStop` / `attempt.cleanup.teardownStop`)
// is real evidence and is re-evaluated with the frozen production helper, never
// ignored: an unconfirmed teardown release forbids full_success in the driver.
const verifyTeardownStop = ({ source, receipt, helpers }) => {
  const entry = {
    source,
    missionId: receipt?.missionId ?? null,
    statusCode: receipt?.statusCode ?? null,
    declaredConfirmed: receipt?.confirmed === true,
    usedFinalState: receipt?.finalState != null,
    evaluatedConfirmed: false,
    reasons: [],
  };
  const initial = receipt?.initialReceipt;
  const hasInitial = Boolean(initial && typeof initial.statusCode === 'number'
    && initial.body && typeof initial.body.state === 'object' && initial.body.state !== null);
  const hasFinal = Boolean(receipt?.finalState && typeof receipt.finalState === 'object' && !Array.isArray(receipt.finalState));
  if (!hasInitial && !hasFinal) {
    entry.reasons.push('provided teardown stop retains no state to evaluate');
    return entry;
  }
  if (!isNonBlank(receipt?.missionId)) {
    entry.reasons.push('provided teardown stop has no Mission identity');
    return entry;
  }
  const chosen = hasFinal ? { state: receipt.finalState } : initial.body;
  let verdict;
  try {
    verdict = helpers.evaluateMissionStopReceipt({ missionId: receipt.missionId, receipt: chosen });
  } catch (error) {
    entry.reasons.push(`evaluateMissionStopReceipt failed: ${error?.message || error}`);
    return entry;
  }
  entry.evaluatedConfirmed = verdict.confirmed === true;
  if (verdict.confirmed !== true) entry.reasons.push(`evaluateMissionStopReceipt rejected: ${verdict.reasons.join(', ') || 'unknown'}`);
  if (receipt.confirmed !== true) entry.reasons.push('declared teardown stop is not confirmed');
  else if (verdict.confirmed !== true) entry.reasons.push('declared confirmed teardown boolean is contradicted by the actual receipt re-evaluation');
  return entry;
};

// ---------------------------------------------------------------------------
// Family recheck: real state tasks, frozen candidate matrix, driver-equivalent
// archive/audit/rollback selection, recomputed family outcome and stop receipts.
// ---------------------------------------------------------------------------
const verifyFamily = async (context) => {
  const {
    root, family, familyOutcome, familySummary, attempt, summary, provider, helpers,
  } = context;
  const reasons = [];
  const gaps = [];
  const result = {
    family,
    missionId: null,
    stateFile: null,
    stateSha256: null,
    workDir: null,
    taskCounts: { baseline: 0, candidate: 0, candidateCompleted: 0, candidateNotCompleted: 0, other: 0 },
    candidateTasks: [],
    completedCandidates: 0,
    distinctCandidateDigests: 0,
    completed: [],
    summaryCompletedMatches: false,
    summaryCompletedIssues: [],
    sourceRoundId: null,
    derivedSourceRoundId: null,
    targetRoundId: null,
    projectId: null,
    continuedRun: null,
    audit: null,
    rollback: null,
    stop: [],
    workflowWritesAfterStart: null,
    declaredOutcome: familyOutcome?.outcome ?? null,
    declaredSummaryOutcome: familySummary?.outcome ?? null,
    recomputedOutcome: null,
    recomputedReasons: [],
    observedRuns: [],
    evidence: [],
    passed: false,
    reasons,
    gaps,
  };
  if (!isSafeArtifactName(family)) {
    reasons.push('family name is not a safe artifact basename');
    return result;
  }
  if (!familyOutcome) reasons.push('attempt.familyOutcomes has no entry for this family');
  if (!familySummary) reasons.push('summary.summaries has no entry for this family');
  const missionId = isNonBlank(familySummary?.missionId) ? familySummary.missionId
    : (isNonBlank(familyOutcome?.missionId) ? familyOutcome.missionId : '');
  result.missionId = missionId || null;
  if (!missionId) reasons.push('family Mission identity is missing');
  const declaredFamilyOutcome = familyOutcome?.outcome ?? null;
  if (declaredFamilyOutcome !== familySummary?.outcome) reasons.push('attempt/summary family outcome mismatch');

  // The family state file is `<family>-state.json` in the explicit runRoot.
  // There is deliberately NO fallback: if it is missing the reader reports a
  // missing artifact instead of reading another state file as a stand-in.
  const stateFileName = `${family}-state.json`;
  const stateRead = await readJsonFile(path.join(root, stateFileName));
  result.stateFile = stateFileName;
  result.stateSha256 = stateRead.sha256;
  if (stateRead.error || !stateRead.value) {
    reasons.push(`family state file ${stateRead.error || 'is not a parsed object'}`);
    result.passed = false;
    return result;
  }
  const stateRoot = stateRead.value;
  const state = stateRoot.state && typeof stateRoot.state === 'object' && !Array.isArray(stateRoot.state) ? stateRoot.state : null;
  const tasks = Array.isArray(stateRoot.tasks) ? stateRoot.tasks : [];
  if (!state) reasons.push('family state file has no state object');
  if (state && missionId && state.activeMissionId !== missionId) reasons.push('state.activeMissionId does not match the family Mission');

  const candidateTasks = tasks.filter((task) => task?.payload?.purpose === 'candidate');
  const completedTasks = candidateTasks.filter((task) => task?.status === 'completed');
  const notCompleted = candidateTasks.filter((task) => task?.status !== 'completed');
  result.taskCounts = {
    baseline: tasks.filter((task) => task?.payload?.purpose === 'baseline').length,
    candidate: candidateTasks.length,
    candidateCompleted: completedTasks.length,
    candidateNotCompleted: notCompleted.length,
    other: tasks.filter((task) => task?.payload?.purpose !== 'candidate' && task?.payload?.purpose !== 'baseline').length,
  };
  // Every candidate task is retained in the report, completed or not.
  result.candidateTasks = tasks.filter((task) => task?.payload?.purpose === 'candidate').map((task) => ({
    taskId: task?.taskId ?? null,
    status: task?.status ?? null,
    missionId: task?.payload?.missionId ?? null,
    candidateId: task?.payload?.candidate?.id ?? null,
    digest: isNonBlank(task?.payload?.candidate?.digest) ? task.payload.candidate.digest : null,
    completedAt: task?.completedAt ?? null,
  }));

  const digests = new Set();
  for (const task of completedTasks) {
    const checked = verifyCandidateTask(task);
    result.completed.push(checked);
    if (isNonBlank(checked.digest)) digests.add(checked.digest.trim().toLowerCase().replace(/^sha256:/u, ''));
    if (!checked.passed) for (const reason of checked.reasons) reasons.push(`completed candidate ${checked.taskId || '?'}: ${reason}`);
    if (!helpers.isRealGpuCompletedCandidate(task)) reasons.push(`completed candidate ${checked.taskId || '?'}: not an admissible real shared-GPU completed candidate`);
    if (isNonBlank(task?.payload?.missionId) && missionId && task.payload.missionId !== missionId) reasons.push(`candidate ${checked.taskId} belongs to a foreign Mission`);
  }
  for (const task of notCompleted) {
    // Legitimate generation/recovery attempts are retained verbatim and are NOT
    // promoted to, or counted as, a new E2E outcome.
    const reason = task?.result?.error || task?.error || task?.statusReason || null;
    const entry = result.candidateTasks.find((item) => item.taskId === task?.taskId);
    if (entry) entry.failureReason = reason ? String(reason).slice(0, 300) : null;
  }
  result.completedCandidates = completedTasks.length;
  result.distinctCandidateDigests = digests.size;

  const desiredTasks = Number(attempt?.config?.candidateTasks);
  if (!Number.isInteger(desiredTasks) || desiredTasks < 1) reasons.push('attempt.config.candidateTasks is not a positive integer');
  if (completedTasks.length < Math.max(2, Number.isInteger(desiredTasks) ? desiredTasks : 2)) reasons.push('fewer completed real candidate tasks than the configured two-round path');
  if (completedTasks.length < 2) reasons.push('fewer than two completed candidate tasks in the real state');
  if (digests.size < 2) reasons.push('fewer than two distinct completed candidate digests');

  // Exact correspondence with the summary's own completed list, field by field.
  const declaredCompleted = Array.isArray(familySummary?.completed) ? familySummary.completed : [];
  result.summaryCompletedMatches = declaredCompleted.length === completedTasks.length;
  if (!result.summaryCompletedMatches) {
    result.summaryCompletedIssues.push(`summary.completed has ${declaredCompleted.length} entries for ${completedTasks.length} completed real tasks`);
  }
  for (const entry of declaredCompleted) {
    const task = completedTasks.find((item) => item?.taskId === entry?.taskId) || null;
    if (!task) { result.summaryCompletedIssues.push(`summary.completed task ${entry?.taskId || '?'} is not a completed real candidate task`); continue; }
    const digest = candidateDigestOf(task, helpers.hexDigest);
    const mismatches = [];
    if (helpers.hexDigest(entry?.candidateDigest) !== digest) mismatches.push('candidateDigest');
    if (entry?.queueRequestId !== queueRequestIdOf(task)) mismatches.push('queueRequestId');
    if (entry?.packageDigest !== task?.payload?.packageDigest) mismatches.push('packageDigest');
    if (entry?.candidateSourceRunId !== candidateSourceRunIdOf(task)) mismatches.push('candidateSourceRunId');
    if (mismatches.length) result.summaryCompletedIssues.push(`summary.completed task ${entry?.taskId || '?'} disagrees on ${mismatches.join(', ')}`);
  }
  for (const task of completedTasks) {
    if (!declaredCompleted.some((entry) => entry?.taskId === task?.taskId)) {
      result.summaryCompletedIssues.push(`completed real task ${task?.taskId || '?'} is missing from summary.completed`);
    }
  }
  for (const issue of result.summaryCompletedIssues) reasons.push(issue);

  result.workflowWritesAfterStart = familySummary?.workflowWritesAfterStart ?? null;
  if (familySummary?.workflowWritesAfterStart !== 0) reasons.push('summary family workflowWritesAfterStart is not 0');

  // --- frozen source round (derived from the first completed candidate) ------
  const ordered = orderCompleted(completedTasks);
  const firstVerifiedTask = ordered[0] || null;
  const derivedMatches = firstVerifiedTask ? archivedRoundsForTask(state, firstVerifiedTask, helpers.hexDigest) : [];
  if (!firstVerifiedTask) reasons.push('no completed candidate task to bind the continuation audit to');
  else if (derivedMatches.length !== 1) reasons.push(`first verified candidate must match exactly one archived round (found ${derivedMatches.length})`);
  const sourceRound = derivedMatches.length === 1 ? derivedMatches[0] : null;
  if (sourceRound) result.derivedSourceRoundId = sourceRound.roundId ?? null;
  const declaredSourceRoundId = familySummary?.sourceRoundId ?? familyOutcome?.sourceRoundId ?? null;
  result.sourceRoundId = declaredSourceRoundId;
  if (familySummary?.sourceRoundId && familyOutcome?.sourceRoundId && familySummary.sourceRoundId !== familyOutcome.sourceRoundId) reasons.push('attempt/summary sourceRoundId mismatch');
  if (!isNonBlank(declaredSourceRoundId)) reasons.push('sourceRoundId is missing');
  else if (sourceRound && sourceRound.roundId !== declaredSourceRoundId) reasons.push('summary sourceRoundId does not match the independently derived source round');
  if (!sourceRound) {
    if (!isNonBlank(declaredSourceRoundId)) {
      const runHistory = Array.isArray(state?.runHistory) ? state.runHistory : [];
      if (!runHistory.some((round) => round?.roundId === declaredSourceRoundId)) reasons.push('state.runHistory has no round matching sourceRoundId');
    }
  }

  let targetRoundId = null;
  let projectId = null;
  let auditForOutcome = null;
  let rollbackEventsRaw = [];
  if (sourceRound) {
    targetRoundId = sourceRound?.roundFacts?.target?.roundId ?? null;
    projectId = sourceRound?.roundFacts?.target?.projectId ?? null;
    result.targetRoundId = targetRoundId;
    result.projectId = projectId;
    if (!isNonBlank(targetRoundId)) reasons.push('source round has no frozen target roundId');
    if (!isNonBlank(projectId)) reasons.push('source round has no frozen target projectId');

    const auditScan = await findRetainedAudit({
      auditDir: path.join(root, 'bridge', 'prompt-audits'),
      missionId,
      roundId: targetRoundId,
      sourceRunId: sourceRound.runId,
    });
    if (auditScan.error) gaps.push(`prompt-audit directory ${auditScan.error}`);
    result.audit = {
      matchedAuditsForTargetRound: auditScan.matched.map((item) => item.runId),
      selectedBy: 'sourceRound.roundFacts.target.roundId',
      selectedFile: auditScan.selected?.file ?? null,
      selectedRunId: auditScan.selected?.runId ?? null,
      verified: null,
      reasons: [],
    };
    if (!auditScan.selected) {
      if (familySummary?.budgetTerminalAccepted === true) {
        result.audit.reasons.push('no retained pre-send audit for the frozen target round, accepted only as a declared budget terminal');
      } else {
        reasons.push(`no retained pre-send audit for the frozen target round ${targetRoundId}`);
      }
    } else {
      const experiencesRead = await readJsonFile(path.join(root, 'runtime', 'experiences', 'experiences.json'));
      const experiences = Array.isArray(experiencesRead.value?.records) ? experiencesRead.value.records : null;
      if (!experiences) gaps.push('runtime/experiences/experiences.json has no records array');
      else {
        try {
          const verified = helpers.verifyContinuationAudit({
            audit: auditScan.selected.audit, sourceRound, experiences, missionId, projectId,
          });
          result.audit.verified = {
            runId: verified.runId,
            roundId: verified.roundId,
            promptDigest: verified.promptDigest,
            promptBytes: verified.promptBytes,
            selectedExperience: verified.selectedExperience,
            facts: verified.facts,
            assertions: verified.assertions,
          };
          auditForOutcome = { runId: verified.runId, roundId: verified.roundId };
          const declared = familySummary?.continuationAudit;
          if (declared) {
            const bad = [];
            if (declared.runId !== verified.runId) bad.push('runId');
            if (declared.promptDigest !== verified.promptDigest) bad.push('promptDigest');
            if (declared.promptBytes !== verified.promptBytes) bad.push('promptBytes');
            if (isNonBlank(declared.path) && path.basename(declared.path) !== auditScan.selected.file) bad.push('path');
            if (bad.length) reasons.push(`summary continuation audit record disagrees with the independently recomputed audit on ${bad.join(', ')}`);
          }
          const declaredMatched = Array.isArray(declared?.matchedAuditsForTargetRound)
            ? [...declared.matchedAuditsForTargetRound].sort().join('|') : null;
          const observedMatched = [...auditScan.matched.map((item) => item.runId)].sort().join('|');
          if (declaredMatched !== null && declaredMatched !== observedMatched) {
            result.audit.reasons.push('summary matchedAuditsForTargetRound disagrees with the audit files present');
          }
        } catch (error) {
          reasons.push(`verifyContinuationAudit failed: ${error?.message || error}`);
        }
      }
    }

    // --- automatic rollback and a genuinely different continuation run -------
    const factsRollback = sourceRound?.roundFacts?.rollback;
    const rollEvents = [...(Array.isArray(state?.runtimeEvents) ? state.runtimeEvents : []), ...(Array.isArray(state?.auditEvents) ? state.auditEvents : [])]
      .filter((event) => event?.type === 'workflow.round_rolled_back')
      .filter((event) => {
        const bound = eventMissionId(event);
        return !missionId || !bound || bound === missionId;
      });
    rollbackEventsRaw = rollEvents;
    const continuedRun = familySummary?.continuedRun ?? familyOutcome?.continuedRun ?? null;
    result.continuedRun = continuedRun ?? null;
    result.rollback = {
      performed: factsRollback?.performed ?? null,
      workspaceClean: factsRollback?.workspaceClean ?? null,
      events: rollEvents.map((event) => ({ eventId: event?.eventId ?? null, workspaceClean: event?.payload?.workspaceClean ?? null })),
      continuedRun: continuedRun ?? null,
      rollbackCount: familySummary?.rollbackCount ?? null,
    };
    if (factsRollback?.performed !== true || factsRollback?.workspaceClean !== true) reasons.push('frozen source-round rollback is not performed/workspaceClean');
    if (rollEvents.length === 0) reasons.push('no current-Mission workflow.round_rolled_back event');
    else if (!rollEvents.every((event) => event?.payload?.workspaceClean === true)) reasons.push('a current-Mission rollback event is not workspaceClean');
    if (!isNonBlank(continuedRun)) reasons.push('family has no continued run');
    else if (!isSafeArtifactName(continuedRun)) reasons.push('continued run id is not a safe artifact basename');
    else if (continuedRun === sourceRound?.runId) reasons.push('continued run is the same run as the source round');
    const observedRunIds = new Set();
    if (isNonBlank(state?.agent?.runId)) observedRunIds.add(state.agent.runId);
    for (const round of Array.isArray(state?.runHistory) ? state.runHistory : []) if (isNonBlank(round?.runId)) observedRunIds.add(round.runId);
    if (isNonBlank(continuedRun) && !observedRunIds.has(continuedRun)) reasons.push('continued run was never observed in the retained state');
    if (result.audit?.verified && continuedRun && continuedRun !== result.audit.verified.runId) {
      // Legitimate same-round recovery: the audit is the frozen target round's
      // earliest continuation artifact; the final completed run may be a later
      // recovery run. Reported, never treated as a failure.
      result.audit.reasons.push(`final continued run ${continuedRun} differs from the earliest target-round audit run ${result.audit.verified.runId} (same-round recovery)`);
    }
  }

  // --- independent family outcome recomputation (frozen helper) -------------
  const budgetTerminal = declaredFamilyOutcome === 'budget_terminal'
    ? helpers.budgetTerminalEvidence(state, { missionId, runId: state?.agent?.runId ?? null }) : null;
  try {
    const recomputed = helpers.evaluateFamilyOutcome({
      desiredTasks: Number.isInteger(desiredTasks) ? desiredTasks : 2,
      completedTasks,
      budgetTerminal,
      continuationAudit: auditForOutcome,
      rollbackEvents: rollbackEventsRaw,
    });
    result.recomputedOutcome = recomputed.outcome;
    result.recomputedReasons = recomputed.reasons;
    if (recomputed.outcome !== declaredFamilyOutcome) {
      reasons.push(`independently recomputed family outcome ${recomputed.outcome} disagrees with the declared ${declaredFamilyOutcome}${recomputed.reasons.length ? ` (${recomputed.reasons.join(', ')})` : ''}`);
    }
    if (recomputed.outcome !== 'full_success') reasons.push(`independently recomputed family outcome is not full_success: ${recomputed.outcome}`);
  } catch (error) {
    reasons.push(`evaluateFamilyOutcome failed: ${error?.message || error}`);
  }

  // --- Mission stop receipts per family, recomputed from the HTTP body -------
  const declaredSummaryReceipts = Array.isArray(summary?.stopReceipts) ? summary.stopReceipts : [];
  const declaredAttemptReceipts = Array.isArray(attempt?.cleanup?.stopReceipts) ? attempt.cleanup.stopReceipts : [];
  const pick = (list) => list.find((receipt) => receipt?.family === family && (!missionId || receipt?.missionId === missionId)) || null;
  const summaryReceipt = pick(declaredSummaryReceipts);
  const attemptReceipt = pick(declaredAttemptReceipts);
  if (!summaryReceipt) gaps.push('summary.stopReceipts has no receipt for this family/Mission');
  if (!attemptReceipt) gaps.push('attempt.cleanup.stopReceipts has no receipt for this family/Mission');
  for (const [source, receipt] of [['summary', summaryReceipt], ['attempt', attemptReceipt]]) {
    if (!receipt) continue;
    const entry = verifyStopReceipt({ source, receipt, missionId, helpers });
    result.stop.push(entry);
    for (const reason of entry.reasons) reasons.push(`${source} stop receipt: ${reason}`);
  }

  // --- observed run identities (for independent model binding) --------------
  const observed = new Map();
  const remember = ({ runId, missionId: runMission, sessionId, runtimeKind, origin }) => {
    if (!isNonBlank(runId) || runtimeKind !== provider) return;
    if (!isSafeArtifactName(runId)) { reasons.push(`observed run id ${runId} is not a safe artifact basename`); return; }
    const key = `${provider} ${runId}`;
    const list = observed.get(key) || [];
    list.push({
      provider, runId,
      missionId: isNonBlank(runMission) ? runMission : '',
      sessionId: isNonBlank(sessionId) ? sessionId : '',
      origin,
    });
    observed.set(key, list);
  };
  if (state) {
    if (state.agent) remember({ runId: state.agent.runId, missionId: state.agent.missionId, sessionId: state.agent.threadId, runtimeKind: state.agent.runtimeKind, origin: `${family}-state.agent` });
    for (const round of Array.isArray(state.runHistory) ? state.runHistory : []) {
      remember({ runId: round?.runId, missionId: round?.missionId ?? null, sessionId: round?.threadId, runtimeKind: round?.runtimeKind, origin: `${family}-state.runHistory` });
    }
  }
  result.observedRuns = [...observed.values()].flat();

  result.evidence = [
    { path: stateFileName, bytes: stateRead.bytes, sha256: stateRead.sha256, error: stateRead.error },
  ];
  result.passed = reasons.length === 0;
  // Internal use only: the final state projection feeds the independent model
  // run-identity enumeration. Removed from the emitted report by the caller.
  result.__state = state;
  return result;
};

// ---------------------------------------------------------------------------
// Independent response-model evidence for the current runRoot.
// ---------------------------------------------------------------------------
const enumerateProviderRunRecords = async (root, providerArtifactDir) => {
  const dir = path.join(root, 'bridge', providerArtifactDir);
  const { entries, error } = await safeReaddir(dir);
  const files = [];
  if (!error) {
    for (const entry of entries) {
      if (!entry.isFile() || !SAFE_RUN_FILE.test(entry.name) || path.basename(entry.name) !== entry.name) continue;
      files.push(entry.name);
    }
  }
  files.sort((a, b) => a.localeCompare(b));
  const records = [];
  for (const fileName of files) {
    const read = await readJsonFile(path.join(dir, fileName));
    records.push({ fileName, record: read.value, error: read.error });
  }
  return { dir, enumerationError: error, files, records };
};

const verifyModelRun = async ({ root, runDir, provider, runId, declaredBinding, knownIdentities, missionSet, helpers }) => {
  const reasons = [];
  const gaps = [];
  const notes = [];
  const result = {
    provider,
    runId,
    declaredBinding: declaredBinding ?? null,
    recordPath: null,
    recordSha256: null,
    recordError: null,
    recordIdentity: null,
    stateIdentities: knownIdentities,
    identitySource: null,
    dtoStatus: null,
    dtoModel: null,
    dtoModels: [],
    retainedObservations: null,
    configuredModels: [],
    usageModels: [],
    rawVisibleAssistant: null,
    rawVisibleModels: [],
    rawSessionMatches: 0,
    rawForeignSession: 0,
    rawMissingSession: 0,
    rawMissingModel: 0,
    rawParseErrors: 0,
    metadataBoundary: METADATA_BOUNDARY,
    comparable: false,
    passed: false,
    reasons,
    gaps,
    comparabilityNotes: notes,
  };
  if (!isSafeArtifactName(runId)) {
    reasons.push('required run id is not a safe artifact basename');
    return result;
  }
  const recordFile = path.join(runDir, `${runId}.json`);
  result.recordPath = path.relative(root, recordFile).split(path.sep).join('/');
  const recordRead = await readJsonFile(recordFile);
  if (recordRead.error || !recordRead.value || typeof recordRead.value !== 'object' || Array.isArray(recordRead.value)) {
    if (recordRead.error === 'missing') gaps.push('no retained bridge run record in the current runRoot');
    else reasons.push(`bridge run record ${recordRead.error || 'is not a parsed object'}`);
    return result;
  }
  const record = recordRead.value;
  result.recordSha256 = recordRead.sha256;

  if (record.runId !== runId) reasons.push('bridge record runId does not match its filename');
  if (record.provider !== provider) reasons.push('bridge record provider does not match the frozen provider');
  const recordMissionId = isNonBlank(record.missionId) ? record.missionId : '';
  const recordSession = isNonBlank(record.sessionId) ? record.sessionId : (isNonBlank(record.threadId) ? record.threadId : '');
  result.recordIdentity = { provider: record.provider ?? null, runId: record.runId ?? null, missionId: recordMissionId || null, sessionId: recordSession || null };
  if (!recordMissionId) gaps.push('bridge record has no Mission identity');
  else if (!missionSet.has(recordMissionId)) reasons.push('bridge record Mission is not in this attempt\'s expected Mission set');
  if (!recordSession) gaps.push('bridge record has no session identity');
  if (isNonBlank(record.sessionId) && isNonBlank(record.threadId) && record.sessionId !== record.threadId) reasons.push('bridge record sessionId and threadId disagree');

  // Independently observed start identities (state agent / archived rounds) may
  // only cross-check the record; they never relabel a foreign run with
  // activeMissionId, and a conflicting concrete identity blocks.
  const concreteMissions = new Set(knownIdentities.map((item) => item.missionId).filter(isNonBlank));
  const concreteSessions = new Set(knownIdentities.map((item) => item.sessionId).filter(isNonBlank));
  if (concreteMissions.size > 1) reasons.push('conflicting concrete Missions observed for this run in the retained states');
  if (concreteSessions.size > 1) reasons.push('conflicting concrete sessions observed for this run in the retained states');
  if (concreteMissions.size === 1 && recordMissionId && !concreteMissions.has(recordMissionId)) reasons.push('bridge record Mission conflicts with the independently observed run Mission');
  if (concreteSessions.size === 1 && recordSession && !concreteSessions.has(recordSession)) reasons.push('bridge record session conflicts with the independently observed run session');
  result.identitySource = concreteSessions.size === 1 || concreteMissions.size === 1 ? 'state+record' : 'record';

  // DTO binding uses the independently READ record identity, never the DTO's own
  // fields. A DTO that does not bind is provided-but-mis-bound evidence.
  const dto = record.modelObservation && typeof record.modelObservation === 'object' && !Array.isArray(record.modelObservation)
    ? record.modelObservation : null;
  let bound = null;
  if (!dto) {
    gaps.push('bridge record retains no model observation DTO');
  } else if (recordMissionId && recordSession) {
    bound = helpers.bindModelObservation(dto, { provider, runId, missionId: recordMissionId, sessionId: recordSession });
    if (!bound) reasons.push('retained model observation DTO does not bind to the independently read bridge record identity');
  } else {
    gaps.push('bridge record identity is incomplete for DTO binding');
  }
  result.dtoStatus = dto?.status ?? null;
  result.dtoModel = bound?.model ?? (dto?.model ?? null);
  result.dtoModels = Array.isArray(dto?.models) ? dto.models : [];
  result.retainedObservations = Array.isArray(dto?.observations) ? dto.observations.length : null;
  result.configuredModels = Array.isArray(dto?.configuredModels) ? dto.configuredModels : [];
  result.usageModels = Array.isArray(dto?.usageModels) ? dto.usageModels : [];

  // Raw JSONL: only visible assistant.message.model / session identity / counts.
  const jsonlFile = path.join(runDir, `${runId}.jsonl`);
  const rawRead = await readTextFile(jsonlFile);
  if (rawRead.error) {
    gaps.push(`raw JSONL ${rawRead.error}`);
  } else {
    let rawVisible = 0;
    const visibleModels = new Set();
    for (const line of rawRead.text.split(/\r?\n/u)) {
      const text = line.trim();
      if (!text) continue;
      let event;
      try { event = JSON.parse(text); } catch { result.rawParseErrors += 1; continue; }
      if (event?.type !== 'assistant') continue;
      rawVisible += 1;
      const eventSession = typeof event.session_id === 'string' ? event.session_id : '';
      if (!isNonBlank(eventSession)) result.rawMissingSession += 1;
      else if (recordSession && eventSession !== recordSession) result.rawForeignSession += 1;
      else result.rawSessionMatches += 1;
      const model = trimmed(event?.message?.model);
      if (!isValidModelLabel(model)) result.rawMissingModel += 1;
      else visibleModels.add(model);
    }
    result.rawVisibleAssistant = rawVisible;
    result.rawVisibleModels = [...visibleModels].sort();
    if (result.rawParseErrors) reasons.push(`raw JSONL has ${result.rawParseErrors} unparsable line(s)`);
    if (result.rawMissingSession) reasons.push(`raw JSONL has ${result.rawMissingSession} assistant event(s) without a session id`);
    if (result.rawForeignSession) reasons.push(`raw JSONL has ${result.rawForeignSession} assistant event(s) from a foreign session`);
    if (result.rawMissingModel) reasons.push(`raw JSONL has ${result.rawMissingModel} assistant event(s) without a valid model label`);

    if (bound && bound.status === 'observed') {
      for (const model of visibleModels) {
        if (model !== bound.model) reasons.push(`visible raw model ${model} disagrees with the retained response model ${bound.model}`);
      }
      if (rawVisible > bound.observations.length) reasons.push('visible raw assistant events exceed retained metadata observations (subset invariant broken)');
      if (rawVisible === 0) {
        // A metadata-only run is legitimate: Claude Code collects
        // assistant.message.model metadata first and its telemetry filter drops
        // thinking-only events, so ALL retained observations may be thinking
        // metadata and the filtered raw stream can legitimately expose no visible
        // assistant response. This is never a rejection. The retained DTO stays
        // provider-reported (never upgraded), is still bound to the independently
        // read run identity, and the rest of the run contract must still hold; the
        // only consequence is that the raw stream cannot independently corroborate
        // this response model, which is stated plainly here.
        notes.push('raw .jsonl exposes no visible assistant response (thinking-only metadata was filtered): this response model rests on the provider-reported retained metadata DTO bound to the run record and cannot be independently corroborated from the raw stream');
      }
    } else if (bound && bound.status === 'unknown') {
      if (rawVisible > 0) reasons.push('raw JSONL exposes assistant responses but the retained DTO is unknown');
    } else if (bound && bound.status === 'conflict') {
      notes.push('retained DTO reports conflicting concrete response models; the workflow outcome is retained unchanged but the run is not comparable');
    } else if (!bound && rawVisible > 0) {
      reasons.push('raw JSONL exposes assistant responses but no bindable retained DTO exists');
    }
  }
  result.comparable = bound?.status === 'observed' && reasons.length === 0 && gaps.length === 0;
  if (bound && bound.status !== 'observed') notes.push(`retained response-model status is ${bound.status}; not comparable, workflow outcome unchanged`);
  result.passed = reasons.length === 0 && gaps.length === 0 && Boolean(bound);
  return result;
};

const verifyModelEvidence = async ({ root, attempt, summary, provider, providerArtifactDir, families, familyStates, stopStates, helpers }) => {
  const reasons = [];
  const gaps = [];
  const runDir = path.join(root, 'bridge', providerArtifactDir);
  const enumeration = await enumerateProviderRunRecords(root, providerArtifactDir);

  // The expected Mission set is fixed by the CURRENT attempt's family identities
  // only. A foreign Mission seen in a stop/teardown state never expands it.
  const missionSet = new Set();
  for (const family of families) if (isNonBlank(family.missionId)) missionSet.add(family.missionId);
  for (const family of Array.isArray(attempt?.familyOutcomes) ? attempt.familyOutcomes : []) if (isNonBlank(family?.missionId)) missionSet.add(family.missionId);

  // Independently observed start identities: per family state agent + archived
  // rounds, plus the read-only final states retained in the stop receipts. Never
  // activeMissionId as a substitute for a run's own binding.
  const identityMap = new Map();
  const remember = ({ runId, missionId, sessionId, runtimeKind, origin }) => {
    if (!isNonBlank(runId) || runtimeKind !== provider) return;
    const key = `${provider} ${runId}`;
    const list = identityMap.get(key) || [];
    list.push({ provider, runId, missionId: isNonBlank(missionId) ? missionId : '', sessionId: isNonBlank(sessionId) ? sessionId : '', origin });
    identityMap.set(key, list);
  };
  const observeState = (state, origin) => {
    if (!state || typeof state !== 'object') return;
    if (state.agent) remember({ runId: state.agent.runId, missionId: state.agent.missionId, sessionId: state.agent.threadId, runtimeKind: state.agent.runtimeKind, origin: `${origin}.agent` });
    for (const round of Array.isArray(state.runHistory) ? state.runHistory : []) {
      remember({ runId: round?.runId, missionId: round?.missionId ?? null, sessionId: round?.threadId, runtimeKind: round?.runtimeKind, origin: `${origin}.runHistory` });
    }
  };
  familyStates.forEach((state, index) => observeState(state, `${families[index]?.family ?? index}-state`));
  for (const state of stopStates) observeState(state, 'stopReceipt.state');

  // The declared required set (attempt + summary). Compared against, never
  // trusted as the independent enumeration.
  const declaredRequired = new Map();
  for (const [origin, list] of [
    ['attempt', Array.isArray(attempt?.modelObservationRequiredRuns) ? attempt.modelObservationRequiredRuns : []],
    ['summary', Array.isArray(summary?.modelObservationRequiredRuns) ? summary.modelObservationRequiredRuns : []],
  ]) {
    for (const item of list) {
      if (!item || typeof item !== 'object') continue;
      const key = `${item.provider || ''} ${item.runId || ''}`;
      if (!declaredRequired.has(key)) declaredRequired.set(key, { origin, provider: item.provider ?? null, runId: item.runId ?? null, missionId: item.missionId ?? null, sessionId: item.sessionId ?? null });
    }
  }

  // Frozen collector semantics: a concrete foreign-Mission record that no known
  // start references is historical evidence of another attempt, reported but not
  // absorbed into this attempt's required denominator.
  const identityIsForeign = (key) => {
    const list = identityMap.get(key) || [];
    const missions = new Set(list.map((item) => item.missionId).filter(isNonBlank));
    return missions.size === 1 && !missionSet.has([...missions][0]);
  };
  const recordEntries = enumeration.records.map((item) => {
    const runId = item.fileName.slice(0, -'.json'.length);
    const record = item.record;
    const recordMissionId = record && typeof record === 'object' && !Array.isArray(record) && isNonBlank(record.missionId) ? record.missionId : '';
    return { ...item, runId, recordMissionId };
  });
  const isForeignRecord = (entry) => Boolean(entry.recordMissionId) && !missionSet.has(entry.recordMissionId)
    && !identityMap.has(`${provider} ${entry.runId}`) && !declaredRequired.has(`${provider} ${entry.runId}`);

  // Independent required run set: declared runs + state-observed runs + safe run
  // files actually present in the frozen provider directory (minus historical
  // foreign-Mission files, which the frozen collector also never observes).
  const requiredKeys = new Map();
  const addRequired = (key, entry) => { if (!requiredKeys.has(key)) requiredKeys.set(key, entry); };
  for (const [key, entry] of declaredRequired) addRequired(key, { provider: entry.provider || provider, runId: entry.runId, source: 'declared' });
  const foreignObservedRuns = [];
  for (const [key, list] of identityMap) {
    if (identityIsForeign(key)) { foreignObservedRuns.push({ runId: list[0].runId, missions: [...new Set(list.map((item) => item.missionId).filter(isNonBlank))], origins: [...new Set(list.map((item) => item.origin))] }); continue; }
    addRequired(key, { provider, runId: list[0].runId, source: 'state' });
  }
  const fileRecords = new Map();
  const foreignRecords = [];
  for (const entry of recordEntries) {
    if (isForeignRecord(entry)) { foreignRecords.push({ fileName: entry.fileName, runId: entry.runId, missionId: entry.recordMissionId, error: entry.error }); continue; }
    fileRecords.set(entry.runId, entry);
    addRequired(`${provider} ${entry.runId}`, { provider, runId: entry.runId, source: 'record' });
  }

  // Known starts for the frozen pure collector: state identities plus declared
  // bindings. The record files are the final read authority.
  const knownRuns = [];
  for (const [key, list] of identityMap) {
    if (identityIsForeign(key)) continue;
    knownRuns.push(...list.map((item) => ({ provider: item.provider, runId: item.runId, missionId: item.missionId, sessionId: item.sessionId })));
  }
  for (const entry of declaredRequired.values()) knownRuns.push({ provider: entry.provider || provider, runId: entry.runId, missionId: entry.missionId && entry.missionId !== helpers.UNRESOLVED_RUN_MISSION ? entry.missionId : '', sessionId: entry.sessionId && entry.sessionId !== helpers.UNRESOLVED_RUN_SESSION ? entry.sessionId : '' });
  for (const entry of fileRecords.values()) knownRuns.push({ provider, runId: entry.runId });

  const collected = helpers.collectModelObservationEvidence({
    provider, missionIds: [...missionSet], knownRuns, records: enumeration.records,
  });

  const runs = [];
  for (const [key, entry] of requiredKeys) {
    const identities = identityMap.get(key) ? [...identityMap.get(key)] : [];
    // Drop duplicate identical observations of the same identity.
    const seen = new Set();
    const knownIdentities = identities.filter((item) => {
      const form = `${item.missionId}|${item.sessionId}|${item.origin}`;
      if (seen.has(form)) return false;
      seen.add(form);
      return true;
    });
    const verified = await verifyModelRun({
      root,
      runDir,
      provider,
      runId: entry.runId,
      declaredBinding: declaredRequired.get(key) || null,
      knownIdentities,
      missionSet,
      helpers,
    });
    verified.requiredSource = entry.source;
    verified.fileName = fileRecords.has(entry.runId) ? `${entry.runId}.json` : null;
    runs.push(verified);
    for (const reason of verified.reasons) reasons.push(`model run ${entry.runId || '?'}: ${reason}`);
    for (const gap of verified.gaps) gaps.push(`model run ${entry.runId || '?'}: ${gap}`);
  }

  // A run file present for this Mission that the summary never declared is a
  // masked run: retained and reported, never silently absorbed.
  const declaredRunIds = new Set([...declaredRequired.values()].map((entry) => entry.runId));
  const undeclared = [];
  for (const entry of fileRecords.values()) {
    if (!declaredRunIds.has(entry.runId)) {
      undeclared.push({ fileName: entry.fileName, runId: entry.runId, missionId: entry.recordMissionId || null, error: entry.error });
    }
  }
  for (const item of undeclared) gaps.push(`run record ${item.fileName} belongs to this attempt but is absent from the declared required runs`);

  if (enumeration.enumerationError) gaps.push(`frozen provider run directory ${enumeration.enumerationError}`);
  if (enumeration.files.length === 0 && !enumeration.enumerationError) gaps.push('frozen provider run directory has no run records');

  // Frozen pure-helper recomputation: any disagreement with the retained summary
  // is a blocking contradiction, never a "close enough" match.
  const summaryFields = ['schemaVersion', 'status', 'model', 'modelSource', 'models', 'requiredRunCount', 'observedRunCount'];
  const declaredSummary = attempt?.modelObservationSummary ?? null;
  const declaredSummaryFromSummaryJson = summary?.modelObservationSummary ?? null;
  const recomputedSummary = collected.summary;
  const mismatch = (declared) => !declared || summaryFields.some((field) => canonical(declared[field]) !== canonical(recomputedSummary[field]));
  if (mismatch(declaredSummary)) reasons.push('attempt.modelObservationSummary disagrees with the independent recomputation from the current runRoot records');
  if (declaredSummaryFromSummaryJson && mismatch(declaredSummaryFromSummaryJson)) reasons.push('summary.modelObservationSummary disagrees with the independent recomputation from the current runRoot records');
  if (declaredSummary && declaredSummaryFromSummaryJson && canonical(declaredSummary) !== canonical(declaredSummaryFromSummaryJson)) reasons.push('attempt/summary modelObservationSummary disagree');

  const normalizeRequired = (list) => [...new Set(list.map((item) => [item.provider || '', item.missionId || '', item.runId || '', item.sessionId || ''].join('|')))].sort();
  const independentRequired = normalizeRequired(collected.requiredRuns);
  const declaredRequiredNormalized = normalizeRequired([...declaredRequired.values()].map((entry) => ({
    provider: entry.provider || provider,
    missionId: entry.missionId || helpers.UNRESOLVED_RUN_MISSION,
    runId: entry.runId || '',
    sessionId: entry.sessionId || helpers.UNRESOLVED_RUN_SESSION,
  })));
  const requiredDiff = {
    missingFromDeclaration: independentRequired.filter((item) => !declaredRequiredNormalized.includes(item)),
    absentFromEnumeration: declaredRequiredNormalized.filter((item) => !independentRequired.includes(item)),
  };
  if (requiredDiff.missingFromDeclaration.length) gaps.push(`independent enumeration found run identities the summary never declared: ${requiredDiff.missingFromDeclaration.join(', ')}`);
  if (requiredDiff.absentFromEnumeration.length) gaps.push(`declared required run identities absent from the independent enumeration: ${requiredDiff.absentFromEnumeration.join(', ')}`);

  return {
    provider,
    providerRunDir: path.relative(root, runDir).split(path.sep).join('/') || null,
    missionIds: [...missionSet].sort(),
    enumerationError: enumeration.enumerationError,
    runFiles: enumeration.files,
    declaredRequiredRuns: [...declaredRequired.values()],
    independentlyRequiredRuns: collected.requiredRuns,
    requiredDiff,
    unboundRuns: collected.unboundRuns,
    undeclaredRuns: undeclared,
    foreignRecords,
    foreignObservedRuns,
    recomputedSummary,
    declaredSummary,
    declaredSummaryFromSummaryJson,
    summaryMatches: !mismatch(declaredSummary),
    runs,
    passed: reasons.length === 0 && gaps.length === 0 && runs.every((run) => run.passed),
    reasons,
    gaps,
  };
};

// ---------------------------------------------------------------------------
// Per-run orchestration.
// ---------------------------------------------------------------------------
const verifyRun = async (record, context) => {
  const { ledgerEntry, helpers } = context;
  const root = record.runDir;
  const attempt = record.attempt;
  const summary = record.summary;
  const reasons = [];
  const gaps = [];
  const notes = [];
  const result = {
    runRoot: root,
    identity: ledgerEntry?.identity ?? null,
    ledgerOutcome: ledgerEntry?.outcome ?? 'failure',
    ledgerIssues: ledgerEntry?.issues ?? [],
    configFingerprint: ledgerEntry?.configFingerprint ?? null,
    declaredFingerprint: ledgerEntry?.declaredFingerprint ?? null,
    fingerprint: {
      recomputed: ledgerEntry?.configFingerprint ?? null,
      declared: ledgerEntry?.declaredFingerprint ?? null,
      declaredMatches: Boolean(ledgerEntry?.configFingerprint) && ledgerEntry?.declaredFingerprint === ledgerEntry?.configFingerprint,
      unknownFields: ledgerEntry?.unknownFields ?? [],
    },
    comparable: ledgerEntry?.comparable ?? false,
    comparabilityIssues: ledgerEntry?.comparabilityIssues ?? [],
    modelObservation: ledgerEntry?.modelObservation ?? null,
    modelObservationIssues: ledgerEntry?.modelObservationIssues ?? [],
    provider: null,
    providerRunDir: null,
    attemptMissing: !attempt,
    summaryMissing: !summary,
    readErrors: Array.isArray(record.errors) ? record.errors : [],
    families: [],
    modelEvidence: null,
    teardownStops: [],
    originals: [],
    metadataBoundary: METADATA_BOUNDARY,
    passed: false,
    reasons,
    gaps,
    comparabilityNotes: notes,
  };
  if (!attempt) gaps.push('attempt.json is missing');
  if (!summary) gaps.push('summary.json is missing');
  if (!attempt || !summary) { result.passed = false; return result; }
  if (ledgerEntry?.issues?.includes('duplicate_record_conflict')) reasons.push('duplicate record conflict retained by the ledger');
  // The declared fingerprint is never taken on trust: the frozen ledger
  // recomputes it from the retained config/code, and a disagreement is reported
  // (comparability), not silently accepted.
  if (!result.fingerprint.recomputed) notes.push('config fingerprint could not be recomputed from the retained config');
  else if (!result.fingerprint.declaredMatches) notes.push('declared config fingerprint does not equal the independently recomputed fingerprint');

  const provider = isNonBlank(attempt.runtime) ? attempt.runtime : (isNonBlank(summary.runtime) ? summary.runtime : null);
  result.provider = provider;
  if (!provider || !Object.hasOwn(PROVIDER_ARTIFACT_DIRS, provider)) {
    reasons.push(`attempt runtime ${provider ?? '<missing>'} is not a frozen provider label`);
  }
  if (attempt.provider && typeof attempt.provider === 'object' && isNonBlank(attempt.provider.runtime)
    && provider && attempt.provider.runtime !== provider) reasons.push('attempt.provider.runtime disagrees with attempt.runtime');
  const providerArtifactDir = provider && Object.hasOwn(PROVIDER_ARTIFACT_DIRS, provider) ? PROVIDER_ARTIFACT_DIRS[provider] : null;
  result.providerRunDir = providerArtifactDir ? `bridge/${providerArtifactDir}` : null;

  if (attempt.outcome !== summary.outcome || attempt.fullSuccess !== summary.fullSuccess) reasons.push('attempt/summary top-level outcome disagree');
  if (attempt.outcome !== 'full_success' || attempt.fullSuccess !== true) {
    notes.push(`retained top-level outcome is ${attempt.outcome ?? '<missing>'} (not full_success); retained verbatim, never upgraded`);
  }

  const requestedFamilies = Array.isArray(attempt?.config?.families) ? attempt.config.families : (Array.isArray(summary?.families) ? summary.families : []);
  const families = [...new Set(requestedFamilies)];
  if (!families.length) gaps.push('no configured families');
  const familyOutcomes = Array.isArray(attempt?.familyOutcomes) ? attempt.familyOutcomes : [];
  const familySummaries = Array.isArray(summary?.summaries) ? summary.summaries : [];
  const stateFiles = [];
  const stopStates = [];
  const familyStates = [];

  for (const family of families) {
    const familyOutcome = familyOutcomes.find((item) => item?.family === family) || null;
    const familySummary = familySummaries.find((item) => item?.family === family) || null;
    const verified = await verifyFamily({
      root, family, familyOutcome, familySummary, attempt, summary, provider: provider || '', helpers,
    });
    result.families.push(verified);
    familyStates.push(verified.__state ?? null);
    stateFiles.push(verified.stateFile);
    for (const reason of verified.reasons) reasons.push(`family ${family}: ${reason}`);
    for (const gap of verified.gaps) gaps.push(`family ${family}: ${gap}`);
    // The family's retained stop receipt (original HTTP body state + any later
    // bounded finalState) is an independent run-identity observation.
    collectStopStates(familySummary?.stopReceipt, stopStates);
  }
  // Fixed collection set: every retained stop/teardown receipt in the explicit
  // runRoot contributes its initialReceipt.body.state and its finalState.
  for (const receipt of Array.isArray(summary?.stopReceipts) ? summary.stopReceipts : []) collectStopStates(receipt, stopStates);
  for (const receipt of Array.isArray(attempt?.cleanup?.stopReceipts) ? attempt.cleanup.stopReceipts : []) collectStopStates(receipt, stopStates);
  collectStopStates(summary?.teardownStop, stopStates);
  collectStopStates(attempt?.cleanup?.teardownStop, stopStates);

  // --- provided teardown stops are re-evaluated, never ignored --------------
  result.teardownStops = [];
  for (const [source, receipt] of [['summary', summary?.teardownStop], ['attempt', attempt?.cleanup?.teardownStop]]) {
    if (receipt === null || receipt === undefined) continue;
    const entry = verifyTeardownStop({ source, receipt, helpers });
    result.teardownStops.push(entry);
    for (const reason of entry.reasons) reasons.push(`${source} teardown stop: ${reason}`);
  }

  // State files declared by the attempt must be exactly the ones read here.
  if (providerArtifactDir) {
    const declaredStateFiles = Array.isArray(attempt?.evidence?.stateFiles) ? attempt.evidence.stateFiles : [];
    for (const file of declaredStateFiles) {
      const base = path.basename(file);
      if (!stateFiles.includes(base)) gaps.push(`attempt.evidence.stateFiles lists ${base} but it was not read as a family state file`);
    }
  }

  // --- independent model evidence for this explicit runRoot -----------------
  if (providerArtifactDir) {
    const modelEvidence = await verifyModelEvidence({
      root, attempt, summary, provider, providerArtifactDir, families: result.families, familyStates, stopStates, helpers,
    });
    result.modelEvidence = modelEvidence;
    for (const reason of modelEvidence.reasons) reasons.push(reason);
    for (const gap of modelEvidence.gaps) gaps.push(gap);
    for (const run of modelEvidence.runs) if (run.comparabilityNotes.length) notes.push(...run.comparabilityNotes.map((note) => `model run ${run.runId}: ${note}`));
  } else {
    gaps.push('no frozen provider artifact directory could be determined');
  }
  // The raw state projections were only needed to enumerate run identities.
  for (const family of result.families) delete family.__state;

  // --- retained-original integrity evidence (this reader never writes them) --
  const originals = ['attempt.json', 'summary.json', 'runtime/experiences/experiences.json'];
  for (const file of [...new Set(stateFiles.filter(isNonBlank))]) originals.push(file);
  for (const modelRun of result.modelEvidence?.runs ?? []) {
    if (modelRun.recordPath) originals.push(modelRun.recordPath, modelRun.recordPath.replace(/\.json$/u, '.jsonl'));
  }
  const auditFiles = [];
  for (const family of result.families) if (family.audit?.selectedFile) auditFiles.push(`bridge/prompt-audits/${family.audit.selectedFile}`);
  originals.push(...auditFiles);
  result.originals = [];
  for (const relative of [...new Set(originals.filter(isNonBlank))]) {
    if (relative.endsWith('.jsonl')) {
      const read = await readTextFile(path.join(root, relative));
      result.originals.push({ path: relative, bytes: read.bytes, sha256: read.sha256, error: read.error });
    } else {
      const read = await readJsonFile(path.join(root, relative));
      result.originals.push({ path: relative, bytes: read.bytes, sha256: read.sha256, error: read.error });
    }
  }

  result.passed = reasons.length === 0
    && gaps.length === 0
    && result.ledgerOutcome === 'full_success'
    && attempt.outcome === 'full_success' && attempt.fullSuccess === true
    && families.length > 0
    && result.families.every((family) => family.passed)
    && Boolean(result.modelEvidence && result.modelEvidence.passed);
  return result;
};

// ---------------------------------------------------------------------------
// Strict N20 and coverage are reported separately.
// ---------------------------------------------------------------------------
const buildStrictN20 = (ledger, passedByRunDir) => {
  const duplicateRunDirs = new Set((ledger.duplicates || []).map((duplicate) => {
    const matchedRun = (ledger.groups || []).flatMap((group) => group.runs || [])
      .find((run) => run.identity === duplicate.identity);
    return matchedRun?.runDir ? path.resolve(matchedRun.runDir) : null;
  }).filter(Boolean));
  const groups = (ledger.groups || []).map((group) => {
    const runs = group.runs || [];
    const nonFull = runs.filter((run) => run.outcome !== 'full_success').length;
    const deepVerified = runs.length > 0 && runs.every((run) => passedByRunDir.get(path.resolve(run.runDir)) === true);
    const hasDuplicate = runs.some((run) => duplicateRunDirs.has(path.resolve(run.runDir)));
    const eligible = group.comparable === true
      && runs.length >= STRICT_N20_REQUIRED_RUNS
      && nonFull === 0
      && group.counts.full_success === runs.length
      && (group.counts.budget_terminal || 0) === 0
      && (group.counts.timeout || 0) === 0
      && (group.counts.missing_summary || 0) === 0
      && deepVerified
      && !hasDuplicate;
    return {
      fingerprint: group.fingerprint,
      groupKey: group.groupKey,
      comparable: group.comparable === true,
      runs: runs.length,
      full_success: group.counts.full_success || 0,
      budget_terminal: group.counts.budget_terminal || 0,
      failure: group.counts.failure || 0,
      timeout: group.counts.timeout || 0,
      missing_summary: group.counts.missing_summary || 0,
      deepVerified,
      duplicateConflict: hasDuplicate,
      unknownFields: group.unknownFields || [],
      comparabilityIssues: group.comparabilityIssues || [],
      eligible,
    };
  });
  const eligible = groups.filter((group) => group.eligible);
  return {
    requiredRuns: STRICT_N20_REQUIRED_RUNS,
    eligible: eligible.length > 0,
    eligibleGroups: eligible.map((group) => group.fingerprint),
    groups,
    reason: eligible.length > 0
      ? 'a same-fingerprint group reached >=20 retained full_success runs with zero failure/budget/timeout/missing/duplicates and every run passed this reader'
      : `no same-fingerprint group meets the strict >=${STRICT_N20_REQUIRED_RUNS} all-full_success rule in this invocation`,
    note: 'The ledger n20.eligible flag is only comparability/denominator eligibility and is never treated as a strict pass. Coverage and strict N20 are reported separately.',
  };
};

const buildCoverage = (runs, ledger) => {
  const families = new Set();
  const models = new Set();
  let candidateTasks = 0;
  let distinctCandidateDigests = 0;
  let modelRuns = 0;
  for (const run of runs) {
    for (const family of run.families) {
      if (family.missionId) families.add(family.family);
      candidateTasks += family.candidateTasks.filter((task) => task.status === 'completed').length;
      distinctCandidateDigests += family.distinctCandidateDigests;
    }
    for (const modelRun of run.modelEvidence?.runs ?? []) {
      modelRuns += 1;
      if (isNonBlank(modelRun.dtoModel)) models.add(modelRun.dtoModel);
    }
  }
  return {
    invocations: runs.length,
    passedInvocations: runs.filter((run) => run.passed).length,
    families: [...families].sort(),
    familyCount: families.size,
    candidateTasks,
    distinctCandidateDigests,
    modelRuns,
    models: [...models].sort(),
    fingerprints: (ledger.groups || []).map((group) => ({ fingerprint: group.fingerprint, runs: group.counts.runs, families: group.families })),
    note: 'Coverage is reported separately from strict N20; a covered multi-family run is not a stability claim.',
  };
};

const emit = (value) => { process.stdout.write(`${JSON.stringify(value, null, 2)}\n`); };

const main = async () => {
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed.help) {
    emit({ schemaVersion: SCHEMA, usage: 'node verify-retained-runs.mjs --repo <absolute repo> <explicit runRoot> [runRoot...]' });
    return;
  }
  const fatal = [...parsed.errors];
  if (!parsed.repo) fatal.push('--repo <absolute repo> is required');
  if (!parsed.runRoots.length) fatal.push('at least one explicit runRoot is required');
  if (fatal.length) {
    emit({ schemaVersion: SCHEMA, ok: false, errors: fatal });
    process.exitCode = 1;
    return;
  }
  const repoRoot = path.resolve(parsed.repo);
  try {
    const info = await stat(repoRoot);
    if (!info.isDirectory()) throw new Error('not a directory');
  } catch (error) {
    emit({ schemaVersion: SCHEMA, ok: false, repo: repoRoot, errors: [`--repo is not a readable directory: ${error?.message || error}`] });
    process.exitCode = 1;
    return;
  }

  let helpers;
  const helperEvidence = [];
  try {
    const load = async (relative) => {
      const file = path.join(repoRoot, relative);
      const buffer = await readFile(file);
      helperEvidence.push({ path: relative, bytes: buffer.length, sha256: sha256Hex(buffer) });
      return import(pathToFileURL(file).href);
    };
    const acceptance = await load('scripts/shared-gpu-acceptance.mjs');
    const ledgerModule = await load('scripts/summarize-gpu-agent-runs.mjs');
    const modelObservation = await load('client-runtime/model-observation.mjs');
    helpers = {
      readRunRecord: ledgerModule.readRunRecord,
      summarizeAcceptanceRuns: ledgerModule.summarizeAcceptanceRuns,
      verifyContinuationAudit: acceptance.verifyContinuationAudit,
      evaluateMissionStopReceipt: acceptance.evaluateMissionStopReceipt,
      evaluateFamilyOutcome: acceptance.evaluateFamilyOutcome,
      budgetTerminalEvidence: acceptance.budgetTerminalEvidence,
      collectModelObservationEvidence: acceptance.collectModelObservationEvidence,
      isRealGpuCompletedCandidate: acceptance.isRealGpuCompletedCandidate,
      hexDigest: acceptance.hexDigest,
      UNRESOLVED_RUN_MISSION: acceptance.UNRESOLVED_RUN_MISSION,
      UNRESOLVED_RUN_SESSION: acceptance.UNRESOLVED_RUN_SESSION,
      bindModelObservation: modelObservation.bindModelObservation,
      summarizeModelObservations: modelObservation.summarizeModelObservations,
    };
  } catch (error) {
    emit({ schemaVersion: SCHEMA, ok: false, repo: repoRoot, errors: [`failed to import frozen helpers from --repo: ${error?.message || error}`] });
    process.exitCode = 1;
    return;
  }

  const runRoots = parsed.runRoots.map((runRoot) => path.resolve(runRoot));
  const records = [];
  for (const runRoot of runRoots) records.push(await helpers.readRunRecord(runRoot));
  // Frozen ledger first: it reclassifies outcome/model proof/fingerprint and keeps
  // every failure, missing summary and duplicate in its denominator.
  const ledger = helpers.summarizeAcceptanceRuns(records);

  const entryByRunDir = new Map();
  for (const group of ledger.groups || []) {
    for (const entry of group.runs || []) {
      if (entry.runDir) entryByRunDir.set(path.resolve(entry.runDir), entry);
    }
  }

  const runs = [];
  for (const record of records) {
    runs.push(await verifyRun(record, { ledgerEntry: entryByRunDir.get(path.resolve(record.runDir)) || null, helpers }));
  }

  const passedByRunDir = new Map(runs.map((run) => [path.resolve(run.runRoot), run.passed]));
  const strictN20 = buildStrictN20(ledger, passedByRunDir);
  const coverage = buildCoverage(runs, ledger);
  const fullSuccessRuns = runs.filter((run) => run.ledgerOutcome === 'full_success').length;
  const verifiedRuns = runs.filter((run) => run.passed).length;
  const ok = runs.length === runRoots.length && runs.length > 0 && runs.every((run) => run.passed);

  const result = {
    schemaVersion: SCHEMA,
    mode: 'read-only-offline',
    generatedBy: 'docs/development/evidence/live-regression-20260913/verify-retained-runs.mjs',
    repo: repoRoot,
    repoHelpers: helperEvidence,
    runRoots,
    ledger: {
      schemaVersion: ledger.schemaVersion,
      totals: ledger.totals,
      duplicates: ledger.duplicates,
      groups: (ledger.groups || []).map((group) => ({
        fingerprint: group.fingerprint,
        groupKey: group.groupKey,
        provider: group.provider,
        comparable: group.comparable,
        counts: group.counts,
        stabilityDenominator: group.stabilityDenominator,
        unknownFields: group.unknownFields,
        comparabilityIssues: group.comparabilityIssues,
        n20: group.n20,
        runs: (group.runs || []).map((entry) => ({
          identity: entry.identity,
          runDir: entry.runDir,
          outcome: entry.outcome,
          issues: entry.issues,
          comparable: entry.comparable,
          modelObservation: entry.modelObservation,
          modelObservationIssues: entry.modelObservationIssues,
        })),
      })),
      n20: ledger.n20,
    },
    runs,
    coverage,
    strictN20,
    metadataBoundary: METADATA_BOUNDARY,
    result: {
      ok,
      exitCode: ok ? 0 : 1,
      runCount: runs.length,
      fullSuccessRuns,
      verifiedRuns,
      strictN20Eligible: strictN20.eligible,
    },
  };
  // Every explicitly passed run must be a real full_success AND pass the recheck.
  emit(result);
  process.exitCode = ok ? 0 : 1;
};

await main();
