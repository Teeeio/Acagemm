import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const root = await mkdtemp(path.join(os.tmpdir(), 'operator-state-store-'));
try {
  process.env.OPERATOR_STORAGE_ROOT = root;
  const { createSeedState, loadState, saveState } = await import('../client-runtime/state-store.mjs');

  const state = createSeedState();
  state.stage = 'candidate';
  state.patchApplied = false;
  state.agent = {
    ...(state.agent || {}),
    status: 'awaiting_action',
    phase: 'Candidate Plan 已生成',
    currentAction: null,
  };
  const missionGoal = state.missions.find((mission) => mission.id === state.activeMissionId).goal;
  state.agent.goal = '本轮诊断建议：连续两轮改善低于 3% 时停止此方向。';
  assert.ok(Array.isArray(state.candidateEvaluations) && state.candidateEvaluations.length > 0);

  await saveState(state);
  const reloaded = await loadState({ ensureWorkspace: false });
  assert.equal(reloaded.stage, 'candidate');
  assert.equal(reloaded.agent.status, 'awaiting_action');
  assert.equal(reloaded.agent.currentAction.type, 'candidate.plan');
  assert.match(reloaded.agent.currentAction.title, /测试/);
  assert.equal(
    reloaded.missions.find((mission) => mission.id === reloaded.activeMissionId).goal,
    missionGoal,
    '保存执行状态不能用 Agent 的轮次简报覆盖 Mission 目标',
  );

  console.log('[state-store] candidate currentAction projection recovery passed');
} finally {
  await rm(root, { recursive: true, force: true });
}
