import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createAgentRuntime } from '../client-runtime/agent-runtime.mjs';
import { createOpenCodeClient, parseOpenCodeModel } from '../client-runtime/opencode-client.mjs';

let receivedPrompt = null;
let responseMode = 'diff';
const sessionId = 'ses_OPERATOR_STUDIO_TEST';

const json = (response, status, payload) => {
  response.writeHead(status, { 'Content-Type': 'application/json' });
  response.end(JSON.stringify(payload));
};

const readBody = async (request) => {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
};

const server = createServer(async (request, response) => {
  const url = new URL(request.url, 'http://127.0.0.1');
  if (request.method === 'GET' && url.pathname === '/global/health') return json(response, 200, { healthy: true, version: '1.1.25-test' });
  if (request.method === 'GET' && url.pathname === '/provider') return json(response, 200, { all: [], connected: ['openai'], default: { openai: 'gpt-test' } });
  if (request.method === 'POST' && url.pathname === '/session') return json(response, 200, { id: sessionId, title: 'Operator Studio test session' });
  if (request.method === 'POST' && url.pathname === `/session/${sessionId}/prompt_async`) {
    receivedPrompt = await readBody(request);
    response.writeHead(204);
    return response.end();
  }
  if (request.method === 'GET' && url.pathname === '/session/status') return json(response, 200, { [sessionId]: { type: 'idle' } });
  if (request.method === 'GET' && url.pathname === `/session/${sessionId}/message`) return json(response, 200, responseMode === 'error' ? [
    { info: { id: 'msg_user', role: 'user' }, parts: [{ type: 'text', text: 'mission request' }] },
    { info: { id: 'msg_assistant', role: 'assistant', tokens: { input: 100, output: 20, reasoning: 5, cache: { read: 30, write: 10 }, total: 165 } }, parts: [
      { id: 'part_text', type: 'text', text: 'Profile evidence points to launch overhead.' },
    ] },
    { info: { id: 'msg_assistant_error', role: 'assistant', tokens: { input: 10, output: 2, reasoning: 1, cache: { read: 3, write: 0 }, total: 16 }, error: { data: { message: 'Provider credential is missing' } } }, parts: [] },
  ] : [
    { info: { id: 'msg_user', role: 'user' }, parts: [{ type: 'text', text: 'mission request' }] },
    { info: { id: 'msg_assistant', role: 'assistant', tokens: { input: 100, output: 20, reasoning: 5, cache: { read: 30, write: 10 }, total: 165 } }, parts: [
      { id: 'part_text', type: 'text', text: 'Profile evidence points to launch overhead.' },
      { id: 'part_tool', type: 'tool', tool: 'grep', state: { status: 'completed', title: 'Inspect hot path', output: '2 matches' } },
    ] },
  ]);
  if (request.method === 'GET' && url.pathname === `/session/${sessionId}/diff`) return json(response, 200, responseMode === 'error' ? [] : [
    { file: 'kernels/paged_attention.cu', additions: 12, deletions: 4 },
  ]);
  return json(response, 404, { error: 'not found' });
});

server.listen(0, '127.0.0.1');
await once(server, 'listening');
const address = server.address();

try {
  assert.deepEqual(parseOpenCodeModel('openai/gpt-test'), { providerID: 'openai', modelID: 'gpt-test' });
  assert.equal(parseOpenCodeModel('invalid'), null);

  const client = createOpenCodeClient({ baseUrl: `http://127.0.0.1:${address.port}` });
  const runtime = createAgentRuntime({ mode: 'opencode-server', opencodeClient: client, openCodeAgent: 'plan', openCodeModel: 'openai/gpt-test' });
  const descriptor = await runtime.describe();
  assert.equal(descriptor.connected, true);
  assert.equal(descriptor.version, '1.1.25-test');
  assert.equal(descriptor.providerConfigured, true);

  const state = { activeMissionId: 'MIS_OPENCODE_TEST', runtimeEvents: [] };
  const mission = { id: 'MIS_OPENCODE_TEST', title: 'OpenCode integration', hardware: ['C500'], metric: 'latency p50' };
  await runtime.startRun({ state, mission, goal: 'Find launch overhead without editing files' });
  assert.equal(state.agent.runId, sessionId);
  assert.equal(state.agent.runtimeKind, 'opencode');
  assert.equal(receivedPrompt.agent, 'plan');
  assert.deepEqual(receivedPrompt.model, { providerID: 'openai', modelID: 'gpt-test' });
  assert.match(receivedPrompt.parts[0].text, /Find launch overhead/);

  const projection = await runtime.projectState(state);
  assert.equal(projection.state.stage, 'candidate');
  assert.equal(projection.state.agent.status, 'awaiting_action');
  assert.equal(projection.state.agent.toolCalls[0].toolId, 'grep');
  assert.equal(projection.state.agent.openCodeDiffCount, 1);
  assert.equal(projection.state.agent.currentAction.type, 'candidate.plan');
  assert.equal(projection.state.tokenUsage.totalTokens, 165);
  assert.equal(projection.state.tokenUsage.coverage, '1/1 runs exact');
  assert.ok(projection.state.runtimeEvents.some((event) => event.type === 'opencode.diff_ready'));

  responseMode = 'error';
  const failedProjection = await runtime.projectState(projection.state);
  assert.equal(failedProjection.state.agent.status, 'failed');
  assert.match(failedProjection.state.agent.messages.at(-1).detail, /credential is missing/);
  assert.equal(failedProjection.state.tokenUsage.totalTokens, 181, 'failed OpenCode messages must remain in the run usage snapshot');
  assert.equal(failedProjection.state.tokenUsage.completeness, 'exact');
  assert.ok(failedProjection.state.runtimeEvents.some((event) => event.type === 'opencode.session_failed'));
  console.log('[opencode] server runtime contract passed');
} finally {
  server.close();
  await once(server, 'close');
}
