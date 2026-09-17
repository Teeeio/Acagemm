// Independent acceptance matrix for EXPERIENCE_STUDY_CONTRACT.md section C items 1-8:
// the opt-in `experienceCondition` on the EXISTING production prepare/collection path,
// its interaction with the frozen 方案 D selection audit, and the retained strictness of
// the original continuation verifier.
//
// Entry points under test are the documented public ones only: the production
// experience service (and its HTTP application service), the production round-experience
// service `prepare`/`collect`, the production experience-context formatter/prompt builder,
// and `verifyContinuationAudit` from the shared-GPU acceptance contract. Fixtures are
// constructed here from real repository transactions and the real KernelWiki importer; no
// assertion matches implementation source text.
//
// No provider, model, network, Python or GPU process is contacted. Stores live in isolated
// temporary roots; the single child process case drives the production Runtime with
// hardware disabled and the local C500 backend mocked, on loopback only.
//
// This file was written against the frozen interface while the parallel A/B producers were
// still uncombined; the author phase runs `node --check` only. A green run after
// combination is contract/integration evidence for the frozen interface, never a selection
// benefit, stability or publishability claim.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { createHash } from 'node:crypto';
import { createExperienceRepository } from '../client-runtime/experience-repository.mjs';
import { createExperienceService } from '../client-runtime/application/experience-service.mjs';
import { createExperienceApiService } from '../client-runtime/application/experience-api-service.mjs';
import { createRoundExperienceService } from '../client-runtime/application/round-experience-service.mjs';
import {
  EXPERIENCE_LIMITS, EXPERIENCE_SELECTION_POLICY_VERSION, formatExperienceContext, validateExperienceContext,
} from '../client-runtime/experience-contract.mjs';
import { buildKernelWikiSnapshot } from '../client-runtime/kernel-wiki-import.mjs';
import { WIKI_SELECTION_POLICY_VERSION } from '../client-runtime/experience-selection.mjs';
import { buildCandidateGenerationPrompt } from '../client-runtime/candidate-generation/prompt.mjs';
import { ROUND_FACTS_SCHEMA_VERSION, verifyContinuationAudit } from '../scripts/shared-gpu-acceptance.mjs';

const MISSION_ID = 'mission-condition';
const PROJECT_ID = 'project-condition';
const FOREIGN_PROJECT_ID = 'project-foreign';
const SOURCE_ROUND = `${MISSION_ID}:round:1`;
const TARGET_ROUND = `${MISSION_ID}:round:2`;
const CONTRACT_SHA = 'b6b4301f15e8ce6955a56776690643ce5db369e6';
const SOURCE_RUN = 'run-condition-source';
const CONTINUATION_RUN = 'run-condition-continuation';
const QUEUE_REQUEST = 'queue-condition-0001';
const CANDIDATE_ID = 'candidate-condition-01';
const PATCH_DIGEST = 'a'.repeat(64);
const FIXED_CLOCK = Date.parse('2026-09-15T09:00:00.000Z');
const GOAL = 'Reduce vector_add tail latency; candidate technique: vectorization for the tail block handling.';
const CONDITIONS = ['facts-only', 'local-only', 'local-and-wiki'];

const sha256 = (value) => createHash('sha256').update(value, 'utf8').digest('hex');
const digest = (character) => character.repeat(64);
const roots = [];

let passed = 0;
let failed = 0;
// Every case is isolated: one failure reports its own name and stack and the remaining
// cases still run, so a combination collects every error instead of only the first. Any
// failure makes the process exit non-zero, so a partial run is never reported as green.
const test = async (name, run) => {
  try {
    await run();
    passed += 1;
    console.log(`PASS ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`FAIL ${name}\n${error?.stack ?? error}`);
  }
};
const codedFailure = (code) => (error) => {
  assert.ok(error instanceof Error, `a rejection must throw an Error, saw ${String(error)}`);
  assert.equal(error.code, code, `expected ${code}, saw ${JSON.stringify(error?.code)} (${error.message})`);
  return true;
};
// `code` is either one frozen code or the exact set of frozen codes the contract
// allows for that conflict; anything else (including a silent success) fails.
const rejected = async (promise, code, label) => {
  const allowed = Array.isArray(code) ? code : [code];
  const expected = allowed.join(' or ');
  try {
    await promise;
  } catch (error) {
    assert.ok(allowed.includes(error?.code), `${label}: expected ${expected}, saw ${JSON.stringify(error?.code)} (${error.message})`);
    return error;
  }
  assert.fail(`${label}: expected ${expected}, the operation resolved`);
};
// A synchronous factory must reject an invalid explicit condition before any effectful
// operation; `assert.throws` proves the rejection is not deferred to a promise.
const rejectsSynchronously = (factory, code, label) => {
  assert.throws(factory, (error) => {
    assert.equal(error?.code, code, `${label}: expected ${code}, saw ${JSON.stringify(error?.code)} (${error.message})`);
    return true;
  }, `${label}: expected a synchronous ${code}`);
};

// --- production fixtures -----------------------------------------------------------------

const mission = Object.freeze({
  id: MISSION_ID, projectId: PROJECT_ID, operator: 'vector_add', tags: [],
  hardware: ['nvidia-gpu'], architecture: ['sm86'], goal: GOAL,
});
const stateFor = () => ({
  activeMissionId: MISSION_ID,
  iterationStats: {
    resolvedTarget: { missionId: MISSION_ID, hardware: ['nvidia-gpu'], architecture: ['sm86'], capabilities: [], software: [] },
  },
  benchmark: { status: 'idle' },
  runHistory: [],
});

// The frozen facts carry the same source-round binding the archive carries, including the
// actual candidate source run: the audit's `previous`, the archived source round and the
// producing task must all name one real source, so a recovery attempt is never re-attributed.
const roundFactsFor = () => ({
  schemaVersion: ROUND_FACTS_SCHEMA_VERSION,
  recordedAt: '2026-09-15T08:00:00.000Z',
  target: { missionId: MISSION_ID, projectId: PROJECT_ID, roundId: TARGET_ROUND },
  previous: {
    missionId: MISSION_ID, projectId: PROJECT_ID, runId: SOURCE_RUN, roundId: SOURCE_ROUND,
    candidateId: CANDIDATE_ID, candidateDigest: `sha256:${PATCH_DIGEST}`, queueRequestId: QUEUE_REQUEST,
    candidateSourceRunId: SOURCE_RUN,
  },
  candidate: { candidateId: CANDIDATE_ID, digest: `sha256:${PATCH_DIGEST}` },
  correctness: { passed: true, cases: 4 },
  failure: null,
  gate: { result: 'reference' },
  decision: { status: 'allowed' },
  rollback: { performed: true, origin: SOURCE_ROUND },
  currentBest: { candidateId: null, status: 'reference' },
});
// The direct-oracle archive is structurally identical to the round the disk reader derives
// from `runHistory`: a fixture that dropped `candidateSourceRunId` here would let the direct
// positive pass while the same binding failed on the retained raw artifacts.
const sourceRoundFor = (facts) => ({
  roundId: SOURCE_ROUND,
  runId: SOURCE_RUN,
  candidateId: CANDIDATE_ID,
  candidateDigest: `sha256:${PATCH_DIGEST}`,
  queueRequestId: QUEUE_REQUEST,
  candidateSourceRunId: SOURCE_RUN,
  decisionReview: { resolution: { outcome: 'reference' } },
  roundFacts: facts,
});
const executionEvidence = () => ({
  missionId: MISSION_ID, candidateId: CANDIDATE_ID, runId: QUEUE_REQUEST,
  patchDigest: `sha256:${PATCH_DIGEST}`, packageDigest: `sha256:${digest('b')}`,
  environmentDigest: `sha256:${digest('c')}`, acceptanceDigest: `sha256:${digest('d')}`,
  hardware: 'nvidia-gpu', architecture: 'sm86', executionMode: 'gpu', outcome: 'passed', operation: 'correctness',
});

const wikiPage = ({ id, body }) => ({
  path: `wiki/techniques/${id}.md`,
  text: [
    '---',
    `id: ${id}`,
    `title: "${id} tail guidance"`,
    'type: technique',
    'tags: ["vectorization"]',
    'symptoms:',
    '  - tail block handling',
    'candidate_techniques:',
    '  - masked-tail-loop',
    'architectures:',
    '  - sm86',
    'performance_claims:',
    '  speedup: "9.9x"',
    '---',
    '',
    body,
    '',
  ].join('\n'),
});
const snapshotFor = ({ pageId = 'cond-tail-handling', body = 'Mask the final partial block instead of padding the whole tensor.', reviewArchitectures = ['sm86'] } = {}) => buildKernelWikiSnapshot({
  pages: [wikiPage({ id: pageId, body })],
  sourceCommit: CONTRACT_SHA,
  reviews: [{
    pageId, reviewId: `review-cond-${pageId}`, mode: 'architecture-specific',
    hardware: ['nvidia-gpu'], architectures: reviewArchitectures, requiredCapabilities: [], software: [],
  }],
});

const createStore = async (label) => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), `operator-condition-${label}-`));
  roots.push(rootDir);
  const repository = createExperienceRepository({ rootDir });
  return { rootDir, repository, file: path.join(rootDir, 'experiences.json') };
};
const serviceFor = (repository) => {
  let serial = 0;
  return createExperienceService({
    repository,
    now: () => new Date(FIXED_CLOCK + serial * 1000).toISOString(),
    createId: () => `EXP-COND-${++serial}`,
  });
};
// The production HTTP application service is the only writer of imported selection
// metadata and the documented project-authorization boundary for the HTTP entry.
const httpApiFor = (experienceService) => createExperienceApiService({
  loadState: async () => ({ projects: [{ id: PROJECT_ID }, { id: FOREIGN_PROJECT_ID }] }),
  experiences: experienceService,
});
const roundServiceFor = (experienceService, extra = {}) => createRoundExperienceService({
  experienceService,
  resolveAccess: ({ mission: owner }) => ({ projectId: owner.projectId, allowedProjectIds: [] }),
  verifyObservationEvidence: async ({ observation }) => ({ verified: true, evidence: observation.evidence, summary: 'In-memory verification receipt.' }),
  timers: { setTimeout, clearTimeout },
  timeoutMs: 2000,
  ...extra,
});
const localObservation = (api, overrides = {}) => api.create(PROJECT_ID, {
  visibility: 'project', title: 'Local tail observation', author: 'engineer',
  content: 'The masked tail block previously produced mismatched values.',
  scope: { hardware: ['nvidia-gpu'], architecture: ['sm86'] }, ...overrides,
});
const resultOf = (value) => (value && typeof value === 'object' && value.result && typeof value.result === 'object' ? value.result : value);
// One shared setup builder: a reviewed sm86 Wiki unit imported through the HTTP
// application service, one applicable local observation, and optionally an execution
// observation recorded through the real round service.
const setup = async (label, { execution = false, foreign = false, cpuScoped = false, pageId = 'cond-tail-handling', reviewArchitectures = ['sm86'] } = {}) => {
  const { rootDir, repository, file } = await createStore(label);
  const service = serviceFor(repository);
  const api = httpApiFor(service);
  const snapshot = snapshotFor({ pageId, reviewArchitectures });
  const imported = await api.importKernelWiki(PROJECT_ID, { snapshot, author: 'condition-test' });
  assert.equal(imported.statusCode, 200, JSON.stringify(imported.payload));
  await localObservation(api);
  if (cpuScoped) await localObservation(api, { title: 'cpu-scoped observation', scope: { hardware: ['cpu'] } });
  if (foreign) {
    const created = await api.create(FOREIGN_PROJECT_ID, {
      visibility: 'project', title: 'Foreign project observation', author: 'engineer', content: 'Another project only.',
      scope: { hardware: ['nvidia-gpu'], architecture: ['sm86'] },
    });
    assert.equal(created.statusCode, 201);
  }
  let recorded = null;
  if (execution) {
    const recorder = roundServiceFor(service);
    recorded = await recorder.record({ state: stateFor(), mission, observation: { evidence: executionEvidence(), evidenceRefs: ['result.json'] } });
    assert.equal(recorded.status, 'recorded', JSON.stringify(recorded));
  }
  return { rootDir, repository, file, service, api, snapshot, recorded };
};
const recordsOf = async (service) => (await service.read(null, { projectId: PROJECT_ID })).experiences;
const prepare = async (roundService, state, roundId) => {
  const context = await roundService.prepare({ state, mission, roundId });
  return { context, selection: state.iterationStats.roundExperienceSelection };
};
const wikiItems = (context) => context.items.filter((item) => item.selectionMetadata?.source === 'kernel-wiki');
const promptFor = (context, facts) => buildCandidateGenerationPrompt({
  mission: { ...mission, iterationContext: facts },
  goal: GOAL,
  workspace: path.join(os.tmpdir(), 'operator-condition-workspace'),
  baseline: {},
  testMatrix: {},
  workspaceInventory: ['run.py'],
  experienceInstruction: formatExperienceContext(context, { projectId: PROJECT_ID, missionId: MISSION_ID, roundId: context.roundId }),
});
const auditFor = ({ context, selection, facts, runId }) => {
  const prompt = promptFor(context, facts);
  return {
    schemaVersion: 'operator-studio.prompt-audit/v1',
    deliveryStage: 'prepared-before-send',
    missionId: MISSION_ID, projectId: PROJECT_ID, roundId: context.roundId, runId,
    prompt, promptDigest: `sha256:${sha256(prompt)}`, promptBytes: Buffer.byteLength(prompt, 'utf8'),
    roundFacts: facts, selection,
  };
};

// Defined before the case runner: every helper used by a case must already be
// initialized when that case executes.
const freePort = async () => {
  const socket = createServer();
  await new Promise((resolve) => socket.listen(0, '127.0.0.1', resolve));
  const port = socket.address().port;
  await new Promise((resolve) => socket.close(resolve));
  return port;
};
const reachable = async (url) => {
  try { return (await fetch(url)).ok; } catch { return false; }
};

try {
  await test('matrix 1: the default (omitted) condition keeps the frozen D selection and the strict verifier', async () => {
    const { service } = await setup('default', { execution: true });
    const roundService = roundServiceFor(service);
    const state = stateFor();
    const { context, selection } = await prepare(roundService, state, TARGET_ROUND);
    validateExperienceContext(context, { projectId: PROJECT_ID, missionId: MISSION_ID, roundId: TARGET_ROUND });
    assert.equal(selection.policyVersion, WIKI_SELECTION_POLICY_VERSION, 'the D policy version is retained');
    assert.equal(selection.selected.length, context.items.length);
    assert.ok(wikiItems(context).length >= 1, 'the reviewed sm86 Wiki unit is selected by default');
    assert.ok(context.items.some((item) => item.source === 'execution'), 'the bound execution record is selected by default');
    assert.ok(context.items.some((item) => item.source === 'human' && !item.selectionMetadata), 'applicable local guidance is selected by default');
    assert.ok(context.items.length <= EXPERIENCE_LIMITS.contextItems);

    // The retained strict verifier still accepts a default-mode continuation audit.
    const facts = roundFactsFor();
    const audit = auditFor({ context, selection, facts, runId: CONTINUATION_RUN });
    const summary = verifyContinuationAudit({
      audit, sourceRound: sourceRoundFor(facts), experiences: await recordsOf(service),
      missionId: MISSION_ID, projectId: PROJECT_ID,
    });
    assert.equal(summary.facts.previousQueueRequestId, QUEUE_REQUEST);
    assert.equal(summary.promptDigest, `sha256:${sha256(audit.prompt)}`);
  });

  await test('matrix 2: each condition filters before ranking with the frozen selection semantics', async () => {
    const expectations = {
      // facts-only selects zero optional experience of either source, with a still-valid frozen context.
      'facts-only': (context) => assert.equal(context.items.length, 0, 'facts-only injects nothing'),
      // local-only keeps every applicable local record and excludes every Wiki-sourced record.
      'local-only': (context) => {
        assert.equal(wikiItems(context).length, 0, 'local-only never injects a kernel-wiki unit');
        assert.ok(context.items.some((item) => item.source === 'execution'), 'local-only keeps the applicable execution record');
        assert.ok(context.items.some((item) => item.source === 'human' && !item.selectionMetadata), 'local-only keeps applicable local guidance');
      },
      // local-and-wiki keeps the unchanged D set, including the reviewed related Wiki unit.
      'local-and-wiki': (context) => {
        assert.ok(wikiItems(context).length >= 1, 'local-and-wiki keeps the reviewed related Wiki unit');
        assert.ok(context.items.some((item) => item.source === 'execution'));
      },
    };
    for (const condition of CONDITIONS) {
      const { service } = await setup(`condition-${condition}`, { execution: true });
      const roundService = roundServiceFor(service, { experienceCondition: condition });
      const state = stateFor();
      const { context, selection } = await prepare(roundService, state, TARGET_ROUND);
      validateExperienceContext(context, { projectId: PROJECT_ID, missionId: MISSION_ID, roundId: TARGET_ROUND });
      assertionsFor(condition, expectations)(context);
      assert.equal(selection.experienceCondition, condition, 'an explicit condition is recorded exactly in the audit');
      assert.equal(selection.selected.length, context.items.length, 'the sidecar still matches the frozen context');
      assert.equal(selection.policyVersion, WIKI_SELECTION_POLICY_VERSION);
      assert.ok(Number.isFinite(selection.renderedBytes) && selection.renderedBytes > 0);
      if (condition === 'facts-only') assert.equal(selection.selected.length, 0, 'facts-only has zero selected entries');
    }
    function assertionsFor(condition, table) { return table[condition]; }
  });

  await test('matrix 3: facts-only does not stop collection or the mandatory round facts', async () => {
    const { service } = await setup('facts-only-collection', {});
    const roundService = roundServiceFor(service, { experienceCondition: 'facts-only' });
    const state = stateFor();
    const { context, selection } = await prepare(roundService, state, TARGET_ROUND);
    assert.deepEqual(context.items, [], 'no optional experience is injected');
    // The rendered pre-send prompt still carries the mandatory facts outside an explicitly empty block.
    const facts = roundFactsFor();
    const prompt = promptFor(context, facts);
    const begin = '----- BEGIN UNTRUSTED EXPERIENCE DATA -----';
    const end = '----- END UNTRUSTED EXPERIENCE DATA -----';
    const start = prompt.indexOf(begin);
    const stop = prompt.indexOf(end, start);
    assert.ok(start >= 0 && stop > start, 'the production formatter always emits its untrusted block');
    const block = JSON.parse(prompt.slice(start + begin.length, stop));
    assert.deepEqual(block.items, [], 'a zero selection renders an explicitly empty block');
    assert.equal(block.contextId, selection.contextId);
    assert.equal(prompt.slice(stop).includes(SOURCE_RUN), true, 'the mandatory round facts stay outside the empty block');

    // Collection still runs: a verified execution observation is durably recorded.
    state.benchmark = { status: 'complete', result: { experienceEvidence: executionEvidence(), experienceEvidenceRefs: ['result.json'] } };
    const collected = await roundService.collect({ state, mission });
    assert.equal(collected.recorded, 1, JSON.stringify(collected));
    assert.equal(state.iterationStats.experienceCollection.recorded, 1);
    const stored = await recordsOf(service);
    assert.equal(stored.filter((item) => item.source === 'execution').length, 1, 'facts-only never suppresses durable collection');
  });

  await test('matrix 4: invalid explicit values fail synchronously and legacy retrieval cannot carry a condition', async () => {
    const { file, service } = await setup('invalid', {});
    const before = await recordsOf(service);
    const bytesBefore = await readFile(file, 'utf8');
    for (const value of ['all', 'facts-only ', 'FACTS-ONLY', '', null, 42, ['facts-only'], {}]) {
      rejectsSynchronously(
        () => roundServiceFor(service, { experienceCondition: value }),
        'EXPERIENCE_INVALID',
        `explicit condition ${JSON.stringify(value)}`,
      );
    }
    // An explicit condition requires the audited retrieval port; a retrieve-only
    // injection must be rejected instead of silently degrading to default selection.
    const legacyOnly = { ...service, retrieveWithSelection: undefined, retrieve: (...args) => service.retrieve(...args) };
    rejectsSynchronously(
      () => roundServiceFor(legacyOnly, { experienceCondition: 'facts-only' }),
      'EXPERIENCE_INVALID',
      'explicit condition with a legacy retrieve-only port',
    );
    assert.deepEqual(await recordsOf(service), before, 'a rejected constructor changes no experience state');
    assert.equal(await readFile(file, 'utf8'), bytesBefore, 'a rejected constructor never rewrites the stored experience repository');
  });

  await test('matrix 4b: the legacy retrieve-only port still prepares under the default mode', async () => {
    const { service } = await setup('legacy', {});
    const legacyOnly = { ...service, retrieveWithSelection: undefined, retrieve: (...args) => service.retrieve(...args) };
    const roundService = roundServiceFor(legacyOnly);
    const state = stateFor();
    const { context, selection } = await prepare(roundService, state, TARGET_ROUND);
    validateExperienceContext(context);
    assert.equal(selection.auditSource, 'context-derived', 'a legacy port keeps its explicitly marked sidecar');
    assert.equal(selection.exclusionReasonsRecorded, false);
    assert.equal(selection.policyVersion, EXPERIENCE_SELECTION_POLICY_VERSION, 'the legacy policy version is not restamped');
    assert.ok(context.items.length >= 2, 'the legacy path still injects the applicable records');
  });

  await test('matrix 5: a frozen round cannot switch condition; a new round uses the configured one', async () => {
    const { service } = await setup('same-round', { execution: true });
    const defaultService = roundServiceFor(service);
    const state = stateFor();
    await prepare(defaultService, state, TARGET_ROUND);
    // The frozen audit carries no explicit condition, so an explicit service must not
    // silently relabel or reselect it.
    await rejected(
      prepare(roundServiceFor(service, { experienceCondition: 'local-only' }), state, TARGET_ROUND),
      'ROUND_EXPERIENCE_CONTEXT_CONFLICT',
      'missing frozen explicit condition',
    );

    const { service: other, repository } = await setup('same-round-explicit', { execution: true });
    const factsService = roundServiceFor(other, { experienceCondition: 'facts-only' });
    const explicitState = stateFor();
    const frozen = await prepare(factsService, explicitState, TARGET_ROUND);
    assert.equal(frozen.selection.experienceCondition, 'facts-only');
    await rejected(
      prepare(roundServiceFor(other, { experienceCondition: 'local-only' }), explicitState, TARGET_ROUND),
      'ROUND_EXPERIENCE_CONTEXT_CONFLICT',
      'different frozen explicit condition',
    );
    // Same-round reuse of the configured condition is idempotent: no reselection.
    const reread = await prepare(factsService, explicitState, TARGET_ROUND);
    assert.equal(reread.context.contextId, frozen.context.contextId);
    assert.equal(reread.selection.contextId, frozen.selection.contextId);
    // A fresh logical round uses the configured condition.
    const nextState = structuredClone(explicitState);
    nextState.iterationStats.roundExperience = null;
    nextState.iterationStats.roundExperienceSelection = null;
    const nextRound = `${MISSION_ID}:round:3`;
    const next = await prepare(factsService, nextState, nextRound);
    assert.equal(next.selection.roundId, nextRound);
    assert.equal(next.selection.experienceCondition, 'facts-only');
    assert.notEqual(next.context.contextId, frozen.context.contextId, 'a fresh round reselects');
    assert.ok(repository);
  });

  await test('matrix 5b: a fresh selection can never be silently relabelled to the configured condition', async () => {
    const { service, file } = await setup('fresh-condition', { execution: true });
    const before = await recordsOf(service);
    const bytesBefore = await readFile(file, 'utf8');
    // The audited retrieval is the only source of the frozen condition. A fresh
    // round whose audited selection carries a missing or different condition must
    // be refused: stamping the configured value onto it would relabel a selection
    // that was really made under another (or no) condition.
    const mutations = [
      ['a fresh selection with no recorded condition', (selection) => { const clone = { ...selection }; delete clone.experienceCondition; return clone; }],
      ['a fresh selection recorded under another condition', (selection) => ({ ...selection, experienceCondition: 'local-only' })],
    ];
    for (const [label, mutate] of mutations) {
      const wrapped = {
        ...service,
        retrieveWithSelection: async (query, options) => {
          const audited = await service.retrieveWithSelection(query, options);
          return { context: audited.context, selection: mutate(audited.selection) };
        },
      };
      const state = stateFor();
      await rejected(
        prepare(roundServiceFor(wrapped, { experienceCondition: 'facts-only' }), state, TARGET_ROUND),
        ['ROUND_EXPERIENCE_CONTEXT_CONFLICT', 'ROUND_EXPERIENCE_SELECTION_CONFLICT'],
        label,
      );
      assert.equal(state.iterationStats?.roundExperience, undefined, `${label}: a refused fresh selection freezes no context`);
      assert.notEqual(state.iterationStats?.roundExperienceSelection?.experienceCondition, 'facts-only',
        `${label}: a refused selection is never relabelled with the configured condition`);
      assert.equal(state.iterationStats?.roundExperienceStatus?.status, 'failed', `${label}: the refused round stays an explicit failure`);
    }
    assert.deepEqual(await recordsOf(service), before, 'a refused fresh selection changes no experience state');
    assert.equal(await readFile(file, 'utf8'), bytesBefore, 'a refused fresh selection never rewrites the store');
  });

  await test('matrix 5c: concurrent same-round reuse dedupes one condition and never fulfils two', async () => {
    // Two services over the same state and the same round with different explicit
    // conditions cannot both succeed: the round is frozen once, so exactly one
    // condition may win and the competitor must conflict instead of being
    // fulfilled with a context it did not select.
    const { service } = await setup('concurrent-different', { execution: true });
    const state = stateFor();
    const factsService = roundServiceFor(service, { experienceCondition: 'facts-only' });
    const wikiService = roundServiceFor(service, { experienceCondition: 'local-and-wiki' });
    const results = await Promise.allSettled([
      factsService.prepare({ state, mission, roundId: TARGET_ROUND }),
      wikiService.prepare({ state, mission, roundId: TARGET_ROUND }),
    ]);
    const fulfilled = results.filter((item) => item.status === 'fulfilled');
    const conflicted = results.filter((item) => item.status === 'rejected');
    assert.equal(fulfilled.length, 1, 'exactly one concurrent same-round retrieval may freeze a condition');
    assert.equal(conflicted.length, 1, 'the competing explicit condition must conflict, never be fulfilled twice');
    assert.equal(conflicted[0].reason?.code, 'ROUND_EXPERIENCE_CONTEXT_CONFLICT',
      `the losing condition must conflict, saw ${JSON.stringify(conflicted[0].reason?.code)} (${conflicted[0].reason?.message})`);
    const frozen = state.iterationStats.roundExperience;
    const selection = state.iterationStats.roundExperienceSelection;
    assert.equal(fulfilled[0].value.contextId, frozen.contextId, 'the fulfilled caller received the frozen context');
    const winner = results[0].status === 'fulfilled' ? 'facts-only' : 'local-and-wiki';
    assert.equal(selection.experienceCondition, winner, 'the persisted sidecar records the condition that really won');
    if (winner === 'facts-only') assert.equal(frozen.items.length, 0, 'the facts-only winner froze an empty injection');
    else assert.ok(wikiItems(frozen).length >= 1, 'the local-and-wiki winner froze its reviewed Wiki unit');

    // Same configured condition: one retrieval serves both concurrent callers and
    // they receive the identical frozen context (existing same-round reuse).
    const { service: shared } = await setup('concurrent-same', { execution: true });
    let retrievals = 0;
    const counted = {
      ...shared,
      retrieveWithSelection: (...args) => { retrievals += 1; return shared.retrieveWithSelection(...args); },
    };
    const sharedState = stateFor();
    const first = roundServiceFor(counted, { experienceCondition: 'local-only' });
    const second = roundServiceFor(counted, { experienceCondition: 'local-only' });
    const [left, right] = await Promise.all([
      first.prepare({ state: sharedState, mission, roundId: TARGET_ROUND }),
      second.prepare({ state: sharedState, mission, roundId: TARGET_ROUND }),
    ]);
    assert.equal(retrievals, 1, 'one frozen retrieval serves both concurrent callers of the same condition');
    assert.equal(left.contextId, right.contextId, 'both same-condition callers receive the identical frozen context');
    assert.equal(sharedState.iterationStats.roundExperienceSelection.experienceCondition, 'local-only');

    // Default (omitted) mode keeps the same dedupe behavior: no condition is
    // required on old contexts, stores or audits.
    const { service: plain } = await setup('concurrent-default', { execution: true });
    let defaultRetrievals = 0;
    const countedPlain = {
      ...plain,
      retrieveWithSelection: (...args) => { defaultRetrievals += 1; return plain.retrieveWithSelection(...args); },
    };
    const defaultState = stateFor();
    const [plainLeft, plainRight] = await Promise.all([
      roundServiceFor(countedPlain).prepare({ state: defaultState, mission, roundId: TARGET_ROUND }),
      roundServiceFor(countedPlain).prepare({ state: defaultState, mission, roundId: TARGET_ROUND }),
    ]);
    assert.equal(defaultRetrievals, 1, 'the default mode still retrieves once per frozen round');
    assert.equal(plainLeft.contextId, plainRight.contextId);
    assert.ok(defaultState.iterationStats.roundExperienceSelection.experienceCondition == null,
      'the default mode records no explicit condition on the retained selection');
  });

  await test('matrix 6: unauthorized IDs stay hidden and scope/applicability are never bypassed', async () => {
    const { service } = await setup('authorization', { foreign: true, cpuScoped: true, pageId: 'cond-sm100-only', reviewArchitectures: ['sm100'] });
    const foreignId = (await service.read(null, { projectId: FOREIGN_PROJECT_ID })).experiences[0].id;
    for (const condition of CONDITIONS) {
      const roundService = roundServiceFor(service, { experienceCondition: condition });
      const state = stateFor();
      const { context, selection } = await prepare(roundService, state, TARGET_ROUND);
      assert.ok(selection.excludedUnauthorized >= 1, `${condition}: an inaccessible project record is counted, not named`);
      const named = [...selection.selected, ...(selection.excluded ?? [])].map((item) => item.id);
      assert.equal(named.includes(foreignId), false, `${condition}: an unauthorized ID is never disclosed`);
      assert.equal(JSON.stringify(context).includes(foreignId), false, `${condition}: an unauthorized record never reaches the context`);
      // Applicability/scope filtering is unchanged by the condition.
      assert.equal(context.items.some((item) => item.selectionMetadata), false, `${condition}: an sm100-only unit is never applicable to sm86`);
      assert.equal(context.items.some((item) => (item.scope?.hardware ?? []).includes('cpu')), false, `${condition}: a cpu-scoped record never matches the bound target`);
      const cpuRecord = (await recordsOf(service)).find((item) => (item.scope?.hardware ?? []).includes('cpu'));
      assert.ok((selection.excluded ?? []).some((item) => item.id === cpuRecord.id && item.reason === 'scope'), `${condition}: the scope exclusion is still audited`);
    }
  });

  await test('matrix 7: the exact condition and policy version enter the persisted selection and the pre-send prompt', async () => {
    const { service } = await setup('pre-send', { execution: true });
    const roundService = roundServiceFor(service, { experienceCondition: 'local-and-wiki' });
    const state = stateFor();
    const { context, selection } = await prepare(roundService, state, TARGET_ROUND);
    assert.equal(selection.experienceCondition, 'local-and-wiki');
    assert.equal(selection.policyVersion, WIKI_SELECTION_POLICY_VERSION);
    assert.equal(state.iterationStats.roundExperienceSelection.experienceCondition, 'local-and-wiki', 'the sidecar persisted with the frozen context carries the condition');
    // The bytes the prompt audit will recompute are measured, not estimated.
    const binding = { projectId: PROJECT_ID, missionId: MISSION_ID, roundId: TARGET_ROUND };
    const rendered = formatExperienceContext(context, binding);
    assert.equal(selection.renderedBytes, Buffer.byteLength(rendered, 'utf8'));
    assert.equal(selection.contextBytes, Buffer.byteLength(JSON.stringify(context), 'utf8'));
    const facts = roundFactsFor();
    const audit = auditFor({ context, selection, facts, runId: CONTINUATION_RUN });
    assert.equal(audit.promptDigest, `sha256:${sha256(audit.prompt)}`);
    const parsed = JSON.parse(audit.prompt.slice(
      audit.prompt.indexOf('----- BEGIN UNTRUSTED EXPERIENCE DATA -----') + '----- BEGIN UNTRUSTED EXPERIENCE DATA -----\n'.length,
      audit.prompt.indexOf('----- END UNTRUSTED EXPERIENCE DATA -----'),
    ));
    assert.equal(parsed.contextId, selection.contextId, 'the pre-send prompt embeds the frozen context the audit describes');
    assert.deepEqual(Object.keys(parsed.versions).sort(), context.items.map((item) => item.id).sort());
  });

  await test('matrix 8: the retained strict verifier rejects a facts-only prompt and accepts its default counterpart', async () => {
    const facts = roundFactsFor();
    const factsOnly = await setup('strict-facts-only', { execution: true });
    const factsRound = roundServiceFor(factsOnly.service, { experienceCondition: 'facts-only' });
    const factsState = stateFor();
    const factsContext = await prepare(factsRound, factsState, TARGET_ROUND);
    assert.deepEqual(factsContext.context.items, []);
    const factsAudit = auditFor({ context: factsContext.context, selection: factsContext.selection, facts, runId: CONTINUATION_RUN });
    const factsExperiences = await recordsOf(factsOnly.service);
    assert.throws(() => verifyContinuationAudit({
      audit: factsAudit, sourceRound: sourceRoundFor(facts), experiences: factsExperiences,
      missionId: MISSION_ID, projectId: PROJECT_ID,
    }), 'a facts-only prompt must never satisfy the default strict verifier');
    assert.ok(factsExperiences.some((item) => item.source === 'execution'), 'the source-round execution experience is still durably collected');

    // Positive control: the same fixture under the default condition is accepted, so the
    // rejection above is caused by the empty selection and not by a broken fixture.
    const control = await setup('strict-control', { execution: true });
    const controlState = stateFor();
    const controlContext = await prepare(roundServiceFor(control.service), controlState, TARGET_ROUND);
    const controlAudit = auditFor({ context: controlContext.context, selection: controlContext.selection, facts, runId: CONTINUATION_RUN });
    const controlExperiences = await recordsOf(control.service);
    const verified = verifyContinuationAudit({
      audit: controlAudit, sourceRound: sourceRoundFor(facts), experiences: controlExperiences,
      missionId: MISSION_ID, projectId: PROJECT_ID,
    });
    assert.equal(verified.runId, CONTINUATION_RUN);
    // Tampering with the control prompt still fails, so the verifier is not relaxed.
    const tampered = { ...controlAudit, promptDigest: `sha256:${digest('0')}` };
    assert.throws(() => verifyContinuationAudit({
      audit: tampered, sourceRound: sourceRoundFor(facts), experiences: controlExperiences,
      missionId: MISSION_ID, projectId: PROJECT_ID,
    }));
  });

  await test('matrix 4c: the Runtime refuses an invalid ambient condition before it listens', async () => {
    const runtimeRoot = await mkdtemp(path.join(os.tmpdir(), 'operator-condition-runtime-'));
    roots.push(runtimeRoot);
    const port = await freePort();
    const baseUrl = `http://127.0.0.1:${port}`;
    const runtimeEnv = (extra) => ({
      ...process.env,
      API_PORT: String(port), SERVE_WEB: 'false',
      OPERATOR_DATA_DIR: path.join(runtimeRoot, 'data'), OPERATOR_RUNTIME_DIR: path.join(runtimeRoot, 'runtime'),
      OPERATOR_RUNTIME_MODE: 'reference-fixture', OPERATOR_AUTO_TICK: '0',
      OPERATOR_RUNTIME_OWNER_PID: String(process.pid), OPERATOR_HARDWARE_DISABLED: '1',
      OPERATOR_TEST_BACKEND: 'local-c500', OPERATOR_LOCAL_C500_MOCK: '1', OPERATOR_LOCAL_C500_SIMULATION: '1',
      OPERATOR_LOCAL_C500_DIR: path.join(runtimeRoot, 'tasks'),
      ...extra,
    });
    const launch = async (extra) => {
      const child = spawn(process.execPath, ['client-runtime/local-server.mjs'], {
        cwd: path.resolve(import.meta.dirname, '..'), windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'],
        env: runtimeEnv(extra),
      });
      let stderr = '';
      child.stderr.on('data', (chunk) => { stderr += chunk; });
      return {
        child,
        stderr: () => stderr,
        healthy: async () => {
          for (let attempt = 0; attempt < 120; attempt += 1) {
            if (child.exitCode != null) return false;
            if (await reachable(`${baseUrl}/api/health`)) return true;
            await sleep(100);
          }
          return false;
        },
        stop: async () => {
          if (child.exitCode != null) return;
          const exited = new Promise((resolve) => child.once('exit', resolve));
          child.kill('SIGTERM');
          await Promise.race([exited, sleep(5000)]);
        },
      };
    };
    // Control: without an invalid ambient condition the same isolated Runtime is healthy,
    // so the rejection below is the condition guard and not a startup failure.
    const valid = await launch({ OPERATOR_EXPERIENCE_CONDITION: 'local-and-wiki' });
    try {
      assert.equal(await valid.healthy(), true, `the isolated Runtime must become healthy: ${valid.stderr()}`);
    } finally {
      await valid.stop();
    }
    const invalid = await launch({ OPERATOR_EXPERIENCE_CONDITION: 'not-a-condition' });
    try {
      const becameHealthy = await invalid.healthy();
      if (becameHealthy) {
        await invalid.stop();
        assert.fail('an invalid OPERATOR_EXPERIENCE_CONDITION must fail before listening');
      }
      assert.notEqual(invalid.child.exitCode, 0, `an invalid ambient condition must exit non-zero: ${invalid.stderr()}`);
    } finally {
      await invalid.stop();
    }
  });
} finally {
  for (const root of roots) await rm(root, { recursive: true, force: true }).catch(() => {});
}

console.log(`Experience condition runtime: ${passed} cases passed, ${failed} failed.`);
if (failed > 0) process.exitCode = 1;
