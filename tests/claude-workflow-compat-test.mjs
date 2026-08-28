import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { createAgentRuntime } from '../client-runtime/agent-runtime.mjs';

const execFileAsync = promisify(execFile);
const root = await mkdtemp(path.join(os.tmpdir(), 'operator-claude-workflow-'));
const sourceRoot = path.join(root, 'sources');
const sourceRepository = path.join(sourceRoot, 'flashinfer');
const researchDir = path.join(root, 'research');
const materializationDir = path.join(root, 'baseline');
const workspace = path.join(root, 'workspace');
const canonicalRepository = 'https://github.com/flashinfer-ai/flashinfer.git';
const runPy = [
  '# MLA paged attention baseline',
  'def get_inputs():',
  '    return {"page_ids": [0], "block_table": [0]}',
  '',
  'def run(inputs):',
  '    return inputs["page_ids"]',
  '',
  'def reference(inputs):',
  '    return inputs["page_ids"]',
  '',
].join('\n');

const initializeRepository = async (directory) => {
  await mkdir(directory, { recursive: true });
  for (const args of [
    ['init'],
    ['config', 'user.name', 'Claude compatibility test'],
    ['config', 'user.email', 'claude-test@local.invalid'],
  ]) await execFileAsync('git', args, { cwd: directory, windowsHide: true });
};

const runs = new Map();
let ordinal = 0;
const claudeClient = {
  describe: async () => ({ installed: true, loggedIn: null, version: 'claude-code compatibility fixture' }),
  preflight: async ({ workspace: target }) => ({ ready: true, code: 'CLAUDE_READY', workspace: target }),
  start: async (args) => {
    ordinal += 1;
    const role = args.environment.OPERATOR_AGENT_ROLE;
    const record = { ...args, role, threadId: `session-${ordinal}`, startedAt: new Date().toISOString(), status: 'completed' };
    runs.set(args.runId, record);
    if (role === 'iteration') await writeFile(path.join(args.workspace, 'run.py'), runPy.replace('baseline', 'candidate'), 'utf8');
    return record;
  },
  readRun: async (runId) => {
    const run = runs.get(runId);
    return { runId, status: 'completed', completedAt: new Date().toISOString(), threadId: run.threadId, workspace: run.workspace, error: null };
  },
  readEvents: async (runId) => {
    const run = runs.get(runId);
    let result;
    if (run.role === 'research-synthesize') {
      result = {
        schemaVersion: 'operator-studio.research-notes/v1',
        summary: 'verified FlashInfer MLA source',
        findings: ['MLA paged attention semantics fixed'],
        suggestedDirections: ['preserve page table semantics'],
        sources: [{ title: 'FlashInfer', url: canonicalRepository, type: 'source' }],
        baselineSources: [{ authority: 'upstream', repository: canonicalRepository, commit: source.commit, path: source.path, operator: 'mla_paged_attention', confidence: 'high' }],
      };
    } else if (run.role === 'materializer') {
      result = { schemaVersion: 'operator-studio.baseline-materializer-result/v1', summary: 'baseline materialized', runPy, report: { summary: 'single-file baseline', sourceFiles: [source.path], assumptions: [] } };
    } else {
      result = {
        schemaVersion: 'operator-studio.agent-result/v1',
        summary: 'candidate ready',
        candidates: [{ id: 'candidate-claude', title: 'Claude candidate', files: ['run.py'], sourceReferences: [{ repository: canonicalRepository, commit: source.commit, path: source.path }] }],
        recommendedCandidate: 'candidate-claude',
        nextAction: { type: 'candidate.plan', title: 'Test candidate', reason: 'workspace diff ready', expectedOutput: 'C500 evidence', risk: 'medium' },
      };
    }
    return [
      { type: 'thread.started', thread_id: run.threadId, provider: 'claude-code' },
      { type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify(result) }, provider: 'claude-code' },
      { type: 'turn.completed', provider: 'claude-code' },
    ];
  },
  cancel: async (runId) => ({ runId, status: 'cancel_requested' }),
  eventText: (event) => event.item?.text || event.error?.message || '',
};

let source;
try {
  await initializeRepository(sourceRepository);
  await mkdir(path.join(sourceRepository, 'flashinfer'), { recursive: true });
  await writeFile(path.join(sourceRepository, 'flashinfer', 'mla.py'), '# MLA paged attention page_ids block_table\n', 'utf8');
  await execFileAsync('git', ['add', '-A'], { cwd: sourceRepository, windowsHide: true });
  await execFileAsync('git', ['commit', '-m', 'source fixture'], { cwd: sourceRepository, windowsHide: true });
  await execFileAsync('git', ['remote', 'add', 'origin', canonicalRepository], { cwd: sourceRepository, windowsHide: true });
  source = {
    authority: 'upstream',
    repository: canonicalRepository,
    commit: (await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: sourceRepository, windowsHide: true })).stdout.trim(),
    path: 'flashinfer/mla.py',
    operator: 'mla_paged_attention',
  };

  await initializeRepository(workspace);
  await writeFile(path.join(workspace, 'MISSION.md'), '# Claude compatibility mission\n', 'utf8');
  await execFileAsync('git', ['add', '-A'], { cwd: workspace, windowsHide: true });
  await execFileAsync('git', ['commit', '-m', 'mission'], { cwd: workspace, windowsHide: true });
  await mkdir(researchDir, { recursive: true });
  await writeFile(path.join(researchDir, 'acquisition-result.json'), `${JSON.stringify({ schemaVersion: 1, acquired: [{ ...source, evidence: [{ path: source.path, content: '# MLA paged attention' }] }] })}\n`, 'utf8');

  const mission = {
    id: 'MIS_CLAUDE_COMPAT',
    title: 'FlashInfer MLA paged attention',
    goal: 'Optimize MLA paged attention for MetaX C500',
    repository: workspace,
    sourceRoot,
    hardware: ['C500'],
    metric: 'latency p50',
    sourcePolicy: { mode: 'agent-research-only', strictZeroSource: true },
  };
  const state = {
    activeMissionId: mission.id,
    missions: [mission],
    runtimeEvents: [],
    stage: 'diagnosis',
    patchApplied: false,
    candidateEvaluations: [],
    agent: { status: 'idle' },
    researchAgent: null,
    researchNotes: [],
    baseline: { required: true, status: 'missing', kind: 'pytorch_reference' },
    testMatrix: { environments: ['C500'], correctnessCases: 1, warmup: 1, repeats: 1 },
    iterationStats: { round: 0 },
  };
  const runtime = createAgentRuntime({ mode: 'claude-code', claudeClient, codexWorkspace: root });
  const descriptor = await runtime.describe();
  assert.equal(descriptor.connected, true);
  assert.equal(descriptor.stallTimeoutMs, 5 * 60 * 1000);
  assert.equal((await runtime.preflight({ workspace })).ready, true);

  await runtime.startResearch({ state, mission, direction: 'synthesize verified MLA evidence', workspace: researchDir, synchronous: true, runPhase: 'synthesize' });
  await runtime.projectState(state);
  assert.equal(state.researchAgent.status, 'completed');
  assert.equal(state.researchNotes[0].baselineSources[0].repository, canonicalRepository);

  await runtime.startBaselineMaterialization({ state, mission, source, matrix: state.testMatrix, workspace: materializationDir });
  await runtime.projectState(state);
  assert.equal(state.baseline.materializer.status, 'completed');
  assert.equal(state.baseline.materializer.result.runPy, runPy);

  state.baseline.status = 'complete';
  await runtime.startRun({ state, mission, goal: mission.goal, workspace });
  const iterationRun = [...runs.values()].find((run) => run.role === 'iteration');
  assert.match(iterationRun.goal, /Workspace file inventory at run start \(authoritative\):/);
  assert.match(iterationRun.goal, /- MISSION\.md/);
  assert.match(iterationRun.goal, /run\.py may therefore be absent/);
  assert.match(iterationRun.goal, /Do not Read or Edit an absent path: create it directly/);
  await runtime.projectState(state);
  assert.equal(state.agent.runtimeKind, 'claude-code');
  assert.equal(state.agent.status, 'awaiting_action');
  assert.equal(state.candidateEvaluations.length, 1);
  assert.equal(state.candidateEvaluations[0].source, 'claude-agent');
  assert.match(state.candidateEvaluations[0].patchDigest, /^sha256:[a-f0-9]{64}$/);
  assert.equal(state.agent.candidateValidation.code, 'CLAUDE_CANDIDATE_DIFF_VERIFIED');
  assert.deepEqual([...runs.values()].map((run) => run.role), ['research-synthesize', 'materializer', 'iteration']);
  await runtime.projectState(state);
  assert.equal(state.runtimeEvents.filter((event) => event.type === 'claude.run_completed' && event.payload?.runId === state.agent.runId).length, 1);

  const failedWorkspace = path.join(root, 'failed-workspace');
  await initializeRepository(failedWorkspace);
  await writeFile(path.join(failedWorkspace, 'MISSION.md'), '# cold-start failure fixture\n', 'utf8');
  await execFileAsync('git', ['add', '-A'], { cwd: failedWorkspace, windowsHide: true });
  await execFileAsync('git', ['commit', '-m', 'cold-start mission'], { cwd: failedWorkspace, windowsHide: true });
  const failedRunId = 'claude_FILE_MISSING';
  const failedRuntime = createAgentRuntime({
    mode: 'claude-code',
    claudeClient: {
      describe: async () => ({ installed: true, officialLoginDetected: true, version: 'claude-code failure fixture' }),
      readRun: async () => ({ runId: failedRunId, status: 'failed', completedAt: new Date().toISOString(), threadId: 'session-file-missing', workspace: failedWorkspace, error: { code: 'CLAUDE_EXEC_FAILED', message: 'File does not exist: run.py' } }),
      readEvents: async () => [{ type: 'item.completed', item: { type: 'command_execution', status: 'failed', output: 'File does not exist: run.py' } }],
      eventText: (event) => event.item?.output || '',
    },
    codexWorkspace: root,
  });
  const failedState = {
    activeMissionId: mission.id,
    missions: [mission],
    runtimeEvents: [],
    stage: 'diagnosis',
    patchApplied: false,
    candidateEvaluations: [],
    baseline: { status: 'complete' },
    agent: { status: 'running', runtimeKind: 'claude-code', runId: failedRunId, startedAt: new Date().toISOString(), eventCount: 0, messages: [], toolCalls: [], artifacts: [] },
  };
  await failedRuntime.projectState(failedState);
  assert.equal(failedState.agent.status, 'completed');
  assert.equal(failedState.stage, 'diagnosis');
  assert.equal(failedState.candidateEvaluations.length, 0);
  assert.match(failedState.agent.phase, /等待同轮重试/);
  assert.equal(failedState.runtimeEvents.find((event) => event.type === 'candidate.not_proposed')?.payload?.recoverable, true);

  const salvagedWorkspace = path.join(root, 'salvaged-workspace');
  await initializeRepository(salvagedWorkspace);
  await writeFile(path.join(salvagedWorkspace, 'MISSION.md'), '# salvage fixture\n', 'utf8');
  await execFileAsync('git', ['add', '-A'], { cwd: salvagedWorkspace, windowsHide: true });
  await execFileAsync('git', ['commit', '-m', 'salvage mission'], { cwd: salvagedWorkspace, windowsHide: true });
  await writeFile(path.join(salvagedWorkspace, 'run.py'), runPy.replace('baseline', 'salvaged candidate'), 'utf8');
  const salvagedRunId = 'claude_FAILED_AFTER_WRITE';
  const salvagedRuntime = createAgentRuntime({
    mode: 'claude-code',
    claudeClient: {
      describe: async () => ({ installed: true, officialLoginDetected: true, version: 'claude-code salvage fixture' }),
      readRun: async () => ({ runId: salvagedRunId, status: 'failed', completedAt: new Date().toISOString(), threadId: 'session-failed-after-write', workspace: salvagedWorkspace, error: { code: 'CLAUDE_EXEC_FAILED', message: 'File does not exist: report.md' } }),
      readEvents: async () => [{ type: 'item.completed', item: { type: 'command_execution', status: 'failed', output: 'File does not exist: report.md' } }],
      eventText: (event) => event.item?.output || '',
    },
    codexWorkspace: root,
  });
  const salvagedState = {
    activeMissionId: 'MIS_SALVAGE',
    missions: [{ id: 'MIS_SALVAGE', title: 'Salvage candidate', repository: salvagedWorkspace, hardware: ['C500'], metric: 'latency p50' }],
    runtimeEvents: [],
    stage: 'diagnosis',
    patchApplied: false,
    candidateEvaluations: [],
    baseline: { status: 'complete' },
    iterationStats: { round: 0 },
    agent: { status: 'running', runtimeKind: 'claude-code', runId: salvagedRunId, startedAt: new Date().toISOString(), eventCount: 0, messages: [], toolCalls: [], artifacts: [] },
  };
  await salvagedRuntime.projectState(salvagedState);
  assert.equal(salvagedState.agent.status, 'awaiting_action');
  assert.equal(salvagedState.stage, 'candidate');
  assert.equal(salvagedState.candidateEvaluations[0].id, 'candidate-01');
  assert.equal(salvagedState.agent.candidateValidation.code, 'CLAUDE_CANDIDATE_DIFF_OBSERVED');

  console.log('[claude-workflow-compat] research, materializer, and candidate diff loop passed');
} finally {
  await rm(root, { recursive: true, force: true });
}
