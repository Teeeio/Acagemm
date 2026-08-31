import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  isHardwareMockTerminalFailure,
  isHardwareMockWorkflowCompleted,
  validateHardwareMockSnapshot,
} from './hardware-mock-e2e-contract.mjs';

const args = process.argv.slice(2);
const argument = (name, fallback = null) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : fallback;
};
const positional = args.filter((value, index) => !value.startsWith('--') && (index === 0 || !args[index - 1].startsWith('--')));
const runtimeId = argument('--runtime', positional[0] || process.env.OPERATOR_RUNTIME_MODE || 'claude-code');
const requestedProfile = argument('--profile', positional[1] || 'all');
const timeoutMs = Number(argument('--timeout-ms', positional[2] || process.env.E2E_AGENT_TIMEOUT_MS || 30 * 60 * 1000));
const agentBudgetMs = Number(argument('--agent-budget-ms', positional[3] || process.env.E2E_AGENT_BUDGET_MS || 10 * 60 * 1000));
const profileIds = requestedProfile === 'all'
  ? ['paged-mqa-logits-triton-v01', 'flash-mla-decode-triton-v01']
  : [requestedProfile];

const reservePort = () => new Promise((resolve, reject) => {
  const server = createServer();
  server.once('error', reject);
  server.listen(0, '127.0.0.1', () => {
    const address = server.address();
    server.close(() => resolve(address.port));
  });
});

const testerHome = await mkdtemp(path.join(os.tmpdir(), 'operator-studio-hardware-mock-e2e-'));
process.env.LOCAL_C500_TESTER_HOME = testerHome;
process.env.LOCAL_C500_API_PORT = String(await reservePort());
process.env.OPERATOR_RUNTIME_MODE = runtimeId;
process.env.OPERATOR_TEST_BACKEND = 'local-c500';
process.env.OPERATOR_LOCAL_C500_MOCK = '1';
process.env.OPERATOR_LOCAL_C500_MOCK_SCENARIO = 'mla-three-round';
process.env.OPERATOR_AUTO_TICK = '1';
process.env.OPERATOR_AUTO_TICK_INTERVAL_MS = '250';
process.env.OPERATOR_MAIN_AGENT_BUDGET_MS = String(agentBudgetMs);
delete process.env.OPERATOR_LOCAL_C500_SIMULATION;
delete process.env.OPERATOR_SIMULATION;
delete process.env.OPERATOR_HARDWARE_DISABLED;
delete process.env.OPERATOR_MUXI_DEVICE;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const api = await import('../tools/local-c500-tester/production-api.mjs');
let cleanupStarted = false;
const cleanup = async () => {
  if (cleanupStarted) return;
  cleanupStarted = true;
  await api.stopProductionRuntime().catch(() => {});
  await rm(testerHome, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(() => {});
};
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => { void cleanup().finally(() => process.exit(130)); });
}
const results = [];
try {
  const doctor = await api.runDoctor();
  api.assertProductionPreflight(doctor);
  assert.equal(doctor.executionMode, 'hardware-mock');
  assert.equal(doctor.runtime.runtime.mode, runtimeId);
  assert.equal(doctor.runtime.runtime.connected, true);
  assert.equal(doctor.runtime.testBackend.mock, true);
  assert.equal(doctor.runtime.testBackend.liveHardware, false);
  assert.equal(doctor.checks.device.status, 'mocked');

  for (const profileId of profileIds) {
    const published = await api.publishMission({ profileId, researchEnabled: false, requireAuthority: false, timeBudget: '' });
    const deadline = Date.now() + timeoutMs;
    let snapshot = await api.loadProductionState();
    while (!isHardwareMockWorkflowCompleted(snapshot) && !isHardwareMockTerminalFailure(snapshot) && Date.now() < deadline) {
      await sleep(500);
      snapshot = await api.loadProductionState();
    }
    if (!isHardwareMockWorkflowCompleted(snapshot)) {
      const state = snapshot.state || {};
      throw new Error(`hardware-mock E2E did not complete ${profileId}: ${JSON.stringify({ missionId: published.missionId, missionStatus: snapshot.mission?.status, stage: state.stage, loopStatus: state.iterationStats?.loopStatus, reason: state.iterationStats?.loopStatusReason, agent: state.agent?.status, agentPhase: state.agent?.phase, benchmark: state.benchmark?.status, workflowFailure: state.workflowFailure })}`);
    }

    results.push(validateHardwareMockSnapshot({ snapshot, published, profileId, runtimeId }));
  }

  console.log(JSON.stringify({ status: 'passed', executionMode: 'hardware-mock', runtimeId, profiles: results }, null, 2));
} finally {
  await cleanup();
}
