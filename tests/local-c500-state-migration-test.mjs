import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { migrateLocalC500TesterState } from '../client-runtime/local-c500-state-migration.mjs';
import { LOCAL_C500_RUNTIME_CONTRACT_VERSION } from '../client-runtime/local-c500-runtime-contract.mjs';

const legacyState = () => ({
  activeMissionId: 'MIS_LEGACY_C500',
  iterationStats: { loopStatus: 'needs_human', loopStatusReason: 'baseline_source_unresolved', round: 0 },
  researchAgent: {
    status: 'failed',
    runPhase: 'acquire',
    phase: '研究员状态读取失败',
    progress: 100,
    runId: 'claude_research_LEGACY',
    threadId: 'session-legacy',
    messages: [],
    error: { code: 'RESEARCH_SOURCE_ACQUISITION_FAILED', message: 'legacy projection failed' },
  },
  missions: [{
    id: 'MIS_LEGACY_C500',
    hardware: ['C500'],
    testScenario: { id: 'mla-three-round', hardwareMockOnly: true },
    sourcePolicy: { mode: 'agent-research-only', strictZeroSource: true },
    iterationStats: { loopStatus: 'needs_human', loopStatusReason: 'baseline_source_unresolved', round: 0 },
    researchAgent: { status: 'failed', phase: '研究员状态读取失败', runId: 'claude_research_LEGACY' },
  }],
});

const state = legacyState();
const migrated = migrateLocalC500TesterState(state, { enabled: true });
assert.equal(migrated.changed, true);
assert.equal(migrated.recovery.previousBlocker, 'baseline_source_unresolved');
assert.equal(migrated.recovery.recoveredRunId, 'claude_research_LEGACY');
assert.deepEqual(state.missions[0].sourcePolicy, {
  mode: 'agent-flexible',
  strictZeroSource: true,
  localFirst: true,
  allowDiscoveredSources: true,
  allowSemanticFallback: true,
  revision: 'local-c500-flexible-source-v1',
});
assert.equal(state.iterationStats.loopStatus, 'running');
assert.equal(state.iterationStats.loopStatusReason, null);
assert.equal(state.researchAgent.status, 'idle');
assert.equal(state.researchAgent.runId, null);
assert.equal(state.researchAgent.phase, '等待重新调研');
assert.match(state.researchAgent.messages.at(-1).detail, /本地 Source.*网络来源.*fallback/);

const second = migrateLocalC500TesterState(state, { enabled: true });
assert.equal(second.changed, false, 'migration must be idempotent');

const unrelatedBlock = legacyState();
unrelatedBlock.iterationStats.loopStatusReason = 'total_budget';
unrelatedBlock.missions[0].iterationStats.loopStatusReason = 'total_budget';
const unrelatedResult = migrateLocalC500TesterState(unrelatedBlock, { enabled: true });
assert.equal(unrelatedResult.changed, true, 'legacy policy is still upgraded');
assert.equal(unrelatedBlock.iterationStats.loopStatus, 'needs_human', 'non-source blockers must remain blocked');
assert.equal(unrelatedBlock.researchAgent.runId, 'claude_research_LEGACY', 'unrelated failures must not restart Research');

const genericState = legacyState();
genericState.missions[0].testScenario = { id: 'custom-production-workflow' };
assert.equal(migrateLocalC500TesterState(genericState, { enabled: true }).changed, false);
assert.equal(genericState.missions[0].sourcePolicy.mode, 'agent-research-only');
assert.equal(migrateLocalC500TesterState(legacyState(), { enabled: false }).changed, false);

const reservePort = () => new Promise((resolve, reject) => {
  const server = createServer();
  server.once('error', reject);
  server.listen(0, '127.0.0.1', () => {
    const address = server.address();
    server.close(() => resolve(address.port));
  });
});

const integrationRoot = await mkdtemp(path.join(os.tmpdir(), 'operator-c500-state-migration-'));
const port = await reservePort();
const environment = {
  ...process.env,
  API_PORT: String(port),
  SERVE_WEB: 'false',
  OPERATOR_RUNTIME_MODE: 'reference-fixture',
  OPERATOR_TEST_BACKEND: 'local-c500',
  OPERATOR_LOCAL_C500_MOCK: '1',
  OPERATOR_AUTO_TICK: '0',
  NO_AUTO_LOOP: '1',
  OPERATOR_DATA_DIR: path.join(integrationRoot, 'data'),
  OPERATOR_RUNTIME_DIR: path.join(integrationRoot, 'runtime'),
  OPERATOR_LOCAL_C500_DIR: path.join(integrationRoot, 'tasks'),
};
Object.assign(process.env, environment);
const { createProductState, saveState } = await import(`../client-runtime/state-store.mjs?migration-integration=${Date.now()}`);
const persisted = createProductState();
const persistedMission = persisted.missions.find((mission) => mission.id === persisted.activeMissionId);
persistedMission.testScenario = { id: 'mla-three-round', hardwareMockOnly: true };
persistedMission.sourcePolicy = { mode: 'agent-research-only', strictZeroSource: true };
persistedMission.iterationStats = { ...persistedMission.iterationStats, loopStatus: 'needs_human', loopStatusReason: 'baseline_source_unresolved' };
persistedMission.researchAgent = structuredClone(legacyState().researchAgent);
persisted.iterationStats = structuredClone(persistedMission.iterationStats);
persisted.researchAgent = structuredClone(persistedMission.researchAgent);
await saveState(persisted);

const child = spawn(process.execPath, ['client-runtime/local-server.mjs'], {
  cwd: path.resolve(import.meta.dirname, '..'),
  env: environment,
  stdio: ['ignore', 'ignore', 'pipe'],
  windowsHide: true,
});
let stderr = '';
child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
try {
  let health = null;
  for (let attempt = 0; attempt < 100 && !health; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (response.ok) health = await response.json();
    } catch { /* wait for server */ }
    if (!health) await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.ok(health, `integration runtime did not start: ${stderr}`);
  assert.equal(health.__bridge.runtimeContractVersion, LOCAL_C500_RUNTIME_CONTRACT_VERSION);
  const response = await fetch(`http://127.0.0.1:${port}/api/state`);
  if (!response.ok) assert.fail(await response.text());
  const snapshot = await response.json();
  const recoveredMission = snapshot.state.missions.find((mission) => mission.id === snapshot.state.activeMissionId);
  assert.equal(recoveredMission.sourcePolicy.mode, 'agent-flexible');
  assert.equal(snapshot.state.iterationStats.loopStatus, 'running');
  assert.equal(snapshot.state.researchAgent.status, 'idle');
  assert.ok(snapshot.state.runtimeEvents.some((event) => event.type === 'mission.source_policy_migrated'));
  const secondSnapshot = await fetch(`http://127.0.0.1:${port}/api/state`).then((entry) => entry.json());
  assert.equal(secondSnapshot.state.runtimeEvents.filter((event) => event.type === 'mission.source_policy_migrated').length, 1);
} finally {
  child.kill('SIGTERM');
  await Promise.race([
    new Promise((resolve) => child.once('exit', resolve)),
    new Promise((resolve) => setTimeout(resolve, 3_000)),
  ]);
  await rm(integrationRoot, { recursive: true, force: true });
}

console.log('[local-c500-state-migration] legacy source blocker recovery passed');
