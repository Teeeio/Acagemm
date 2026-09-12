#!/usr/bin/env node
// Read-only ledger over retained real shared-GPU Agent acceptance run directories.
// It never starts a Runtime, provider, GPU test or N=20 batch: it only reads the
// `attempt.json` / `summary.json` artifacts a driver run already left on disk.
//
// Contract documentation: scripts/shared-gpu-acceptance.md
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  GPU_ATTEMPT_SCHEMA_VERSION, GPU_SUMMARY_SCHEMA_VERSION, GPU_LEDGER_SCHEMA_VERSION,
  buildConfigFingerprint, digestJson,
} from './shared-gpu-acceptance.mjs';

const OUTCOMES = Object.freeze(['full_success', 'budget_terminal', 'failure', 'timeout', 'missing_summary']);

const readJson = async (file) => {
  try {
    return { value: JSON.parse(await readFile(file, 'utf8')), error: null };
  } catch (error) {
    return { value: null, error: error.code === 'ENOENT' ? 'missing' : `unreadable: ${error.message}` };
  }
};

// Read one run directory into a record. Missing artifacts are recorded, never
// skipped: a run without a summary must still appear in the ledger.
export const readRunRecord = async (runDir) => {
  const attemptFile = path.join(runDir, 'attempt.json');
  const summaryFile = path.join(runDir, 'summary.json');
  const [attempt, summary] = await Promise.all([readJson(attemptFile), readJson(summaryFile)]);
  return {
    runDir,
    attemptPath: attemptFile,
    summaryPath: summaryFile,
    attempt: attempt.value,
    summary: summary.value,
    errors: [
      ...(attempt.error ? [`attempt.json ${attempt.error}`] : []),
      ...(summary.error ? [`summary.json ${summary.error}`] : []),
    ],
  };
};

const familyOutcomes = (value) => (Array.isArray(value) ? value.filter(Boolean) : []);

// Classify one retained attempt. Explicit failure always wins, and a
// contradiction never upgrades: an attempt that says failure with a summary that
// says full_success is a failure; a missing/running attempt or an invalid schema
// can never be full_success. `issues` keeps every contradiction observable.
export const classifyAcceptanceRecord = (record) => {
  const attempt = record?.attempt || null;
  const summary = record?.summary || null;
  const issues = [];
  const attemptMissing = !attempt;
  const summaryMissing = !summary;
  const attemptPhase = typeof attempt?.phase === 'string' ? attempt.phase
    : (typeof attempt?.status === 'string' ? attempt.status : null);
  const attemptOutcome = typeof attempt?.outcome === 'string' ? attempt.outcome : null;
  const summaryOutcome = typeof summary?.outcome === 'string' ? summary.outcome : null;
  const summaryStatus = typeof summary?.status === 'string' ? summary.status : null;
  const attemptSchemaValid = Boolean(attempt) && attempt.schemaVersion === GPU_ATTEMPT_SCHEMA_VERSION;
  const summarySchemaValid = Boolean(summary) && summary.schemaVersion === GPU_SUMMARY_SCHEMA_VERSION;
  const attemptTerminal = attemptPhase === 'terminal';
  if (attemptMissing) issues.push('attempt_missing');
  if (summaryMissing) issues.push('summary_missing');
  if (attempt && !attemptSchemaValid) issues.push('attempt_schema_invalid');
  if (summary && !summarySchemaValid) issues.push('summary_schema_invalid');
  if (attempt && !attemptTerminal) issues.push('attempt_not_terminal');

  const explicitFailure = attemptOutcome === 'failure' || summaryOutcome === 'failure'
    || summaryStatus === 'failed' || attemptPhase === 'failed';
  const timedOut = attemptOutcome === 'timeout' || summaryOutcome === 'timeout';
  const claimedFull = attemptOutcome === 'full_success' || summaryOutcome === 'full_success'
    || attempt?.fullSuccess === true || summary?.fullSuccess === true;

  const outcomesConsistent = attemptOutcome === null || summaryOutcome === null || attemptOutcome === summaryOutcome;
  const flagsConsistent = !(claimedFull && (attempt?.fullSuccess === false || summary?.fullSuccess === false));
  const attemptFamilies = familyOutcomes(attempt?.familyOutcomes);
  const summaryFamilies = familyOutcomes(summary?.familyOutcomes ?? summary?.summaries);
  const requestedFamilies = attempt?.config?.families ?? attempt?.families ?? summary?.families ?? [];
  const completeFamilySet = (items) => Array.isArray(requestedFamilies) && requestedFamilies.length > 0
    && new Set(requestedFamilies).size === requestedFamilies.length
    && items.length === requestedFamilies.length
    && requestedFamilies.every((family) => items.filter((item) => item.family === family).length === 1);
  const familyCoverage = completeFamilySet(attemptFamilies) && completeFamilySet(summaryFamilies);
  const familyItems = [...attemptFamilies, ...summaryFamilies];
  const familyFlagsConsistent = !claimedFull
    || (familyCoverage && familyItems.every((item) => item?.outcome === 'full_success' && item?.fullSuccess === true));
  if (!outcomesConsistent) issues.push('attempt_summary_outcome_mismatch');
  if (!flagsConsistent) issues.push('full_success_flag_mismatch');
  if (!familyFlagsConsistent) issues.push('family_outcomes_not_full_success');
  if (!familyCoverage) issues.push('family_coverage_incomplete');

  const fullSuccessEvidenced = claimedFull && !explicitFailure && !timedOut
    && !attemptMissing && !summaryMissing && attemptTerminal
    && attemptSchemaValid && summarySchemaValid
    && attemptOutcome === 'full_success' && summaryOutcome === 'full_success'
    && attempt?.fullSuccess === true && summary?.fullSuccess === true
    && outcomesConsistent && flagsConsistent && familyFlagsConsistent;

  const budgetConsistent = !attemptMissing && attemptTerminal && attemptSchemaValid && summarySchemaValid
    && !claimedFull && outcomesConsistent
    && attemptOutcome === 'budget_terminal' && summaryOutcome === 'budget_terminal'
    && attempt?.fullSuccess === false && summary?.fullSuccess === false
    && familyCoverage
    && familyItems.every((item) => ['full_success', 'budget_terminal'].includes(item.outcome)
      && item.fullSuccess === (item.outcome === 'full_success'))
    && summaryFamilies.some((item) => item.outcome === 'budget_terminal')
    && summaryFamilies.filter((item) => item.outcome === 'budget_terminal').every((item) => {
      const proof = item.budgetTerminalEvidence;
      return proof?.safe === true && proof.terminal === true && proof.budgetReasonRecorded === true
        && proof.resourceReleaseConfirmed === true && proof.issues?.length === 0;
    });

  let outcome;
  if (summaryMissing) {
    outcome = 'missing_summary';
  } else if (explicitFailure) {
    outcome = 'failure';
  } else if (timedOut) {
    outcome = 'timeout';
  } else if (fullSuccessEvidenced) {
    outcome = 'full_success';
  } else if (budgetConsistent && (attemptOutcome === 'budget_terminal' || summaryOutcome === 'budget_terminal')) {
    outcome = 'budget_terminal';
  } else {
    outcome = 'failure';
  }
  if (outcome !== 'full_success' && claimedFull && !explicitFailure && !timedOut) {
    issues.push('full_success_not_evidenced');
  }
  return {
    outcome,
    issues: [...new Set(issues)],
    attemptOutcome,
    summaryOutcome,
    attemptPhase,
    attemptTerminal,
    attemptMissing,
    summaryMissing,
    attemptSchemaValid,
    summarySchemaValid,
    claimedFull,
  };
};

const identityOf = (record, index) => record?.attempt?.attemptId
  || record?.attempt?.runRoot
  || record?.runDir
  || `record:${index}`;

// Pure ledger. `records` are `{ runDir, attempt, summary }` objects (either may be
// null). Every retained attempt is counted once; duplicate identities (same
// attemptId/runRoot or runDir passed twice) are de-duplicated with a warning and
// never accumulate into an N. Missing summaries, timeouts and failures stay in
// the denominator of their own comparable group. A group is comparable only when
// EVERY entry in it is comparable, and its unknown-field set is the union; runs
// with unknown/declared fields can never claim N=20.
export const summarizeAcceptanceRuns = (records = []) => {
  const raw = Array.isArray(records) ? records : [];
  const seen = new Map();
  const duplicates = [];
  const unique = [];
  raw.forEach((record, index) => {
    const identity = identityOf(record, index);
    const aliases = [record?.attempt?.attemptId && `id:${record.attempt.attemptId}`,
      record?.runDir && `path:${path.resolve(record.runDir)}`,
      record?.attempt?.runRoot && `path:${path.resolve(record.attempt.runRoot)}`].filter(Boolean);
    const matched = aliases.find((alias) => seen.has(alias));
    if (matched) {
      const kept = unique.find((entry) => entry.index === seen.get(matched));
      const previousOutcome = classifyAcceptanceRecord(kept.record).outcome;
      const duplicateOutcome = classifyAcceptanceRecord(record).outcome;
      const conflict = previousOutcome !== duplicateOutcome
        || digestJson(kept.record.attempt?.config ?? null) !== digestJson(record?.attempt?.config ?? null);
      kept.duplicateConflict ||= conflict;
      duplicates.push({
        identity,
        keptIndex: kept.index,
        duplicateIndex: index,
        runDir: record?.runDir || null,
        previousOutcome, duplicateOutcome, conflict,
      });
      return;
    }
    for (const alias of aliases) seen.set(alias, index);
    unique.push({ record, index });
  });

  const entries = unique.map(({ record, index, duplicateConflict }) => {
    const attempt = record?.attempt || null;
    const summary = record?.summary || null;
    const classified = classifyAcceptanceRecord(record);
    const config = attempt?.config || summary?.config || null;
    const configPresent = Boolean(config) && typeof config === 'object' && Object.keys(config).length > 0;
    const code = attempt?.code || summary?.code || null;
    const computed = configPresent ? buildConfigFingerprint(config, { code }) : null;
    const unknownFields = computed ? [...computed.unknownFields] : ['config'];

    const declaredAttempt = typeof attempt?.configFingerprint === 'string' ? attempt.configFingerprint : null;
    const declaredSummary = typeof summary?.configFingerprint === 'string' ? summary.configFingerprint : null;
    const declared = declaredSummary || declaredAttempt;
    if (declaredAttempt && declaredSummary && declaredAttempt !== declaredSummary) {
      unknownFields.push('declared_fingerprint_mismatch');
    }
    if (declared && computed && declared !== computed.fingerprint) unknownFields.push('declared_fingerprint_mismatch');
    const attemptConfig = attempt?.config && typeof attempt.config === 'object' ? attempt.config : null;
    const summaryConfig = summary?.config && typeof summary.config === 'object' ? summary.config : null;
    if (attemptConfig && summaryConfig
      && buildConfigFingerprint(attemptConfig, { code: attempt?.code || null }).fingerprint
        !== buildConfigFingerprint(summaryConfig, { code: summary?.code || null }).fingerprint) {
      unknownFields.push('attempt_summary_config_mismatch');
    }

    const attemptValid = Boolean(attempt) && classified.attemptSchemaValid && classified.attemptTerminal;
    const comparabilityIssues = [...new Set(unknownFields)];
    if (!attemptValid) comparabilityIssues.push(classified.attemptMissing ? 'attempt_missing' : 'attempt_not_terminal');
    if (!record?.attempt?.attemptId && !record?.runDir && !record?.attempt?.runRoot) comparabilityIssues.push('attempt_identity_missing');
    if (duplicateConflict) comparabilityIssues.push('duplicate_record_conflict');
    return {
      index,
      runDir: record?.runDir || null,
      identity: identityOf(record, index),
      outcome: duplicateConflict ? 'failure' : classified.outcome,
      issues: duplicateConflict ? [...classified.issues, 'duplicate_record_conflict'] : classified.issues,
      attemptOutcome: classified.attemptOutcome,
      summaryOutcome: classified.summaryOutcome,
      config,
      configFingerprint: computed?.fingerprint || null,
      declaredFingerprint: declared,
      unknownFields: [...new Set(unknownFields)],
      comparabilityIssues,
      comparable: comparabilityIssues.length === 0,
      attemptValid,
      provider: config?.provider || null,
      backend: config?.backend || null,
      families: Array.isArray(config?.families) ? config.families : (Array.isArray(summary?.families) ? summary.families : []),
      attemptPhase: classified.attemptPhase,
      attemptTerminal: classified.attemptTerminal,
      summaryMissing: classified.summaryMissing,
      attemptMissing: classified.attemptMissing,
      errors: Array.isArray(record?.errors) ? [...record.errors] : [],
    };
  });

  const totals = {
    runs: entries.length,
    receivedRecords: raw.length,
    duplicateRuns: duplicates.length,
    full_success: 0,
    budget_terminal: 0,
    failure: 0,
    timeout: 0,
    missing_summary: 0,
    summariesMissing: 0,
    attemptsMissing: 0,
    attemptsNotTerminal: 0,
    comparableRuns: 0,
  };
  for (const entry of entries) {
    if (OUTCOMES.includes(entry.outcome)) totals[entry.outcome] += 1;
    else totals.failure += 1;
    if (entry.summaryMissing) totals.summariesMissing += 1;
    if (entry.attemptMissing) totals.attemptsMissing += 1;
    if (!entry.attemptMissing && !entry.attemptTerminal) totals.attemptsNotTerminal += 1;
    if (entry.comparable) totals.comparableRuns += 1;
  }

  const groupMap = new Map();
  for (const entry of entries) {
    const key = entry.configFingerprint || `unconfigured:${entry.unknownFields.join('+') || 'unknown'}`;
    if (!groupMap.has(key)) {
      groupMap.set(key, {
        fingerprint: entry.configFingerprint,
        groupKey: key,
        provider: entry.provider,
        backend: entry.backend,
        matrixFingerprint: entry.config ? digestJson(entry.config.matrix ?? null) : null,
        promptPolicy: entry.config?.promptPolicy || null,
        budgets: entry.config?.budgets || null,
        families: [...new Set(entry.families)].sort(),
        runs: [],
        unknownFields: [],
        comparabilityIssues: [],
        counts: { runs: 0, full_success: 0, budget_terminal: 0, failure: 0, timeout: 0, missing_summary: 0 },
      });
    }
    const group = groupMap.get(key);
    group.runs.push(entry);
    group.counts.runs += 1;
    group.counts[entry.outcome] = (group.counts[entry.outcome] || 0) + 1;
    group.unknownFields = [...new Set([...group.unknownFields, ...entry.unknownFields])];
    group.comparabilityIssues = [...new Set([...group.comparabilityIssues, ...entry.comparabilityIssues])];
  }

  const groups = [...groupMap.values()]
    .map((group) => {
      // Every entry must be comparable; one declared mismatch, missing config or
      // non-terminal attempt makes the whole group non-comparable.
      const comparable = group.runs.every((entry) => entry.comparable);
      // Stability denominator retains every unique started attempt, including
      // missing summaries and failures. Nothing is silently excluded.
      const stabilityDenominator = group.counts.runs;
      return {
        ...group,
        fingerprint: group.fingerprint,
        comparable,
        counts: group.counts,
        stabilityDenominator,
        n20: {
          eligible: comparable && group.counts.runs >= 20,
          comparable,
          requiredRuns: 20,
          runs: group.counts.runs,
          reason: comparable
            ? (group.counts.runs >= 20 ? 'comparable group reached 20 retained attempts' : 'fewer than 20 retained attempts in this comparable group')
            : `non-comparable group: ${[...new Set([...group.comparabilityIssues, ...group.unknownFields])].join(', ') || 'unknown'}`,
        },
      };
    })
    .sort((a, b) => String(a.fingerprint || a.groupKey).localeCompare(String(b.fingerprint || b.groupKey)));

  const eligible = groups.filter((group) => group.n20.eligible);
  return {
    schemaVersion: GPU_LEDGER_SCHEMA_VERSION,
    totals,
    duplicates,
    groups,
    n20: {
      eligibleGroups: eligible.map((group) => group.fingerprint),
      eligibleGroupCount: eligible.length,
      // This ledger never asserts stability; it only reports which groups could
      // even enter an N=20 denominator. Real hardware samples are never inferred.
      note: 'Only groups whose provider, CLI/model version, backend, hardware, architecture, device, driver, code revision, matrix, prompt policy and budgets are all observed and identical may be pooled. A declared (env/configured) value or any unknown field keeps the group non-comparable. Missing summaries, timeouts and failures stay in the denominator of their own group; duplicate identities are counted once with a warning.',
    },
  };
};

const usage = () => [
  'Usage: node scripts/summarize-gpu-agent-runs.mjs [--json] <runDir> [runDir...]',
  '',
  'Reads retained attempt.json / summary.json from explicit run directories.',
  'Never starts a new Agent, GPU or N=20 run.',
].join('\n');

const renderText = (ledger) => {
  const lines = [];
  lines.push(`GPU Agent acceptance ledger (${ledger.schemaVersion})`);
  lines.push(`runs=${ledger.totals.runs} (received=${ledger.totals.receivedRecords} duplicates=${ledger.totals.duplicateRuns}) full_success=${ledger.totals.full_success} budget_terminal=${ledger.totals.budget_terminal} failure=${ledger.totals.failure} timeout=${ledger.totals.timeout} missing_summary=${ledger.totals.missing_summary}`);
  lines.push(`summariesMissing=${ledger.totals.summariesMissing} attemptsMissing=${ledger.totals.attemptsMissing} attemptsNotTerminal=${ledger.totals.attemptsNotTerminal} comparableRuns=${ledger.totals.comparableRuns}`);
  for (const duplicate of ledger.duplicates) {
    lines.push(`duplicate ignored: identity=${duplicate.identity} runDir=${duplicate.runDir || 'unknown'}`);
  }
  for (const group of ledger.groups) {
    const provider = group.provider?.runtime || 'unknown';
    const version = group.provider?.cliVersion || 'unknown';
    const model = group.provider?.model || 'unknown';
    lines.push('');
    lines.push(`[${group.comparable ? 'comparable' : 'NOT-comparable'}] provider=${provider} cli=${version} model=${model} fingerprint=${group.fingerprint || group.groupKey}`);
    lines.push(`  runs=${group.counts.runs} stabilityDenominator=${group.stabilityDenominator} full_success=${group.counts.full_success} budget_terminal=${group.counts.budget_terminal} failure=${group.counts.failure} timeout=${group.counts.timeout} missing_summary=${group.counts.missing_summary}`);
    if (group.comparabilityIssues.length) lines.push(`  comparabilityIssues=${group.comparabilityIssues.join(', ')}`);
    lines.push(`  n20.eligible=${group.n20.eligible} (${group.n20.reason})`);
  }
  lines.push('');
  lines.push(ledger.n20.note);
  return lines.join('\n');
};

const main = async () => {
  const args = process.argv.slice(2);
  const json = args.includes('--json');
  const runDirs = args.filter((arg) => !arg.startsWith('--'));
  if (args.includes('--help') || args.includes('-h')) { console.log(usage()); return; }
  if (!runDirs.length) { console.error(usage()); process.exitCode = 1; return; }
  const records = [];
  for (const runDir of runDirs) records.push(await readRunRecord(path.resolve(runDir)));
  const ledger = summarizeAcceptanceRuns(records);
  console.log(json ? JSON.stringify(ledger, null, 2) : renderText(ledger));
};

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  await main();
}
