import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { claudeActivityFromEvent, classifyClaudeFailure, createClaudeClient, normalizeClaudeEvents } from '../client-runtime/claude-client.mjs';
import { claudeRulePath } from '../client-runtime/claude-permission-surface.mjs';

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

  // permission mode 的守卫已删除：它拦的是一个名字，不是一个能力差（实测四种 mode 下越界写都成功）。
  // 现在 preflight 直接对任意 mode 返回 ready，并显式标注它不是边界。真正的强制面见文件末尾的
  // enforcedSurface 断言。
  const alternateModeClient = createClaudeClient({ command: 'claude-test', permissionMode: 'bypassPermissions', bridgeDir: path.join(root, 'alt-bridge'), execFileImpl, spawnImpl });
  const alternatePreflight = await alternateModeClient.preflight({ workspace: root });
  assert.equal(alternatePreflight.ready, true, 'permission mode must not gate readiness: it is not a capability boundary');
  assert.equal(alternatePreflight.permissionMode, 'bypassPermissions');
  assert.equal(alternatePreflight.permissionModeIsBoundary, false);

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
  // 适配器不得沿用宿主的全局配置：用户级 ~/.claude/settings.json 里的 permissions.deny 等规则是对
  // 本次运行生效的强制通道（实测 deny 规则在显式 --permission-mode 下仍然拒绝），不 pin 配置根，
  // 宿主的这套规则就会跟着进到运行时的 agent 里。配置根必须是运行时自己的，且**每次运行独立**——
  // 共用目录会让并发的两次运行互相覆盖 settings.json。
  const configDir = spawnCalls[0].env.CLAUDE_CONFIG_DIR;
  assert.ok(configDir, 'the claude run must pin CLAUDE_CONFIG_DIR so host global settings cannot leak in');
  assert.equal(path.resolve(configDir), path.join(root, 'bridge', 'claude-config', 'claude_TEST'),
    'each run must get its own config root, or concurrent runs overwrite each other\'s deny rules');
  assert.notEqual(path.resolve(configDir), path.resolve(os.homedir(), '.claude'));
  // 隔离的是配置目录，不是进程环境：PATH 等必须照常传递，否则 claude 根本起不来。
  assert.equal(spawnCalls[0].env.PATH, process.env.PATH);

  await client.start({
    runId: 'claude_MATERIALIZER',
    missionId: 'MIS_CLAUDE',
    goal: 'materialize baseline',
    workspace: root,
    environment: { OPERATOR_AGENT_ROLE: 'materializer', OPERATOR_AGENT_ROOTS: JSON.stringify({ workspace: root }) },
  });
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(spawnCalls[1].args[spawnCalls[1].args.indexOf('--max-turns') + 1], '6');

  const sourceRegistryDir = path.join(root, 'sources');
  await client.start({
    runId: 'claude_RESUME',
    missionId: 'MIS_CLAUDE',
    goal: 'continue',
    workspace: root,
    resumeThreadId: 'session-test',
    readOnlyDirectories: [sourceRegistryDir],
    environment: { OPERATOR_AGENT_ROLE: 'research-acquire', OPERATOR_AGENT_ROOTS: JSON.stringify({ workspace: root }) },
  });
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.ok(spawnCalls[2].args.includes('--resume'));
  assert.ok(spawnCalls[2].args.includes('session-test'));
  assert.equal(spawnCalls[2].args[spawnCalls[2].args.indexOf('--allowedTools') + 1], 'Read,Glob,Grep,WebSearch,WebFetch');
  // 只读轮次：写工具必须从工具面移除（能力不存在），而不是靠权限规则逐次拒绝。
  assert.equal(spawnCalls[2].args[spawnCalls[2].args.indexOf('--disallowedTools') + 1], 'Bash,NotebookEdit,Write,Edit',
    'a read-only grant must not expose any write tool, or the read-only Source Registry grant can be written through');
  assert.equal(spawnCalls[2].args.includes('--add-dir') && spawnCalls[2].args[spawnCalls[2].args.indexOf('--add-dir') + 1], sourceRegistryDir);

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

  // ---- 能力边界由 grant 派生，不由 role 名字派生 ----
  // 上面那次 acquire 的运行记录必须如实登记实际强制面：写工具被摘除、deny 规则与只读根一一对应、
  // 且不再声称 permission mode 是边界。
  const acquireRecord = await client.readRun('claude_RESUME');
  assert.equal(acquireRecord.boundary.enforcement, 'claude-tool-surface-and-config-deny',
    'the enforcement label must not claim permission mode bounds anything');
  assert.equal(acquireRecord.enforcedSurface.authority, 'tool-surface');
  assert.equal(acquireRecord.enforcedSurface.toolSurface.writeToolsWithheld, true);
  assert.equal(acquireRecord.enforcedSurface.permissionModeIsBoundary, false);
  assert.deepEqual(acquireRecord.enforcedSurface.denyRules, [`Edit(${claudeRulePath(sourceRegistryDir)}/**)`],
    'the read-only root must produce a deny rule in the documented Edit(...) form');
  // Windows 路径必须归一化成 `Edit(//c/.../**)`：小写盘符、无冒号。写成 Edit(//C:/.../**) 不匹配。
  assert.match(acquireRecord.enforcedSurface.denyRules[0], /^Edit\(\/\/[a-z]\/.*\/\*\*\)$/,
    'write rules must not carry an uppercase drive letter with a colon, which never matches');
  const settingsWritten = JSON.parse(await readFile(path.join(acquireRecord.claudeConfigDir, 'settings.json'), 'utf8'));
  assert.deepEqual(settingsWritten.permissions.deny, acquireRecord.enforcedSurface.denyRules,
    'the settings actually written must match what the run record claims');
  // 可写运行不产生 deny 规则，但仍登记强制面。
  const iterationRecord = await client.readRun('claude_ACTIVITY');
  assert.equal(iterationRecord.enforcedSurface.toolSurface.writeToolsWithheld, false);
  assert.deepEqual(iterationRecord.enforcedSurface.denyRules, []);

  // 负例 A：role 不再说了算——非 acquire 的 role 只要拿到只读根，同样摘除写工具。
  await client.start({
    runId: 'claude_READONLY_ITERATION',
    missionId: 'MIS_CLAUDE',
    goal: 'iteration with a read-only reference root',
    workspace: root,
    readOnlyDirectories: [sourceRegistryDir],
    environment: { OPERATOR_AGENT_ROLE: 'iteration', OPERATOR_AGENT_ROOTS: JSON.stringify({ workspace: root }) },
  });
  const readOnlyIteration = spawnCalls.at(-1);
  assert.equal(readOnlyIteration.args[readOnlyIteration.args.indexOf('--disallowedTools') + 1], 'Bash,NotebookEdit,Write,Edit',
    'write tools must be withheld from any run holding a read-only root, not only from research-acquire');
  await new Promise((resolve) => setTimeout(resolve, 80));
  const readOnlyIterationRecord = await client.readRun('claude_READONLY_ITERATION');
  assert.equal(readOnlyIterationRecord.enforcedSurface.toolSurface.writeToolsWithheld, true);
  assert.deepEqual(readOnlyIterationRecord.enforcedSurface.denyRules, [`Edit(${claudeRulePath(sourceRegistryDir)}/**)`]);

  // 负例 B：缺 grant 时显式失败，而不是静默落到「联网 + 有写工具」那一档——那会比改动前更宽。
  await assert.rejects(
    client.start({
      runId: 'claude_ACQUIRE_NO_GRANT',
      missionId: 'MIS_CLAUDE',
      goal: 'acquire without a read-only root',
      workspace: root,
      environment: { OPERATOR_AGENT_ROLE: 'research-acquire', OPERATOR_AGENT_ROOTS: JSON.stringify({ workspace: root }) },
    }),
    (error) => error.code === 'CLAUDE_ACQUIRE_GRANT_MISSING',
  );

  // 负例 C：permission mode 不再是闸门——顶层非 acceptEdits 的 client 能正常跑完一次并如实登记。
  await alternateModeClient.start({
    runId: 'claude_ALTMODE',
    missionId: 'MIS_CLAUDE',
    goal: 'run under a mode that used to be rejected',
    workspace: root,
    environment: { OPERATOR_AGENT_ROLE: 'iteration', OPERATOR_AGENT_ROOTS: JSON.stringify({ workspace: root }) },
  });
  await new Promise((resolve) => setTimeout(resolve, 80));
  const altModeRecord = await alternateModeClient.readRun('claude_ALTMODE');
  assert.equal(altModeRecord.status, 'completed', 'a non-acceptEdits permission mode must not block a run');
  assert.equal(altModeRecord.permissionMode, 'bypassPermissions');
  assert.equal(altModeRecord.enforcedSurface.permissionModeIsBoundary, false);

  console.log('[claude-runtime] CLI lifecycle and normalized event contract passed');
} finally {
  // Windows 上未结束的运行仍可能在写 run 记录/事件文件，与清理抢跑会抛 ENOTEMPTY，
  // 把真正的断言失败盖成一条目录报错。重试让失败信息始终是断言本身。
  await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
}
