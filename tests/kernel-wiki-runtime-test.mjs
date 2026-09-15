// Independent acceptance matrix for PHASE3_WIKI_CONTRACT.md section C (and the
// prepare/prompt half of section D): production HTTP import into an isolated
// Runtime, and the production prepare -> frozen context -> FINAL prompt
// composition (round-experience service + D selection + experience formatter +
// candidate prompt builder).
//
// The Runtime is a real child process with its own temporary OPERATOR_DATA_DIR /
// OPERATOR_RUNTIME_DIR, hardware disabled and the local C500 backend mocked, so
// no provider, model, network, Python or GPU is ever contacted. The apply path
// uses the real experience repository and the real application services. The
// Project is registered explicitly through the production createProject API on a
// legal seed state; the seed state itself owns no Project registry.
//
// Written before the parallel C candidate was combined: until the combination
// provides the production import route/service and the D-aware prepare path this
// file can only be syntax-checked, and the author phase runs `node --check` only.
// A green run after combination is contract/integration evidence for the frozen
// interface, never a stability, publishability or selection-benefit claim.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { request as openHttpRequest } from 'node:http';
import { mkdtemp, readFile, readdir, rm, mkdir } from 'node:fs/promises';
import { createServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { createExperienceRepository } from '../client-runtime/experience-repository.mjs';
import { createExperienceService } from '../client-runtime/application/experience-service.mjs';
import { createRoundExperienceService } from '../client-runtime/application/round-experience-service.mjs';
import { createAgentCommands } from '../client-runtime/application/agent-commands.mjs';
import { formatExperienceContext, validateExperienceContext, EXPERIENCE_LIMITS } from '../client-runtime/experience-contract.mjs';
import { buildKernelWikiSnapshot } from '../client-runtime/kernel-wiki-import.mjs';
import { WIKI_SELECTION_POLICY_VERSION } from '../client-runtime/experience-selection.mjs';
import { buildCandidateGenerationPrompt } from '../client-runtime/candidate-generation/prompt.mjs';
import { selectRoundFactsForPrompt, ROUND_FACTS_SCHEMA_VERSION } from '../client-runtime/mission-project-state.mjs';
import { ROUND_BUDGET_MS } from '../client-runtime/round-budget-contract.mjs';

const CONTRACT_SHA = 'b6b4301f15e8ce6955a56776690643ce5db369e6';
const ROUND_ID = 'mission-1:round:1';
const PROJECT = 'project-1';
const INFRA_TOKEN = 'INFRA-XID-999-driver-crash';
const OPERATOR_TOKEN = 'tail-mask-mismatch';
const root = await mkdtemp(path.join(os.tmpdir(), 'operator-wiki-runtime-'));
const dataDir = path.join(root, 'data');
const runtimeDir = path.join(root, 'runtime');
const experienceStorePath = path.join(runtimeDir, 'experiences', 'experiences.json');
const stateFilePath = path.join(dataDir, 'mock-db.json');
Object.assign(process.env, { OPERATOR_DATA_DIR: dataDir, OPERATOR_RUNTIME_DIR: runtimeDir, OPERATOR_RUNTIME_MODE: 'reference-fixture' });
// Imported after the storage environment is fixed: the store resolves its paths
// at module scope, and the seeded state must land in this isolated Runtime.
const { createSeedState, saveState, createProject } = await import('../client-runtime/state-store.mjs');
let passed = 0;
let failed = 0;
// Every independent case is isolated: a failure is reported with its own name and
// stack, and the remaining cases still run so one combination collects every
// error instead of only the first. Any failed case makes the file exit
// non-zero, so a partial run is never reported as green.
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
// A rejected operation must fail for its own rule with an explicit domain error
// code, never with an unrelated TypeError or an assertion raised by a broken
// fixture. Codes the frozen contracts already name are asserted exactly.
const codedFailure = (error) => {
  assert.ok(error instanceof Error, `a rejected operation must throw an Error, saw ${String(error)}`);
  assert.match(String(error?.code ?? ''), /^[A-Z][A-Z0-9_]+$/u, `a rejected operation must carry an explicit domain error code, saw ${JSON.stringify(error?.code)}`);
  return true;
};
const targetInvalid = (error) => {
  assert.equal(error?.code, 'ROUND_EXPERIENCE_TARGET_INVALID', `expected ROUND_EXPERIENCE_TARGET_INVALID, saw ${JSON.stringify(error?.code)}`);
  return true;
};
const startedAt = '2026-09-15T08:00:00.000Z';
const clock = Date.parse(startedAt);
// The apply wrapper returns the transaction result. Whether the application
// service exposes the pure `{changed,result}` envelope or its `result` is not
// separately frozen; the frozen facts are the counts and the store it leaves.
const resultOf = (value) => (value && typeof value === 'object' && value.result && typeof value.result === 'object' ? value.result : value);

// --- source pages, built by the pure importer API ---
const sourcePage = ({ id, title, type = 'technique', tags = [], symptoms = [], techniques = [], architectures = [], body = 'Reviewed guidance body.' }) => ({
  path: `wiki/techniques/${id}.md`,
  text: [
    '---',
    `id: ${id}`,
    `title: "${title}"`,
    `type: ${type}`,
    `tags: [${tags.map((tag) => `"${tag}"`).join(', ')}]`,
    'symptoms:',
    ...(symptoms.length ? symptoms.map((value) => `  - ${value}`) : ['  - none-recorded']),
    'candidate_techniques:',
    ...(techniques.length ? techniques.map((value) => `  - ${value}`) : []),
    'architectures:',
    ...(architectures.length ? architectures.map((value) => `  - ${value}`) : []),
    'performance_claims:',
    '  speedup: "9.9x"',
    '  nested:',
    '    note: "upstream marketing, never evidence"',
    '---',
    '',
    body,
    '',
  ].join('\n'),
});
const snapshotFor = (pages, reviews = []) => buildKernelWikiSnapshot({ pages, sourceCommit: CONTRACT_SHA, reviews });
const coveragePage = (body = 'Mask the final partial block instead of padding the whole tensor.') => sourcePage({
  id: 'tail-handling', title: 'Tail handling guidance', tags: ['vectorization'],
  symptoms: ['tail-effect'], techniques: ['masked-tail-loop'], architectures: ['sm86'], body,
});
const architectureReview = (pageId) => ({
  pageId, reviewId: `review-sm86-${pageId}`, mode: 'architecture-specific',
  hardware: ['nvidia-gpu'], architectures: ['sm86'], requiredCapabilities: [], software: [],
});

// --- production round-facts snapshot for the current Mission and Round ---
const roundFacts = (failure) => ({
  schemaVersion: ROUND_FACTS_SCHEMA_VERSION,
  recordedAt: startedAt,
  target: { missionId: 'mission-1', projectId: PROJECT, roundId: ROUND_ID, roundNumber: 1 },
  previous: { missionId: 'mission-1', projectId: PROJECT, runId: 'run-previous', roundId: ROUND_ID, roundIdSource: 'run' },
  candidate: { id: 'candidate-previous', digest: 'a'.repeat(64), title: 'CANDIDATE-TITLE-TOKEN', direction: 'CANDIDATE-DIRECTION-TOKEN', files: ['run.py'], degraded: false },
  correctness: { status: 'failed', passedCases: 7, failedCases: 2, summary: 'CORRECTNESS-SUMMARY-TOKEN' },
  failure,
  gate: { passed: false, result: 'failed', publishable: false, failedRules: ['GATE-RULE-TOKEN'], summary: 'GATE-SUMMARY-TOKEN' },
  decision: { status: 'resolved', outcome: 'DECISION-OUTCOME-TOKEN' },
  rollback: { status: 'ROLLBACK-STATUS-TOKEN' },
  currentBest: { candidateId: 'candidate-best', version: 'v3', value: 'CURRENT-BEST-VALUE-TOKEN', improvement: '+4%', status: 'stable' },
});
const MANDATORY_TOKENS = ['CANDIDATE-TITLE-TOKEN', 'CANDIDATE-DIRECTION-TOKEN', 'CORRECTNESS-SUMMARY-TOKEN', 'GATE-SUMMARY-TOKEN', 'DECISION-OUTCOME-TOKEN', 'ROLLBACK-STATUS-TOKEN', 'CURRENT-BEST-VALUE-TOKEN', 'run-previous'];
const operatorFailure = () => ({ classification: 'operator', code: OPERATOR_TOKEN, message: 'Masked tail block produced wrong results', source: 'failureRecords' });
const infrastructureFailure = () => ({ classification: 'infrastructure', code: INFRA_TOKEN, message: 'CUDA driver crashed before execution', source: 'benchmark.lastServiceError' });

const missionState = ({ failure = operatorFailure(), resolvedHardware = ['nvidia-gpu'], resolvedArchitecture = ['sm86'] } = {}) => ({
  schemaVersion: 7,
  activeMissionId: 'mission-1',
  activeProjectId: PROJECT,
  projects: [{ id: PROJECT, name: 'Project One' }],
  missions: [{
    id: 'mission-1', projectId: PROJECT, goal: 'Reduce vector_add tail latency; symptom: tail-effect; technique: masked-tail-loop',
    hardware: ['nvidia-gpu'], architecture: ['sm86'], tags: [], operator: 'vector_add', metric: 'latency',
  }],
  iterationStats: {
    round: 0,
    // A complete, valid active round budget: identity, clock and budget size must
    // all match the frozen contract or admission fails before selection runs.
    roundBudget: { roundId: ROUND_ID, roundNumber: 1, startedAt, deadlineAt: new Date(clock + ROUND_BUDGET_MS).toISOString(), budgetMs: ROUND_BUDGET_MS, status: 'active' },
    resolvedTarget: { missionId: 'mission-1', hardware: resolvedHardware, architecture: resolvedArchitecture },
    roundFacts: roundFacts(failure),
  },
  benchmark: { status: 'idle' },
  runtimeEvents: [],
  runHistory: [],
  workflowRecovery: {},
  decisionReview: { status: 'idle' },
  currentBest: {},
  agent: {},
});
const missionOf = (state) => state.missions[0];
const roundServiceFor = (experienceService, overrides = {}) => createRoundExperienceService({
  experienceService,
  resolveAccess: ({ mission }) => ({ projectId: mission.projectId, allowedProjectIds: [] }),
  verifyObservationEvidence: async () => ({ verified: false, code: 'EXPERIENCE_EVIDENCE_UNVERIFIED' }),
  timers: { setTimeout, clearTimeout },
  ...overrides,
});
const createStore = async (name) => {
  const rootDir = path.join(root, name);
  await mkdir(rootDir, { recursive: true });
  return { rootDir, repository: createExperienceRepository({ rootDir }), file: path.join(rootDir, 'experiences.json') };
};
const serviceFor = (repository) => createExperienceService({ repository, now: () => new Date(clock).toISOString(), createId: (() => { let index = 0; return () => `EXP-${++index}`; })() });
const createLocalObservation = (experienceService, title, content) => experienceService.create({
  projectId: PROJECT, visibility: 'project', title, content, author: 'engineer',
  scope: { hardware: ['nvidia-gpu'], architecture: ['sm86'] },
});
// Mirrors the production composition in agent-runtime (selectRoundFactsForPrompt
// -> iterationContext projection -> buildCandidateGenerationPrompt) with the
// production experience formatter as experienceInstruction. The formatter
// identity always comes from the frozen context, never a hardcoded round.
const finalPrompt = (state, mission, context) => {
  const facts = selectRoundFactsForPrompt(state, mission);
  const promptMission = facts ? { ...mission, iterationContext: facts } : mission;
  return buildCandidateGenerationPrompt({
    mission: promptMission,
    goal: mission.goal,
    workspace: path.join(root, 'workspace-mission-1'),
    baseline: {},
    testMatrix: {},
    workspaceInventory: ['run.py'],
    experienceInstruction: context ? formatExperienceContext(context, { projectId: mission.projectId, missionId: mission.id, roundId: context.roundId }) : '',
    boundaryInstruction: '',
  });
};
const untrustedBlockOf = (prompt) => {
  const begin = '----- BEGIN UNTRUSTED EXPERIENCE DATA -----';
  const end = '----- END UNTRUSTED EXPERIENCE DATA -----';
  const start = prompt.indexOf(begin);
  const stop = prompt.indexOf(end);
  assert.ok(start >= 0 && stop > start, 'the production formatter always emits its untrusted data block');
  return { text: prompt.slice(start + begin.length, stop).trim(), outside: prompt.slice(0, start) + prompt.slice(stop + end.length) };
};
const available = async (url) => { try { const response = await fetch(url); return response.ok; } catch { return false; } };
const childEnv = (port, extra = {}) => ({
  ...process.env, API_PORT: String(port), SERVE_WEB: 'false',
  OPERATOR_AUTO_TICK: '0', OPERATOR_RUNTIME_OWNER_PID: String(process.pid),
  OPERATOR_HARDWARE_DISABLED: '1', OPERATOR_TEST_BACKEND: 'local-c500',
  OPERATOR_LOCAL_C500_MOCK: '1', OPERATOR_LOCAL_C500_SIMULATION: '1',
  OPERATOR_LOCAL_C500_DIR: path.join(root, 'tasks'), ...extra,
});

try {
  await test('the production HTTP route imports a snapshot into an isolated Runtime exactly once', async () => {
    const socket = createServer();
    await new Promise((resolve) => socket.listen(0, '127.0.0.1', resolve));
    const port = socket.address().port;
    await new Promise((resolve) => socket.close(resolve));
    const baseUrl = `http://127.0.0.1:${port}`;
    let child = null;
    let stderr = '';
    const stop = async () => {
      if (!child || child.exitCode != null) return;
      const exited = new Promise((resolve) => child.once('exit', resolve));
      child.kill('SIGTERM');
      await Promise.race([exited, sleep(5000).then(() => { if (child.exitCode == null) throw new Error('Runtime did not stop'); })]);
    };
    const api = async (route, options = {}) => {
      const response = await fetch(baseUrl + route, options);
      const text = await response.text();
      return { status: response.status, body: text ? JSON.parse(text) : null };
    };
    try {
      // The Runtime owns an explicitly registered, isolated Project. The seed
      // state has no Project registry of its own, so the production Project API
      // is the only way to obtain a legal owning Project for the import route.
      const seeded = createSeedState();
      assert.equal(Array.isArray(seeded.projects), false, 'the seed state owns no Project registry');
      const projectRoot = path.join(root, 'project-one');
      await mkdir(projectRoot, { recursive: true });
      const project = createProject(seeded, { name: 'Phase3 Isolated Project', repository: projectRoot, root: projectRoot });
      assert.equal(typeof project.id, 'string');
      assert.ok(project.id.length > 0);
      await saveState(seeded);
      const projectId = project.id;
      const experiences = `/api/projects/${encodeURIComponent(projectId)}/experiences`;
      child = spawn(process.execPath, ['client-runtime/local-server.mjs'], {
        cwd: path.resolve(import.meta.dirname, '..'), windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'],
        env: childEnv(port),
      });
      child.stderr.on('data', (chunk) => { stderr += chunk; });
      let healthy = false;
      for (let attempt = 0; attempt < 150; attempt += 1) {
        assert.equal(child.exitCode, null, stderr);
        if (await available(`${baseUrl}/api/health`)) { healthy = true; break; }
        await sleep(100);
      }
      assert.equal(healthy, true, `the isolated Runtime must become healthy: ${stderr}`);
      // Captured after startup so a startup-side snapshot rewrite cannot be
      // mistaken for an import side effect.
      const stateBeforeImport = await readFile(stateFilePath, 'utf8');
      const snapshot = snapshotFor([coveragePage()], [architectureReview('tail-handling')]);
      const importRoute = `${experiences}/import-kernel-wiki`;
      const post = (body) => api(importRoute, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

      const created = await post({ snapshot, author: 'phase3-d' });
      assert.equal(created.status, 200, JSON.stringify(created.body));
      // The route payload is the apply result itself; it has no `changed` wrapper.
      assert.equal(Object.hasOwn(created.body, 'changed'), false, 'the import payload is the apply result without a changed envelope');
      assert.equal(created.body.created, 1, JSON.stringify(created.body));
      assert.equal(created.body.updated, 0);
      assert.equal(created.body.unchanged, 0);
      assert.equal(created.body.sourceCommit, CONTRACT_SHA);
      assert.equal(created.body.snapshotDigest, snapshot.snapshotDigest);
      assert.equal(created.body.records.length, 1);
      for (const record of created.body.records) {
        assert.equal(typeof record.id, 'string');
        assert.equal(record.version, 1);
        assert.ok(record.id.length <= 160);
      }
      const revisionAfterFirst = JSON.parse(await readFile(experienceStorePath, 'utf8')).revision;
      assert.ok(revisionAfterFirst >= 1, 'a changed import advances the repository revision');
      const bytesAfterFirst = await readFile(experienceStorePath, 'utf8');

      const repeated = await post({ snapshot, author: 'phase3-d' });
      assert.equal(repeated.status, 200);
      assert.equal(Object.hasOwn(repeated.body, 'changed'), false);
      assert.equal(repeated.body.created, 0, 'an identical import creates nothing');
      assert.equal(repeated.body.updated, 0, 'an identical import updates nothing');
      assert.equal(repeated.body.unchanged, 1, 'an identical import reports the unchanged unit');
      assert.deepEqual(repeated.body.records, created.body.records);
      assert.equal(await readFile(experienceStorePath, 'utf8'), bytesAfterFirst, 'an identical import does not rewrite the store');
      assert.equal(JSON.parse(bytesAfterFirst).revision, revisionAfterFirst, 'an identical import keeps the repository revision');

      // A changed page advances the same stable unit ID instead of duplicating it.
      const revised = await post({ snapshot: snapshotFor([coveragePage('Revised tail guidance body.')], [architectureReview('tail-handling')]), author: 'phase3-d' });
      assert.equal(revised.status, 200, JSON.stringify(revised.body));
      assert.equal(revised.body.created, 0, 'a revised page keeps its stable ID');
      assert.equal(revised.body.updated, 1);
      assert.equal(revised.body.unchanged, 0);
      assert.equal(revised.body.records[0].id, created.body.records[0].id);
      assert.equal(revised.body.records[0].version, 2);
      const storeAfterChange = JSON.parse(await readFile(experienceStorePath, 'utf8'));
      assert.equal(storeAfterChange.revision, revisionAfterFirst + 1, 'a changed import advances the revision once');
      assert.equal(storeAfterChange.records.filter((record) => record.id === created.body.records[0].id).length, 2, 'the old version is kept as history');
      const bytesAfterChange = await readFile(experienceStorePath, 'utf8');

      const listed = await api(experiences);
      assert.equal(listed.status, 200);
      assert.equal(listed.body.experiences.length, 1, 'history is not listed as duplicate heads');
      for (const record of listed.body.experiences) {
        assert.equal(record.verification.publishable, false, 'an imported page is never publishable evidence');
        assert.equal(record.verification.status, 'unverified');
        assert.equal(record.source, 'human');
        assert.equal(record.kind, 'guidance');
        assert.deepEqual(record.scope.tags, [], 'raw topics never become scope tags');
      }
      assert.equal(JSON.stringify(listed.body).includes('9.9x'), false, 'upstream performance claims never enter the store');

      const single = await api(`${experiences}/${encodeURIComponent(created.body.records[0].id)}`);
      assert.equal(single.status, 200);
      assert.ok(single.body.experience);
      assert.equal((await api(importRoute)).status !== 200, true, 'GET must not run an import');
      assert.equal(await readFile(experienceStorePath, 'utf8'), bytesAfterChange, 'no write on GET');
      assert.deepEqual((await readdir(path.join(runtimeDir, 'experiences'))).sort(), ['experiences.json'], 'no side-index storage is created');

      const unknownProject = await api('/api/projects/does-not-exist/experiences/import-kernel-wiki', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ snapshot, author: 'phase3-d' }),
      });
      assert.equal(unknownProject.status, 404);
      assert.equal(unknownProject.body.code, 'EXPERIENCE_PROJECT_NOT_FOUND');
      const forged = await post({ snapshot, author: 'phase3-d', projectId: 'other-project' });
      assert.equal(forged.status, 400, 'the import body accepts only {snapshot,author}');
      assert.equal(forged.body.code, 'EXPERIENCE_INVALID');
      const tampered = await post({ snapshot: { ...snapshot, snapshotDigest: 'f'.repeat(64) }, author: 'phase3-d' });
      assert.notEqual(tampered.status, 200, 'a tampered envelope digest must be rejected before any store change');
      assert.equal(await readFile(experienceStorePath, 'utf8'), bytesAfterChange, 'rejected imports write nothing');
      assert.equal(await readFile(stateFilePath, 'utf8'), stateBeforeImport, 'import never mutates Runtime state');

      // The Runtime retains its bounded request body: an oversized body is refused
      // (413) or aborted, and never reaches the importer.
      const oversized = await new Promise((resolve) => {
        const request = openHttpRequest(`${baseUrl}${importRoute}`, { method: 'POST', headers: { 'Content-Type': 'application/json' } }, (response) => {
          response.resume();
          response.on('end', () => resolve({ status: response.statusCode }));
        });
        request.on('error', (error) => resolve({ error: error.code || error.message }));
        request.end(JSON.stringify({ snapshot: { padding: 'x'.repeat(1_200_000) }, author: 'phase3-d' }));
      });
      assert.ok(oversized.status === 413 || oversized.error, `oversized body must be refused: ${JSON.stringify(oversized)}`);
      assert.equal(await available(`${baseUrl}/api/health`), true, 'the Runtime survives an oversized request');
      assert.equal(await readFile(experienceStorePath, 'utf8'), bytesAfterChange, 'an oversized request writes nothing');
      console.log(`[kernel-wiki-runtime] HTTP import: bytes after change ${Buffer.byteLength(bytesAfterChange, 'utf8')}`);
    } finally {
      await stop();
    }
  });

  await test('production prepare freezes a D selection and the FINAL prompt carries complete mandatory facts', async () => {
    const { repository, file } = await createStore('prepare');
    const experienceService = serviceFor(repository);
    const snapshot = snapshotFor([coveragePage()], [architectureReview('tail-handling')]);
    const imported = resultOf(await experienceService.importKernelWiki(snapshot, { projectId: PROJECT, author: 'phase3-d' }));
    assert.equal(imported.created, 1);
    assert.equal(imported.updated, 0);
    const revisionAfterImport = JSON.parse(await readFile(file, 'utf8')).revision;
    const repeated = resultOf(await experienceService.importKernelWiki(snapshot, { projectId: PROJECT, author: 'phase3-d' }));
    assert.equal(repeated.created, 0);
    assert.equal(repeated.unchanged, 1, 'the application wrapper reports an identical import as unchanged');
    assert.equal(JSON.parse(await readFile(file, 'utf8')).revision, revisionAfterImport, 'the application wrapper keeps the repository revision for a no-op');
    await createLocalObservation(experienceService, 'Local tail observation', 'The masked tail path previously produced mismatched values.');

    const roundExperience = roundServiceFor(experienceService);
    const state = missionState();
    const mission = missionOf(state);
    const context = await roundExperience.prepare({ state, mission, roundId: ROUND_ID });
    validateExperienceContext(context);
    assert.equal(context.roundId, ROUND_ID);
    assert.ok(context.items.length >= 1, 'the current-project observation is selected');
    assert.ok(context.items.length <= EXPERIENCE_LIMITS.contextItems);
    const selection = state.iterationStats.roundExperienceSelection;
    assert.equal(selection.policyVersion, WIKI_SELECTION_POLICY_VERSION, 'prepare records the D strategy version');
    assert.equal(selection.roundId, ROUND_ID);
    assert.equal(selection.contextId, context.contextId);
    assert.equal(selection.selected.length, context.items.length, 'the audit aligns with the frozen context');
    assert.ok(Array.isArray(selection.features) && selection.features.length <= 8, 'at most 8 explicit features are recorded');
    assert.ok(selection.features.length >= 1, 'the goal yields at least one explicit feature');
    for (const feature of selection.features) {
      assert.deepEqual(Object.keys(feature).sort(), ['basis', 'kind', 'value'], 'a feature is an explicit hypothesis, never a measurement');
      assert.ok(['structure', 'failure', 'symptom', 'technique'].includes(feature.kind));
      assert.equal(typeof feature.value, 'string');
      assert.ok(feature.basis.length > 0 && feature.basis.length <= 1000);
      assert.equal(!/\d+(\.\d+)?\s*%/.test(feature.basis), true, 'no numeric bottleneck claim is invented');
    }
    const considered = new Set([...selection.selected.map((item) => item.id), ...(selection.excluded ?? []).map((item) => item.id)]);
    for (const item of context.items) assert.ok(considered.has(item.id));
    assert.ok(Number.isFinite(selection.renderedBytes) && selection.renderedBytes > 0, 'actual rendered bytes are recorded');
    assert.equal(selection.renderedBytes, Buffer.byteLength(formatExperienceContext(context, { projectId: PROJECT, missionId: mission.id, roundId: context.roundId }), 'utf8'), 'rendered bytes are measured, not estimated');
    assert.ok(selection.renderedBytes <= 24 * 1024, `the soft 24 KiB budget holds, saw ${selection.renderedBytes}`);
    // Wiki units present in the context must be architecture-qualified provenance.
    for (const item of context.items.filter((entry) => entry.selectionMetadata)) {
      assert.equal(item.selectionMetadata.source, 'kernel-wiki');
      assert.ok(item.selectionMetadata.applicability.architectures.includes('sm86'), 'only architecture-qualified units are injected');
    }

    const prompt = finalPrompt(state, mission, context);
    for (const token of MANDATORY_TOKENS) assert.ok(prompt.includes(token), `the FINAL prompt carries the mandatory round fact ${token}`);
    assert.ok(prompt.includes('----- BEGIN MISSION ITERATION CONTEXT -----'));
    const block = untrustedBlockOf(prompt);
    for (const token of MANDATORY_TOKENS) assert.equal(block.text.includes(token), false, `a mandatory fact never moves inside the untrusted experience block: ${token}`);
    assert.equal(JSON.parse(block.text).contextId, context.contextId, 'the prompt embeds the frozen context itself');

    // Same round: the frozen context and its selection survive a retry unchanged.
    const before = JSON.stringify({ context: state.iterationStats.roundExperience, selection });
    const retried = await roundExperience.prepare({ state, mission, roundId: ROUND_ID });
    assert.equal(retried.contextId, context.contextId, 'a same-round retry reuses the frozen context');
    assert.equal(JSON.stringify({ context: state.iterationStats.roundExperience, selection: state.iterationStats.roundExperienceSelection }), before, 'a same-round retry neither reselects nor restamps the legacy policy version');

    // A fresh logical round reselects against the current repository.
    await createLocalObservation(experienceService, 'Newer tail observation', 'A newer observation for the next logical round.');
    const nextRound = 'mission-1:round:2';
    state.iterationStats = { ...state.iterationStats, roundBudget: { ...state.iterationStats.roundBudget, roundId: nextRound, roundNumber: 2 }, roundFacts: { ...state.iterationStats.roundFacts, target: { ...state.iterationStats.roundFacts.target, roundId: nextRound } } };
    const refreshed = await roundExperience.prepare({ state, mission, roundId: nextRound });
    assert.notEqual(refreshed.contextId, context.contextId, 'a fresh logical round reselects');
    assert.equal(state.iterationStats.roundExperienceSelection.roundId, nextRound);
    assert.equal(state.iterationStats.roundExperienceSelection.policyVersion, WIKI_SELECTION_POLICY_VERSION);
    assert.ok(refreshed.items.some((item) => item.title === 'Newer tail observation'), 'the new round sees the newer record');
    const refreshedPrompt = finalPrompt(state, mission, refreshed);
    for (const token of MANDATORY_TOKENS) assert.ok(refreshedPrompt.includes(token), `the refreshed FINAL prompt keeps ${token}`);
  });

  await test('all-Wiki-zero keeps the complete mandatory facts in the FINAL assembled prompt', async () => {
    const { repository } = await createStore('zero-wiki');
    const experienceService = serviceFor(repository);
    const roundExperience = roundServiceFor(experienceService);
    const state = missionState();
    const mission = missionOf(state);
    const context = await roundExperience.prepare({ state, mission, roundId: ROUND_ID });
    assert.deepEqual(context.items, [], 'an empty repository yields no experience items');
    const prompt = finalPrompt(state, mission, context);
    for (const token of MANDATORY_TOKENS) assert.ok(prompt.includes(token), `mandatory fact ${token} survives a zero-experience round`);
    // The production formatter always emits its untrusted block; an empty
    // selection therefore renders an explicitly empty data block, and the
    // mandatory round facts stay outside it.
    const block = untrustedBlockOf(prompt);
    assert.deepEqual(JSON.parse(block.text).items, [], 'the zero-selection block is empty, not absent');
    for (const token of MANDATORY_TOKENS) assert.ok(block.outside.includes(token), `mandatory fact ${token} lives outside the untrusted block`);
    assert.equal(JSON.stringify(context).includes('9.9x'), false);

    // A hardware-inapplicable page is retained in the store and still excluded.
    const snapshot = snapshotFor([sourcePage({ id: 'sm100-only', title: 'sm100 only page', tags: ['vectorization'], symptoms: ['tail-effect'], architectures: ['sm100'] })], [{
      pageId: 'sm100-only', reviewId: 'review-sm100', mode: 'architecture-specific',
      hardware: ['nvidia-gpu'], architectures: ['sm100'], requiredCapabilities: [], software: [],
    }]);
    const imported = resultOf(await experienceService.importKernelWiki(snapshot, { projectId: PROJECT, author: 'phase3-d' }));
    assert.equal(imported.created, 1);
    assert.equal((await experienceService.read(null, { projectId: PROJECT })).experiences.length, 1, 'an inapplicable page is retained');
    const second = await roundExperience.prepare({ state: { ...state, iterationStats: { ...state.iterationStats, roundExperience: null, roundExperienceSelection: null } }, mission, roundId: ROUND_ID });
    assert.deepEqual(second.items, [], 'sm100 content is never injected for an sm86 target');
  });

  await test('an infrastructure failure never becomes an operator symptom and a backend target is rejected', async () => {
    const { repository } = await createStore('classification');
    const experienceService = serviceFor(repository);
    const roundExperience = roundServiceFor(experienceService);
    const infrastructure = missionState({ failure: infrastructureFailure() });
    const infrastructureContext = await roundExperience.prepare({ state: infrastructure, mission: missionOf(infrastructure), roundId: ROUND_ID });
    validateExperienceContext(infrastructureContext);
    const infraSelection = infrastructure.iterationStats.roundExperienceSelection;
    assert.equal(JSON.stringify(infraSelection.features ?? []).includes(INFRA_TOKEN), false, 'an infrastructure/provider failure is not turned into an optimization feature');
    const operator = missionState({ failure: operatorFailure() });
    const operatorContext = await roundExperience.prepare({ state: operator, mission: missionOf(operator), roundId: ROUND_ID });
    validateExperienceContext(operatorContext);
    const operatorSelection = operator.iterationStats.roundExperienceSelection;
    assert.ok(Array.isArray(operatorSelection.features));
    assert.ok(operatorSelection.features.length >= 1, 'an operator failure still yields at least one explicit hypothesis');
    assert.notDeepEqual(operatorSelection.features, infraSelection.features, 'an operator failure is treated differently from an infrastructure failure');

    // Backend-as-hardware stays an explicit target error instead of a silent lookup.
    const backend = missionState({ resolvedHardware: ['local-c500'] });
    await assert.rejects(roundExperience.prepare({ state: backend, mission: missionOf(backend), roundId: ROUND_ID }), targetInvalid, 'a resolved backend is not a hardware target');
    assert.equal(backend.iterationStats.roundExperience, undefined, 'a rejected target stores no frozen context');
    const backendName = missionState();
    backendName.missions[0].hardware = ['local-c500'];
    delete backendName.iterationStats.resolvedTarget;
    await assert.rejects(roundExperience.prepare({ state: backendName, mission: missionOf(backendName), roundId: ROUND_ID }), targetInvalid, 'an unresolved backend name is not a hardware target either');
  });

  await test('a retrieve-only legacy port still prepares, and a selection error blocks the dependent start', async () => {
    const { repository } = await createStore('legacy-port');
    const experienceService = serviceFor(repository);
    await createLocalObservation(experienceService, 'Legacy local guidance', 'Bound legacy guidance for the current project.');
    const legacyPort = Object.freeze({
      retrieve: (query, options) => experienceService.retrieve(query, options),
      recordObservation: (input, options) => experienceService.recordObservation(input, options),
    });
    const legacyRound = roundServiceFor(legacyPort);
    const legacyState = missionState();
    const context = await legacyRound.prepare({ state: legacyState, mission: missionOf(legacyState), roundId: ROUND_ID });
    assert.equal(context.items.length, 1, 'a retrieve-only port keeps working without additional arguments');
    const legacySelection = legacyState.iterationStats.roundExperienceSelection;
    assert.equal(legacySelection.auditSource, 'context-derived');
    assert.equal(legacySelection.exclusionReasonsRecorded, false, 'a legacy port never invents exclusion reasons');
    assert.deepEqual(legacySelection.excluded, []);

    // A failing selection must block the dependent Agent start instead of silently
    // injecting no knowledge.
    const failingRound = roundServiceFor({
      retrieve: (query, options) => experienceService.retrieve(query, options),
      retrieveWithSelection: async () => { throw Object.assign(new Error('selection unavailable'), { code: 'ROUND_EXPERIENCE_FAILED', status: 409 }); },
      recordObservation: (input, options) => experienceService.recordObservation(input, options),
    });
    let launches = 0;
    const commands = createAgentCommands({
      agentRuntime: {
        describe: async () => ({ mode: 'codex-cli' }),
        startRun: async (input) => { launches += 1; input.state.agent = { runId: 'run-1', status: 'running' }; return { handled: true, state: input.state }; },
      },
      roundExperience: failingRound,
      now: () => new Date(clock),
      isManagedWorkspaceRuntimeMode: () => true,
      resetMissionRunState: (value) => { value.agent = {}; value.stage = 'diagnosis'; },
      createWorkspaceCheckpoint: async () => ({ id: 'checkpoint-1' }),
      appendRuntimeEvent: () => {},
    }).runs;
    const blockedState = missionState();
    const intent = commands.plan({ state: blockedState });
    await assert.rejects(commands.prepare({
      state: blockedState, body: { workspace: path.join(root, 'workspace-mission-1') }, intent,
      recordIntent: async () => {}, runEffect: (effect) => effect(),
    }), (error) => {
      codedFailure(error);
      assert.match(String(error?.message), /selection unavailable/u, 'the selection failure must surface instead of being swallowed');
      return true;
    }, 'a failing selection blocks the dependent Agent start');
    assert.equal(launches, 0, 'a selection failure blocks the dependent start');

    // The same wiring with the real service prepares and hands the frozen context on.
    let captured = null;
    const working = createAgentCommands({
      agentRuntime: {
        describe: async () => ({ mode: 'codex-cli' }),
        startRun: async (input) => { captured = input; input.state.agent = { runId: 'run-1', status: 'running' }; return { handled: true, state: input.state }; },
      },
      roundExperience: roundServiceFor(experienceService),
      now: () => new Date(clock),
      isManagedWorkspaceRuntimeMode: () => true,
      resetMissionRunState: (value) => { value.agent = {}; value.stage = 'diagnosis'; },
      createWorkspaceCheckpoint: async () => ({ id: 'checkpoint-1' }),
      appendRuntimeEvent: () => {},
    }).runs;
    const workingState = missionState();
    const workingIntent = working.plan({ state: workingState });
    const prepared = await working.prepare({
      state: workingState, body: { workspace: path.join(root, 'workspace-mission-1') }, intent: workingIntent,
      recordIntent: async () => {}, runEffect: (effect) => effect(),
    });
    assert.ok(captured.experienceContext, 'the Agent receives the frozen experience context');
    assert.equal(captured.experienceContext.contextId, prepared.payload.roundExperience.contextId);
    assert.equal(prepared.payload.roundExperienceSelection.policyVersion, WIKI_SELECTION_POLICY_VERSION, 'prepare does not stamp the legacy policy version over a D selection');
    assert.ok(prepared.payload.roundExperienceSelection.renderedBytes > 0);
    const prompt = finalPrompt(workingState, missionOf(workingState), prepared.payload.roundExperience);
    for (const token of MANDATORY_TOKENS) assert.ok(prompt.includes(token), `the prepared FINAL prompt carries ${token}`);
    assert.ok(prompt.includes(prepared.payload.roundExperience.contextId));
  });

  await test('prepare follows the latest committed facts and ignores stale, foreign or identity-less ones', async () => {
    // The marker is appended to every fact field a selector could legally read
    // (failure code/message, candidate identity, correctness/gate summaries and
    // the current best value) so the token proves which committed facts were
    // used - while the frozen mandatory tokens stay intact for the prompt check.
    // `runId` is the run that produced this fact set, exactly as the production
    // archive records it: every `previous.runId` is a real, distinct id that also
    // exists as a runHistory entry, never one shared placeholder.
    const marker = (token, runId, recordedAt, overrides = {}) => {
      const facts = roundFacts(operatorFailure());
      return {
        ...facts,
        recordedAt,
        previous: { ...facts.previous, runId },
        candidate: { ...facts.candidate, id: `candidate-${token}`, title: `${facts.candidate.title} ${token}`, direction: `${facts.candidate.direction} ${token}` },
        correctness: { ...facts.correctness, summary: `${facts.correctness.summary} ${token}` },
        gate: { ...facts.gate, summary: `${facts.gate.summary} ${token}` },
        decision: { ...facts.decision, outcome: `${facts.decision.outcome} ${token}` },
        rollback: { status: `${facts.rollback.status} ${token}` },
        currentBest: { ...facts.currentBest, value: `${facts.currentBest.value} ${token}` },
        failure: { classification: 'operator', code: token, message: `${token} failure message`, source: 'failureRecords' },
        ...overrides,
      };
    };
    const base = roundFacts(operatorFailure());
    const { repository } = await createStore('latest-facts');
    const experienceService = serviceFor(repository);
    const roundExperience = roundServiceFor(experienceService);
    const state = missionState();
    const mission = missionOf(state);
    const STALE = 'STALE-COMMITTED-TOKEN';
    const FRESH = 'FRESH-COMMITTED-TOKEN';
    // The iterationStats snapshot is older than the committed run history. The
    // foreign entries are NEWER than the fresh one, so only an identity filter
    // (Mission, Project, previous-Mission) can keep them out of the selection.
    // History is newest-first, like the production archive, and `run-previous` is
    // the run behind the live iterationStats snapshot, so the mandatory
    // `run-previous` fact below still names a committed run.
    state.iterationStats.roundFacts = marker(STALE, 'run-previous', '2026-09-15T07:00:00.000Z');
    state.runHistory = [
      { runId: 'run-foreign-mission', roundId: ROUND_ID, candidateId: 'candidate-FOREIGN-MISSION-TOKEN', candidateDigest: '1'.repeat(64), roundFacts: marker('FOREIGN-MISSION-TOKEN', 'run-foreign-mission', '2026-09-15T07:59:00.000Z', { target: { ...base.target, missionId: 'mission-other' }, previous: { ...base.previous, runId: 'run-foreign-mission', missionId: 'mission-other' } }) },
      { runId: 'run-foreign-project', roundId: ROUND_ID, candidateId: 'candidate-FOREIGN-PROJECT-TOKEN', candidateDigest: '2'.repeat(64), roundFacts: marker('FOREIGN-PROJECT-TOKEN', 'run-foreign-project', '2026-09-15T07:58:00.000Z', { target: { ...base.target, projectId: 'project-other' }, previous: { ...base.previous, runId: 'run-foreign-project', projectId: 'project-other' } }) },
      { runId: 'run-foreign-previous', roundId: ROUND_ID, candidateId: 'candidate-FOREIGN-PREVIOUS-TOKEN', candidateDigest: '3'.repeat(64), roundFacts: marker('FOREIGN-PREVIOUS-TOKEN', 'run-foreign-previous', '2026-09-15T07:57:00.000Z', { previous: { ...base.previous, runId: 'run-foreign-previous', missionId: 'mission-other' } }) },
      { runId: 'run-unknown-identity', roundId: ROUND_ID, candidateId: null, candidateDigest: null, roundFacts: marker('UNKNOWN-IDENTITY-TOKEN', 'run-unknown-identity', '2026-09-15T07:56:00.000Z', { target: {}, previous: {} }) },
      { runId: 'run-fresh', roundId: ROUND_ID, candidateId: `candidate-${FRESH}`, candidateDigest: '4'.repeat(64), roundFacts: marker(FRESH, 'run-fresh', '2026-09-15T07:55:00.000Z') },
      { runId: 'run-previous', roundId: ROUND_ID, candidateId: `candidate-${STALE}`, candidateDigest: '5'.repeat(64), roundFacts: marker(STALE, 'run-previous', '2026-09-15T07:00:00.000Z') },
    ];
    const context = await roundExperience.prepare({ state, mission, roundId: ROUND_ID });
    validateExperienceContext(context);
    const selection = state.iterationStats.roundExperienceSelection;
    assert.equal(selection.policyVersion, WIKI_SELECTION_POLICY_VERSION);
    const features = JSON.stringify(selection.features);
    assert.ok(selection.features.length >= 1, 'the committed facts still yield explicit features');
    assert.equal(features.includes(FRESH), true, `the newest committed same-Mission facts must drive the selection, saw ${features}`);
    // Freshness only orders the same kind of fact; it never erases legal run
    // history. An older committed same-Mission fact may stay, but the freshest one
    // must come first inside its own kind, and the contract still caps each kind.
    for (const kind of ['structure', 'failure', 'symptom', 'technique']) {
      assert.ok(selection.features.filter((feature) => feature.kind === kind).length <= 2, `at most two ${kind} features are recorded`);
    }
    const freshFeature = selection.features.find((feature) => JSON.stringify(feature).includes(FRESH));
    assert.ok(freshFeature, `the fresh committed fact is recorded as a feature, saw ${features}`);
    const sameKind = selection.features.filter((feature) => feature.kind === freshFeature.kind);
    const staleFeature = sameKind.find((feature) => JSON.stringify(feature).includes(STALE));
    if (staleFeature) {
      assert.ok(sameKind.indexOf(staleFeature) > sameKind.indexOf(freshFeature), 'a legal but older committed fact is kept only after the fresher same-kind feature');
    }
    // Foreign and identity-less facts are a different rule: they are never usable
    // input, however new they are.
    for (const token of ['FOREIGN-MISSION-TOKEN', 'FOREIGN-PROJECT-TOKEN', 'FOREIGN-PREVIOUS-TOKEN', 'UNKNOWN-IDENTITY-TOKEN']) {
      assert.equal(features.includes(token), false, `${token} must never become a selection feature`);
    }
    // The prompt still assembles its complete mandatory facts from the same
    // committed round; selection never rewrites them.
    const prompt = finalPrompt(state, mission, context);
    for (const token of MANDATORY_TOKENS) assert.ok(prompt.includes(token), `the FINAL prompt keeps ${token}`);
  });

  await test('an exact completed attempt demotes only its own bound experience and nothing else', async () => {
    // Four fully distinct digests per set: a digest shared between the bound and
    // the control observation would let one repeat claim cover both records.
    const boundDigests = { patchDigest: 'a'.repeat(64), packageDigest: 'b'.repeat(64), environmentDigest: 'c'.repeat(64), acceptanceDigest: 'd'.repeat(64) };
    const controlDigests = { patchDigest: 'e'.repeat(64), packageDigest: 'f'.repeat(64), environmentDigest: '1'.repeat(64), acceptanceDigest: '2'.repeat(64) };
    const unmatchedDigests = { patchDigest: '3'.repeat(64), packageDigest: '4'.repeat(64), environmentDigest: '5'.repeat(64), acceptanceDigest: '6'.repeat(64) };
    const OLD_ROUND = ROUND_ID;
    const NEW_ROUND = 'mission-1:round:2';
    // The attempt that already ran: a real, distinct run/candidate whose exact
    // modification+parameters+conditions are the four digests plus the execution
    // conditions, carried by the stored observation it produced.
    const oldEvidence = (overrides = {}) => ({
      missionId: 'mission-1', candidateId: 'candidate-old', runId: 'run-old',
      ...boundDigests, hardware: 'nvidia-gpu', architecture: 'sm86', executionMode: 'gpu',
      outcome: 'failed', operation: 'benchmark', ...overrides,
    });
    // The attempt the current round runs: a different candidate and run id over
    // the same modification+parameters+conditions. A method or candidate name is
    // not part of the identity, so this is the same attempt.
    const currentEvidence = (digests, overrides = {}) => ({
      missionId: 'mission-1', candidateId: 'candidate-new', runId: 'run-new',
      ...digests, hardware: 'nvidia-gpu', architecture: 'sm86', executionMode: 'gpu',
      outcome: 'failed', operation: 'benchmark', ...overrides,
    });
    const observation = (title, value) => ({
      projectId: PROJECT, visibility: 'project', title, content: `${title}: bound execution observation.`,
      author: 'engineer', scope: { hardware: ['nvidia-gpu'], architecture: ['sm86'] }, evidence: value,
    });
    // A completed attempt, carried consistently in the live benchmark and in the
    // committed run history, exactly like the production archive.
    const attemptOf = (value, status = 'complete') => ({
      status, runId: value?.runId ?? null,
      candidate: { id: value?.candidateId ?? null, digest: value?.patchDigest ?? null },
      result: { experienceEvidence: value ?? null, experienceEvidenceRefs: [] },
    });
    const historyEntry = (runId, value, roundFacts, status = 'complete') => ({
      runId, roundId: OLD_ROUND, candidateId: value?.candidateId ?? null, candidateDigest: value?.patchDigest ?? null,
      benchmark: structuredClone(attemptOf(value, status)), roundFacts: structuredClone(roundFacts),
    });
    // Each scenario gets its own store so an observed order cannot leak between
    // them. The observations are written through the real repository, and the
    // previous round's frozen context is produced by the real legacy retrieval -
    // it is the only place a demotion candidate can come from, so no context is
    // hand-built and no record is invented.
    const prepared = async (name, scenario) => {
      const { repository } = await createStore(name);
      let tick = clock;
      const ids = scenario.ids ?? [];
      let idIndex = 0;
      const experienceService = createExperienceService({
        repository, now: () => new Date(tick).toISOString(),
        createId: () => ids[idIndex++] ?? `EXP-${idIndex}`,
      });
      const created = {};
      for (const record of scenario.records) {
        // recordObservation resolves to `{experience, created}` (frozen by the
        // existing experience tests); only the import wrapper needs resultOf.
        created[record.key] = (await experienceService.recordObservation(observation(record.title, record.evidence))).experience;
        tick += 60_000;
      }
      const previousContext = await experienceService.retrieve({
        projectId: PROJECT, missionId: 'mission-1', roundId: OLD_ROUND,
        scope: { hardware: ['nvidia-gpu'], architecture: ['sm86'] },
      });
      const current = scenario.current;
      const status = scenario.status ?? 'complete';
      const state = missionState();
      state.iterationStats = {
        ...state.iterationStats,
        // The previous logical round froze this context; the current round id
        // differs, so prepare must run a fresh selection instead of reusing it.
        roundExperience: previousContext,
        roundBudget: { ...state.iterationStats.roundBudget, roundId: NEW_ROUND, roundNumber: 2 },
        roundFacts: {
          ...state.iterationStats.roundFacts,
          target: { ...state.iterationStats.roundFacts.target, roundId: NEW_ROUND },
          candidate: { ...state.iterationStats.roundFacts.candidate, id: current?.candidateId ?? null, digest: current?.patchDigest ?? null },
          previous: { ...state.iterationStats.roundFacts.previous, runId: current?.runId ?? null },
        },
      };
      const currentFacts = structuredClone(state.iterationStats.roundFacts);
      // History keeps the attempts that already finished - newest first, one entry
      // per run id, exactly like the production archive. The negative cases change
      // one field of the current attempt only; this evidence is never touched.
      const entries = [
        historyEntry(current?.runId ?? null, current, currentFacts, status),
        historyEntry('run-old', oldEvidence(), structuredClone(state.iterationStats.roundFacts), 'complete'),
      ];
      const seen = new Set();
      state.runHistory = entries.filter((entry) => {
        if (entry.runId === null || seen.has(entry.runId)) return false;
        seen.add(entry.runId);
        return true;
      });
      state.benchmark = structuredClone(attemptOf(current, status));
      const context = await roundServiceFor(experienceService).prepare({ state, mission: missionOf(state), roundId: NEW_ROUND });
      const selection = state.iterationStats.roundExperienceSelection;
      return {
        state, created, context, selection, previousContext,
        order: context.items.map((item) => item.id),
        reasonOf: (record) => selection.selected.find((entry) => entry.id === record.id)?.reason ?? null,
      };
    };
    const records = [
      // The record that may be demoted is created last (strictly newer) and is
      // handed the lower id, so the undemoted order is the same whether the local
      // tier falls back to recency or to the id tie-break.
      { key: 'control', title: 'Unrelated local observation', evidence: { ...oldEvidence(controlDigests), candidateId: 'candidate-control', runId: 'run-control' } },
      { key: 'bound', title: 'Repeated attempt observation', evidence: oldEvidence() },
    ];
    const bound = (label, current, status) => prepared(`repeat-${label}`, { current, status, ids: ['EXP-9', 'EXP-1'], records });

    // Baseline: an attempt whose digests match neither stored record claims no
    // repeat, so the newer bound record is served first.
    const baseline = await bound('baseline', currentEvidence(unmatchedDigests), 'complete');
    assert.ok(baseline.created.bound && baseline.created.control, 'both observations are stored through the real repository');
    // The fixture itself is checked first: the previous logical round really did
    // freeze a legal context holding both stored observations, so a later demotion
    // is about the attempt identity and not about a record that never qualified.
    assert.equal(baseline.previousContext.roundId, OLD_ROUND, 'the frozen context belongs to the previous logical round');
    assert.deepEqual(
      baseline.previousContext.items.map((item) => item.id).sort(),
      [baseline.created.bound.id, baseline.created.control.id].sort(),
      'the previous round froze both stored observations',
    );
    assert.notEqual(baseline.reasonOf(baseline.created.bound), 'repeated-attempt', 'nothing is marked as a repeated attempt when the bindings differ');
    assert.deepEqual(baseline.order, [baseline.created.bound.id, baseline.created.control.id], 'without a matching attempt the newer record is ranked first');

    // Positive: the same four digests and the same execution conditions under a
    // different candidate/run id is the same attempt, so the exact record bound to
    // it is demoted. The demotion must be visible as the repeated-attempt reason on
    // that record alone.
    const repeat = await bound('exact-repeat', currentEvidence(boundDigests), 'complete');
    assert.deepEqual(repeat.order, [repeat.created.control.id, repeat.created.bound.id], 'the record bound to the repeated attempt is demoted behind the unrelated one');
    assert.equal(new Set(repeat.order).size, repeat.order.length, 'a demotion never duplicates or drops a record');
    assert.equal(repeat.reasonOf(repeat.created.bound), 'repeated-attempt', 'the demoted record is audited with the repeated-attempt reason');
    assert.notEqual(repeat.reasonOf(repeat.created.control), 'repeated-attempt', 'an unrelated record is never demoted by someone else\'s repeat claim');
    assert.ok(repeat.previousContext.items.some((item) => item.id === repeat.created.bound.id), 'the demoted record was already legal knowledge in the previous round');

    // running/idle is not a completed attempt identity.
    for (const status of ['running', 'idle']) {
      const incomplete = await bound(`status-${status}`, currentEvidence(boundDigests), status);
      assert.notEqual(incomplete.reasonOf(incomplete.created.bound), 'repeated-attempt', `a ${status} attempt claims no repeat`);
      assert.deepEqual(incomplete.order, [incomplete.created.bound.id, incomplete.created.control.id], `a ${status} attempt keeps the ordinary order`);
    }
    // Any one changed digest breaks the same-modification identity.
    for (const key of ['patchDigest', 'packageDigest', 'environmentDigest', 'acceptanceDigest']) {
      const changed = await bound(`digest-${key}`, currentEvidence({ ...boundDigests, [key]: '9'.repeat(64) }), 'complete');
      assert.notEqual(changed.reasonOf(changed.created.bound), 'repeated-attempt', `a changed ${key} is not a repeat`);
      assert.deepEqual(changed.order, [changed.created.bound.id, changed.created.control.id], `a changed ${key} keeps the ordinary order`);
    }
    // Different execution conditions are not the same attempt either.
    const otherCondition = await bound('other-condition', currentEvidence(boundDigests, { architecture: 'sm90' }), 'complete');
    assert.notEqual(otherCondition.reasonOf(otherCondition.created.bound), 'repeated-attempt', 'a changed execution condition is not a repeat');
    assert.deepEqual(otherCondition.order, [otherCondition.created.bound.id, otherCondition.created.control.id], 'a changed execution condition keeps the ordinary order');
    // An attempt without a candidate/run id can never be bound to a record: the
    // absence of an exact identity means no repeat claim, and no id is invented.
    const noIdentity = currentEvidence(boundDigests);
    delete noIdentity.candidateId;
    delete noIdentity.runId;
    const noId = await bound('no-identity', noIdentity, 'complete');
    assert.notEqual(noId.reasonOf(noId.created.bound), 'repeated-attempt', 'a missing candidate/run id claims no repeat');
    assert.deepEqual(noId.order, [noId.created.bound.id, noId.created.control.id], 'a missing identity keeps the ordinary order');

    // The same four digests under another Mission are a different attempt and must
    // not be demoted by this Mission's repeat claim.
    const foreign = await prepared('repeat-foreign-mission', {
      current: currentEvidence(boundDigests),
      status: 'complete',
      ids: ['EXP-9', 'EXP-1'],
      records: [
        { key: 'control', title: 'Foreign mission control', evidence: { ...oldEvidence(controlDigests), candidateId: 'candidate-control', runId: 'run-control' } },
        { key: 'foreign', title: 'Foreign mission observation', evidence: oldEvidence({ missionId: 'mission-2', candidateId: 'candidate-foreign', runId: 'run-foreign' }) },
      ],
    });
    assert.notEqual(foreign.reasonOf(foreign.created.foreign), 'repeated-attempt', 'identical digests in another Mission are never demoted by this Mission');
    assert.notEqual(foreign.reasonOf(foreign.created.control), 'repeated-attempt', 'an unrelated record is not demoted either');
  });

  if (failed) {
    console.error(`Kernel wiki runtime: ${failed} of ${passed + failed} independent checks FAILED.`);
    process.exitCode = 1;
  } else {
    console.log(`Kernel wiki runtime: ${passed} independent checks passed.`);
  }
} finally {
  const resolved = path.resolve(root);
  assert.ok(resolved.startsWith(path.resolve(os.tmpdir()) + path.sep));
  assert.ok(path.basename(resolved).startsWith('operator-wiki-runtime-'));
  await rm(resolved, { recursive: true, force: true });
}
