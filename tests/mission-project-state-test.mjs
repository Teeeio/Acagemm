// Unit/contract coverage of the state-store compatibility API; no storage,
// Workspace, Agent, queue, or hardware operation is initialized or executed.
import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import {
  createMission,
  createProject,
  deleteProject,
  normalizeMissionBudgetMs,
  resumeMissionState,
  selectMission,
  selectProject,
  updateProject,
} from '../client-runtime/state-store.mjs';
import { fixedOperatorTestMatrix, getFixedOperatorProfile } from '../client-runtime/fixed-operator-profiles.mjs';
import { freezeSemanticSnapshot, semanticSnapshotDigest } from '../client-runtime/semantic-snapshot.mjs';

const emptyState = () => ({ missions: [], projects: [], activeMissionId: null, activeProjectId: null });
const activeMission = (state) => state.missions.find((mission) => mission.id === state.activeMissionId);

// Legacy Mission IDs use millisecond timestamps. Give synchronous creations
// distinct times without sleeping; always restore the process clock immediately.
let creationTime = Date.UTC(2026, 8, 7);
const addMission = (state, input = {}) => {
  const originalNow = Date.now;
  Date.now = () => ++creationTime;
  try {
    assert.equal(createMission(state, { goal: 'Optimize kernel latency', repository: 'memory-repo', ...input }), state);
    return activeMission(state);
  } finally {
    Date.now = originalNow;
  }
};

const projectedFields = [
  'stage', 'patchApplied', 'benchmark', 'baseline', 'objective', 'testMatrix', 'tokenUsage',
  'decisionReview', 'workflowRecovery', 'currentBest', 'knowledgeDrafts', 'candidateEvaluations',
  'failureRecords', 'publishedAssets', 'knowledgeMaintenance', 'knowledgeReferences', 'runtimeEvents',
  'workflowFailure', 'runHistory', 'missionPaused', 'missionBudgetMs', 'missionBudgetStartedAt',
  'researchNotes', 'researchAgent', 'iterationStats', 'agent',
];
const projection = (value) => structuredClone(Object.fromEntries(projectedFields.map((key) => [key, value[key]])));
const assertStatus = (action, status) => assert.throws(action, (error) => error.status === status);

const populateProjection = (state, label, ordinal) => {
  const candidateId = `candidate-${label}`;
  const evidence = { runId: `test-${label}`, candidateId, patchDigest: `digest-${label}`, source: 'simulation', liveHardware: false, publishable: false };
  Object.assign(state, {
    stage: 'validation',
    patchApplied: true,
    benchmark: { ...state.benchmark, status: 'complete', runId: evidence.runId, candidate: { id: candidateId, digest: evidence.patchDigest }, result: evidence, logs: [label] },
    baseline: { ...state.baseline, status: 'ready', source: { id: `baseline-${label}` }, evidence: { ...evidence, candidateId: null }, oracleRunPy: `# oracle ${label}` },
    objective: { mode: 'maximize', metric: 'speedup', direction: 'maximize', completionPolicy: 'budget_or_plateau', targetRelativeImprovement: ordinal / 10, inferred: false },
    tokenUsage: { ...state.tokenUsage, totalTokens: ordinal * 100, trackedRuns: 1, runs: { [`run-${label}`]: { runId: `run-${label}`, totalTokens: ordinal * 100, completeness: 'exact' } } },
    decisionReview: { ...state.decisionReview, candidateId, request: { id: `review-${label}` } },
    workflowRecovery: { ...state.workflowRecovery, worktree: { ...state.workflowRecovery.worktree, candidateId }, checkpoints: [{ id: `checkpoint-${label}` }], invalidatedArtifacts: [label] },
    currentBest: { candidateId, version: label, value: `${ordinal} us`, status: 'active' },
    knowledgeDrafts: [{ id: `draft-${label}`, content: { summary: label } }],
    candidateEvaluations: [{ id: candidateId, patchDigest: evidence.patchDigest, evidence }],
    failureRecords: [{ id: `failure-${label}`, detail: { code: 'CORRECTNESS_FAILED' } }],
    publishedAssets: [{ id: `asset-${label}`, provenance: { source: label } }],
    knowledgeMaintenance: { ...state.knowledgeMaintenance, result: { draftId: `draft-${label}` } },
    knowledgeReferences: [{ assetId: `reference-${label}`, missionId: state.activeMissionId }],
    runtimeEvents: [{ eventId: `event-${label}`, missionId: state.activeMissionId, sequence: 1, type: 'contract.fixture' }],
    workflowFailure: { code: 'CONTRACT_FIXTURE', details: { label } },
    auditEvents: [{ title: `audit-${label}` }],
    runHistory: [{ id: `history-${label}`, result: { candidateId } }],
    missionPaused: ordinal === 1,
    missionBudgetMs: ordinal * 60_000,
    missionBudgetStartedAt: `2026-09-07T00:0${ordinal}:00.000Z`,
    researchNotes: [{ id: `research-${label}`, findings: [label] }],
    researchAgent: { ...state.researchAgent, missionId: state.activeMissionId, runId: `research-run-${label}`, notes: [label] },
    iterationStats: { ...state.iterationStats, round: ordinal, correctnessAttempts: ordinal, totalCorrectnessAttempts: ordinal + 1, performanceRounds: ordinal, pendingInjection: { label } },
    agent: { ...state.agent, status: 'awaiting_action', goal: `Round brief ${label}`, currentAction: { type: 'test.plan', candidateId }, artifacts: [{ id: label }] },
  });
  state.testMatrix.testSpec.generation.seed += ordinal;
};

test('Mission creation exposes clean defaults and registers its Project in memory', () => {
  const state = emptyState();
  const mission = addMission(state, { title: '  Kernel A  ', goal: '  Optimize latency  ', repository: '  local-kernels  ' });
  assert.match(mission.id, /^MIS_[A-Z0-9]+$/);
  assert.equal(mission.title, 'Kernel A');
  assert.equal(mission.goal, 'Optimize latency');
  assert.equal(mission.repository, 'local-kernels');
  assert.deepEqual(mission.hardware, ['C550']);
  assert.equal(mission.metric, 'latency p50');
  assert.equal(mission.implementation.id, 'pytorch-python');
  assert.equal(mission.stage, 'diagnosis');
  assert.equal(mission.status, 'ready');
  assert.equal(state.patchApplied, false);
  assert.equal(state.agent.status, 'idle');
  assert.equal(state.agent.missionId, mission.id);
  assert.equal(state.agent.goal, mission.goal);
  assert.equal(state.baseline.required, true);
  assert.equal(state.baseline.status, 'missing');
  assert.equal(state.baseline.sourcePolicy.requireAuthority, true);
  assert.equal(state.currentBest.candidateId, null);
  assert.equal(state.tokenUsage.totalTokens, 0);
  assert.deepEqual(state.tokenUsage.runs, {});
  for (const key of ['knowledgeDrafts', 'candidateEvaluations', 'failureRecords', 'publishedAssets', 'knowledgeReferences', 'runtimeEvents', 'runHistory', 'researchNotes']) assert.deepEqual(state[key], [], key);
  assert.equal(state.missionBudgetMs, null);
  assert.equal(state.missionBudgetStartedAt, null);
  assert.equal(state.projects.length, 1);
  assert.equal(state.projects[0].id, mission.projectId);
  assert.equal(state.activeProjectId, mission.projectId);
  assert.equal(state.auditEvents[0].title, 'Mission 已切换');
  assert.equal(mission.semanticSnapshot.missionId, mission.id);
  assert.equal(mission.semanticSnapshot.projection.goal, mission.goal);
});

test('Mission creation inherits the selected Project paths and honors input defaults', () => {
  const state = emptyState();
  const root = path.resolve('memory-only-project');
  const project = createProject(state, { repository: path.join(root, 'repository'), root, sourceRoot: path.join(root, 'sources'), runtimeRoot: path.join(root, '.operator-studio'), layout: 'three-layer' });
  const mission = addMission(state, { projectId: project.id, repository: 'ignored-repository', title: ' ', goal: '  A goal with enough text to derive the short mission title  ', metric: '  throughput  ', implementation: 'triton', hardware: ['C550', 'CUDA'], missionBudgetHours: 2 });
  assert.equal(mission.title, mission.goal.slice(0, 30));
  assert.equal(mission.projectId, project.id);
  assert.equal(mission.repository, project.repository);
  assert.equal(mission.projectRoot, root);
  assert.equal(mission.sourceRoot, project.sourceRoot);
  assert.equal(mission.runtimeRoot, project.runtimeRoot);
  assert.equal(mission.implementation.id, 'triton');
  assert.deepEqual(mission.hardware, ['C550', 'CUDA']);
  assert.equal(mission.metric, 'throughput');
  assert.equal(state.objective.direction, 'maximize');
  assert.equal(state.missionBudgetMs, 7_200_000);
  assert.equal(state.projects.length, 1);
});

test('Mission switching preserves each runtime projection and isolates mutable evidence', () => {
  const state = emptyState();
  const first = addMission(state, { goal: 'Frozen goal A', repository: 'repo-a' });
  populateProjection(state, 'A', 1);
  const firstProjection = projection(state);
  const firstAudit = structuredClone(state.auditEvents);
  const second = addMission(state, { goal: 'Frozen goal B', repository: 'repo-b' });
  assert.deepEqual(projection(state.missions.find((mission) => mission.id === first.id)), firstProjection);
  assert.equal(state.currentBest.candidateId, null);
  assert.deepEqual(state.knowledgeDrafts, []);
  populateProjection(state, 'B', 2);
  const secondProjection = projection(state);
  const secondAudit = structuredClone(state.auditEvents);

  assert.equal(selectMission(state, first.id), state);
  assert.equal(state.activeProjectId, first.projectId);
  assert.deepEqual(projection(state), firstProjection);
  assert.deepEqual(state.auditEvents.slice(1), firstAudit);
  assert.equal(state.auditEvents[0].title, 'Mission 已切换');
  assert.equal(activeMission(state).goal, 'Frozen goal A');
  assert.equal(state.agent.goal, 'Round brief A');
  const storedSecond = structuredClone(state.missions.find((mission) => mission.id === second.id));
  state.candidateEvaluations[0].evidence.patchDigest = 'changed-A';
  state.knowledgeDrafts[0].content.summary = 'changed-A';
  state.tokenUsage.runs['run-A'].totalTokens += 10;
  state.baseline.evidence.runId = 'changed-baseline-A';
  state.testMatrix.testSpec.generation.seed += 10;
  assert.deepEqual(state.missions.find((mission) => mission.id === second.id), storedSecond);
  const changedFirst = projection(state);

  selectMission(state, second.id);
  assert.equal(state.activeProjectId, second.projectId);
  assert.deepEqual(projection(state), secondProjection);
  assert.deepEqual(state.auditEvents.slice(1), secondAudit);
  assert.equal(state.benchmark.result.source, 'simulation');
  assert.equal(state.benchmark.result.liveHardware, false);
  assert.equal(state.benchmark.result.publishable, false);
  assert.notEqual(state.tokenUsage, activeMission(state).tokenUsage);
  assert.notEqual(state.tokenUsage.runs, activeMission(state).tokenUsage.runs);
  assert.notEqual(state.candidateEvaluations[0], activeMission(state).candidateEvaluations[0]);
  assert.notEqual(state.knowledgeDrafts[0].content, activeMission(state).knowledgeDrafts[0].content);
  selectMission(state, first.id);
  assert.deepEqual(projection(state), changedFirst);
});

test('fixed Profile, objective, retry budgets, and frozen semantics survive Mission switches', () => {
  const state = emptyState();
  const profile = getFixedOperatorProfile('paged-mqa-logits-triton-v01');
  const matrix = fixedOperatorTestMatrix(profile);
  const originalProfile = structuredClone(profile);
  const sourcePolicy = { mode: 'authoritative-first', references: ['reference-a'] };
  const testScenario = { id: 'contract', constraints: ['fixed-only'] };
  const semanticDraft = { operator: profile.operator, inputs: [{ name: 'q', dtype: 'bfloat16' }] };
  const mission = addMission(state, { title: profile.title, goal: 'Keep the original optimization goal', operator: 'conflicting-generic-name', operatorProfile: profile, testMatrix: matrix, implementation: 'triton', sourcePolicy, testScenario, semanticDraft, objective: { mode: 'maximize', metric: 'speedup', targetRelativeImprovement: 0.15 }, timeBudgetMs: 123_456 });
  mission.semanticSnapshot = freezeSemanticSnapshot(mission.semanticSnapshot);
  const frozen = structuredClone(mission.semanticSnapshot);
  const frozenMatrix = structuredClone(state.testMatrix);
  const objective = structuredClone(state.objective);
  profile.correctness.pop();
  profile.iterationPolicy.maxCorrectnessAttempts = 1;
  sourcePolicy.references.push('unrelated');
  testScenario.constraints.push('weakened');
  semanticDraft.inputs[0].dtype = 'float32';
  state.agent.goal = 'A temporary round brief';
  state.missionBudgetStartedAt = '2026-09-07T01:00:00.000Z';
  addMission(state, { goal: 'Independent goal', repository: 'another-repo' });
  selectMission(state, mission.id);
  const restored = activeMission(state);
  assert.equal(restored.goal, 'Keep the original optimization goal');
  assert.equal(restored.operator, originalProfile.operator, 'a generic label cannot override the fixed Profile operator');
  assert.deepEqual(restored.operatorProfile, originalProfile);
  assert.deepEqual(restored.operatorProfile.iterationPolicy, originalProfile.iterationPolicy);
  assert.deepEqual(restored.sourcePolicy.references, ['reference-a']);
  assert.deepEqual(restored.testScenario.constraints, ['fixed-only']);
  assert.deepEqual(state.testMatrix, frozenMatrix);
  assert.equal(state.testMatrix.correctnessCases, originalProfile.correctness.length);
  assert.equal(state.testMatrix.warmup, matrix.warmup);
  assert.equal(state.testMatrix.repeats, matrix.repeats);
  assert.deepEqual(state.testMatrix.testSpec.benchmark.requiredProfiles, matrix.testSpec.benchmark.requiredProfiles);
  assert.deepEqual(state.objective, objective);
  assert.equal(state.missionBudgetMs, 123_456);
  assert.equal(state.missionBudgetStartedAt, '2026-09-07T01:00:00.000Z');
  assert.deepEqual(restored.semanticSnapshot, frozen);
  assert.equal(restored.semanticSnapshot.status, 'frozen');
  assert.equal(restored.semanticSnapshot.digest, semanticSnapshotDigest(restored.semanticSnapshot));
  assert.deepEqual(restored.semanticSnapshot.semanticContract.profile, originalProfile);
  assert.equal(restored.semanticSnapshot.semanticContract.inputs[0].dtype, 'bfloat16');
});

test('Mission budget aliases, precedence, fractional values, and unlimited defaults remain compatible', () => {
  const cases = [
    [undefined, null], [null, null], [0, null], ['', null], [false, null], [true, null],
    [-1, null], [Infinity, null], [NaN, null], ['invalid', null],
    [1234.9, 1234], ['2500', 2500], [{}, null],
    [{ missionBudgetMs: 4000, timeBudgetMs: 5000, missionBudgetHours: 2 }, 4000],
    [{ missionBudgetMs: null, timeBudgetMs: 5000 }, null],
    [{ missionBudgetMs: 0, missionBudgetHours: 2 }, null],
    [{ timeBudgetMs: 6000, missionBudgetHours: 2 }, 6000],
    [{ missionBudgetHours: 1.5, timeBudgetHours: 2 }, 5_400_000],
    [{ timeBudgetHours: 0.25 }, 900_000],
  ];
  for (const [input, expected] of cases) assert.equal(normalizeMissionBudgetMs(input), expected, String(input));
});

test('candidate selection restores its pending action without overwriting the Mission goal', () => {
  const state = emptyState();
  const mission = addMission(state, { goal: 'Original Mission target' });
  state.stage = 'candidate';
  state.agent = { ...state.agent, status: 'idle', goal: 'Temporary candidate brief', currentAction: null };
  state.candidateEvaluations = [{ id: 'candidate-resume', patchDigest: 'resume-digest' }];
  state.decisionReview.candidateId = 'candidate-resume';
  selectMission(state, mission.id);
  assert.equal(state.agent.status, 'awaiting_action');
  assert.equal(state.agent.currentAction.type, 'candidate.plan');
  assert.equal(state.agent.currentAction.id, 'action.candidate-resume.resume');
  assert.equal(state.agent.currentAction.approvalRequired, false);
  assert.equal(activeMission(state).goal, 'Original Mission target');
  const action = structuredClone(state.agent.currentAction);
  selectMission(state, mission.id);
  assert.deepEqual(state.agent.currentAction, action);
});

test('active Mission status preserves running, approval, failure, and completion precedence', () => {
  const cases = [
    ['running', 'running', 'diagnosis', 'idle', 'running'],
    ['executing', 'running', 'diagnosis', 'idle', 'running'],
    ['cancel_requested', 'running', 'diagnosis', 'idle', 'running'],
    ['awaiting_approval', 'running', 'diagnosis', 'idle', 'awaiting_approval'],
    ['failed', 'running', 'diagnosis', 'idle', 'failed'],
    ['idle', 'failed', 'published', 'completed', 'failed'],
    ['completed', 'running', 'published', 'completed', 'completed'],
    ['idle', 'running', 'diagnosis', 'idle', 'ready'],
  ];
  for (const [agentStatus, loopStatus, stage, maintenanceStatus, expected] of cases) {
    const state = emptyState();
    const mission = addMission(state);
    state.agent.status = agentStatus;
    state.iterationStats.loopStatus = loopStatus;
    state.stage = stage;
    state.knowledgeMaintenance.status = maintenanceStatus;
    selectMission(state, mission.id);
    assert.equal(activeMission(state).status, expected, `${agentStatus}/${loopStatus}/${stage}`);
  }
});

test('resume restarts stopped and human-review loops once while preserving work and consumed budgets', () => {
  for (const previousLoopStatus of ['stopped', 'needs_human']) {
    const state = emptyState();
    const mission = addMission(state);
    populateProjection(state, 'resume', 1);
    state.iterationStats = { ...state.iterationStats, loopStatus: previousLoopStatus, loopStatusReason: 'manual_pause', stoppedAt: '2026-09-07T00:00:00.000Z' };
    const before = projection(state);
    const eventCount = state.runtimeEvents.length;
    const result = resumeMissionState(state, { source: 'contract-test' });
    assert.equal(result.state, state);
    assert.equal(result.resumed, true);
    assert.equal(result.previousLoopStatus, previousLoopStatus);
    assert.equal(state.missionPaused, false);
    assert.deepEqual(state.iterationStats, { ...before.iterationStats, loopStatus: 'running', loopStatusReason: null, stoppedAt: null });
    assert.equal(activeMission(state).status, 'running');
    assert.equal(activeMission(state).missionPaused, false);
    assert.deepEqual(activeMission(state).iterationStats, state.iterationStats);
    assert.notEqual(activeMission(state).iterationStats, state.iterationStats);
    for (const key of projectedFields.filter((field) => !['iterationStats', 'missionPaused', 'runtimeEvents'].includes(field))) assert.deepEqual(state[key], before[key], key);
    assert.equal(state.runtimeEvents.length, eventCount + 1);
    const event = state.runtimeEvents.at(-1);
    assert.equal(event.type, 'mission.resumed');
    assert.equal(event.missionId, mission.id);
    assert.deepEqual(event.payload, { missionId: mission.id, source: 'contract-test', previousLoopStatus });
    const resumedState = structuredClone(state);
    assert.equal(resumeMissionState(state).resumed, false);
    assert.deepEqual(state, resumedState);
  }
});

test('resume preserves non-resumable loop outcomes and terminal Mission statuses', () => {
  for (const loopStatus of ['running', 'failed']) {
    const state = emptyState();
    addMission(state);
    state.iterationStats.loopStatus = loopStatus;
    const before = structuredClone(state);
    assert.equal(resumeMissionState(state).resumed, false);
    assert.deepEqual(state, before);
  }
  for (const status of ['completed', 'published', 'archived']) {
    const state = emptyState();
    addMission(state);
    activeMission(state).status = status;
    state.missionPaused = true;
    state.iterationStats.loopStatus = 'stopped';
    assert.equal(resumeMissionState(state).resumed, true);
    assert.equal(activeMission(state).status, status);
  }
});

test('Project create and update normalize metadata without changing its linked Mission', () => {
  const state = emptyState();
  const repository = path.resolve('memory-only-kernels');
  const project = createProject(state, { repository: `  ${repository}  `, name: '  Kernels  ', defaultBranch: '  main  ' });
  assert.equal(state.activeProjectId, project.id);
  assert.equal(state.projects[0], project);
  assert.equal(project.name, 'Kernels');
  assert.equal(project.repository, repository);
  assert.equal(project.root, repository);
  assert.equal(project.sourceRoot, path.join(repository, '.operator-studio', 'sources'));
  assert.equal(project.runtimeRoot, path.join(repository, '.operator-studio'));
  assert.equal(project.layout, 'legacy-compatible');
  assert.equal(project.defaultBranch, 'main');
  assert.equal(project.status, 'active');
  assert.ok(Number.isFinite(Date.parse(project.createdAt)));
  const mission = addMission(state, { projectId: project.id });
  const before = structuredClone(mission);
  assert.equal(updateProject(state, project.id, { name: '  Renamed  ', defaultBranch: ' ', status: 'archived' }), project);
  assert.equal(project.name, 'Renamed');
  assert.equal(project.defaultBranch, 'HEAD');
  assert.equal(project.status, 'archived');
  assert.deepEqual(activeMission(state), before);
  updateProject(state, project.id, { name: ' ', status: 'active' });
  assert.equal(project.name, 'Renamed');
  assert.equal(project.status, 'active');
});

test('invalid selections and Project conflicts retain 400, 404, and 409 status contracts', () => {
  const state = emptyState();
  assertStatus(() => createProject(state, { repository: ' ' }), 400);
  const project = createProject(state, { repository: 'memory-kernels' });
  assertStatus(() => createProject(state, { repository: 'MEMORY-KERNELS' }), 409);
  const mission = addMission(state, { projectId: project.id });
  assertStatus(() => selectMission(state, 'missing'), 404);
  assertStatus(() => selectProject(state, 'missing'), 404);
  assertStatus(() => updateProject(state, 'missing', {}), 404);
  assertStatus(() => deleteProject(state, 'missing'), 404);
  assert.equal(state.activeMissionId, mission.id);
  assert.equal(state.activeProjectId, project.id);
  assertStatus(() => updateProject(state, project.id, { status: 'deleted' }), 400);
  assertStatus(() => updateProject(state, project.id, { repository: 'replacement-repo' }), 409);
  activeMission(state).status = 'running';
  assertStatus(() => updateProject(state, project.id, { status: 'archived' }), 409);
  assert.equal(project.status, 'active');
  assert.equal(project.repository, 'memory-kernels');
  activeMission(state).status = 'completed';
  assert.equal(updateProject(state, project.id, { status: 'archived' }).status, 'archived');
  assertStatus(() => deleteProject(state, project.id), 409);
  assert.equal(state.projects.length, 1);
  assert.equal(state.missions.length, 1);
});

test('Project selection prefers running, then unfinished, then completed linked Missions', () => {
  for (const [statuses, expectedIndex] of [[['completed', 'ready', 'running'], 2], [['completed', 'ready'], 1], [['completed', 'completed'], 0]]) {
    const state = emptyState();
    const project = createProject(state, { repository: 'priority-repo' });
    state.missions = statuses.map((status, index) => ({ id: `MIS_${index}`, title: `Mission ${index}`, goal: `Goal ${index}`, repository: project.repository, ...(index < 2 ? { projectId: project.id } : {}), status, stage: 'diagnosis' }));
    const result = selectProject(state, project.id);
    assert.equal(result.project, project);
    assert.equal(result.selectedMission.id, `MIS_${expectedIndex}`);
    assert.equal(state.activeMissionId, result.selectedMission.id);
    assert.equal(state.activeProjectId, project.id);
  }
});

test('selecting an empty Project retains the active Mission and records the switch', () => {
  const state = emptyState();
  const mission = addMission(state);
  populateProjection(state, 'empty-project', 1);
  const before = projection(state);
  const project = createProject(state, { repository: 'empty-project' });
  const result = selectProject(state, project.id);
  assert.equal(result.project, project);
  assert.equal(result.selectedMission, null);
  assert.equal(state.activeProjectId, project.id);
  assert.equal(state.activeMissionId, mission.id);
  assert.deepEqual(projection(state), before);
  assert.equal(state.auditEvents[0].title, '项目已切换');
});

test('deleting an unlinked Project selects an active fallback, then an archive, then null', () => {
  const state = emptyState();
  const active = createProject(state, { repository: 'active-repo' });
  const archived = createProject(state, { repository: 'archived-repo' });
  updateProject(state, archived.id, { status: 'archived' });
  const removed = createProject(state, { repository: 'removed-repo' });
  assert.equal(deleteProject(state, removed.id), removed);
  assert.equal(state.activeProjectId, active.id);
  assert.deepEqual(state.projects.map((project) => project.id), [archived.id, active.id]);
  assert.equal(deleteProject(state, active.id), active);
  assert.equal(state.activeProjectId, archived.id);
  assert.equal(deleteProject(state, archived.id), archived);
  assert.equal(state.activeProjectId, null);
  assert.deepEqual(state.projects, []);
  assert.deepEqual(state.missions, []);
});
