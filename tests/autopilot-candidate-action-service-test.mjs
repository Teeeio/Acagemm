import assert from 'node:assert/strict';
import { createAutopilotCandidateActionService } from '../client-runtime/application/autopilot-candidate-action-service.mjs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createCandidateCommands } from '../client-runtime/application/candidate-commands.mjs';
import { createCommandJournal, executeCommand } from '../client-runtime/command-journal.mjs';
import { createAgentRuntime } from '../client-runtime/agent-runtime.mjs';
import { createWorkspaceManager } from '../client-runtime/workspace-manager.mjs';
import { createAutopilotService } from '../client-runtime/application/autopilot-service.mjs';
import { createAutopilotContextService } from '../client-runtime/application/autopilot-context-service.mjs';
import { createRuntimeProjectionService } from '../client-runtime/application/runtime-projection-service.mjs';
import { createRuntimeAdvanceService } from '../client-runtime/application/runtime-advance-service.mjs';
import { createRuntimeStatePipelineService } from '../client-runtime/application/runtime-state-pipeline-service.mjs';
import { createRuntimeLifecycleService } from '../client-runtime/application/runtime-lifecycle-service.mjs';
import { createMissionControlService } from '../client-runtime/application/mission-control-service.mjs';
import { advanceIteration } from '../client-runtime/iteration-loop.mjs';
import { reconcileWorkflowState } from '../client-runtime/workflow-kernel.mjs';
import { ensureRoundBudgetStarted, ROUND_BUDGET_MS } from '../client-runtime/round-budget-contract.mjs';
const calls = [];
const service = createAutopilotCandidateActionService({ executeCommand: async (input) => { calls.push(input); return { state: { applied: true } }; }, journal: {}, saveState: () => {}, registry: {} });
assert.equal((await service.applyCandidate({ state: { stateVersion: 1 }, candidateId: 'c' })).applied, true);
assert.equal(calls[0].body.candidate, 'c');
assert.match((await service.resumeCandidate({ state: {}, mission: { goal: 'g' }, startMainRound: async ({ goal }) => ({ goal }) })).goal, /系统恢复/);
console.log('[autopilot-candidate-action-service] patch and recovery contracts passed');

// Production projection -> command admission -> autopilot -> persisted snapshot.
// Provider observations are fixtures; Git diff, journal, orchestration and disk
// reload are real. No model, hardware or benchmark execution is used here.
const execFileAsync = promisify(execFile);
const root = await mkdtemp(path.join(os.tmpdir(), 'patch-policy-lifecycle-'));
try {
  const git = (...args) => execFileAsync('git', args, { cwd: root });
  await git('init');
  await git('config', 'user.name', 'Policy Test');
  await git('config', 'user.email', 'policy@test.invalid');
  await writeFile(path.join(root, 'run.py'), 'def run(inputs):\n    return inputs\n');
  await git('add', 'run.py');
  await git('commit', '-m', 'baseline');
  await writeFile(path.join(root, 'run.py'), 'def run(inputs):\n    # candidate\n    return inputs\n');
  // Runtime evidence must not enter the candidate diff.
  await writeFile(path.join(root, '.git', 'info', 'exclude'), 'snapshot.json\ncommand-journal.jsonl\n');
  const snapshot = path.join(root, 'snapshot.json');
  const journal = createCommandJournal({ filePath: path.join(root, 'command-journal.jsonl') });
  const loadState = async () => JSON.parse(await readFile(snapshot, 'utf8'));
  const persistState = async (state) => {
    const saved = { ...state, stateVersion: Number(state.stateVersion || 0) + 1 };
    await writeFile(snapshot, JSON.stringify(saved));
    return saved;
  };
  const base = {
    stateVersion: 1, activeMissionId: 'mission', missions: [{ id: 'mission', goal: 'reduce latency', status: 'running', hardware: ['local-gpu'], metric: 'latency_p50' }],
    stage: 'diagnosis', baseline: { status: 'complete' }, benchmark: { status: 'idle' },
    candidateEvaluations: [], runtimeEvents: [], runHistory: [], tokenUsage: { runs: {} },
    iterationStats: { round: 0, loopStatus: 'running' }, patchApplied: false,
    agent: { runtimeKind: 'claude-code', missionId: 'mission', runId: 'claude_policy', status: 'running', startedAt: new Date().toISOString(), eventCount: 0, messages: [], artifacts: [] },
  };
  const modelObservation = {
    schemaVersion: 'operator-studio.model-observation/v1', provider: 'claude-code', source: 'assistant.message.model',
    runId: 'claude_policy', missionId: 'mission', sessionId: 'session-policy', status: 'observed', model: 'test-response-model',
    models: ['test-response-model'], configuredModels: [], usageModels: [], reasons: [],
    observations: [{ eventIndex: 0, sessionId: 'session-policy', model: 'test-response-model' }],
  };
  const runtime = createAgentRuntime({ mode: 'claude-code', claudeClient: {
    describe: async () => ({ installed: true, loggedIn: true, version: 'policy-test' }),
    readRun: async () => ({ runId: 'claude_policy', missionId: 'mission', threadId: 'session-policy', workspace: root, status: 'completed', resourceRelease: { confirmed: true, status: 'confirmed' }, modelObservation }),
    readEvents: async () => [{ item: { type: 'agent_message', text: JSON.stringify({
      summary: 'candidate ready', candidates: [{ id: 'candidate', files: 'run.py', title: 'candidate' }], recommendedCandidate: 'candidate',
      nextAction: { id: 'apply-candidate', type: 'candidate.plan', title: 'apply', risk: 'high' },
    }) } }],
    eventText: (event) => event.item?.text || '',
  } });
  let writes = 0;
  let submissions = 0;
  const unexpected = () => { throw new Error('unexpected new work'); };
  const appendRuntimeEvent = (state, type, payload) => (state.runtimeEvents ||= []).push({ type, payload });
  const registry = createCandidateCommands({
    agentRuntime: runtime, workspaceManager: createWorkspaceManager(), ensureMissionWorkspace: async () => root,
    isManagedWorkspaceRuntimeMode: () => true, path, rootDir: root,
    createWorkspaceCheckpoint: async () => { writes++; return { id: 'checkpoint' }; },
    artifactDirForMission: () => root, mkdir: async () => { writes++; }, writeFile: async () => { writes++; },
    appendRuntimeEvent, addAuditEvent: () => {},
  });
  const candidateActionService = createAutopilotCandidateActionService({ executeCommand, journal, saveState: persistState, registry });
  const autopilot = createAutopilotService({
    contextService: createAutopilotContextService({ isFixedOperatorMission: () => false, selectCandidate: state => state.candidateEvaluations[0] }),
    isFixedOperatorMission: () => false, isStrictZeroSourceMission: () => false, runtimeMode: () => 'claude-code',
    candidateActionService, validationService: { startCandidateTest: () => { submissions++; unexpected(); } }, iteration: {},
  });
  const runtimeAdvance = createRuntimeAdvanceService({ autopilot, advanceIteration, iteration: {}, reconcileWorkflowState });
  const pipeline = createRuntimeStatePipelineService({
    maintenance: { advance: ({ state }) => ({ state, changed: false }) }, migrateState: () => ({ changed: false }),
    projectBaselineFailure: () => false, processTests: async () => {},
    runtimeProjection: createRuntimeProjectionService({ reconcileWorkflowState, projectState: runtime.projectState }),
    benchmarkProjection: { project: async ({ state }) => ({ state, changed: false }) },
    repositoryAdoption: { adopt: async ({ state }) => ({ state, changed: false }) }, runtimeAdvance,
  });
  const boot = () => createRuntimeLifecycleService({ readState: loadState, persistState, describeRuntime: runtime.describe, pipeline });
  await writeFile(snapshot, JSON.stringify(base));
  const blocked = await boot().advance();
  assert.equal(blocked.stage, 'candidate', 'completion projection must survive policy rejection');
  assert.equal(blocked.agent.status, 'needs_human');
  assert.equal(blocked.agent.modelObservation.model, 'test-response-model');
  assert.ok(blocked.runtimeEvents.some(event => event.type === 'claude.run_completed'));
  assert.equal(blocked.agent.candidateValidation.passed, true);
  assert.equal(blocked.patchApplied, false);
  assert.equal(blocked.agent.currentAction.risk, 'high');
  assert.equal(blocked.missionPaused, true);
  assert.equal(blocked.missions[0].status, 'needs_human');
  assert.deepEqual(blocked.agent.patchPolicyRejection.checks.filter(check => !check.passed).map(check => check.id), ['risk.policy']);
  assert.equal(blocked.agent.patchPolicyRejection.sourceRunId, base.agent.runId);
  assert.equal(blocked.agent.patchPolicyRejection.patchDigest, blocked.candidateEvaluations[0].patchDigest);
  const restarted = boot();
  for (let tick = 0; tick < 3; tick++) {
    const state = await restarted.advance();
    assert.equal(state.agent.status, 'needs_human');
    assert.deepEqual(state.agent.patchPolicyRejection, blocked.agent.patchPolicyRejection);
  }
  const entries = await journal.readAll();
  assert.equal(entries.length, 1, 'persisted policy block must not reissue apply-patch on later ticks or restart');
  assert.equal(entries[0].status, 'failed');
  assert.equal(entries[0].effectStarted, false);
  assert.equal(writes, 0);
  assert.equal(submissions, 0);
  assert.equal((await autopilot.advance(await loadState())).action, 'none');

  const expired = structuredClone(blocked);
  ensureRoundBudgetStarted(expired, { nowMs: Date.now() - ROUND_BUDGET_MS - 1 });
  const deadline = expired.iterationStats.roundBudget.deadlineAt;
  await runtimeAdvance.advance({ state: expired });
  assert.equal(expired.iterationStats.loopStatusReason, 'round_budget');
  assert.equal(expired.iterationStats.roundBudget.deadlineAt, deadline, 'policy rejection cannot renew the round deadline');
  assert.equal(expired.patchApplied, false);

  // An explicit stop remains available and retains the rejection evidence.
  const control = createMissionControlService({ loadState, persistState, agentRuntime: runtime, operatorTestQueue: {}, appendRuntimeEvent, addAuditEvent: () => {} });
  await control.stopMission();
  assert.equal((await loadState()).iterationStats.loopStatus, 'stopped');
  assert.deepEqual((await loadState()).agent.patchPolicyRejection, blocked.agent.patchPolicyRejection);

  // A different run must not inherit the old policy projection overlay.
  const foreign = structuredClone(blocked);
  foreign.agent.patchPolicyRejection.sourceRunId = 'old-run';
  assert.equal((await runtime.projectState(foreign)).state.agent.status, 'awaiting_action');

  const mismatch = structuredClone(blocked);
  mismatch.candidateEvaluations[0].files = 'wrong.py';
  mismatch.agent.currentAction.risk = 'low';
  const rejected = await candidateActionService.applyCandidate({ state: mismatch, candidateId: mismatch.candidateEvaluations[0].id });
  assert.deepEqual(rejected.agent.patchPolicyRejection.checks.filter(check => !check.passed).map(check => check.id), ['patch.diff.matches']);
  assert.equal(writes, 0, 'non-risk admission failures also remain effect-free');

  const storageError = new Error('journal storage unavailable');
  const brokenJournal = createAutopilotCandidateActionService({ executeCommand, journal: { ...journal, patch: async () => { throw storageError; } }, saveState: persistState, registry });
  const storageState = structuredClone(blocked);
  delete storageState.agent.patchPolicyRejection;
  await assert.rejects(brokenJournal.applyCandidate({ state: storageState, candidateId: storageState.candidateEvaluations[0].id }), error => error === storageError);
  assert.equal(storageState.agent.patchPolicyRejection, undefined, 'failed journal persistence cannot be reported as a saved policy outcome');
  // Remove only this test's deliberately orphaned, effect-free intent so the
  // following independent positive can use the same fixture journal.
  const orphan = (await journal.readAll()).at(-1);
  assert.equal(orphan.effectStarted, false);
  await journal.patch(orphan.seq, { status: 'failed', failurePhase: 'prepare' });

  // Low risk still goes through the unchanged actual command policy/effects.
  const admitted = structuredClone(blocked);
  admitted.missionPaused = false;
  admitted.iterationStats = { round: 0, loopStatus: 'running' };
  admitted.agent.status = 'awaiting_action';
  admitted.agent.currentAction.risk = 'low';
  delete admitted.agent.patchPolicyRejection;
  const applied = await autopilot.advance(admitted);
  assert.equal(applied.action, 'candidate_applied');
  assert.equal(applied.state.patchApplied, true);
  assert.equal(applied.state.stage, 'validation');
  assert.ok(writes > 0);

  // Unexpected failures (even a lookalike wire code) must still propagate.
  for (const error of [new Error('disk unavailable'), Object.assign(new Error('untrusted code'), { code: 'PATCH_POLICY_CHECK_FAILED', status: 409, details: [] })]) {
    const failing = createAutopilotCandidateActionService({ executeCommand: async () => { throw error; } });
    const state = structuredClone(base);
    await assert.rejects(failing.applyCandidate({ state, candidateId: 'candidate' }), value => value === error);
    assert.deepEqual(state, base);
  }
  console.log('[autopilot-candidate-action-service] durable policy rejection, restart, model projection, stop and normal admission passed');
} finally {
  await rm(root, { recursive: true, force: true });
}
