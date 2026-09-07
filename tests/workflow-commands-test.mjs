import assert from 'node:assert/strict';
import path from 'node:path';
import { createCandidateCommands } from '../client-runtime/application/candidate-commands.mjs';
import { createAgentCommands } from '../client-runtime/application/agent-commands.mjs';
import { createDecisionCommands } from '../client-runtime/application/decision-commands.mjs';
import { createWorkflowCommandPolicy } from '../client-runtime/application/workflow-command-policy.mjs';
import { hashKey } from '../client-runtime/command-journal.mjs';

let effects = 0;
let writes = 0;
const runEffect = async (operation) => { effects += 1; return operation(); };
const events = [];
const appendRuntimeEvent = (state, type) => events.push(type);
const addAuditEvent = () => {};
const isManagedWorkspaceRuntimeMode = (mode) => mode === 'managed';
const diff = { dirty: true, diff: 'verified diff', digest: 'sha256:verified', changedFiles: ['run.py'], workspace: '/workspace' };
const candidateCommands = createCandidateCommands({
  addAuditEvent, appendRuntimeEvent, isManagedWorkspaceRuntimeMode, path, rootDir: '/',
  agentRuntime: { describe: async () => ({ mode: 'managed' }) },
  workspaceManager: { captureDiff: async () => structuredClone(diff) },
  ensureMissionWorkspace: async () => '/workspace',
  createWorkspaceCheckpoint: async () => { writes += 1; return { id: 'checkpoint' }; },
  artifactDirForMission: () => '/artifacts',
  mkdir: async () => { writes += 1; }, writeFile: async () => { writes += 1; },
});
const state = { activeMissionId: 'mission', missions: [{ id: 'mission' }], candidateEvaluations: [{ id: 'candidate', files: 'wrong.py' }], agent: { runId: 'agent', messages: [] } };
await assert.rejects(candidateCommands['apply-patch'].prepare({ state, body: { candidate: 'candidate' }, runEffect }), (error) => error.code === 'PATCH_POLICY_CHECK_FAILED');
assert.equal(effects, 0);
assert.equal(writes, 0, 'candidate admission must happen before mutations');
state.candidateEvaluations[0].files = 'run.py';
const patch = await candidateCommands['apply-patch'].prepare({ state, body: { candidate: 'candidate' }, runEffect });
assert.equal(effects, 1);
assert.equal(writes, 4);
const beforeApply = writes;
candidateCommands['apply-patch'].apply(state, patch.payload);
assert.equal(writes, beforeApply, 'command apply must not write files');
assert.equal(state.appliedCandidateId, 'candidate');
assert.equal(state.candidateEvaluations[0].patchDigest, diff.digest);
assert.equal(state.stage, 'validation');

let ready = false;
let starts = 0;
const agentCommands = createAgentCommands({
  addAuditEvent, appendRuntimeEvent, isManagedWorkspaceRuntimeMode, hashKey,
  agentRuntime: {
    describe: async () => ({ mode: 'managed' }),
    startRun: async ({ state }) => { starts += 1; state.agent = { runId: 'run', runtimeKind: 'managed' }; return { handled: true }; },
  },
  buildRuntimePreflight: async () => ({ ready, workspace: '/workspace', workspaceCheck: { detail: 'missing', code: 'WORKSPACE_MISSING' } }),
  resetMissionRunState: (state, goal) => { state.agent = { goal }; },
  createWorkspaceCheckpoint: async () => ({ id: 'agent-checkpoint' }),
});
const agentState = { activeMissionId: 'mission', missions: [{ id: 'mission', goal: 'optimize' }], runtimeEvents: [] };
const effectsBeforeAgent = effects;
await assert.rejects(agentCommands.runs.prepare({ state: agentState, body: {}, runEffect }), (error) => error.code === 'WORKSPACE_MISSING');
assert.equal(effects, effectsBeforeAgent);
assert.equal(starts, 0);
ready = true;
const run = await agentCommands.runs.prepare({ state: agentState, body: {}, runEffect });
assert.equal(starts, 1);
assert.equal(effects, effectsBeforeAgent + 2, 'checkpoint and Agent launch must be journaled effects');
agentCommands.runs.apply(agentState, run.payload);
assert.equal(starts, 1);
assert.equal(agentState.agent.runId, 'run');

const decisions = createDecisionCommands({
  addAuditEvent, appendRuntimeEvent,
  createDecisionReviewState: (status) => ({ status }),
  interventionOutcomeMeta: { adopt: { label: 'adopt', expectedOutput: 'decision' } },
});
await assert.rejects(decisions['request-review'].prepare({ state: { stage: 'candidate' }, body: { outcome: 'adopt', note: 'review' } }), (error) => error.code === 'INTERVENTION_OUTCOME_UNAVAILABLE');
const reviewState = { stage: 'evidence', appliedCandidateId: 'candidate', agent: { messages: [] } };
const review = await decisions['request-review'].prepare({ state: reviewState, body: { outcome: 'adopt', note: 'review evidence' } });
decisions['request-review'].apply(reviewState, review.payload);
assert.equal(reviewState.decisionReview.status, 'awaiting_review');
assert.equal(reviewState.agent.currentAction.type, 'review.resolve');
assert.ok(events.includes('decision.review_requested'));

const now = new Date('2026-09-06T00:00:01.000Z');
const policy = createWorkflowCommandPolicy({ normalizeMissionBudgetMs: (value) => Number(value) > 0 ? Number(value) : null, now: () => now });
const budget = { missionBudgetMs: 500 };
policy.guardMutation(budget);
assert.equal(budget.missionBudgetStartedAt, now.toISOString());
assert.throws(() => policy.guardMutation({ missionBudgetMs: 500, missionBudgetStartedAt: '2026-09-06T00:00:00.000Z' }), (error) => error.code === 'MISSION_BUDGET_EXCEEDED');
assert.throws(() => policy.guardWorkflowTransition({ stage: 'candidate' }, { stages: ['evidence'], label: 'adoption' }), (error) => error.code === 'INVALID_WORKFLOW_TRANSITION');
assert.deepEqual(policy.validateMissionBudgetInput(null), { ok: true, value: null });
assert.deepEqual(policy.validateMissionBudgetInput(-1), { ok: false, value: null });
console.log('[workflow-commands] Candidate admission, effect boundaries, Agent launch, review transitions and budget guards passed');
