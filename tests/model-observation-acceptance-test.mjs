// Independent, hardware-free acceptance for the frozen model-observation contract
// (docs/development/MODEL_OBSERVATION_ACCEPTANCE.md, frozen executable matrix B) and
// its driver/ledger comparability consequences.
//
// This batch is intentionally RED: the pure module
// `client-runtime/model-observation.mjs` is not implemented yet, and the frozen
// fingerprint/ledger eligibility rules (observed status + schema version +
// modelSource 'observed', per-required-run DTO agreement, run/session identities
// stripped from the stable fingerprint) are not implemented yet either. Red must come
// only from those pending APIs/contracts, never from this file's own logic.
//
// Authority: docs/development/MODEL_OBSERVATION_ACCEPTANCE.md (upstream-frozen; this
// test must not edit it), scripts/shared-gpu-acceptance.md, REAL_GPU_REGRESSION.md.
// It never starts a Runtime, provider, GPU, Agent or N=20 batch; it imports the public
// pure APIs and passes synthetic evidence only.
import assert from 'node:assert/strict';
import {
  MODEL_OBSERVATION_SCHEMA_VERSION, bindModelObservation, observeClaudeModel,
  summarizeModelObservations,
} from '../client-runtime/model-observation.mjs';
import {
  GPU_ATTEMPT_SCHEMA_VERSION, GPU_SUMMARY_SCHEMA_VERSION, ROUND_FACTS_SCHEMA_VERSION,
  buildConfigFingerprint,
} from '../scripts/shared-gpu-acceptance.mjs';
import {
  classifyAcceptanceRecord, summarizeAcceptanceRuns,
} from '../scripts/summarize-gpu-agent-runs.mjs';

// The responding model is provider-reported assistant.message.model, never the
// system.init/env/usage labels. This mirrors the preserved P1 raw-stream mismatch.
const RESPONSE_MODEL = 'deepseek-v4-flash';
const INIT_MODEL = 'claude-opus-5[1m]';
const RUN = 'run_model_1';
const MISSION = 'MIS_MODEL';
const SESSION = 'sess_model_1';

const assistant = (sessionId, model, content = [{ type: 'text', text: 'ok' }]) => ({
  type: 'assistant', session_id: sessionId, message: { model, content },
});
const initEvent = (sessionId, model = INIT_MODEL) => ({
  type: 'system', subtype: 'init', session_id: sessionId, model,
});
const resultEvent = (sessionId, models = [INIT_MODEL]) => ({
  type: 'result', session_id: sessionId,
  modelUsage: Object.fromEntries(models.map((model) => [model, { input_tokens: 1 }])),
});
const eventsFor = (sessionId, model) => [
  initEvent(sessionId),
  // Thinking-only responses still carry the actual response metadata.
  assistant(sessionId, model, [{ type: 'thinking', thinking: 'private reasoning' }]),
  assistant(sessionId, model),
  resultEvent(sessionId),
];
const observe = (overrides = {}) => observeClaudeModel({
  runId: RUN, missionId: MISSION, sessionId: SESSION, events: [], ...overrides,
});

// ---------------------------------------------------------------------------
// Part A — observeClaudeModel: response identity is not a source label
// ---------------------------------------------------------------------------

const DTO_FIELDS = [
  'configuredModels', 'missionId', 'model', 'models', 'observations', 'provider',
  'reasons', 'runId', 'schemaVersion', 'sessionId', 'source', 'status', 'usageModels',
];

{
  const dto = observe({ events: eventsFor(SESSION, RESPONSE_MODEL) });
  assert.deepEqual(Object.keys(dto).sort(), DTO_FIELDS,
    'observeClaudeModel returns the complete required DTO shape');
  assert.equal(dto.schemaVersion, MODEL_OBSERVATION_SCHEMA_VERSION);
  assert.equal(dto.provider, 'claude-code');
  assert.equal(dto.runId, RUN);
  assert.equal(dto.missionId, MISSION);
  assert.equal(dto.sessionId, SESSION);
  assert.equal(dto.status, 'observed');
  // Init/usage labels disagree with the response and are diagnostic only.
  assert.equal(dto.model, RESPONSE_MODEL, 'only assistant.message.model reports the responding model');
  assert.equal(dto.source, 'assistant.message.model');
  assert.deepEqual(dto.models, [RESPONSE_MODEL]);
  assert.deepEqual(dto.configuredModels, [INIT_MODEL], 'system.init.model is retained separately');
  assert.deepEqual(dto.usageModels, [INIT_MODEL], 'result.modelUsage keys are retained separately');
  assert.equal(dto.observations.length, 2, 'both assistant responses (including thinking-only) are observed');
  assert.ok(dto.observations.every((item) => Number.isInteger(item.eventIndex) && item.eventIndex >= 0
    && item.sessionId === SESSION && item.model === RESPONSE_MODEL));
  assert.ok(!JSON.stringify(dto).includes('private reasoning'), 'no thinking/text is persisted in the DTO');
  assert.ok(Array.isArray(dto.reasons));
}

{
  // No assistant response at all: init/result labels never create an observation.
  const initOnly = observe({ events: [initEvent(SESSION), resultEvent(SESSION)] });
  assert.equal(initOnly.status, 'unknown');
  assert.equal(initOnly.model, null);
  assert.equal(initOnly.source, null);
  assert.deepEqual(initOnly.models, []);
  assert.ok(initOnly.reasons.length > 0);

  const empty = observe();
  assert.equal(empty.status, 'unknown');
  assert.equal(empty.model, null);
  assert.deepEqual(empty.models, []);

  // A foreign event field named `model` or model-like text is ignored.
  const ignored = observe({
    events: [initEvent(SESSION), resultEvent(SESSION),
      { type: 'user', session_id: SESSION, model: 'other-model', text: 'the model is claude-x' }],
  });
  assert.equal(ignored.status, 'unknown');
  assert.deepEqual(ignored.models, []);
}

{
  // Missing/blank/unknown/null/undefined/<synthetic> response labels never count.
  for (const bad of ['', '   ', 'unknown', 'UNKNOWN', '<synthetic>', null, undefined]) {
    const dto = observe({ events: [assistant(SESSION, bad), assistant(SESSION, bad)] });
    assert.equal(dto.status, 'unknown', `a ${JSON.stringify(bad)} response label must stay unknown`);
    assert.equal(dto.model, null);
    assert.equal(dto.source, null);
    assert.deepEqual(dto.models, []);
  }
}

{
  // Multiple concrete response models conflict; model/source are cleared, the
  // concrete labels remain visible, sorted and unique.
  const conflict = observe({ events: [assistant(SESSION, 'model-b'), assistant(SESSION, 'model-a'), assistant(SESSION, 'model-b')] });
  assert.equal(conflict.status, 'conflict');
  assert.equal(conflict.model, null);
  assert.equal(conflict.source, null);
  assert.deepEqual(conflict.models, ['model-a', 'model-b']);
  assert.ok(conflict.reasons.length > 0);
}

{
  // A foreign or absent session invalidates completeness and never replaces the
  // current session identity.
  const foreign = observe({ events: [assistant('sess_other', RESPONSE_MODEL)] });
  assert.notEqual(foreign.status, 'observed');
  assert.equal(foreign.model, null);
  assert.equal(foreign.sessionId, SESSION, 'the requested session identity is retained, never the foreign one');

  const missingSession = observe({ events: [{ type: 'assistant', message: { model: RESPONSE_MODEL, content: [] } }] });
  assert.notEqual(missingSession.status, 'observed');
  assert.equal(missingSession.model, null);
}

// ---------------------------------------------------------------------------
// Part B — bindModelObservation: exact identity and complete shape
// ---------------------------------------------------------------------------

const validDto = observe({ events: eventsFor(SESSION, RESPONSE_MODEL) });
const VALID_BINDING = { provider: 'claude-code', runId: RUN, missionId: MISSION, sessionId: SESSION };

{
  const bound = bindModelObservation(validDto, VALID_BINDING);
  assert.ok(bound, 'an observed DTO with exact identities must bind');
  assert.deepEqual(bound, validDto);
  bound.models.push('mutated');
  bound.observations[0].model = 'mutated';
  assert.deepEqual(validDto.models, [RESPONSE_MODEL], 'bind must return a deep detached copy');
  assert.equal(validDto.observations[0].model, RESPONSE_MODEL);
}

{
  for (const [label, patch] of [
    ['provider', { provider: 'codex-cli' }],
    ['runId', { runId: 'run_other' }],
    ['missionId', { missionId: 'MIS_OTHER' }],
    ['sessionId', { sessionId: 'sess_other' }],
  ]) {
    assert.equal(bindModelObservation(validDto, { ...VALID_BINDING, ...patch }), null,
      `an exact ${label} mismatch must be rejected`);
  }
  for (const field of ['provider', 'runId', 'missionId', 'sessionId']) {
    assert.equal(bindModelObservation(validDto, { ...VALID_BINDING, [field]: '   ' }), null,
      `a blank ${field} identity must be rejected`);
  }
  assert.equal(bindModelObservation(validDto, undefined), null);
  assert.equal(bindModelObservation(null, VALID_BINDING), null);
  assert.equal(bindModelObservation([], VALID_BINDING), null);
}

{
  const mutations = [
    ['wrong schema version', (dto) => { dto.schemaVersion = 'operator-studio.model-observation/v0'; }],
    ['invalid status', (dto) => { dto.status = 'guessed'; }],
    ['missing field', (dto) => { delete dto.models; }],
    ['observed without a model', (dto) => { dto.model = null; }],
    ['observed without a source', (dto) => { dto.source = null; }],
    ['source without an observed response', (dto) => { dto.status = 'unknown'; }],
    ['model absent from models', (dto) => { dto.models = ['model-other']; }],
    ['blank model entry', (dto) => { dto.models = [RESPONSE_MODEL, ' ']; }],
    ['duplicated models entry', (dto) => { dto.models = [RESPONSE_MODEL, RESPONSE_MODEL]; }],
    ['observations not an array', (dto) => { dto.observations = {}; }],
    ['negative event index', (dto) => { dto.observations[0].eventIndex = -1; }],
    ['non-integer event index', (dto) => { dto.observations[0].eventIndex = 1.5; }],
    ['observation model absent from models', (dto) => { dto.observations[0].model = 'model-other'; }],
    ['blank observation session', (dto) => { dto.observations[0].sessionId = ' '; }],
    ['configuredModels not unique', (dto) => { dto.configuredModels = [INIT_MODEL, INIT_MODEL]; }],
    ['usageModels not an array', (dto) => { dto.usageModels = INIT_MODEL; }],
    ['reasons not an array', (dto) => { dto.reasons = 'x'; }],
    ['wrong provider field', (dto) => { dto.provider = 'codex-cli'; }],
  ];
  for (const [label, mutate] of mutations) {
    const dto = structuredClone(validDto);
    mutate(dto);
    assert.equal(bindModelObservation(dto, VALID_BINDING), null, `${label} must fail bind`);
  }

  // unknown/conflict DTOs may be shape-valid and bind, but never establish comparability.
  const unknownDto = observe();
  assert.equal(unknownDto.status, 'unknown');
  const boundUnknown = bindModelObservation(unknownDto, VALID_BINDING);
  assert.ok(boundUnknown, 'a shape-valid unknown DTO still binds to its exact run identity');
}

// ---------------------------------------------------------------------------
// Part C — summarizeModelObservations: every required (incl. failed/recovery) run
// ---------------------------------------------------------------------------

const LEDGER_MISSION = 'MIS_LEDGER';
const REQUIRED_RUNS = [
  { provider: 'claude-code', runId: 'run_ok', missionId: LEDGER_MISSION, sessionId: 'sess_ok' },
  { provider: 'claude-code', runId: 'run_failed', missionId: LEDGER_MISSION, sessionId: 'sess_failed' },
  { provider: 'claude-code', runId: 'run_recovery', missionId: LEDGER_MISSION, sessionId: 'sess_recovery' },
];
const dtoFor = (binding, model = RESPONSE_MODEL) => observeClaudeModel({
  runId: binding.runId, missionId: binding.missionId, sessionId: binding.sessionId,
  events: eventsFor(binding.sessionId, model),
});
const ALL_DTOS = REQUIRED_RUNS.map((binding) => dtoFor(binding));

{
  const summary = summarizeModelObservations(ALL_DTOS, { requiredRuns: REQUIRED_RUNS });
  assert.equal(summary.schemaVersion, MODEL_OBSERVATION_SCHEMA_VERSION);
  assert.equal(summary.status, 'observed');
  assert.equal(summary.model, RESPONSE_MODEL);
  assert.equal(summary.modelSource, 'observed');
  assert.deepEqual(summary.models, [RESPONSE_MODEL]);
  assert.equal(summary.requiredRunCount, 3);
  assert.equal(summary.observedRunCount, 3, 'failed and recovery runs are counted, not dropped');
  assert.deepEqual(summary.reasons, []);
  for (const field of ['schemaVersion', 'status', 'model', 'modelSource', 'models',
    'requiredRunCount', 'observedRunCount', 'reasons']) {
    assert.ok(Object.hasOwn(summary, field), `summary DTO must carry ${field}`);
  }
}

{
  // A missing failed/recovery run keeps the denominator and can never be observed.
  const missingFailed = summarizeModelObservations([ALL_DTOS[0], ALL_DTOS[2]], { requiredRuns: REQUIRED_RUNS });
  assert.notEqual(missingFailed.status, 'observed');
  assert.equal(missingFailed.requiredRunCount, 3);
  assert.equal(missingFailed.observedRunCount, 2);
  assert.equal(missingFailed.modelSource, 'unknown');

  // A required failed run with no matching DTO is never satisfied by another run's DTO.
  const foreignOnly = summarizeModelObservations([ALL_DTOS[0]], { requiredRuns: [REQUIRED_RUNS[1]] });
  assert.notEqual(foreignOnly.status, 'observed');
  assert.equal(foreignOnly.requiredRunCount, 1);
  assert.equal(foreignOnly.observedRunCount, 0, 'a foreign DTO never satisfies a required run');
}

{
  // Foreign identity evidence is rejected outright.
  const foreign = dtoFor({ runId: 'run_foreign', missionId: LEDGER_MISSION, sessionId: 'sess_foreign' });
  const withForeign = summarizeModelObservations([...ALL_DTOS, foreign], { requiredRuns: REQUIRED_RUNS });
  assert.notEqual(withForeign.status, 'observed', 'foreign per-run evidence must never establish observed');
  assert.equal(withForeign.observedRunCount, 3);

  const foreignProvider = { ...ALL_DTOS[0], provider: 'codex-cli' };
  assert.notEqual(summarizeModelObservations([foreignProvider, ALL_DTOS[1], ALL_DTOS[2]], { requiredRuns: REQUIRED_RUNS }).status,
    'observed');
}

{
  // Different concrete response models across valid runs conflict.
  const conflicting = dtoFor(REQUIRED_RUNS[1], 'model-other');
  const conflict = summarizeModelObservations([ALL_DTOS[0], conflicting, ALL_DTOS[2]], { requiredRuns: REQUIRED_RUNS });
  assert.equal(conflict.status, 'conflict');
  assert.equal(conflict.modelSource, 'unknown');
  assert.ok(conflict.model == null, 'a conflicting summary cannot carry a single response model');
}

{
  // Empty required list is unknown; repeated identical evidence adds no run;
  // contradictory duplicates for one binding fail closed.
  assert.equal(summarizeModelObservations([], {}).status, 'unknown');
  assert.equal(summarizeModelObservations([], { requiredRuns: [] }).status, 'unknown');
  assert.equal(summarizeModelObservations(ALL_DTOS, {}).status, 'unknown');

  const repeated = summarizeModelObservations([ALL_DTOS[0], ALL_DTOS[0], ...ALL_DTOS], { requiredRuns: REQUIRED_RUNS });
  assert.equal(repeated.status, 'observed');
  assert.equal(repeated.observedRunCount, 3, 'a repeated identical DTO for one binding does not add a run');

  const contradictory = summarizeModelObservations([ALL_DTOS[1], dtoFor(REQUIRED_RUNS[1], 'model-other')],
    { requiredRuns: [REQUIRED_RUNS[1]] });
  assert.notEqual(contradictory.status, 'observed', 'contradictory duplicates for one binding fail closed');

  const malformed = summarizeModelObservations([{ ...ALL_DTOS[0], schemaVersion: 'bogus' }, ALL_DTOS[1], ALL_DTOS[2]],
    { requiredRuns: REQUIRED_RUNS });
  assert.notEqual(malformed.status, 'observed', 'malformed evidence can never establish observed');

  const duplicatedRequired = summarizeModelObservations([ALL_DTOS[0]],
    { requiredRuns: [REQUIRED_RUNS[0], { ...REQUIRED_RUNS[0], sessionId: 'sess_other' }] });
  assert.notEqual(duplicatedRequired.status, 'observed', 'required identities must be unique by provider/mission/run');
}

// ---------------------------------------------------------------------------
// Part D — fingerprint: one comparable configuration, one N
// ---------------------------------------------------------------------------

const OBSERVED_SUMMARY = summarizeModelObservations(ALL_DTOS, { requiredRuns: REQUIRED_RUNS });
assert.equal(OBSERVED_SUMMARY.status, 'observed');

const baseConfig = (summary = OBSERVED_SUMMARY) => ({
  provider: {
    runtime: 'claude-code', cliVersion: '1.2.3', cliVersionSource: 'runtime-descriptor',
    // Derived from the observed response summary, per the frozen contract.
    model: summary.model, modelSource: summary.modelSource,
    modelObservationStatus: summary.status, modelObservationVersion: summary.schemaVersion,
  },
  backend: { kind: 'local-shared-gpu', executionMode: 'gpu', publishable: false },
  hardware: ['nvidia-gpu'], architecture: ['sm86'],
  device: 'NVIDIA GeForce RTX 3060 Laptop GPU', driverVersion: '555.99',
  families: ['affine'], candidateTasks: 2,
  matrix: {
    environments: ['local-shared-gpu'], stages: ['Correctness', 'Full Benchmark'],
    correctnessCases: 4, warmup: 3, repeats: 10,
  },
  promptPolicy: {
    experienceSelectionPolicyVersion: 'operator-studio.experience-selection/v1',
    roundFactsSchemaVersion: ROUND_FACTS_SCHEMA_VERSION,
  },
  budgets: { missionBudgetMs: 720_000, mainAgentBudgetMs: 180_000 },
  code: { commit: 'a'.repeat(40), dirty: false, contentDigest: `sha256:${'b'.repeat(64)}` },
});

{
  const config = baseConfig();
  const built = buildConfigFingerprint(config, { code: config.code });
  assert.deepEqual(built.unknownFields, [], 'a complete observed model/config is comparable');
  assert.equal(built.comparable, true);
}

{
  // Same model/config, different run/session identifiers => identical fingerprint.
  const withIdentity = (suffix) => ({
    ...baseConfig(),
    runId: `run-${suffix}`, missionId: `MIS-${suffix}`, sourceRunId: `src-${suffix}`,
    sessionId: `sess-${suffix}`,
    observedTargets: [{ family: 'affine', runId: `observed-${suffix}`, sessionId: `sess-${suffix}` }],
    startedAt: `2026-09-13T0${suffix}:00:00.000Z`,
  });
  const first = withIdentity('1');
  const second = withIdentity('2');
  assert.equal(buildConfigFingerprint(first, { code: first.code }).fingerprint,
    buildConfigFingerprint(second, { code: second.code }).fingerprint,
    'run/session identifiers must never split a same-configuration group');
}

{
  // Model / code / budget / matrix changes must hash differently.
  const baseline = buildConfigFingerprint(baseConfig(), { code: baseConfig().code }).fingerprint;
  const otherModelSummary = summarizeModelObservations(
    [dtoFor(REQUIRED_RUNS[1], 'model-other')], { requiredRuns: [REQUIRED_RUNS[1]] });
  const mutators = [
    ['model', () => baseConfig(otherModelSummary)],
    ['code content digest', () => { const c = baseConfig(); c.code = { ...c.code, contentDigest: `sha256:${'c'.repeat(64)}` }; return c; }],
    ['code commit', () => { const c = baseConfig(); c.code = { ...c.code, commit: 'd'.repeat(40) }; return c; }],
    ['budgets', () => { const c = baseConfig(); c.budgets = { ...c.budgets, missionBudgetMs: 60_000 }; return c; }],
    ['matrix', () => { const c = baseConfig(); c.matrix = { ...c.matrix, correctnessCases: 8 }; return c; }],
  ];
  for (const [label, make] of mutators) {
    const changed = make();
    assert.notEqual(buildConfigFingerprint(changed, { code: changed.code }).fingerprint, baseline,
      `a changed ${label} must change the fingerprint`);
  }
}

{
  // Bare observed labels and probe/init/env sources can never make the model eligible.
  const cases = [
    ['bare observed model without observation status/schema', () => {
      const c = baseConfig();
      c.provider = { runtime: 'claude-code', cliVersion: '1.2.3', cliVersionSource: 'runtime-descriptor', model: RESPONSE_MODEL, modelSource: 'observed' };
      return c;
    }],
    ['probe model provenance', () => { const c = baseConfig(); c.provider = { ...c.provider, modelSource: 'probe' }; return c; }],
    ['init model provenance', () => { const c = baseConfig(); c.provider = { ...c.provider, modelSource: 'init' }; return c; }],
    ['env model provenance', () => { const c = baseConfig(); c.provider = { ...c.provider, modelSource: 'env' }; return c; }],
    ['declared model provenance', () => { const c = baseConfig(); c.provider = { ...c.provider, modelSource: 'declared' }; return c; }],
    ['model observation status not observed', () => { const c = baseConfig(); c.provider = { ...c.provider, modelObservationStatus: 'unknown' }; return c; }],
    ['model observation version missing', () => { const c = baseConfig(); const { modelObservationVersion, ...provider } = c.provider; c.provider = provider; return c; }],
  ];
  for (const [label, make] of cases) {
    const config = make();
    const built = buildConfigFingerprint(config, { code: config.code });
    assert.ok(built.unknownFields.length > 0, `${label} must report an unknown field`);
    assert.equal(built.comparable, false, `${label} must stay non-comparable`);
  }

  // An unknown/conflict observation summary cannot produce a comparable model label.
  const unknownSummary = summarizeModelObservations([ALL_DTOS[0]], { requiredRuns: REQUIRED_RUNS });
  assert.notEqual(unknownSummary.status, 'observed');
  const unknownConfig = baseConfig(unknownSummary);
  assert.equal(buildConfigFingerprint(unknownConfig, { code: unknownConfig.code }).comparable, false);
}

// ---------------------------------------------------------------------------
// Part E — ledger: recompute per-run model evidence, keep every outcome
// ---------------------------------------------------------------------------

const proofFor = (runIds, { model = RESPONSE_MODEL } = {}) => {
  const requiredRuns = runIds.map((runId) => ({
    provider: 'claude-code', runId, missionId: LEDGER_MISSION, sessionId: `sess_${runId}`,
  }));
  const modelObservations = requiredRuns.map((binding) => dtoFor(binding, model));
  return {
    requiredRuns,
    modelObservations,
    summary: summarizeModelObservations(modelObservations, { requiredRuns }),
  };
};

const ledgerRecord = (index, {
  outcome = 'full_success', status = 'passed',
  proof = proofFor([`run_ledger_${index}`]), config = null,
} = {}) => {
  const effectiveConfig = config ?? baseConfig(proof.summary);
  const fingerprint = buildConfigFingerprint(effectiveConfig, { code: effectiveConfig.code }).fingerprint;
  const familyOutcome = outcome === 'full_success'
    ? { family: 'affine', outcome: 'full_success', fullSuccess: true }
    : { family: 'affine', outcome: 'failure', fullSuccess: false };
  const attempt = {
    schemaVersion: GPU_ATTEMPT_SCHEMA_VERSION, attemptId: `attempt-${index}`, runRoot: `C:/ledger/run-${index}`,
    phase: 'terminal', status: 'terminal', outcome, fullSuccess: outcome === 'full_success',
    config: effectiveConfig, code: effectiveConfig.code, configFingerprint: fingerprint,
    families: ['affine'], candidateTasks: 2, familyOutcomes: [{ ...familyOutcome }],
    modelObservations: proof.modelObservations,
    modelObservationRequiredRuns: proof.requiredRuns,
    modelObservationSummary: proof.summary,
  };
  const summary = {
    schemaVersion: GPU_SUMMARY_SCHEMA_VERSION, status, outcome, fullSuccess: outcome === 'full_success',
    config: effectiveConfig, code: effectiveConfig.code, configFingerprint: fingerprint,
    families: ['affine'], summaries: [{ ...familyOutcome }],
    modelObservations: proof.modelObservations,
    modelObservationRequiredRuns: proof.requiredRuns,
    modelObservationSummary: proof.summary,
  };
  return { runDir: `C:/ledger/run-${index}`, attempt, summary };
};

{
  const record = ledgerRecord(1);
  assert.equal(classifyAcceptanceRecord(record).outcome, 'full_success');
  const ledger = summarizeAcceptanceRuns([record]);
  assert.equal(ledger.groups.length, 1);
  assert.equal(ledger.groups[0].comparable, true, 'consistent observed model evidence is comparable');
  assert.equal(ledger.groups[0].n20.eligible, false, 'one run is nowhere near an N=20 claim');
}

{
  // 20 consistent same-configuration observations may enter the N=20 denominator.
  const ledger = summarizeAcceptanceRuns(Array.from({ length: 20 }, (_, index) => ledgerRecord(index + 1)));
  assert.equal(ledger.totals.full_success, 20);
  assert.equal(ledger.groups.length, 1);
  assert.equal(ledger.groups[0].comparable, true);
  assert.equal(ledger.groups[0].stabilityDenominator, 20);
  assert.equal(ledger.groups[0].n20.eligible, true);
}

{
  // Attempt/summary model-evidence disagreement makes the run non-comparable.
  const attemptProof = proofFor(['run_mismatch']);
  const summaryProof = proofFor(['run_mismatch'], { model: 'model-other' });
  const config = baseConfig(attemptProof.summary);
  const record = ledgerRecord(1, { proof: attemptProof, config });
  record.summary.modelObservations = summaryProof.modelObservations;
  record.summary.modelObservationSummary = summaryProof.summary;
  const ledger = summarizeAcceptanceRuns([record]);
  assert.equal(ledger.groups[0].comparable, false, 'attempt/summary model DTO disagreement is not comparable');
  assert.equal(ledger.groups[0].n20.eligible, false);
}

{
  // A config that claims observed without retained DTO/required-run proof is rejected.
  const bareProof = { modelObservations: [], requiredRuns: [], summary: OBSERVED_SUMMARY };
  const record = ledgerRecord(1, { proof: bareProof });
  const ledger = summarizeAcceptanceRuns([record]);
  assert.equal(ledger.groups[0].comparable, false, 'a bare observed config label is not evidence');

  // Dishonest label: config says observed, but the recomputed DTO summary is unknown.
  const unknownBinding = { provider: 'claude-code', runId: 'run_dishonest', missionId: LEDGER_MISSION, sessionId: 'sess_dishonest' };
  const unknownDto = observeClaudeModel({
    runId: unknownBinding.runId, missionId: unknownBinding.missionId, sessionId: unknownBinding.sessionId, events: [],
  });
  const unknownProof = {
    modelObservations: [unknownDto],
    requiredRuns: [unknownBinding],
    summary: summarizeModelObservations([unknownDto], { requiredRuns: [unknownBinding] }),
  };
  assert.notEqual(unknownProof.summary.status, 'observed');
  const dishonestConfig = baseConfig(OBSERVED_SUMMARY);
  const dishonest = ledgerRecord(1, { proof: unknownProof, config: dishonestConfig });
  assert.equal(summarizeAcceptanceRuns([dishonest]).groups[0].comparable, false,
    'a config label that the retained evidence contradicts is not comparable');
}

{
  // probe/init/env provenance never reaches N=20 even with otherwise valid evidence.
  for (const modelSource of ['probe', 'init', 'env']) {
    const proof = proofFor(['run_source']);
    const config = baseConfig(proof.summary);
    config.provider = { ...config.provider, modelSource };
    const ledger = summarizeAcceptanceRuns([ledgerRecord(1, { proof, config })]);
    assert.equal(ledger.groups[0].comparable, false, `${modelSource} model provenance must stay non-comparable`);
    assert.equal(ledger.groups[0].n20.eligible, false);
  }
}

{
  // Missing summaries, timeouts and failures all stay in the stability denominator.
  const records = [
    ledgerRecord(1),
    ledgerRecord(2, { outcome: 'timeout', status: 'timeout' }),
    ledgerRecord(3, { outcome: 'failure', status: 'failed' }),
    (() => { const missing = ledgerRecord(4); missing.summary = null; return missing; })(),
  ];
  const ledger = summarizeAcceptanceRuns(records);
  assert.equal(ledger.totals.runs, 4);
  assert.equal(ledger.totals.summariesMissing, 1);
  assert.equal(ledger.groups.length, 1);
  assert.equal(ledger.groups[0].stabilityDenominator, 4, 'nothing is dropped from the stability denominator');
  assert.deepEqual(ledger.groups[0].counts, {
    runs: 4, full_success: 1, budget_terminal: 0, failure: 1, timeout: 1, missing_summary: 1,
  });
  assert.equal(ledger.groups[0].n20.eligible, false);
}

console.log('[model-observation-acceptance] response-model observation, required-run coverage, fingerprint and ledger comparability contracts are exercised without GPU or Agent');
