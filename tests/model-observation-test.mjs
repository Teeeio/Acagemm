#!/usr/bin/env node
// Independent, hardware-free acceptance for the frozen response-model observation
// contract in docs/development/MODEL_OBSERVATION_ACCEPTANCE.md (matrix A).
//
// This test is written BEFORE the production implementation and must stay red
// until `client-runtime/model-observation.mjs` exists and the Claude adapter,
// agent-runtime projection and reset/archive path implement the frozen
// semantics. It therefore:
//   * dynamically imports the pure API so a missing module is reported as
//     MODEL_OBSERVATION_API_MISSING instead of a module-resolution crash;
//   * drives the real `createClaudeClient` with a fake child process (no real
//     Claude CLI, no network, no Python, no GPU);
//   * drives the real `createAgentRuntime({ mode: 'claude-code' })` projection
//     and the real `createMissionProjectState(...).resetMissionRunState`;
//   * never mirrors the production implementation to manufacture a pass.
//
// It must not be weakened to accept a partial implementation.
//
// Revision 2 (2026-09-13): the frozen matrix-A cancellation positive passed a
// record session that disagreed with its DTO session; it now passes the explicit
// session and asserts equality. Root-reproduced pure/projection identity escapes
// are pinned as independent negatives (trim-merged sessions, blank run/mission
// identity, observed DTOs with error reasons, unlisted conflict evidence,
// duplicate event indexes, key-order-only duplicates, foreign record mission /
// provider, cancelled session mismatch, stale value after a readRun failure).
// Production must satisfy these without using the DTO as its own expected
// identity.

import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createClaudeClient } from '../client-runtime/claude-client.mjs';
import { createAgentRuntime } from '../client-runtime/agent-runtime.mjs';
import { createMissionProjectState } from '../client-runtime/mission-project-state.mjs';

const SCHEMA = 'operator-studio.model-observation/v1';
const DTO_KEYS = ['configuredModels', 'missionId', 'model', 'models', 'observations', 'provider', 'reasons', 'runId', 'schemaVersion', 'sessionId', 'source', 'status', 'usageModels'];
const OBSERVATION_KEYS = ['eventIndex', 'model', 'sessionId'];
const RESPONSE_MODEL = 'deepseek-v4-flash';
const INIT_LABEL = 'claude-opus-5[1m]';

const failures = [];
let passCount = 0;
const check = async (name, fn) => {
  try {
    await fn();
    passCount += 1;
    console.log(`ok - ${name}`);
  } catch (error) {
    failures.push({ name, message: error?.message || String(error) });
    console.log(`not ok - ${name}`);
  }
};
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let api = null;
let apiImportError = null;
try {
  api = await import('../client-runtime/model-observation.mjs');
} catch (error) {
  apiImportError = error;
}
const requireApi = () => {
  if (!api) {
    throw new Error(`MODEL_OBSERVATION_API_MISSING: client-runtime/model-observation.mjs is not importable (${apiImportError?.code || apiImportError?.message || 'unknown'})`);
  }
  if (api.MODEL_OBSERVATION_SCHEMA_VERSION !== SCHEMA) {
    throw new Error(`MODEL_OBSERVATION_API_INCOMPLETE: MODEL_OBSERVATION_SCHEMA_VERSION=${JSON.stringify(api.MODEL_OBSERVATION_SCHEMA_VERSION)}`);
  }
  for (const name of ['observeClaudeModel', 'bindModelObservation', 'summarizeModelObservations']) {
    if (typeof api[name] !== 'function') throw new Error(`MODEL_OBSERVATION_API_INCOMPLETE: missing export ${name}`);
  }
  return api;
};

// ---- DTO fixtures (hand-written from the frozen contract, not API output) ----
const observedDto = ({ runId, missionId, sessionId, model = RESPONSE_MODEL, configuredModels = [INIT_LABEL], usageModels = [], observations } = {}) => ({
  schemaVersion: SCHEMA,
  provider: 'claude-code',
  runId,
  missionId,
  sessionId,
  status: 'observed',
  model,
  source: 'assistant.message.model',
  models: [model],
  configuredModels: [...configuredModels],
  usageModels: [...usageModels],
  observations: observations || [{ eventIndex: 0, sessionId, model }],
  reasons: [],
});
const unknownDto = ({ runId, missionId, sessionId, configuredModels = [] } = {}) => ({
  schemaVersion: SCHEMA,
  provider: 'claude-code',
  runId,
  missionId,
  sessionId,
  status: 'unknown',
  model: null,
  source: null,
  models: [],
  configuredModels: [...configuredModels],
  usageModels: [],
  observations: [],
  reasons: ['no valid assistant.message.model metadata'],
});
// A conflict DTO is internally consistent only when its `models` are backed by
// matching observations: one concrete response per model, same session, distinct
// event indexes. Evidence-free `models` must never bind.
const conflictDto = ({ runId, missionId, sessionId, models = ['model-a', 'model-b'] } = {}) => ({
  schemaVersion: SCHEMA,
  provider: 'claude-code',
  runId,
  missionId,
  sessionId,
  status: 'conflict',
  model: null,
  source: null,
  models: [...models],
  configuredModels: [],
  usageModels: [],
  observations: models.map((model, index) => ({ eventIndex: index, sessionId, model })),
  reasons: ['multiple concrete response models'],
});
const identity = (dto) => ({ provider: dto.provider, runId: dto.runId, missionId: dto.missionId, sessionId: dto.sessionId });

const root = await mkdtemp(path.join(os.tmpdir(), 'operator-model-observation-'));

try {
  // =====================================================================
  // 1. Pure API: observeClaudeModel
  // =====================================================================
  await check('pure: one matching assistant model is observed; init/usage labels stay separate', () => {
    const { observeClaudeModel } = requireApi();
    const events = [
      { type: 'system', subtype: 'init', session_id: 'sess-pure', model: INIT_LABEL },
      { type: 'assistant', session_id: 'sess-pure', message: { model: RESPONSE_MODEL, content: [{ type: 'text', text: 'done' }] } },
      { type: 'result', subtype: 'success', is_error: false, session_id: 'sess-pure', modelUsage: { [INIT_LABEL]: 1, [RESPONSE_MODEL]: 2 } },
    ];
    const dto = observeClaudeModel({ runId: 'run-pure', missionId: 'mis-pure', sessionId: 'sess-pure', events });
    assert.equal(dto.schemaVersion, SCHEMA);
    assert.equal(dto.provider, 'claude-code');
    assert.deepEqual(Object.keys(dto).sort(), DTO_KEYS, 'DTO must expose exactly the frozen fields');
    assert.equal(dto.status, 'observed');
    assert.equal(dto.model, RESPONSE_MODEL);
    assert.equal(dto.source, 'assistant.message.model');
    assert.deepEqual(dto.models, [RESPONSE_MODEL]);
    assert.deepEqual(dto.configuredModels, [INIT_LABEL]);
    assert.deepEqual(dto.usageModels, [INIT_LABEL, RESPONSE_MODEL]);
    assert.deepEqual(dto.observations, [{ eventIndex: 1, sessionId: 'sess-pure', model: RESPONSE_MODEL }]);
    assert.deepEqual(Object.keys(dto.observations[0]).sort(), OBSERVATION_KEYS, 'observations carry metadata only');
  });

  await check('pure: zero assistant responses and init-only streams stay unknown', () => {
    const { observeClaudeModel } = requireApi();
    for (const events of [
      [],
      [{ type: 'system', subtype: 'init', session_id: 'sess-pure', model: INIT_LABEL }],
    ]) {
      const dto = observeClaudeModel({ runId: 'run-pure', missionId: 'mis-pure', sessionId: 'sess-pure', events });
      assert.equal(dto.status, 'unknown');
      assert.equal(dto.model, null);
      assert.equal(dto.source, null);
      assert.deepEqual(dto.models, []);
      assert.deepEqual(dto.observations, []);
    }
  });

  await check('pure: missing/blank/synthetic response labels are never observed', () => {
    const { observeClaudeModel } = requireApi();
    const sentinels = [undefined, null, '', '   ', 'unknown', 'UNKNOWN', '<synthetic>'];
    for (const sentinel of sentinels) {
      const events = [
        { type: 'system', subtype: 'init', session_id: 'sess-pure', model: INIT_LABEL },
        { type: 'assistant', session_id: 'sess-pure', message: { model: sentinel, content: [{ type: 'text', text: 'done' }] } },
      ];
      const dto = observeClaudeModel({ runId: 'run-pure', missionId: 'mis-pure', sessionId: 'sess-pure', events });
      assert.equal(dto.status, 'unknown', `sentinel ${JSON.stringify(sentinel)} must not be observed`);
      assert.equal(dto.model, null);
      assert.deepEqual(dto.observations, []);
    }
  });

  await check('pure: two concrete response models are a conflict, never a pick', () => {
    const { observeClaudeModel } = requireApi();
    const events = [
      { type: 'assistant', session_id: 'sess-pure', message: { model: 'model-a', content: [{ type: 'text', text: 'a' }] } },
      { type: 'assistant', session_id: 'sess-pure', message: { model: 'model-b', content: [{ type: 'text', text: 'b' }] } },
    ];
    const dto = observeClaudeModel({ runId: 'run-pure', missionId: 'mis-pure', sessionId: 'sess-pure', events });
    assert.equal(dto.status, 'conflict');
    assert.equal(dto.model, null);
    assert.equal(dto.source, null);
    assert.deepEqual(dto.models, ['model-a', 'model-b']);
  });

  await check('pure: absent or foreign assistant sessions invalidate completeness without replacing identity', () => {
    const { observeClaudeModel } = requireApi();
    const missingSession = observeClaudeModel({
      runId: 'run-pure', missionId: 'mis-pure', sessionId: 'sess-pure',
      events: [{ type: 'assistant', message: { model: RESPONSE_MODEL, content: [{ type: 'text', text: 'x' }] } }],
    });
    assert.equal(missingSession.status, 'unknown');
    assert.equal(missingSession.model, null);
    assert.ok(missingSession.reasons.length > 0, 'missing session must retain a reason');

    const foreign = observeClaudeModel({
      runId: 'run-pure', missionId: 'mis-pure', sessionId: 'sess-pure',
      events: [
        { type: 'system', subtype: 'init', session_id: 'sess-pure', model: INIT_LABEL },
        { type: 'assistant', session_id: 'sess-other', message: { model: 'foreign-model', content: [{ type: 'text', text: 'x' }] } },
      ],
    });
    assert.notEqual(foreign.status, 'observed', 'a foreign session must never replace the current identity');
    assert.equal(foreign.sessionId, 'sess-pure');
    assert.ok(!foreign.models.includes('foreign-model'));
    assert.ok(foreign.reasons.length > 0);
  });

  await check('pure: session identity is exact and run/mission identity must be nonblank before a response is observed', () => {
    const { observeClaudeModel } = requireApi();
    const stream = (session) => [
      { type: 'system', subtype: 'init', session_id: session, model: INIT_LABEL },
      { type: 'assistant', session_id: session, message: { model: RESPONSE_MODEL, content: [{ type: 'text', text: 'ok' }] } },
    ];
    // Root reproduction: the expected session ' s ' and the event session 's' are
    // different identities. Trimming one side must never merge a foreign stream
    // into the current run and turn it into an observation.
    const padded = observeClaudeModel({ runId: 'run-pure', missionId: 'mis-pure', sessionId: ' s ', events: stream('s') });
    assert.notEqual(padded.status, 'observed', "expected session ' s ' must not be trim-merged with event session 's'");
    assert.equal(padded.model, null, 'a trim-merged session must not yield a model');
    assert.deepEqual(padded.models, []);
    assert.deepEqual(padded.observations, []);
    assert.ok(padded.reasons.length > 0, 'a session identity mismatch must retain a reason');

    // A response only belongs to a run/mission identity that is actually nonblank.
    for (const blankIdentity of [
      { runId: '', missionId: 'mis-pure' },
      { runId: 'run-pure', missionId: '' },
      { runId: '   ', missionId: 'mis-pure' },
      { runId: 'run-pure', missionId: '   ' },
      { runId: null, missionId: 'mis-pure' },
      { runId: 'run-pure', missionId: null },
    ]) {
      const dto = observeClaudeModel({ ...blankIdentity, sessionId: 'sess-pure', events: stream('sess-pure') });
      assert.notEqual(dto.status, 'observed', `blank identity ${JSON.stringify(blankIdentity)} must never be observed`);
      assert.equal(dto.model, null, `blank identity ${JSON.stringify(blankIdentity)} must not yield a response model`);
      assert.ok(dto.reasons.length > 0, `blank identity ${JSON.stringify(blankIdentity)} must retain a reason`);
    }
  });

  await check('pure: a valid response cannot mask a missing/blank model or missing session in the same stream', () => {
    const { observeClaudeModel } = requireApi();
    const valid = { type: 'assistant', session_id: 'sess-pure', message: { model: RESPONSE_MODEL, content: [{ type: 'text', text: 'valid' }] } };
    const incompleteEvents = {
      'missing model': { type: 'assistant', session_id: 'sess-pure', message: { content: [{ type: 'text', text: 'no model' }] } },
      'blank model': { type: 'assistant', session_id: 'sess-pure', message: { model: '   ', content: [{ type: 'text', text: 'blank' }] } },
      'synthetic model': { type: 'assistant', session_id: 'sess-pure', message: { model: '<synthetic>', content: [{ type: 'text', text: 'synthetic' }] } },
      'missing session': { type: 'assistant', message: { model: RESPONSE_MODEL, content: [{ type: 'text', text: 'no session' }] } },
    };
    for (const [label, incomplete] of Object.entries(incompleteEvents)) {
      const dto = observeClaudeModel({ runId: 'run-pure', missionId: 'mis-pure', sessionId: 'sess-pure', events: [valid, incomplete] });
      assert.notEqual(dto.status, 'observed', `a valid response must not mask ${label} in the same stream`);
      assert.equal(dto.model, null, `${label} must not yield a response model`);
      assert.ok(dto.reasons.length > 0, `${label} must retain a completeness reason`);
    }
  });

  await check('pure: thinking-only metadata is observed without leaking thinking content', () => {
    const { observeClaudeModel } = requireApi();
    const secret = 'PRIVATE_REASONING_MUST_NOT_BE_PERSISTED';
    const events = [
      { type: 'system', subtype: 'init', session_id: 'sess-pure', model: INIT_LABEL },
      { type: 'assistant', session_id: 'sess-pure', message: { model: RESPONSE_MODEL, content: [{ type: 'thinking', thinking: secret }] } },
    ];
    const dto = observeClaudeModel({ runId: 'run-pure', missionId: 'mis-pure', sessionId: 'sess-pure', events });
    assert.equal(dto.status, 'observed');
    assert.equal(dto.model, RESPONSE_MODEL);
    assert.ok(!JSON.stringify(dto).includes(secret), 'DTO must never contain thinking text');
  });

  await check('pure: unrelated model fields and prose are ignored', () => {
    const { observeClaudeModel } = requireApi();
    const events = [
      { type: 'user', session_id: 'sess-pure', model: 'wrong-user-model', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] } },
      { type: 'system', subtype: 'init', session_id: 'sess-pure', model: INIT_LABEL },
      { type: 'assistant', session_id: 'sess-pure', message: { model: RESPONSE_MODEL, content: [{ type: 'text', text: 'compare with claude-fake-model in prose' }] } },
    ];
    const dto = observeClaudeModel({ runId: 'run-pure', missionId: 'mis-pure', sessionId: 'sess-pure', events });
    assert.equal(dto.status, 'observed');
    assert.deepEqual(dto.models, [RESPONSE_MODEL]);
    assert.deepEqual(dto.configuredModels, [INIT_LABEL]);
  });

  await check('pure: DTO JSON round-trip stays a valid observable DTO', () => {
    const { observeClaudeModel, bindModelObservation } = requireApi();
    const dto = observeClaudeModel({
      runId: 'run-pure', missionId: 'mis-pure', sessionId: 'sess-pure',
      events: [{ type: 'assistant', session_id: 'sess-pure', message: { model: RESPONSE_MODEL, content: [{ type: 'text', text: 'x' }] } }],
    });
    const roundTripped = JSON.parse(JSON.stringify(dto));
    assert.deepEqual(roundTripped, dto);
    assert.ok(bindModelObservation(roundTripped, identity(dto)));
  });

  // =====================================================================
  // 2. Pure API: bindModelObservation
  // =====================================================================
  await check('pure: bind detaches a valid observation and rejects all four identity swaps', () => {
    const { bindModelObservation } = requireApi();
    const dto = observedDto({ runId: 'run-bind', missionId: 'mis-bind', sessionId: 'sess-bind' });
    const bound = bindModelObservation(dto, identity(dto));
    assert.ok(bound, 'exact identity must bind');
    assert.notEqual(bound, dto);
    assert.notEqual(bound.observations, dto.observations);
    assert.notEqual(bound.observations[0], dto.observations[0]);
    assert.notEqual(bound.models, dto.models);
    bound.models.push('mutated');
    assert.deepEqual(dto.models, [RESPONSE_MODEL], 'binding must be deep detached');

    const swaps = [
      { provider: 'codex-cli', runId: dto.runId, missionId: dto.missionId, sessionId: dto.sessionId },
      { provider: dto.provider, runId: 'run-other', missionId: dto.missionId, sessionId: dto.sessionId },
      { provider: dto.provider, runId: dto.runId, missionId: 'mis-other', sessionId: dto.sessionId },
      { provider: dto.provider, runId: dto.runId, missionId: dto.missionId, sessionId: 'sess-other' },
      { provider: '', runId: dto.runId, missionId: dto.missionId, sessionId: dto.sessionId },
      { provider: dto.provider, runId: '', missionId: dto.missionId, sessionId: dto.sessionId },
    ];
    for (const swapped of swaps) {
      assert.equal(bindModelObservation(dto, swapped), null, `identity swap ${JSON.stringify(swapped)} must fail closed`);
    }
  });

  await check('pure: bind rejects malformed and internally inconsistent DTOs but accepts unknown/conflict shapes', () => {
    const { bindModelObservation } = requireApi();
    const base = observedDto({ runId: 'run-bind', missionId: 'mis-bind', sessionId: 'sess-bind' });
    const mutations = {
      'wrong schema': { ...base, schemaVersion: 'operator-studio.model-observation/v0' },
      'unknown status string': { ...base, status: 'bogus' },
      'observed with null model': { ...base, model: null, models: [] },
      'observed with null source': { ...base, source: null },
      'model missing from models': { ...base, models: ['other-model'] },
      'negative observation index': { ...base, observations: [{ eventIndex: -1, sessionId: base.sessionId, model: base.model }] },
      'fractional observation index': { ...base, observations: [{ eventIndex: 1.5, sessionId: base.sessionId, model: base.model }] },
      'foreign observation session': { ...base, observations: [{ eventIndex: 0, sessionId: 'sess-other', model: base.model }] },
      'unsorted models': { ...base, models: ['b-model', 'a-model'], model: 'a-model' },
      'missing reasons field': (() => { const copy = { ...base }; delete copy.reasons; return copy; })(),
      'non-array observations': { ...base, observations: 'none' },
    };
    const conflictBase = conflictDto({ runId: 'run-bind', missionId: 'mis-bind', sessionId: 'sess-bind' });
    mutations['conflict models with no observations'] = { ...conflictBase, observations: [] };
    mutations['conflict models not backed by matching observations'] = {
      ...conflictBase,
      observations: [{ eventIndex: 0, sessionId: conflictBase.sessionId, model: 'model-a' }],
    };
    mutations['conflict observations from a foreign session'] = {
      ...conflictBase,
      observations: conflictBase.observations.map((observation) => ({ ...observation, sessionId: 'sess-other' })),
    };
    for (const [label, value] of Object.entries(mutations)) {
      assert.equal(bindModelObservation(value, identity(base)), null, `${label} must fail closed`);
    }
    assert.ok(bindModelObservation(unknownDto({ runId: 'run-bind', missionId: 'mis-bind', sessionId: 'sess-bind' }), { provider: 'claude-code', runId: 'run-bind', missionId: 'mis-bind', sessionId: 'sess-bind' }));
    assert.ok(bindModelObservation(conflictBase, { provider: 'claude-code', runId: 'run-bind', missionId: 'mis-bind', sessionId: 'sess-bind' }), 'an observation-backed conflict DTO must still bind');
  });

  await check('pure: bind refuses observed error reasons, unlisted conflict evidence and duplicate event indexes', () => {
    const { bindModelObservation } = requireApi();
    const binding = { provider: 'claude-code', runId: 'run-bind', missionId: 'mis-bind', sessionId: 'sess-bind' };
    const base = observedDto({ runId: 'run-bind', missionId: 'mis-bind', sessionId: 'sess-bind' });
    const conflictBase = conflictDto({ runId: 'run-bind', missionId: 'mis-bind', sessionId: 'sess-bind' });
    const rejects = {
      // An observed DTO that still carries completeness/error reasons contradicts
      // itself: a complete observation has nothing left to explain.
      'observed DTO carrying error reasons': { ...base, reasons: ['1 assistant response(s) had no session_id'] },
      // conflict models[a,b] with an extra unlisted observation model c is not a
      // faithful conflict DTO; every visible response model must be listed and
      // every listed model must be backed, no more and no less.
      'conflict observation model missing from models': {
        ...conflictBase,
        observations: [...conflictBase.observations, { eventIndex: 2, sessionId: conflictBase.sessionId, model: 'model-c' }],
      },
      // One response event can only be counted once; duplicate event indexes are
      // internally inconsistent evidence and must not bind.
      'duplicate observation event index': {
        ...base,
        observations: [base.observations[0], { ...base.observations[0] }],
      },
    };
    for (const [label, value] of Object.entries(rejects)) {
      assert.equal(bindModelObservation(value, binding), null, `${label} must fail closed`);
    }
    assert.ok(bindModelObservation(conflictBase, binding), 'a faithful observation-backed conflict DTO must still bind');
  });

  // =====================================================================
  // 3. Pure API: summarizeModelObservations
  // =====================================================================
  await check('pure: summary of an empty required set is unknown', () => {
    const { summarizeModelObservations } = requireApi();
    const summary = summarizeModelObservations([], { requiredRuns: [] });
    assert.equal(summary.schemaVersion, SCHEMA);
    assert.equal(summary.status, 'unknown');
    assert.equal(summary.model, null);
    assert.equal(summary.modelSource, 'unknown');
    assert.equal(summary.requiredRunCount, 0);
    assert.equal(summary.observedRunCount, 0);
  });

  await check('pure: summary is observed only when every required run reports the same model', () => {
    const { summarizeModelObservations } = requireApi();
    const r1 = { provider: 'claude-code', runId: 'run-1', missionId: 'mis-1', sessionId: 'sess-1' };
    const r2 = { provider: 'claude-code', runId: 'run-2', missionId: 'mis-1', sessionId: 'sess-2' };
    const one = summarizeModelObservations([observedDto(r1)], { requiredRuns: [r1] });
    assert.equal(one.status, 'observed');
    assert.equal(one.model, RESPONSE_MODEL);
    assert.equal(one.modelSource, 'observed');
    assert.equal(one.requiredRunCount, 1);
    assert.equal(one.observedRunCount, 1);
    assert.deepEqual(one.models, [RESPONSE_MODEL]);

    const missing = summarizeModelObservations([observedDto(r1)], { requiredRuns: [r1, r2] });
    assert.notEqual(missing.status, 'observed', 'a missing run can never be observed');
    assert.equal(missing.observedRunCount, 1);

    const same = summarizeModelObservations([observedDto(r1), observedDto(r2)], { requiredRuns: [r1, r2] });
    assert.equal(same.status, 'observed');
    assert.equal(same.observedRunCount, 2);

    const different = summarizeModelObservations(
      [observedDto(r1), observedDto({ ...r2, model: 'other-model' })],
      { requiredRuns: [r1, r2] },
    );
    assert.equal(different.status, 'conflict');
    assert.equal(different.model, null);
  });

  await check('pure: foreign, non-observed, malformed and duplicate evidence fails closed', () => {
    const { summarizeModelObservations } = requireApi();
    const r1 = { provider: 'claude-code', runId: 'run-1', missionId: 'mis-1', sessionId: 'sess-1' };
    const foreign = summarizeModelObservations([observedDto({ ...r1, runId: 'run-foreign' })], { requiredRuns: [r1] });
    assert.notEqual(foreign.status, 'observed');

    const unknown = summarizeModelObservations([unknownDto(r1)], { requiredRuns: [r1] });
    assert.notEqual(unknown.status, 'observed');

    const blankIdentity = summarizeModelObservations([observedDto(r1)], { requiredRuns: [{ ...r1, sessionId: '  ' }] });
    assert.notEqual(blankIdentity.status, 'observed');

    const duplicateRequired = summarizeModelObservations([observedDto(r1)], { requiredRuns: [r1, { ...r1 }] });
    assert.notEqual(duplicateRequired.status, 'observed', 'required run identities must be unique');

    const contradictory = summarizeModelObservations(
      [observedDto(r1), observedDto({ ...r1, model: 'other-model' })],
      { requiredRuns: [r1] },
    );
    assert.notEqual(contradictory.status, 'observed', 'contradictory duplicates must fail closed');
  });

  await check('pure: duplicate evidence differing only in object key order is one run, counted once', () => {
    const { summarizeModelObservations } = requireApi();
    const r1 = { provider: 'claude-code', runId: 'run-order', missionId: 'mis-order', sessionId: 'sess-order' };
    const dto = observedDto(r1);
    const reordered = {};
    for (const key of Object.keys(dto).slice().reverse()) reordered[key] = dto[key];
    reordered.observations = dto.observations.map((observation) => ({
      model: observation.model,
      sessionId: observation.sessionId,
      eventIndex: observation.eventIndex,
    }));
    assert.deepEqual(reordered, dto, 'the duplicate must be semantically identical, not contradictory');
    const summary = summarizeModelObservations([dto, reordered], { requiredRuns: [r1] });
    assert.equal(summary.status, 'observed', 'key order alone must never turn one run into a contradiction');
    assert.equal(summary.observedRunCount, 1, 'the same run must be counted exactly once');
    assert.equal(summary.model, RESPONSE_MODEL);
    assert.deepEqual(summary.models, [RESPONSE_MODEL]);
  });

  // =====================================================================
  // 4. Real Claude adapter with a fake child process (no hardware, no CLI)
  // =====================================================================
  const adapterScripts = new Map();
  const adapterSpawnImpl = (command, args, options) => {
    const call = { command, args, cwd: options.cwd, stdin: '' };
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.stdin = new PassThrough();
    child.pid = 9182;
    child.killed = false;
    child.kill = () => { child.killed = true; child.emit('close', null, 'SIGTERM'); };
    child.stdin.on('data', (chunk) => { call.stdin += chunk.toString(); });
    child.stdin.on('finish', () => {
      const script = adapterScripts.get(call.stdin.trim()) || { lines: [] };
      for (const line of script.lines) child.stdout.write(line);
      if (script.hold) return;
      child.stdout.end();
      setTimeout(() => child.emit('close', 0, null), script.closeDelayMs ?? 20);
    });
    return child;
  };
  const claude = createClaudeClient({
    command: 'claude-test',
    bridgeDir: path.join(root, 'bridge'),
    spawnImpl: adapterSpawnImpl,
    terminateProcessTreeImpl: async (child) => { if (child) child.kill(); },
  });

  const evInit = (session, model) => `${JSON.stringify({ type: 'system', subtype: 'init', session_id: session, model })}\n`;
  const evAssistant = (session, model, content, { newline = true } = {}) => `${JSON.stringify({ type: 'assistant', session_id: session, message: { model, content } })}${newline ? '\n' : ''}`;
  const evResult = (session, modelUsage) => `${JSON.stringify({ type: 'result', subtype: 'success', is_error: false, session_id: session, result: 'ok', modelUsage })}\n`;
  const textContent = (text) => [{ type: 'text', text }];

  const startScenario = async (runId, goal, lines, extra = {}) => {
    adapterScripts.set(goal, { lines, hold: extra.hold === true });
    await claude.start({
      runId,
      missionId: 'MIS_OBS',
      goal,
      workspace: root,
      resumeThreadId: extra.resumeThreadId || null,
      environment: {
        OPERATOR_AGENT_ROLE: 'iteration',
        OPERATOR_AGENT_ROOTS: JSON.stringify({ workspace: root }),
        ...(extra.environment || {}),
      },
    });
  };
  const waitForRun = async (runId, predicate, timeoutMs = 3000) => {
    const deadline = Date.now() + timeoutMs;
    let record;
    while (Date.now() < deadline) {
      record = await claude.readRun(runId);
      if (predicate(record)) return record;
      await delay(10);
    }
    throw new Error(`run ${runId} did not settle; last status=${record?.status}`);
  };

  await check('adapter: fake-child stream persists a provider-reported response observation', async () => {
    const runId = 'claude_ADAPTER_MATCH';
    await startScenario(runId, 'adapter-match', [
      evInit('sess-real', INIT_LABEL),
      evAssistant('sess-real', RESPONSE_MODEL, textContent('{"summary":"ok"}')),
      evResult('sess-real', { [INIT_LABEL]: 1, [RESPONSE_MODEL]: 2 }),
    ]);
    const record = await waitForRun(runId, (value) => value.status !== 'running');
    assert.equal(record.status, 'completed');
    assert.equal(record.sessionId, 'sess-real');
    const observation = record.modelObservation;
    assert.ok(observation, 'the adapter must persist record.modelObservation');
    assert.equal(observation.schemaVersion, SCHEMA);
    assert.equal(observation.provider, 'claude-code');
    assert.equal(observation.runId, runId);
    assert.equal(observation.missionId, 'MIS_OBS');
    assert.equal(observation.sessionId, 'sess-real');
    assert.equal(observation.status, 'observed');
    assert.equal(observation.model, RESPONSE_MODEL);
    assert.equal(observation.source, 'assistant.message.model');
    assert.deepEqual(observation.configuredModels, [INIT_LABEL]);
    assert.deepEqual(observation.usageModels, [INIT_LABEL, RESPONSE_MODEL]);
    const roundTripped = JSON.parse(JSON.stringify(record));
    assert.deepEqual(roundTripped, record, 'the persisted record must survive JSON round-trip');
  });

  await check('adapter: a resume hint is not an observation; init-only/empty streams stay unknown', async () => {
    const runId = 'claude_ADAPTER_RESUME';
    await startScenario(runId, 'adapter-resume', [
      evInit('sess-real', INIT_LABEL),
      evAssistant('sess-real', RESPONSE_MODEL, textContent('ok')),
    ], { resumeThreadId: 'session-hint' });
    const record = await waitForRun(runId, (value) => value.status !== 'running');
    assert.equal(record.modelObservation.sessionId, 'sess-real');
    assert.notEqual(record.modelObservation.sessionId, 'session-hint');
    assert.equal(record.modelObservation.model, RESPONSE_MODEL);
    // The learned current stream session must replace the resume hint on the run
    // record itself, otherwise a later archive/reset would bind the run to the
    // stale hint identity even though the observation carries the real session.
    assert.equal(record.sessionId, 'sess-real', 'the record must persist the learned stream session');
    assert.equal(record.threadId, 'sess-real', 'the resume hint must not survive as the current stream session');
    assert.notEqual(record.threadId, 'session-hint');

    const emptyRunId = 'claude_ADAPTER_EMPTY';
    await startScenario(emptyRunId, 'adapter-empty', [], { resumeThreadId: 'session-hint' });
    const empty = await waitForRun(emptyRunId, (value) => value.status !== 'running');
    assert.equal(empty.modelObservation.status, 'unknown');
    assert.equal(empty.modelObservation.model, null);
    assert.notEqual(empty.modelObservation.sessionId, 'session-hint');
    assert.deepEqual(empty.modelObservation.models, []);

    const initRunId = 'claude_ADAPTER_INIT_ONLY';
    await startScenario(initRunId, 'adapter-init-only', [evInit('sess-real', INIT_LABEL)]);
    const initOnly = await waitForRun(initRunId, (value) => value.status !== 'running');
    assert.equal(initOnly.modelObservation.status, 'unknown');
    assert.deepEqual(initOnly.modelObservation.configuredModels, [INIT_LABEL]);
    assert.equal(initOnly.modelObservation.model, null);
  });

  await check('adapter: thinking-only assistant metadata is observed and private reasoning is not persisted', async () => {
    const runId = 'claude_ADAPTER_THINKING';
    const secret = 'PRIVATE_THINKING_PAYLOAD_DO_NOT_PERSIST';
    await startScenario(runId, 'adapter-thinking', [
      evInit('sess-real', INIT_LABEL),
      `${JSON.stringify({ type: 'assistant', session_id: 'sess-real', message: { model: RESPONSE_MODEL, content: [{ type: 'thinking', thinking: secret }] } })}\n`,
    ]);
    const record = await waitForRun(runId, (value) => value.status !== 'running');
    assert.equal(record.modelObservation.status, 'observed');
    assert.equal(record.modelObservation.model, RESPONSE_MODEL);
    const raw = await readFile(record.eventPath, 'utf8');
    assert.ok(!raw.includes(secret), 'telemetry-filtered thinking content must not be persisted');
    assert.ok(!JSON.stringify(record.modelObservation).includes(secret));
  });

  await check('adapter: an unterminated final JSON line is still observed on physical close', async () => {
    const runId = 'claude_ADAPTER_NO_NEWLINE';
    await startScenario(runId, 'adapter-no-newline', [
      evInit('sess-real', INIT_LABEL),
      evAssistant('sess-real', RESPONSE_MODEL, textContent('final'), { newline: false }),
    ]);
    const record = await waitForRun(runId, (value) => value.status !== 'running');
    const raw = await readFile(record.eventPath, 'utf8');
    assert.ok(raw.includes(RESPONSE_MODEL), 'the flushed final line must be persisted');
    assert.equal(record.modelObservation.status, 'observed');
    assert.equal(record.modelObservation.model, RESPONSE_MODEL);
  });

  await check('adapter: mixed/foreign/synthetic response metadata fails closed', async () => {
    const mixedRunId = 'claude_ADAPTER_MIXED';
    await startScenario(mixedRunId, 'adapter-mixed', [
      evInit('sess-real', INIT_LABEL),
      evAssistant('sess-real', 'model-a', textContent('a')),
      evAssistant('sess-real', 'model-b', textContent('b')),
    ]);
    const mixed = await waitForRun(mixedRunId, (value) => value.status !== 'running');
    assert.equal(mixed.modelObservation.status, 'conflict');
    assert.equal(mixed.modelObservation.model, null);
    assert.deepEqual(mixed.modelObservation.models, ['model-a', 'model-b']);

    const foreignRunId = 'claude_ADAPTER_FOREIGN';
    await startScenario(foreignRunId, 'adapter-foreign', [
      evInit('sess-real', INIT_LABEL),
      evAssistant('sess-other', 'foreign-model', textContent('x')),
    ]);
    const foreign = await waitForRun(foreignRunId, (value) => value.status !== 'running');
    assert.notEqual(foreign.modelObservation.status, 'observed');
    assert.ok(!foreign.modelObservation.models.includes('foreign-model'));

    const syntheticRunId = 'claude_ADAPTER_SYNTHETIC';
    await startScenario(syntheticRunId, 'adapter-synthetic', [
      evInit('sess-real', INIT_LABEL),
      evAssistant('sess-real', '<synthetic>', textContent('x')),
    ]);
    const synthetic = await waitForRun(syntheticRunId, (value) => value.status !== 'running');
    assert.equal(synthetic.modelObservation.status, 'unknown');
    assert.equal(synthetic.modelObservation.model, null);
  });

  await check('adapter: a valid response followed by incomplete assistant metadata stays unknown', async () => {
    const rawMixed = {
      'missing-model': evAssistant('sess-real', undefined, textContent('no model')),
      'blank-model': evAssistant('sess-real', '   ', textContent('blank')),
      'missing-session': `${JSON.stringify({ type: 'assistant', message: { model: RESPONSE_MODEL, content: textContent('no session') } })}\n`,
    };
    for (const [label, incompleteLine] of Object.entries(rawMixed)) {
      const runId = `claude_ADAPTER_INCOMPLETE_${label.toUpperCase().replaceAll('-', '_')}`;
      await startScenario(runId, `adapter-incomplete-${label}`, [
        evInit('sess-real', INIT_LABEL),
        evAssistant('sess-real', RESPONSE_MODEL, textContent('valid')),
        incompleteLine,
      ]);
      const record = await waitForRun(runId, (value) => value.status !== 'running');
      assert.notEqual(record.modelObservation.status, 'observed', `the raw adapter must not mask ${label} behind a valid response`);
      assert.equal(record.modelObservation.model, null, `${label} must not yield a persisted response model`);
      assert.ok(record.modelObservation.reasons.length > 0, `${label} must retain a completeness reason`);
    }
  });

  await check('adapter: cancellation retains the observed metadata', async () => {
    const runId = 'claude_ADAPTER_CANCEL';
    await startScenario(runId, 'adapter-cancel', [
      evInit('sess-real', INIT_LABEL),
      evAssistant('sess-real', RESPONSE_MODEL, textContent('ok')),
    ], { hold: true });
    await delay(40);
    const running = await claude.readRun(runId);
    assert.equal(running.status, 'running');
    assert.equal(running.modelObservation.status, 'observed');
    await claude.cancel(runId);
    const cancelled = await waitForRun(runId, (value) => value.status === 'cancelled');
    assert.equal(cancelled.modelObservation.status, 'observed');
    assert.equal(cancelled.modelObservation.model, RESPONSE_MODEL);
  });

  // =====================================================================
  // 5. Real agent-runtime projection
  // =====================================================================
  const projectionRuns = new Map();
  const projectionEvents = new Map();
  const projectionClient = {
    describe: async () => ({ installed: true, loggedIn: true, version: 'projection-contract-double' }),
    preflight: async ({ workspace }) => ({ ready: true, code: 'CLAUDE_READY', workspace }),
    start: async () => { throw new Error('the projection acceptance must not start a provider'); },
    readRun: async (runId) => structuredClone(projectionRuns.get(runId)),
    readEvents: async (runId) => structuredClone(projectionEvents.get(runId) || []),
    cancel: async (runId) => ({ runId, status: 'cancelled', resourceRelease: { confirmed: true, status: 'confirmed' } }),
    eventText: (event) => event?.item?.text || event?.error?.message || '',
  };
  const projectionRuntime = createAgentRuntime({
    mode: 'claude-code',
    claudeClient: projectionClient,
    bridgeDir: path.join(root, 'projection-bridge'),
    codexWorkspace: root,
  });
  const buildProjectionState = (runId) => ({
    activeMissionId: 'MIS_OBS',
    missions: [{ id: 'MIS_OBS', title: 'Observation projection', repository: root, hardware: ['CPU'], metric: 'latency p50' }],
    runtimeEvents: [],
    stage: 'diagnosis',
    patchApplied: false,
    candidateEvaluations: [],
    runHistory: [],
    tokenUsage: null,
    agent: {
      status: 'running', runtimeKind: 'claude-code', runId, missionId: 'MIS_OBS', goal: 'observe',
      startedAt: new Date().toISOString(), eventCount: 0, messages: [], toolCalls: [], artifacts: [],
    },
  });
  const projectionRunRecord = (runId, modelObservation, sessionId = 'sess-proj') => ({
    runId, missionId: 'MIS_OBS', status: 'running', threadId: sessionId, workspace: root,
    startedAt: new Date(Date.now() - 1_000).toISOString(), lastActivityAt: new Date().toISOString(),
    completedAt: null, error: null, activity: null, resourceRelease: undefined,
    ...(modelObservation === null ? {} : { modelObservation }),
  });

  await check('projection: exact current-run binding is exposed and metadata-only change flips changed=true', async () => {
    const runId = 'claude_PROJ_META';
    const runRecord = projectionRunRecord(runId, observedDto({ runId, missionId: 'MIS_OBS', sessionId: 'sess-proj', usageModels: [] }));
    projectionRuns.set(runId, runRecord);
    projectionEvents.set(runId, []);
    const state = buildProjectionState(runId);
    // The first two projections normalize the token-usage ledger (it re-stamps
    // once); the third identical projection must be a no-op so the following
    // metadata-only change is the only remaining difference.
    await projectionRuntime.projectState(state);
    await projectionRuntime.projectState(state);
    const baseEventCount = state.agent.eventCount;
    const baseStatus = state.agent.status;
    const baseline = await projectionRuntime.projectState(state);
    assert.equal(baseline.changed, false, 'a stable projection must not report churn');
    const bound = state.agent.modelObservation;
    assert.ok(bound, 'agent-runtime must project state.agent.modelObservation');
    assert.equal(bound.provider, 'claude-code');
    assert.equal(bound.runId, runId);
    assert.equal(bound.missionId, 'MIS_OBS');
    assert.equal(bound.sessionId, 'sess-proj');
    assert.equal(bound.status, 'observed');
    assert.equal(bound.model, RESPONSE_MODEL);

    runRecord.modelObservation = observedDto({ runId, missionId: 'MIS_OBS', sessionId: 'sess-proj', usageModels: [INIT_LABEL] });
    const after = await projectionRuntime.projectState(state);
    assert.equal(state.agent.status, baseStatus, 'the metadata change must not alter run status');
    assert.equal(state.agent.eventCount, baseEventCount, 'the metadata change must not alter the event count');
    assert.equal(after.changed, true, 'a metadata-only observation change must trigger changed=true');
    assert.deepEqual(state.agent.modelObservation.usageModels, [INIT_LABEL]);
    assert.notEqual(state.agent.modelObservation, runRecord.modelObservation, 'projection must deep-detach the observation');
  });

  await check('projection: missing, foreign or wrongly bound observations clear a stale value', async () => {
    const runId = 'claude_PROJ_STALE';
    projectionEvents.set(runId, []);
    const state = buildProjectionState(runId);
    const foreignBindings = {
      'foreign run': observedDto({ runId: 'claude_FOREIGN', missionId: 'MIS_OBS', sessionId: 'sess-proj' }),
      'foreign mission': observedDto({ runId, missionId: 'MIS_FOREIGN', sessionId: 'sess-proj' }),
      'foreign session': observedDto({ runId, missionId: 'MIS_OBS', sessionId: 'sess-other' }),
      'foreign provider': { ...observedDto({ runId, missionId: 'MIS_OBS', sessionId: 'sess-proj' }), provider: 'codex-cli' },
    };
    for (const [label, foreign] of Object.entries(foreignBindings)) {
      projectionRuns.set(runId, projectionRunRecord(runId, observedDto({ runId, missionId: 'MIS_OBS', sessionId: 'sess-proj' })));
      await projectionRuntime.projectState(state);
      assert.ok(state.agent.modelObservation, `a valid binding must project before the ${label} case`);
      projectionRuns.set(runId, projectionRunRecord(runId, foreign));
      await projectionRuntime.projectState(state);
      assert.ok(!state.agent.modelObservation, `a ${label} binding must clear the stale observation`);
    }

    projectionRuns.set(runId, projectionRunRecord(runId, observedDto({ runId, missionId: 'MIS_OBS', sessionId: 'sess-proj' })));
    await projectionRuntime.projectState(state);
    assert.ok(state.agent.modelObservation);
    projectionRuns.set(runId, projectionRunRecord(runId, null));
    await projectionRuntime.projectState(state);
    assert.ok(!state.agent.modelObservation, 'a missing observation must clear any stale value');
  });

  await check('projection: cancellation settlement retains observation without weakening release', async () => {
    const runId = 'claude_PROJ_CANCEL';
    projectionEvents.set(runId, []);
    // The record's own session must match the DTO exactly. The observation can
    // never be accepted because production treats the DTO session as its own
    // expected identity; the run record is the identity authority here.
    const record = projectionRunRecord(runId, observedDto({ runId, missionId: 'MIS_OBS', sessionId: 'sess-cancel' }), 'sess-cancel');
    projectionRuns.set(runId, record);
    const state = buildProjectionState(runId);
    state.agent.status = 'cancel_requested';
    state.agent.resourceRelease = { confirmed: false, status: 'pending' };
    await projectionRuntime.projectState(state);
    assert.equal(state.agent.status, 'cancelled');
    assert.equal(state.agent.resourceRelease.confirmed, true, 'a provider release receipt must stay authoritative');
    assert.ok(state.agent.modelObservation, 'cancellation settlement must retain the observation');
    assert.equal(state.agent.modelObservation.model, RESPONSE_MODEL);
    assert.equal(record.threadId, state.agent.modelObservation.sessionId, 'the projected session must equal the actual run record session');
  });

  await check('projection: a record/DTO bound to a foreign mission never projects into the current mission', async () => {
    const runId = 'claude_PROJ_FOREIGN_MISSION';
    projectionEvents.set(runId, []);
    // Baseline: the same shape bound to the current mission must project, so the
    // foreign-mission refusal is not satisfied by simply never projecting.
    projectionRuns.set(runId, projectionRunRecord(runId, observedDto({ runId, missionId: 'MIS_OBS', sessionId: 'sess-proj' })));
    const state = buildProjectionState(runId);
    assert.equal(state.agent.missionId, 'MIS_OBS');
    await projectionRuntime.projectState(state);
    assert.ok(state.agent.modelObservation, 'a record/DTO bound to the current mission must project first');
    const record = projectionRunRecord(runId, observedDto({ runId, missionId: 'MIS_FOREIGN', sessionId: 'sess-proj' }));
    record.missionId = 'MIS_FOREIGN';
    projectionRuns.set(runId, record);
    await projectionRuntime.projectState(state);
    assert.ok(!state.agent.modelObservation, 'the current mission is MIS_OBS; a run/DTO bound to MIS_FOREIGN must not project');
  });

  await check('projection: a cancelled run whose DTO session disagrees with the record is refused, release stays authoritative', async () => {
    const runId = 'claude_PROJ_CANCEL_MISMATCH';
    projectionEvents.set(runId, []);
    const cancelledRecord = (dtoSession) => {
      const record = projectionRunRecord(runId, observedDto({ runId, missionId: 'MIS_OBS', sessionId: dtoSession }), 'sess-record');
      record.status = 'cancelled';
      record.resourceRelease = { confirmed: true, status: 'confirmed' };
      return record;
    };
    // Baseline: a cancelled record whose session matches the DTO may settle and
    // retain the observation.
    projectionRuns.set(runId, cancelledRecord('sess-record'));
    const baselineState = buildProjectionState(runId);
    baselineState.agent.status = 'cancel_requested';
    baselineState.agent.resourceRelease = { confirmed: false, status: 'pending' };
    await projectionRuntime.projectState(baselineState);
    assert.equal(baselineState.agent.status, 'cancelled');
    assert.ok(baselineState.agent.modelObservation, 'a cancelled record with a matching session must retain the observation');

    projectionRuns.set(runId, cancelledRecord('sess-other'));
    const state = buildProjectionState(runId);
    state.agent.status = 'cancel_requested';
    state.agent.resourceRelease = { confirmed: false, status: 'pending' };
    const result = await projectionRuntime.projectState(state);
    assert.equal(state.agent.status, 'cancelled');
    assert.equal(state.agent.resourceRelease.confirmed, true, 'a provider release receipt must stay authoritative');
    assert.ok(!state.agent.modelObservation, 'a cancelled DTO session that disagrees with the record session must not project');
    assert.equal(result.changed, true);
  });

  await check('projection: a run record claiming another provider never projects a claude-code observation', async () => {
    const runId = 'claude_PROJ_FOREIGN_PROVIDER';
    projectionEvents.set(runId, []);
    const record = projectionRunRecord(runId, observedDto({ runId, missionId: 'MIS_OBS', sessionId: 'sess-proj' }));
    record.provider = 'claude-code';
    projectionRuns.set(runId, record);
    const state = buildProjectionState(runId);
    await projectionRuntime.projectState(state);
    assert.ok(state.agent.modelObservation, 'a claude-code record with a matching provider must project first');
    record.provider = 'codex-cli';
    await projectionRuntime.projectState(state);
    assert.ok(!state.agent.modelObservation, "a run record claiming provider 'codex-cli' must not project a claude-code observation");
  });

  await check('projection: a failing readRun clears a previously projected observation instead of leaving stale evidence', async () => {
    const runId = 'claude_PROJ_READ_FAIL';
    projectionEvents.set(runId, []);
    projectionRuns.set(runId, projectionRunRecord(runId, observedDto({ runId, missionId: 'MIS_OBS', sessionId: 'sess-proj' })));
    const state = buildProjectionState(runId);
    await projectionRuntime.projectState(state);
    assert.ok(state.agent.modelObservation, 'a valid binding must project before the read failure case');
    const readRun = projectionClient.readRun;
    projectionClient.readRun = async () => { throw new Error('projection readRun unavailable'); };
    try {
      await projectionRuntime.projectState(state);
    } finally {
      projectionClient.readRun = readRun;
    }
    assert.ok(!state.agent.modelObservation, 'unvalidated stale evidence must not survive a readRun failure');
  });

  // =====================================================================
  // 6. Real archive / new-run reset
  // =====================================================================
  const missionDomain = createMissionProjectState({
    rootDir: root,
    workspaceDir: path.join(root, 'workspace'),
    workspaceDirForMission: (missionId) => path.join(root, 'workspaces', missionId),
    missionSourceDirFor: (missionId) => path.join(root, 'sources', missionId),
  });
  const buildArchiveState = () => {
    const state = { missions: [], projects: [], activeMissionId: null, activeProjectId: null };
    missionDomain.createMission(state, { goal: 'observation archive', repository: path.join(root, 'repo'), hardware: ['CPU'] });
    const missionId = state.activeMissionId;
    const dto = observedDto({ runId: 'claude_ARCH', missionId, sessionId: 'sess-arch' });
    state.agent = { ...state.agent, runId: 'claude_ARCH', runtimeKind: 'claude-code', threadId: 'sess-arch', status: 'completed', goal: 'observation archive', modelObservation: dto };
    return { state, missionId, dto };
  };

  await check('archive: reset preserves the bound observation as a detached runHistory entry and clears the live run', () => {
    const { state, dto } = buildArchiveState();
    missionDomain.resetMissionRunState(state, 'next goal');
    assert.equal(state.runHistory[0].runId, 'claude_ARCH');
    assert.ok(state.runHistory[0].modelObservation, 'reset must archive the bound observation');
    assert.deepEqual(state.runHistory[0].modelObservation, dto);
    assert.notEqual(state.runHistory[0].modelObservation, dto, 'the archived observation must be detached');
    assert.ok(!state.agent.modelObservation, 'reset must clear the live observation');
    state.runHistory[0].modelObservation.reasons.push('mutated');
    assert.deepEqual(dto.reasons, [], 'mutating the archive must not touch the source DTO');
  });

  await check('archive: a foreign observation binding is rejected instead of archived', () => {
    const foreignObservations = {
      'foreign run': (missionId) => observedDto({ runId: 'claude_OTHER', missionId, sessionId: 'sess-arch' }),
      'foreign mission': (missionId) => observedDto({ runId: 'claude_ARCH', missionId: 'MIS_FOREIGN', sessionId: 'sess-arch' }),
      'foreign session': (missionId) => observedDto({ runId: 'claude_ARCH', missionId, sessionId: 'sess-other' }),
      'foreign provider': (missionId) => ({ ...observedDto({ runId: 'claude_ARCH', missionId, sessionId: 'sess-arch' }), provider: 'codex-cli' }),
    };
    for (const [label, buildForeign] of Object.entries(foreignObservations)) {
      const { state, missionId } = buildArchiveState();
      state.agent.modelObservation = buildForeign(missionId);
      missionDomain.resetMissionRunState(state, 'next goal');
      assert.ok(!state.agent.modelObservation, `reset must clear the live ${label} observation binding`);
      assert.ok(!state.runHistory[0].modelObservation, `a ${label} observation must never be archived`);
    }
  });

  await check('archive: a brand-new run never inherits the archived observation', () => {
    const { state, dto } = buildArchiveState();
    missionDomain.resetMissionRunState(state, 'next goal');
    missionDomain.startAgentRun(state, 'brand new run');
    assert.notEqual(state.agent.runId, 'claude_ARCH');
    assert.ok(!state.agent.modelObservation, 'a new run must start with no inherited observation');
    assert.deepEqual(state.runHistory[0].modelObservation, dto);
  });
} finally {
  await rm(root, { recursive: true, force: true });
}

console.log('\n[model-observation] hardware-free: no real Claude CLI, Python, network or GPU process was started.');
if (apiImportError) {
  console.log(`[model-observation] baseline red: client-runtime/model-observation.mjs is absent (${apiImportError?.code || apiImportError?.message}); the frozen pure API cannot be exercised yet.`);
}
console.log(`[model-observation] ${passCount} passed, ${failures.length} failed`);
for (const failure of failures) console.log(`  FAIL ${failure.name}: ${failure.message}`);
if (failures.length) process.exitCode = 1;
