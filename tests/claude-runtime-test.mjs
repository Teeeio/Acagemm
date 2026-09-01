import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { claudeActivityFromEvent, classifyClaudeFailure, createClaudeClient, normalizeClaudeEvents } from '../client-runtime/claude-client.mjs';

const normalized = normalizeClaudeEvents([
  { type: 'system', subtype: 'init', session_id: 'session-test' },
  { type: 'assistant', message: { content: [
    { type: 'tool_use', id: 'tool-1', name: 'Write', input: { file_path: 'run.py' } },
    { type: 'text', text: '{"summary":"candidate ready"}' },
  ] } },
  { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'ok' }] } },
  { type: 'result', subtype: 'success', is_error: false, session_id: 'session-test', result: '{"summary":"candidate ready"}', usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 30, cache_creation_input_tokens: 10 } },
]);
assert.equal(normalized[0].type, 'thread.started');
assert.ok(normalized.some((event) => event.type === 'item.started' && event.item.id === 'tool-1'));
assert.equal(normalized.find((event) => event.type === 'item.started').item.summary, '写入 run.py');
assert.equal(normalized.find((event) => event.type === 'item.completed' && event.item.id === 'tool-1').item.name, 'Write');
assert.equal(normalized.find((event) => event.type === 'item.completed' && event.item.id === 'tool-1').item.summary, '写入 run.py');
assert.ok(normalized.some((event) => event.type === 'item.completed' && event.item.type === 'agent_message'));
assert.equal(normalized.at(-1).type, 'turn.completed');
assert.equal(normalized.at(-1).usageId, 'claude-usage-3');
const normalizedError = normalizeClaudeEvents([
  { type: 'result', subtype: 'success', is_error: true, result: 'API Error: 402 Insufficient Balance', usage: { input_tokens: 10, output_tokens: 2 } },
]);
assert.equal(normalizedError.at(-1).type, 'turn.failed');
assert.equal(normalizedError.at(-1).usage.input_tokens, 10);
assert.match(normalizedError.find((event) => event.type === 'error').error.message, /402 Insufficient Balance/);
const thinkingActivity = claudeActivityFromEvent({ type: 'system', subtype: 'thinking_tokens' });
assert.equal(thinkingActivity.summary, '正在分析任务，尚未调用新工具');
const readActivity = claudeActivityFromEvent({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'read-1', name: 'Read', input: { file_path: 'run.py' } }] } }, thinkingActivity);
assert.equal(readActivity.summary, '读取 run.py');
const completedReadActivity = claudeActivityFromEvent({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'read-1', content: 'ok' }] } }, readActivity);
assert.equal(completedReadActivity.name, 'Read');
assert.equal(completedReadActivity.status, 'completed');
const billingFailure = classifyClaudeFailure(
  { error: { code: 'CLAUDE_RESULT_ERROR', message: 'API Error: 402 Insufficient Balance' } },
  [],
);
assert.equal(billingFailure.code, 'CLAUDE_BILLING_UNAVAILABLE');

const root = await mkdtemp(path.join(os.tmpdir(), 'operator-claude-runtime-'));
const spawnCalls = [];
const terminatedPids = [];
const execFileImpl = (command, args, options, callback) => {
  if (args[0] === '--version') return callback(null, '2.1.0 (Claude Code)\n', '');
  if (args[0] === 'auth' && args[1] === 'status') return callback(null, 'Logged in\n', '');
  return callback(new Error(`unexpected probe: ${args.join(' ')}`), '', '');
};
const spawnImpl = (command, args, options) => {
  const call = { command, args, cwd: options.cwd, env: options.env, stdin: '' };
  spawnCalls.push(call);
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin = new PassThrough();
  child.stdin.on('data', (chunk) => { call.stdin += chunk.toString(); });
  child.pid = 7182;
  child.killed = false;
  child.kill = () => { child.killed = true; child.emit('close', null, 'SIGTERM'); };
  call.child = child;
  child.stdin.on('finish', () => {
    if (call.stdin === 'hold\n') return;
    child.stdout.write(`${JSON.stringify({ type: 'system', subtype: 'init', session_id: 'session-test' })}\n`);
    for (let token = 1; token <= 200; token += 1) child.stdout.write(`${JSON.stringify({ type: 'system', subtype: 'thinking_tokens', estimated_tokens: token, estimated_tokens_delta: 1, session_id: 'session-test' })}\n`);
    child.stdout.write(`${JSON.stringify({ type: 'assistant', message: { content: [{ type: 'thinking', thinking: 'private reasoning block'.repeat(5000) }] } })}\n`);
    child.stdout.write(`${JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: '{"summary":"ok"}' }] } })}\n`);
    child.stdout.write(`${JSON.stringify({ type: 'result', subtype: 'success', is_error: false, session_id: 'session-test', result: '{"summary":"ok"}', usage: { input_tokens: 12, output_tokens: 3 } })}\n`);
    child.stdout.end();
    setTimeout(() => child.emit('close', 0, null), 30);
  });
  return child;
};

try {
  const client = createClaudeClient({
    command: 'claude-test',
    bridgeDir: path.join(root, 'bridge'),
    execFileImpl,
    spawnImpl,
    terminateProcessTreeImpl: async (child) => {
      terminatedPids.push(child.pid);
      child.kill();
    },
  });
  const descriptor = await client.describe();
  assert.equal(descriptor.installed, true);
  assert.equal(descriptor.loggedIn, true);
  assert.equal(descriptor.version, '2.1.0 (Claude Code)');
  assert.equal((await client.preflight({ workspace: root })).ready, true);

  const unsafeClient = createClaudeClient({ command: 'claude-test', permissionMode: 'bypassPermissions', bridgeDir: path.join(root, 'unsafe-bridge'), execFileImpl, spawnImpl });
  const unsafePreflight = await unsafeClient.preflight({ workspace: root });
  assert.equal(unsafePreflight.ready, false);
  assert.equal(unsafePreflight.code, 'CLAUDE_PERMISSION_MODE_UNSAFE');
  await assert.rejects(
    unsafeClient.start({ missionId: 'MIS_UNSAFE', goal: 'must not start', workspace: root }),
    (error) => error.code === 'CLAUDE_PERMISSION_MODE_UNSAFE',
  );

  await client.start({
    runId: 'claude_TEST',
    missionId: 'MIS_CLAUDE',
    goal: 'create run.py',
    workspace: root,
    environment: { OPERATOR_AGENT_ROLE: 'iteration', OPERATOR_AGENT_ROOTS: JSON.stringify({ workspace: root }) },
  });
  await new Promise((resolve) => setTimeout(resolve, 80));
  const record = await client.readRun('claude_TEST');
  assert.equal(record.status, 'completed');
  assert.equal(record.threadId, 'session-test');
  assert.ok(Date.parse(record.lastActivityAt) >= Date.parse(record.startedAt));
  const persistedEvents = await readFile(record.eventPath, 'utf8');
  assert.doesNotMatch(persistedEvents, /thinking_tokens/);
  assert.doesNotMatch(persistedEvents, /private reasoning block/);
  const completedEvents = await client.readEvents('claude_TEST');
  assert.equal(completedEvents.at(-1).type, 'turn.completed');
  assert.equal(completedEvents.at(-1).usage.input_tokens, 12);
  assert.deepEqual(spawnCalls[0].args, [
    '-p', '--output-format', 'stream-json', '--verbose', '--permission-mode', 'acceptEdits', '--tools', 'Read,Write,Edit',
    '--allowedTools', 'Read,Write,Edit', '--disallowedTools', 'Bash,NotebookEdit',
    '--disable-slash-commands', '--strict-mcp-config', '--mcp-config', path.join(root, 'bridge', 'claude-empty-mcp.json'), '--no-chrome',
  ]);
  assert.equal(spawnCalls[0].cwd, root);
  assert.equal(spawnCalls[0].stdin, 'create run.py\n');

  await client.start({
    runId: 'claude_MATERIALIZER',
    missionId: 'MIS_CLAUDE',
    goal: 'materialize baseline',
    workspace: root,
    environment: { OPERATOR_AGENT_ROLE: 'materializer', OPERATOR_AGENT_ROOTS: JSON.stringify({ workspace: root }) },
  });
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(spawnCalls[1].args[spawnCalls[1].args.indexOf('--max-turns') + 1], '6');

  await client.start({
    runId: 'claude_RESUME',
    missionId: 'MIS_CLAUDE',
    goal: 'continue',
    workspace: root,
    resumeThreadId: 'session-test',
    environment: { OPERATOR_AGENT_ROLE: 'research-acquire', OPERATOR_AGENT_ROOTS: JSON.stringify({ workspace: root }) },
  });
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.ok(spawnCalls[2].args.includes('--resume'));
  assert.ok(spawnCalls[2].args.includes('session-test'));
  assert.equal(spawnCalls[2].args[spawnCalls[2].args.indexOf('--allowedTools') + 1], 'Read,Glob,Grep,Write,Edit,WebSearch,WebFetch');

  await client.start({
    runId: 'claude_ACTIVITY',
    missionId: 'MIS_CLAUDE',
    goal: 'hold',
    workspace: root,
    environment: { OPERATOR_AGENT_ROLE: 'iteration', OPERATOR_AGENT_ROOTS: JSON.stringify({ workspace: root }) },
  });
  const activityChild = spawnCalls[3].child;
  activityChild.stdout.write(`${JSON.stringify({ type: 'system', subtype: 'init', session_id: 'session-activity' })}\n`);
  activityChild.stdout.write(`${JSON.stringify({ type: 'system', subtype: 'thinking_tokens', estimated_tokens: 50, estimated_tokens_delta: 50 })}\n`);
  activityChild.stdout.write(`${JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'edit-live', name: 'Edit', input: { file_path: 'run.py' } }] } })}\n`);
  await new Promise((resolve) => setTimeout(resolve, 50));
  const liveActivityRecord = await client.readRun('claude_ACTIVITY');
  assert.equal(liveActivityRecord.status, 'running');
  assert.equal(liveActivityRecord.activity.name, 'Edit');
  assert.equal(liveActivityRecord.activity.summary, '修改 run.py');
  const liveActivityEvents = await client.readEvents('claude_ACTIVITY');
  assert.equal(liveActivityEvents.find((event) => event.item?.id === 'edit-live').item.summary, '修改 run.py');
  assert.doesNotMatch(await readFile(liveActivityRecord.eventPath, 'utf8'), /thinking_tokens/);
  await client.cancel('claude_ACTIVITY');

  await client.start({
    runId: 'claude_CANCEL',
    missionId: 'MIS_CLAUDE',
    goal: 'hold',
    workspace: root,
    environment: { OPERATOR_AGENT_ROLE: 'iteration', OPERATOR_AGENT_ROOTS: JSON.stringify({ workspace: root }) },
  });
  const cancelResult = await client.cancel('claude_CANCEL');
  assert.equal(cancelResult.status, 'cancel_requested');
  assert.deepEqual(terminatedPids, [7182, 7182]);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal((await client.readRun('claude_CANCEL')).status, 'cancelled');

  console.log('[claude-runtime] CLI lifecycle and normalized event contract passed');
} finally {
  await rm(root, { recursive: true, force: true });
}
