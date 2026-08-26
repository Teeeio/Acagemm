import assert from 'node:assert/strict';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { prepareAgentBoundary } from '../client-runtime/agent-boundary.mjs';
import { createCodexClient } from '../client-runtime/codex-client.mjs';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const root = path.join(projectRoot, '.local-c500-tests', `boundary-smoke-${Date.now().toString(36)}`);
const workspace = path.join(root, 'repository');
const bridgeDir = path.join(root, 'bridge');
const auditPath = path.join(root, 'audit', 'smoke.jsonl');
let client;
let runId;
let passed = false;

try {
  await mkdir(workspace, { recursive: true });
  await writeFile(path.join(workspace, 'MISSION.md'), '# boundary smoke\n', 'utf8');
  const boundary = await prepareAgentBoundary({ workspace, role: 'boundary-smoke', roots: { workspace }, auditPath });
  client = createCodexClient({ bridgeDir });
  runId = `codex_boundary_smoke_${Date.now().toString(36)}`;
  await client.start({
    runId,
    missionId: 'BOUNDARY_SMOKE',
    goal: 'Create run.py in the current workspace using apply_patch. Its complete content must be: BOUNDARY_SMOKE = True',
    workspace,
    sandboxMode: 'workspace-write',
    environment: boundary.environment,
  });
  const deadline = Date.now() + 5 * 60 * 1000;
  let run;
  while (Date.now() < deadline) {
    run = await client.readRun(runId);
    if (['completed', 'failed', 'cancelled'].includes(run.status)) break;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  assert.ok(run && run.status !== 'running', 'Codex boundary smoke timed out');
  const events = await client.readEvents(runId);
  assert.equal(events.some((event) => event.item?.type === 'command_execution'), false, 'local shell remained exposed');
  assert.match(await readFile(path.join(workspace, 'run.py'), 'utf8'), /BOUNDARY_SMOKE = True/);
  passed = true;
  console.log('[agent-boundary-codex] local shell hidden and cwd apply_patch retained');
} finally {
  if (client && runId) await client.cancel(runId).catch(() => {});
  await new Promise((resolve) => setTimeout(resolve, 500));
  if (passed) await rm(root, { recursive: true, force: true }).catch(() => {});
  else console.error(`[agent-boundary-codex] preserved failure evidence: ${root}`);
}
