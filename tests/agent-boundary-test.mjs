import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { prepareAgentBoundary } from '../client-runtime/agent-boundary.mjs';

const root = await mkdtemp(path.join(os.tmpdir(), 'operator-agent-boundary-'));
const workspace = path.join(root, 'mission', 'repository');

try {
  await mkdir(workspace, { recursive: true });
  await writeFile(path.join(workspace, 'MISSION.md'), '# mission\n', 'utf8');
  const boundary = await prepareAgentBoundary({ workspace, role: 'iteration', roots: { workspace } });
  assert.deepEqual(JSON.parse(boundary.environment.OPERATOR_AGENT_ROOTS), { workspace: path.resolve(workspace) });
  assert.match(boundary.toolInstruction, /Do not use a local shell/);
  assert.match(boundary.toolInstruction, /Never assume that a requested file already exists/);
  assert.match(boundary.toolInstruction, /Create missing files/);
  assert.ok((await readdir(workspace)).includes('.git'));
  assert.equal((await readdir(workspace)).includes('.codex'), false);
  console.log('[agent-boundary] isolated cwd contract passed');
} finally {
  await rm(root, { recursive: true, force: true });
}
