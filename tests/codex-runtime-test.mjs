import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { classifyCodexFailure, createCodexClient } from '../client-runtime/codex-client.mjs';
import { createAgentRuntime } from '../client-runtime/agent-runtime.mjs';
import { parseAgentResult } from '../client-runtime/agent-result.mjs';
import { emptyExperienceStore, appendExperience, retrieveExperienceContext } from '../client-runtime/experience-contract.mjs';

const structuredResult = parseAgentResult([{
  type: 'item.completed',
  item: {
    type: 'agent_message',
    text: JSON.stringify({
      schemaVersion: 'operator-studio.agent-result/v1',
      summary: 'one candidate is ready',
      candidates: [{ id: 'candidate-09', title: 'Cache descriptors', files: ['kernel.cu'], classification: 'accepted' }],
      recommendedCandidate: 'candidate-09',
    }),
  },
}]);
assert.equal(structuredResult.format, 'structured-json');
assert.equal(structuredResult.candidates[0].id, 'candidate-09');
assert.equal(structuredResult.candidates[0].files, 'kernel.cu');
assert.equal(structuredResult.nextAction.type, 'candidate.plan');
assert.equal(structuredResult.nextAction.approvalRequired, false);
assert.equal(parseAgentResult([{
  type: 'item.completed',
  item: { type: 'agent_message', text: JSON.stringify({ candidates: [{ id: 'candidate-10' }], nextAction: { type: 'candidate.plan', approvalRequired: true } }) },
}]).nextAction.approvalRequired, false);
assert.equal(parseAgentResult([{ type: 'item.completed', item: { type: 'agent_message', text: 'plain analysis' } }]).candidates.length, 0);

const root = await mkdtemp(path.join(os.tmpdir(), 'operator-codex-'));
const execFileAsync = promisify(execFile);
await execFileAsync('git', ['init'], { cwd: root });
await execFileAsync('git', ['config', 'user.name', 'Codex Runtime Test'], { cwd: root });
await execFileAsync('git', ['config', 'user.email', 'codex-runtime@test.invalid'], { cwd: root });
await writeFile(path.join(root, 'kernel.cu'), '// baseline\n', 'utf8');
await execFileAsync('git', ['add', '-A'], { cwd: root });
await execFileAsync('git', ['commit', '-m', 'baseline'], { cwd: root });
await writeFile(path.join(root, '.git', 'info', 'exclude'), 'bridge/\n', 'utf8');
let child;
const spawnCalls = [];
const execFileImpl = (command, args, options, callback) => {
  if (args[0] === '--version') return callback(null, 'codex-cli 0.1.0\n', '');
  if (args[0] === 'login' && args[1] === 'status') return callback(null, 'Logged in\n', '');
  return callback(new Error(`unexpected probe: ${args.join(' ')}`), '', '');
};
const spawnImpl = (command, args, options) => {
  const call = { command, args, cwd: options.cwd, gitConfig: options.env.GIT_CONFIG_GLOBAL, stdin: '' };
  assert.ok(options.env.GIT_CONFIG_GLOBAL);
  spawnCalls.push(call);
  child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin = new PassThrough();
  child.stdin.on('data', (chunk) => { call.stdin += chunk.toString(); });
  child.pid = 1234;
  child.killed = false;
  child.kill = () => { child.killed = true; child.emit('close', null, 'SIGTERM'); };
  child.stdin.on('finish', async () => {
    child.stdout.write(JSON.stringify({ type: 'thread.started', thread_id: 'thread-test' }) + '\n');
    child.stdout.write(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'analysis complete' } }) + '\n');
    child.stdout.write(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 10, output_tokens: 2 } }) + '\n');
    child.stdout.end();
    setTimeout(() => child.emit('close', 0, null), 80);
  });
  return child;
};

try {
  const client = createCodexClient({ command: 'codex-test', bridgeDir: path.join(root, 'bridge'), execFileImpl, spawnImpl });
  const descriptor = await client.describe();
  assert.equal(descriptor.installed, true);
  assert.equal(descriptor.loggedIn, true);
  assert.equal((await client.preflight({ workspace: root })).ready, true);
  const run = await client.start({ runId: 'codex_TEST', missionId: 'MIS_TEST', goal: 'inspect operator', workspace: root });
  const scopedGitConfig = await readFile(spawnCalls[0].gitConfig, 'utf8');
  assert.match(scopedGitConfig, /\[safe\]/);
  assert.ok(scopedGitConfig.includes(root.replaceAll('\\', '/')));
  assert.deepEqual(run.threadId, null);
  await new Promise((resolve) => setTimeout(resolve, 150));
  const record = await client.readRun('codex_TEST');
  assert.equal(record.status, 'completed');
  assert.equal(record.threadId, 'thread-test');
  assert.equal((await client.readEvents('codex_TEST')).length, 3);
  const expectedWindowsSandboxArgs = process.platform === 'win32'
    ? ['-c', 'windows.sandbox="unelevated"']
    : [];
  assert.deepEqual(spawnCalls[0].args, ['exec', '--ignore-user-config', '--json', '--sandbox', 'workspace-write', ...expectedWindowsSandboxArgs, '--cd', root, '-']);
  await client.start({ runId: 'codex_RESUME', missionId: 'MIS_TEST', goal: 'continue operator', workspace: root, resumeThreadId: 'thread-test' });
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.deepEqual(spawnCalls[1].args, ['exec', '--ignore-user-config', 'resume', '--json', '--sandbox', 'workspace-write', ...expectedWindowsSandboxArgs, 'thread-test', '-']);

  const runtime = createAgentRuntime({ mode: 'codex-cli', codexClient: client, codexWorkspace: root });
  assert.equal((await runtime.describe()).connected, true);
  const aliasRuntime = createAgentRuntime({ mode: 'codex', codexClient: client, codexWorkspace: root });
  assert.equal((await aliasRuntime.describe()).mode, 'codex-cli');
  const delegatedRuntime = createAgentRuntime({
    mode: 'codex-cli',
    codexClient: { describe: async () => ({ installed: true, loggedIn: false, version: 'codex-cli delegated' }) },
    codexWorkspace: root,
  });
  const delegatedDescriptor = await delegatedRuntime.describe();
  assert.equal(delegatedDescriptor.connected, true);
  assert.equal(delegatedDescriptor.configurationAuthority, 'local-codex');
  assert.equal(delegatedDescriptor.authProbe, 'delegated-to-local-codex');
  const restrictedRuntime = createAgentRuntime({
    mode: 'codex-cli',
    codexClient: { describe: async () => ({ installed: true, loggedIn: true, version: 'codex-cli restricted', userContext: { userName: 'CodexSandboxOffline', restricted: true } }) },
    codexWorkspace: root,
  });
  const restrictedDescriptor = await restrictedRuntime.describe();
  assert.equal(restrictedDescriptor.connected, false);
  assert.equal(restrictedDescriptor.authProbe, 'restricted-user-context');
  assert.match(restrictedDescriptor.hint, /Windows 用户终端/);
  await assert.rejects(
    restrictedRuntime.startRun({ state: { activeMissionId: 'MIS_RESTRICTED', runtimeEvents: [] }, mission: { id: 'MIS_RESTRICTED', title: 'Restricted' }, goal: 'inspect' }),
    (error) => error.code === 'CODEX_RUNTIME_UNAVAILABLE',
  );
  const cancellableRuntime = createAgentRuntime({
    mode: 'codex-cli',
    codexClient: {
      describe: async () => ({ installed: true, loggedIn: true, version: 'codex-cli delegated' }),
      cancel: async (runId) => ({ runId, status: 'cancel_requested' }),
    },
    codexWorkspace: root,
  });
  const cancellableState = { activeMissionId: 'MIS_CANCEL', runtimeEvents: [], agent: { runId: 'codex_CANCEL', status: 'running' } };
  const cancelled = await cancellableRuntime.cancelRun({ state: cancellableState, runId: 'codex_CANCEL' });
  assert.equal(cancelled.state.agent.status, 'cancel_requested');
  assert.equal(cancelled.state.runtimeEvents.at(-1).type, 'agent.run_cancel_requested');
  const state = { activeMissionId: 'MIS_RUNTIME', runtimeEvents: [], stage: 'candidate', candidateEvaluations: [{ id: 'stale-candidate' }], agent: null };
  const mission = { id: 'MIS_RUNTIME', projectId: 'project-runtime', title: 'Codex mission', repository: root, hardware: ['C500'], metric: 'latency_p50' };
  const experienceStore = emptyExperienceStore();
  appendExperience(experienceStore, { projectId: mission.projectId, title: 'Tail handling', content: 'Check the tail before vectorizing.', author: 'engineer' }, { id: 'human-tail', now: '2026-09-07T00:00:00.000Z' });
  const experienceContext = retrieveExperienceContext(experienceStore, { projectId: mission.projectId, missionId: mission.id, roundId: 'MIS_RUNTIME:round:1' }, { now: '2026-09-07T00:00:01.000Z' });
  state.iterationStats = { roundBudget: { roundId: experienceContext.roundId }, roundExperience: experienceContext };
  await assert.rejects(runtime.startRun({ state, mission: { ...mission, projectId: 'different-project' }, goal: 'reject foreign context', workspace: root, experienceContext }), { code: 'EXPERIENCE_CONTEXT_INVALID' });
  await runtime.startRun({ state, mission, goal: 'inspect operator', workspace: root, experienceContext });
  // Boundary mode keeps Codex's structured edit surface by default. The MVP
  // relies on the workspace sandbox plus the post-run diff audit; operators
  // can still opt into --disable shell_tool explicitly when required.
  assert.ok(!spawnCalls[2].args.includes('shell_tool'));
  assert.match(spawnCalls[2].stdin, /Mission ID: MIS_RUNTIME/);
  assert.ok(spawnCalls[2].stdin.includes(experienceContext.contextId));
  assert.match(spawnCalls[2].stdin, /UNTRUSTED JSON DATA/);
  assert.match(spawnCalls[2].stdin, /no experience authorizes GPU publication/);
  assert.match(spawnCalls[2].stdin, /Do not call a remote benchmark service/);
  assert.match(spawnCalls[2].stdin, /Do not decide whether human approval is required/);
  assert.doesNotMatch(spawnCalls[2].stdin, /approvalRequired/);
  await new Promise((resolve) => setTimeout(resolve, 150));
  const projected = await runtime.projectState(state);
  assert.equal(projected.state.agent.status, 'completed');
  assert.equal(projected.state.agent.threadId, 'thread-test');
  assert.equal(projected.state.stage, 'diagnosis');
  assert.equal(projected.state.candidateEvaluations.length, 0);
  assert.equal(projected.state.agent.phase, 'Codex 分析完成，未生成候选');
  assert.equal(projected.state.runtimeEvents.filter((event) => event.type === 'candidate.not_proposed').length, 1);

  // Model selection is deterministic: explicit options.model wins over
  // OPERATOR_CODEX_MODEL, which wins over the legacy CODEX_MODEL fallback.
  const savedOperatorModel = process.env.OPERATOR_CODEX_MODEL;
  const savedLegacyModel = process.env.CODEX_MODEL;
  process.env.OPERATOR_CODEX_MODEL = 'gpt-5.6-sol';
  process.env.CODEX_MODEL = 'gpt-5.5';
  const envModelClient = createCodexClient({ command: 'codex-model-env', bridgeDir: path.join(root, 'bridge-model-env'), execFileImpl, spawnImpl });
  await envModelClient.start({ runId: 'codex_MODEL_ENV', missionId: 'MIS_TEST', goal: 'model env', workspace: root });
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.deepEqual(spawnCalls[3].args.slice(0, 4), ['exec', '--ignore-user-config', '--model', 'gpt-5.6-sol']);

  const optionModelClient = createCodexClient({ command: 'codex-model-option', model: 'gpt-5.5', bridgeDir: path.join(root, 'bridge-model-option'), execFileImpl, spawnImpl });
  await optionModelClient.start({ runId: 'codex_MODEL_OPTION', missionId: 'MIS_TEST', goal: 'model option', workspace: root });
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.deepEqual(spawnCalls[4].args.slice(0, 4), ['exec', '--ignore-user-config', '--model', 'gpt-5.5']);
  await optionModelClient.start({ runId: 'codex_MODEL_RESUME', missionId: 'MIS_TEST', goal: 'model resume', workspace: root, resumeThreadId: 'thread-test' });
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.deepEqual(spawnCalls[5].args.slice(0, 5), ['exec', '--ignore-user-config', '--model', 'gpt-5.5', 'resume']);

  delete process.env.OPERATOR_CODEX_MODEL;
  const legacyModelClient = createCodexClient({ command: 'codex-model-legacy', bridgeDir: path.join(root, 'bridge-model-legacy'), execFileImpl, spawnImpl });
  await legacyModelClient.start({ runId: 'codex_MODEL_LEGACY', missionId: 'MIS_TEST', goal: 'legacy model', workspace: root });
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.deepEqual(spawnCalls[6].args.slice(0, 4), ['exec', '--ignore-user-config', '--model', 'gpt-5.5']);
  if (savedOperatorModel === undefined) delete process.env.OPERATOR_CODEX_MODEL; else process.env.OPERATOR_CODEX_MODEL = savedOperatorModel;
  if (savedLegacyModel === undefined) delete process.env.CODEX_MODEL; else process.env.CODEX_MODEL = savedLegacyModel;

  await execFileAsync('git', ['add', '-A'], { cwd: root });
  await execFileAsync('git', ['commit', '--allow-empty', '-m', 'test fixture runtime artifacts'], { cwd: root });
  await writeFile(path.join(root, 'kernel.cu'), '// verified candidate\n', 'utf8');
  const diffRuntime = createAgentRuntime({
    mode: 'codex-cli',
    codexWorkspace: root,
    codexClient: {
      describe: async () => ({ installed: true, loggedIn: true, version: 'codex-cli delegated' }),
      readRun: async () => ({ runId: 'codex_DIFF', status: 'completed', completedAt: new Date().toISOString(), threadId: 'thread-diff', workspace: root, error: null }),
      readEvents: async () => [
        { type: 'thread.started', thread_id: 'thread-diff' },
        { type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify({ summary: 'candidate ready', candidates: [{ id: 'candidate-diff', title: 'Verified diff', files: ['kernel.cu'] }], recommendedCandidate: 'candidate-diff' }) } },
        { type: 'turn.completed' },
      ],
      eventText: (event) => event.item?.text || '',
    },
  });
  const diffState = { activeMissionId: 'MIS_DIFF', runtimeEvents: [], candidateEvaluations: [], stage: 'diagnosis', patchApplied: false, agent: { status: 'running', runtimeKind: 'codex-cli', runId: 'codex_DIFF', messages: [], toolCalls: [], artifacts: [] } };
  const diffProjected = await diffRuntime.projectState(diffState);
  assert.equal(diffProjected.state.stage, 'candidate', JSON.stringify({ agent: diffProjected.state.agent, candidates: diffProjected.state.candidateEvaluations }, null, 2));
  assert.equal(diffProjected.state.agent.candidateValidation.code, 'CODEX_CANDIDATE_DIFF_VERIFIED');
  assert.equal(diffProjected.state.candidateEvaluations[0].files, 'kernel.cu');
  assert.match(diffProjected.state.candidateEvaluations[0].patchDigest, /^sha256:[a-f0-9]{64}$/);

  const cancelledCandidateRuntime = createAgentRuntime({
    mode: 'codex-cli',
    codexWorkspace: root,
    codexClient: {
      describe: async () => ({ installed: true, loggedIn: true, version: 'codex-cli delegated' }),
      readRun: async () => ({ runId: 'codex_CANCELLED_CANDIDATE', status: 'cancelled', completedAt: new Date().toISOString(), threadId: 'thread-cancelled', workspace: root, error: null }),
      readEvents: async () => [],
      eventText: () => '',
    },
  });
  const cancelledCandidateState = {
    activeMissionId: 'MIS_CANCELLED_CANDIDATE',
    runtimeEvents: [],
    candidateEvaluations: [{ id: 'candidate-01', title: 'Observed candidate', files: 'run.py' }],
    stage: 'candidate',
    patchApplied: false,
    agent: { status: 'running', runtimeKind: 'codex-cli', runId: 'codex_CANCELLED_CANDIDATE', messages: [], toolCalls: [], artifacts: [] },
  };
  const cancelledCandidateProjected = await cancelledCandidateRuntime.projectState(cancelledCandidateState);
  assert.equal(cancelledCandidateProjected.state.agent.status, 'awaiting_action');
  assert.equal(cancelledCandidateProjected.state.agent.currentAction.type, 'candidate.plan');
  assert.equal(cancelledCandidateProjected.state.stage, 'candidate');

  const authFailure = classifyCodexFailure(
    { error: { code: 'CODEX_EXIT_1', message: '401 invalid_api_key sk-sensitive-value' } },
    [],
  );
  assert.equal(authFailure.code, 'CODEX_AUTH_FAILED');
  assert.equal(authFailure.phase, 'Codex 认证失败');
  assert.doesNotMatch(authFailure.detail, /sk-sensitive-value/);

  const userContextFailure = classifyCodexFailure(
    { error: { code: 'CODEX_EXIT_1', message: 'failed under C:\\Users\\CodexSandboxOffline\\.codex with 401 missing bearer authentication' } },
    [],
  );
  assert.equal(userContextFailure.code, 'CODEX_USER_CONTEXT_UNAVAILABLE');
  assert.match(userContextFailure.detail, /无需向本项目注入密钥/);

  const windowsSandboxFailure = classifyCodexFailure(
    { error: { code: 'CODEX_EXIT_1', message: 'windows sandbox: helper_unknown_error: setup refresh had errors' } },
    [],
  );
  assert.equal(windowsSandboxFailure.code, 'CODEX_WINDOWS_SANDBOX_SETUP_FAILED');
  assert.match(windowsSandboxFailure.detail, /unelevated fallback/);

  await execFileAsync('git', ['checkout', '--', 'kernel.cu'], { cwd: root });
  const completedWithToolFailureRuntime = createAgentRuntime({
    mode: 'codex-cli',
    codexClient: {
      describe: async () => ({ installed: true, loggedIn: true, version: 'codex-cli delegated' }),
      readRun: async () => ({ runId: 'codex_TOOL_WARNING', workspace: root, status: 'completed', completedAt: '2026-08-10T00:00:00.000Z', threadId: 'thread-warning', error: null }),
      readEvents: async () => [
        { type: 'item.started', item: { id: 'tool-warning', type: 'command_execution', status: 'in_progress' } },
        { type: 'item.completed', item: { id: 'tool-warning', type: 'command_execution', status: 'failed', aggregated_output: 'windows sandbox: helper_unknown_error: setup refresh had errors' } },
        { type: 'item.started', item: { id: 'tool-without-terminal-event', type: 'command_execution', status: 'in_progress' } },
        { type: 'error', error: { message: 'recoverable tool diagnostic' } },
        { type: 'item.completed', item: { id: 'result-warning', type: 'agent_message', text: 'analysis completed with warning' } },
        { type: 'turn.completed' },
      ],
      eventText: (event) => event.item?.aggregated_output || event.item?.text || '',
    },
    codexWorkspace: root,
  });
  const warningState = { activeMissionId: 'MIS_WARNING', runtimeEvents: [], agent: { status: 'running', runtimeKind: 'codex-cli', runId: 'codex_TOOL_WARNING', messages: [], toolCalls: [], artifacts: [] } };
  const warningProjection = await completedWithToolFailureRuntime.projectState(warningState);
  assert.equal(warningProjection.state.agent.status, 'completed');
  assert.equal(warningProjection.state.agent.toolCalls.length, 2);
  assert.equal(warningProjection.state.agent.toolCalls[0].status, 'failed');
  assert.equal(warningProjection.state.agent.toolCalls[1].status, 'warning');
  assert.equal(warningProjection.state.agent.toolCalls.some((call) => call.status === 'running'), false);
  assert.equal(warningProjection.state.agent.messages.some((message) => message.errorCode), false);

  const permissionFailure = classifyCodexFailure({ error: { message: 'failed to open state DB: attempt to write a readonly database' } }, []);
  assert.equal(permissionFailure.code, 'CODEX_RUNTIME_PERMISSION_DENIED');
  assert.match(permissionFailure.detail, /Windows 用户终端/);

  const failedRuntime = createAgentRuntime({
    mode: 'codex-cli',
    codexClient: {
      describe: async () => ({ installed: true, loggedIn: false, version: 'codex-cli delegated' }),
      readRun: async () => ({ runId: 'codex_FAILED', status: 'failed', completedAt: '2026-08-08T00:00:00.000Z', threadId: null, error: { code: 'CODEX_EXIT_1', message: 'Missing bearer or basic authentication in header' } }),
      readEvents: async () => [],
      eventText: () => '',
    },
    codexWorkspace: root,
  });
  const failedState = { activeMissionId: 'MIS_FAILED', runtimeEvents: [], agent: { status: 'running', runtimeKind: 'codex-cli', runId: 'codex_FAILED', messages: [], toolCalls: [], artifacts: [] } };
  const failedProjection = await failedRuntime.projectState(failedState);
  assert.equal(failedProjection.state.agent.status, 'failed');
  assert.equal(failedProjection.state.agent.phase, 'Codex 认证失败');
  assert.equal(failedProjection.state.agent.messages.at(-1).errorCode, 'CODEX_AUTH_FAILED');
  assert.match(failedProjection.state.agent.messages.at(-1).detail, /Provider/);
  console.log('[codex] native CLI adapter contract passed');
} finally {
  await new Promise((resolve) => setTimeout(resolve, 250));
  for (let attempt = 0; attempt < 6; attempt += 1) {
    try {
      await rm(root, { recursive: true, force: true });
      break;
    } catch (error) {
      if (!['ENOTEMPTY', 'EPERM', 'EACCES'].includes(error.code) || attempt === 5) throw error;
      await new Promise((resolve) => setTimeout(resolve, 100 * (attempt + 1)));
    }
  }
}
