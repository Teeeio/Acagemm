import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { createMission, createSeedState, normalizeMissionBudgetMs, selectMission } from '../client-runtime/state-store.mjs';

let state = createSeedState();

assert.equal(state.missionBudgetMs, null);
assert.equal(state.missionBudgetStartedAt, null);
assert.equal(state.missions[0].missionBudgetMs, null);

state = createMission(state, {
  title: 'Default Budget Mission',
  goal: '优化 MLA Paged KV Cache 在 C500 上的 small batch 延迟',
  repository: 'mla-kernels',
  hardware: ['C500'],
});
const defaultMissionId = state.activeMissionId;
assert.equal(state.missionBudgetMs, null);
assert.equal(state.missionBudgetStartedAt, null);
assert.equal(state.missions.find((mission) => mission.id === defaultMissionId).missionBudgetMs, null);

await delay(2);
state = createMission(state, {
  title: 'Budgeted Mission',
  goal: '优化 MLA Paged KV Cache 在 C500 上的 small batch 延迟',
  repository: 'mla-kernels',
  hardware: ['C500'],
  missionBudgetMs: 12_345,
});
const budgetedMissionId = state.activeMissionId;
state.missionBudgetStartedAt = '2026-08-19T00:00:00.000Z';
assert.equal(state.missionBudgetMs, 12_345);
assert.equal(state.missions.find((mission) => mission.id === budgetedMissionId).missionBudgetMs, 12_345);

selectMission(state, defaultMissionId);
assert.equal(state.missionBudgetMs, null);
assert.equal(state.missionBudgetStartedAt, null);

selectMission(state, budgetedMissionId);
assert.equal(state.missionBudgetMs, 12_345);
assert.equal(state.missionBudgetStartedAt, '2026-08-19T00:00:00.000Z');

assert.equal(normalizeMissionBudgetMs(null), null);
assert.equal(normalizeMissionBudgetMs(0), null);
assert.equal(normalizeMissionBudgetMs({ missionBudgetMs: '' }), null);
assert.equal(normalizeMissionBudgetMs({ missionBudgetMs: 5 * 60 * 60 * 1000 }), 18_000_000);
assert.equal(normalizeMissionBudgetMs({ missionBudgetHours: 2 }), 7_200_000);

console.log('mission budget defaults and projection ok');
