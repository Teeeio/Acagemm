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
  // 文案不得断言「本阶段没有 shell」：codex 的 shell 默认开着，那种断言在它那一侧是假话。
  assert.match(boundary.toolInstruction, /to reach outside the granted roots/);
  assert.doesNotMatch(boundary.toolInstruction, /Do not use a local shell/);
  // 也不得声称「工具只能访问已授予根内的路径」：codex 沙箱全盘可读，claude 的 Read 实测能读到
  // cwd 与全部 --add-dir 之外。声明必须写成约束，而不是一句做不到的能力断言。
  assert.doesNotMatch(boundary.toolInstruction, /may access only/);
  assert.match(boundary.toolInstruction, /even if a tool can reach further/);
  assert.match(boundary.toolInstruction, /Never assume that a requested file already exists/);
  assert.match(boundary.toolInstruction, /Create missing files/);
  assert.ok((await readdir(workspace)).includes('.git'));
  assert.equal((await readdir(workspace)).includes('.codex'), false);

  // 授予只读根时，边界说明必须如实描述，不能一边 --add-dir 一边说「只有 workspace」。
  const sourceRoot = path.join(root, 'sources');
  await mkdir(sourceRoot, { recursive: true });
  const researchBoundary = await prepareAgentBoundary({ workspace, role: 'research-acquire', roots: { workspace, sourceRoot } });
  assert.match(researchBoundary.toolInstruction, /READ-ONLY reference root/);
  // 只读根必须带上它真实的目标路径，否则研究员拿不到可用的清单位置。
  assert.ok(researchBoundary.toolInstruction.includes(`sourceRoot (READ-ONLY reference root): ${sourceRoot}`));
  assert.doesNotMatch(researchBoundary.toolInstruction, /The only filesystem root assigned to this Agent/);
  assert.match(researchBoundary.toolInstruction, /ONLY root you may write to/);
  assert.deepEqual(JSON.parse(researchBoundary.environment.OPERATOR_AGENT_ROOTS), { workspace: path.resolve(workspace), sourceRoot: path.resolve(sourceRoot) });
  // 只有 workspace 时保持原文，主迭代边界不变。
  assert.match(boundary.toolInstruction, /The only filesystem root assigned to this Agent/);
  console.log('[agent-boundary] isolated cwd contract passed');
} finally {
  await rm(root, { recursive: true, force: true });
}
