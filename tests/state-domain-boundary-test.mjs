import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SourceTextModule } from 'node:vm';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relative) => readFile(path.join(root, relative), 'utf8');
const pureRoots = [
  'accept-gate', 'operator-test-evidence', 'mission-objective', 'evidence-state',
  'state-identifiers', 'runtime-events', 'iteration-loop',
  'mission-state-shapes', 'mission-project-state', 'knowledge-state',
  'state-reference-data', 'state-initialization', 'state-reference-runtime',
  'execution-package-contract', 'cancellation-contract', 'experience-contract',
  'candidate-generation/prompt', 'candidate-generation/admission',
].map((name) => 'client-runtime/' + name + '.mjs');
const forbidden = /(?:^|\/)(?:state-store|state-workspace|state-snapshot-storage|storage-paths|state-repository|command-journal|execution-package-store|experience-repository|operator-test-tool|workspace-manager|agent-runtime|local-server|operator-test-queue|local-c500-service-client|claude-client|codex-client)\.mjs$|(?:^|\/)(?:server|tools)\//;
const allowedBuiltins = new Set(['node:crypto', 'node:path']);

// Parse static ESM with Node itself, without linking or evaluating modules.
// Dynamic/alternate loaders are intentionally unsupported in this policy graph.
const inspectGraph = async (roots, readSource = read, { application = false } = {}) => {
  const visited = new Set();
  const visit = async (relative, trail = []) => {
    const chain = [...trail, relative].join(' -> ');
    assert.ok(relative.startsWith('client-runtime/'), 'domain dependency escapes runtime: ' + chain);
    assert.ok(application || !relative.startsWith('client-runtime/application/'), 'domain cannot depend on application orchestration: ' + chain);
    assert.doesNotMatch(relative, forbidden, 'domain reaches an effect implementation: ' + chain);
    if (relative.includes('/agent-runtime/')) {
      assert.match(relative, /\/agent-runtime\/(?:capabilities|registry|definitions|usage)\.mjs$/, 'only declarative Agent contracts are allowed: ' + chain);
    }
    assert.ok(!trail.includes(relative), 'domain dependency cycle: ' + chain);
    if (visited.has(relative)) return;
    const source = await readSource(relative);
    assert.ok(!/\bimport\s*\(|(?<![\w.])require\s*\(\s*['"]|\b(?:fetch|WebSocket)\s*\(/.test(source), 'domain effects/loaders must be injected: ' + chain);
    const parsed = new SourceTextModule(source, { identifier: relative });
    for (const dependency of parsed.dependencySpecifiers) {
      if (dependency.startsWith('node:')) {
        assert.ok(allowedBuiltins.has(dependency), 'effectful builtin is forbidden: ' + chain + ' -> ' + dependency);
      } else {
        assert.ok(dependency.startsWith('.'), 'domain external dependency requires contract review: ' + chain + ' -> ' + dependency);
        await visit(path.posix.normalize(path.posix.join(path.posix.dirname(relative), dependency)), [...trail, relative]);
      }
    }
    visited.add(relative);
  };
  for (const relative of roots) await visit(relative);
  return visited;
};

// Prove that re-exports/transitive imports cannot bypass the boundary guard.
const probe = 'client-runtime/domain-probe.mjs';
const virtualRead = (sources) => async (name) => {
  assert.ok(Object.hasOwn(sources, name), 'missing virtual module: ' + name);
  return sources[name];
};
await assert.rejects(inspectGraph([probe], virtualRead({
  [probe]: "export { value } from './indirect.mjs';",
  'client-runtime/indirect.mjs': "import './state-workspace.mjs'; export const value = 1;",
})), /effect implementation/);
await assert.rejects(inspectGraph([probe], virtualRead({
  [probe]: "import './indirect.mjs';",
  'client-runtime/indirect.mjs': "import { readFile } from 'node:fs/promises';",
})), /effectful builtin/);
await assert.rejects(inspectGraph([probe], virtualRead({
  [probe]: "export const load = () => import('./state-store.mjs');",
})), /effects\/loaders/);
await assert.rejects(inspectGraph([probe], virtualRead({
  [probe]: "import './indirect.mjs';",
  'client-runtime/indirect.mjs': "import './domain-probe.mjs';",
})), /dependency cycle/);

await assert.rejects(inspectGraph([probe], virtualRead({
  [probe]: "const fs = require('node:fs');",
})), /effects\/loaders/);
await inspectGraph([probe], virtualRead({
  [probe]: "export const registry = { require(id) { return id; } };",
}));

const graph = await inspectGraph(pureRoots);
const applicationRoots = (await readdir(path.join(root, 'client-runtime/application')))
  .filter((file) => file.endsWith('.mjs')).map((file) => 'client-runtime/application/' + file);
const applicationGraph = await inspectGraph(applicationRoots, read, { application: true });
const ownership = await read('docs/development/MODULE_OWNERSHIP.md');
for (const name of ['accept-gate', 'operator-test-evidence', 'mission-objective', 'evidence-state', 'state-identifiers', 'runtime-events', 'state-workspace', 'state-snapshot-storage', 'mission-state-shapes', 'mission-project-state', 'knowledge-state', 'state-reference-data', 'state-initialization', 'state-reference-runtime']) {
  assert.ok((await read('client-runtime/' + name + '.md')).trim(), 'missing local contract: ' + name);
  assert.ok(ownership.includes(name + '.md'), 'ownership must link the canonical contract: ' + name);
}
for (const document of ['client-runtime/candidate-generation/README.md', 'client-runtime/candidate-generation/CONSTRAINTS.md']) {
  assert.ok((await read(document)).trim(), 'missing candidate-generation contract: ' + document);
  assert.ok(ownership.includes(document.split('/').at(-1)), 'ownership must link the candidate-generation contract: ' + document);
}

// Importing the facade is only for legacy compatibility verification, not a
// permitted dependency of any production policy root above.
const facade = await import('../client-runtime/state-store.mjs');
for (const [moduleName, exports] of [
  ['accept-gate', ['evaluateAcceptGate']],
  ['operator-test-evidence', ['applyOperatorTestSnapshot', 'isInfrastructureTestFailure']],
  ['mission-objective', ['inferMissionObjectiveMode', 'normalizeMissionObjective', 'isMaximizeMission']],
  ['evidence-state', ['createDecisionReviewState']],
  ['runtime-events', ['addAuditEvent']],
  ['mission-state-shapes', ['normalizeMissionBudgetMs', 'createCurrentBestState', 'createResearchAgentState', 'createIterationStats', 'createResearchNote', 'appendResearchNote']],
  ['knowledge-state', ['createKnowledgeMaintenanceState', 'toPublishedKnowledgeAsset', 'runKnowledgeMaintenance', 'markCandidateAccepted', 'runAutomaticAdoption']],
  ['state-reference-data', ['knowledgeDrafts', 'candidateEvaluations', 'failureRecords']],
  ['state-reference-runtime', ['refreshReferenceBenchmark', 'refreshReferenceAgent', 'buildBenchmarkLogsForMatrix', 'buildBenchmarkLogs']],
]) {
  const canonical = await import('../client-runtime/' + moduleName + '.mjs');
  for (const name of exports) assert.equal(facade[name], canonical[name], 'facade must alias canonical implementation: ' + name);
}
const workspace = await import('../client-runtime/state-workspace.mjs');
for (const name of Object.keys(workspace).filter((name) => !['createStateWorkspace', 'resetFixtureWorkspaces'].includes(name))) {
  assert.equal(facade[name], workspace[name], 'legacy workspace export changed: ' + name);
}
for (const name of ['applyCandidatePatch', 'createWorkspaceCheckpoint']) assert.equal(typeof facade[name], 'function');

const gate = await import('../client-runtime/accept-gate.mjs');
const evidence = await import('../client-runtime/operator-test-evidence.mjs');
const objective = await import('../client-runtime/mission-objective.mjs');
const identifiers = await import('../client-runtime/state-identifiers.mjs');
const shapes = await import('../client-runtime/evidence-state.mjs');
const state = facade.createSeedState();
const before = structuredClone(state);
const result = gate.evaluateAcceptGate(state, {});
assert.deepEqual(state, before, 'Gate must not mutate supplied state');
assert.equal(result.publishable, false);
assert.equal(evidence.applyOperatorTestSnapshot(state, { taskId: 'unrelated-task', status: 'completed' }), state);
assert.deepEqual(state, before, 'an unrelated task must not change evidence');
assert.equal(evidence.isInfrastructureTestFailure({ error: { code: 'ECONNRESET' } }), true);
assert.equal(evidence.isInfrastructureTestFailure({ error: { code: 'CORRECTNESS_FAILED' } }), false);
assert.equal(objective.isMaximizeMission({ objective: { mode: 'maximize' } }), true);
assert.equal(objective.normalizeMissionObjective().mode, 'threshold');
assert.equal(identifiers.safeMissionId('Mission / A'), 'Mission___A');
assert.equal(identifiers.projectNameForRepository('root\\repository'), 'repository');
assert.equal(shapes.createBaselineRequirementState().required, true);
assert.equal(shapes.createBaselineSourcePolicy('naive_v0').allowGeneratedV0, true);
const firstReview = shapes.createDecisionReviewState();
const secondReview = shapes.createDecisionReviewState();
firstReview.signals[0].triggered = true;
assert.equal(secondReview.signals[0].triggered, false);

const { createMissionProjectState } = await import('../client-runtime/mission-project-state.mjs');
const { createStateInitialization } = await import('../client-runtime/state-initialization.mjs');
assert.throws(() => createMissionProjectState(), TypeError);
assert.throws(() => createStateInitialization(), TypeError);
const virtualRoot = path.resolve('runtime', 'domain-contract-only');
const pathQueries = [];
const sourceQueries = [];
const domain = createMissionProjectState({
  rootDir: virtualRoot,
  workspaceDir: path.join(virtualRoot, 'legacy'),
  workspaceDirForMission: (...args) => {
    pathQueries.push(args);
    return path.join(virtualRoot, 'bound', args[0] || 'missing-id');
  },
  missionSourceDirFor: (...args) => {
    sourceQueries.push(args);
    return path.join(virtualRoot, 'strict-sources', args[0]);
  },
});
assert.equal(Object.isFrozen(domain), true);
assert.equal(domain.createWorkflowRecoveryState().worktree.path, 'legacy');
assert.equal(pathQueries.length, 0, 'unassigned recovery must preserve the legacy-path branch');
assert.equal(domain.createWorkflowRecoveryState('MIS_PORT', 'repository', 'project').worktree.path, 'bound/MIS_PORT');
assert.deepEqual(pathQueries.pop(), ['MIS_PORT', 'repository', 'project']);
const initial = createStateInitialization(domain);
assert.equal(Object.isFrozen(initial), true);
const product = initial.createProductState();
const anotherProduct = initial.createProductState();
product.agent.messages[0].title = 'isolated';
assert.notEqual(anotherProduct.agent.messages[0].title, 'isolated');
product.schemaVersion = 99;
product.stateVersion = 'invalid-version';
product.commandJournalSeq = 'invalid-sequence';
assert.equal(domain.normalizeMissionState(product), product);
assert.equal(product.schemaVersion, 99, 'incoming snapshot schema policy belongs to the facade');
assert.equal(product.stateVersion, 'invalid-version');
assert.equal(product.commandJournalSeq, 'invalid-sequence');

const emptyId = initial.createProductState();
emptyId.activeMissionId = '';
emptyId.missions[0].id = '';
domain.normalizeMissionState(emptyId);
assert.equal(emptyId.workflowRecovery.worktree.path, 'bound/missing-id', 'normalization uses the assigned-path query even for an empty legacy ID');
const domainState = initial.createProductState();
const newProject = domain.createProject(domainState, { repository: path.join(virtualRoot, 'repository') });
assert.equal(newProject.sourceRoot, path.join(newProject.repository, '.operator-studio', 'sources'));
domain.createMission(domainState, {
  projectId: newProject.id,
  goal: 'strict path port contract',
  sourcePolicy: { strictZeroSource: true },
  missionBudgetHours: 2,
});
const selectedMission = domainState.missions.find((mission) => mission.id === domainState.activeMissionId);
assert.equal(selectedMission.sourceRoot, path.join(virtualRoot, 'strict-sources', selectedMission.id));
assert.deepEqual(sourceQueries.at(-1), [selectedMission.id, newProject.repository, newProject.root]);
assert.equal(domainState.missionBudgetMs, 7200000);
domainState.agent.runId = 'old-run';
domainState.runHistory = Array.from({ length: 22 }, (_, index) => ({ runId: 'history-' + index }));
domainState.currentBest = { candidateId: 'stable-best', verified: true };
domain.resetMissionRunState(domainState, 'new goal');
assert.equal(domainState.runHistory.length, 20);
assert.equal(domainState.runHistory[0].runId, 'old-run');
assert.equal(domainState.currentBest.candidateId, 'stable-best');
domain.startAgentRun(domainState, 'state transition only', { reset: false });
assert.equal(domainState.agent.status, 'running');
assert.match(domainState.agent.runId, /^agent_/);

// Requiring transition ports prevents a missing dependency from silently falling
// back to the persistence facade. Queries use pure shapes where a default exists.
for (const [file, factoryName, ports] of [
  ['projects-service', 'createProjectsService', { loadState() {}, persistState() {}, ensureProjectLayout() {}, workspaceDirForMission() {}, workspace: {}, filesystem: {} }],
  ['missions-service', 'createMissionsService', { loadState() {}, persistState() {}, ensureMissionWorkspace() {}, validateMissionBudgetInput() {} }],
  ['mission-query-service', 'createMissionQueryService', { loadState() {}, persistState() {} }],
  ['research-service', 'createResearchService', { loadState() {}, persistState() {}, executeCommand() {}, journal: {}, registry: {}, agentRuntime: {} }],
  ['run-service', 'createRunService', { loadState() {}, persistState() {}, executeCommand() {}, journal: {}, registry: {}, agentRuntime: {}, buildRuntimePreflight() {} }],
]) {
  const module = await import('../client-runtime/application/' + file + '.mjs');
  assert.throws(() => module[factoryName](ports), TypeError, file + ' must require an explicit domain port');
}

console.log('[state-domain-boundary] ' + graph.size + ' domain nodes, ' + applicationGraph.size + ' application closure nodes, explicit ports, pure factories, and compatibility passed');
