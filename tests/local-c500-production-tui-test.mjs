import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderDashboardSnapshot } from '../tools/local-c500-tester/tui-state.mjs';
import { Dashboard } from '../tools/local-c500-tester/components/Dashboard.mjs';
import { reconcileLocalTaskSnapshot } from '../client-runtime/local-c500-service-client.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relative) => readFile(path.join(root, relative), 'utf8');

const [tui, tuiState, topologyComponent, activityComponent, terminalScreen, productionApi, server, runtimeAdvance, runtimeStatePipeline, candidateActions, validationActions, strictSourceAutopilot, candidateBaselineAutopilot, systemRoutes, backend, runner, hardwareMockE2e, hardwareMockContract, runtimeRegistry, codexClient, packageJson] = await Promise.all([
  read('tools/local-c500-tester/tui.mjs'),
  read('tools/local-c500-tester/tui-state.mjs'),
  read('tools/local-c500-tester/components/WorkflowTopology.mjs'),
  read('tools/local-c500-tester/components/WorkflowActivityIndicator.mjs'),
  read('tools/local-c500-tester/terminal-screen.mjs'),
  read('tools/local-c500-tester/production-api.mjs'),
  read('client-runtime/local-server.mjs'),
  read('client-runtime/application/runtime-advance-service.mjs'),
  read('client-runtime/application/runtime-state-pipeline-service.mjs'),
  read('client-runtime/application/autopilot-candidate-action-service.mjs'),
  read('client-runtime/application/autopilot-validation-service.mjs'),
  read('client-runtime/application/autopilot-strict-source-service.mjs'),
  read('client-runtime/application/autopilot-candidate-baseline-service.mjs'),
  read('client-runtime/server/system-routes.mjs'),
  read('client-runtime/local-c500-service-client.mjs'),
  read('tools/local-c500-runner.py'),
  read('scripts/e2e-agent-runtime-hardware-mock.mjs'),
  read('scripts/hardware-mock-e2e-contract.mjs'),
  read('client-runtime/agent-runtime/registry.mjs'),
  read('client-runtime/codex-client.mjs'),
  read('package.json').then(JSON.parse),
]);
const profiles = await import('../client-runtime/fixed-operator-profiles.mjs');
assert.deepEqual(profiles.tuiOperatorProfiles.map((profile) => profile.id), ['paged-mqa-logits-triton-v01', 'flash-mla-decode-triton-v01']);
assert.match(tui, /tuiOperatorProfiles/);
assert.match(productionApi, /TUI 只允许发布两个完整 v0\.1 C550 Profile/);
assert.match(productionApi, /TUI_PROFILE_NOT_PUBLISHABLE/);
assert.match(productionApi, /C550_STACK/);
assert.match(productionApi, /checkC550Smoke/);

for (const source of [tui, tuiState, productionApi]) {
  assert.doesNotMatch(source, /workflow-entry\.mjs|candidate-agent\.mjs|local-c500-adapter\.mjs/);
}
assert.doesNotMatch(tui, /cli\.mjs|runIterationLoop|mission['"]\s*,\s*['"]loop/);
assert.doesNotMatch(tui, /input === 'q' \|\| key\.escape/);
assert.match(tui, /resolveDashboardCommand/);
assert.match(tui, /promptExistingRuntime/);
assert.match(tui, /--reuse-existing/);
assert.match(tui, /--replace-existing/);
assert.match(tui, /reconcileOperationSnapshot/);
assert.match(tuiState, /activeMissionId/);
assert.match(tuiState, /task\.payload\?\.missionId/);
assert.match(tuiState, /deriveWorkflowTopology/);
assert.match(topologyComponent, /TopologyNode/);
assert.match(topologyComponent, /borderStyle:\s*current \? 'double' : 'round'/);
assert.match(topologyComponent, /Recent Candidates/);
assert.doesNotMatch(topologyComponent, /WORKFLOW_SPINNER_FRAMES|setInterval/);
assert.match(activityComponent, /WORKFLOW_SPINNER_FRAMES/);
assert.match(activityComponent, /WORKFLOW_SPINNER_INTERVAL_MS = 160/);
assert.match(activityComponent, /clearInterval/);
assert.match(activityComponent, /FLOW ACTIVE/);
assert.match(tui, /createTerminalScreenSession/);
assert.match(tui, /waitUntilExit/);
assert.match(tui, /restoreScreen/);
assert.match(tui, /patchConsole:\s*false/);
assert.match(terminalScreen, /\?1049h/);
assert.match(terminalScreen, /\?1049l/);
assert.match(productionApi, /\/api\/projects/);
assert.match(productionApi, /\/api\/missions/);
assert.match(productionApi, /\/runs/);
assert.match(productionApi, /MISSION\.md/);
assert.match(productionApi, /await stopMission\(\)/);
assert.match(productionApi, /Do not substitute an unrelated operator or a smoke template/);
assert.doesNotMatch(productionApi, /def get_inputs|vector_add/);
assert.match(productionApi, /OPERATOR_TEST_BACKEND:\s*'local-c500'/);
assert.match(productionApi, /OPERATOR_AUTO_TICK:\s*'1'/);
assert.match(productionApi, /OPERATOR_AUTO_TICK_INTERVAL_MS/);
assert.match(productionApi, /OPERATOR_RUNTIME_OWNER_PID:\s*String\(process\.pid\)/);
assert.match(productionApi, /export const stopProductionRuntime/);
assert.match(productionApi, /OPERATOR_EXISTING_RUNTIME_POLICY/);
assert.match(productionApi, /attachedRuntimePid/);
assert.match(productionApi, /LOCAL_C500_UNRECOGNIZED_RUNTIME/);
assert.match(productionApi, /ownerPid > 0 && ownerPid !== process\.pid/);
assert.match(tui, /await stopProductionRuntime\(\)\.catch/);
assert.match(server, /const runtimeOwnerPid = Number\(process\.env\.OPERATOR_RUNTIME_OWNER_PID/);
assert.match(server, /ownerPid: runtimeOwnerPid \|\| null/);
assert.match(server, /runtimeOwnerPid > 0 && !processAlive\(runtimeOwnerPid\)/);
assert.match(server, /process\.exit\(98\)/);
assert.match(server, /autoTickBusy/);
assert.match(server, /autoTickIntervalMs/);
assert.match(server, /OPERATOR_LOCAL_C500_TIMEOUT_SECONDS \|\| 600/);
// Cancellation now belongs to the task-owned supervisor, not a Runtime-local
// helper name. Its real descendant-tree/restart tests must stay in the release gate.
assert.match(backend, /cancel-request\.json/);
assert.match(backend, /execution-exit\.json/);
assert.match(backend, /taskkill\.exe/);
assert.match(backend, /detached: process\.platform !== 'win32'/);
assert.equal(packageJson.scripts['test:local-c500-recovery'], 'node tests/local-c500-recovery-test.mjs');
const releaseGate = await read('scripts/verify-local-c500-release.mjs');
assert.match(releaseGate, /['"]test:local-c500-recovery['"]/);
const confirmedTerminal = {
  status: 'completed', progress: 100, result: { benchmark: [] },
  resourceRelease: { confirmed: true, status: 'confirmed' },
};
for (const status of ['running', 'cancel_requested', 'cancelled', 'failed']) {
  assert.deepEqual(reconcileLocalTaskSnapshot(confirmedTerminal, {
    status, progress: 10, cancelRequested: true, resourceRelease: { confirmed: false },
  }), confirmedTerminal, 'stale progress or cancellation cannot overwrite a confirmed terminal outcome');
}
const cancelling = reconcileLocalTaskSnapshot(
  { status: 'cancel_requested', cancelRequested: true, progress: 60 },
  { status: 'running', cancelRequested: false, progress: 10 },
);
assert.equal(cancelling.status, 'cancel_requested');
assert.equal(cancelling.cancelRequested, true);
assert.equal(cancelling.progress, 60);
assert.match(server, /createSystemRoutes/);
assert.match(systemRoutes, /url\.pathname === '\/api\/health'/);
assert.match(tui, /OPERATOR_TUI_REFRESH_MS/);
assert.match(tui, /if \(args\[0\] === '--snapshot'\)[\s\S]*stopProductionRuntime/);
assert.match(tui, /if \(args\[0\] === 'panel' && args\.includes\('--once'\)\)[\s\S]*stopProductionRuntime/);
assert.match(tui, /if \(args\[0\] === 'doctor'\)[\s\S]*stopProductionRuntime/);
assert.match(tui, /finally \{[\s\S]*stopProductionRuntime/);
const simulationEntry = await read('tools/local-c500-tester/simulation.mjs');
const existingRuntimePrompt = await read('tools/local-c500-tester/existing-runtime-prompt.mjs');
const launcher = await read('tools/local-c500-tester/launcher.cjs');
assert.match(simulationEntry, /mkdtemp/);
assert.match(existingRuntimePrompt, /连接旧实例/);
assert.match(existingRuntimePrompt, /停止旧实例/);
assert.match(simulationEntry, /rm\(temporaryHome/);
assert.match(launcher, /operator-studio-simulation-/);
assert.match(launcher, /rmSync\(temporarySimulationHome/);
assert.match(productionApi, /OPERATOR_RUNTIME_MODE:\s*agentRuntimeMode/);
assert.match(productionApi, /OPERATOR_CLAUDE_PERMISSION_MODE:\s*'acceptEdits'/);
assert.match(productionApi, /environment\.OPERATOR_RUNTIME_MODE \|\| 'claude-code'/);
assert.match(productionApi, /inspectRuntimeCapabilities/);
assert.match(productionApi, /executionMode/);
assert.match(hardwareMockE2e, /const runtimeId = argument\('--runtime'/);
assert.match(hardwareMockE2e, /OPERATOR_RUNTIME_MODE = runtimeId/);
assert.match(hardwareMockE2e, /OPERATOR_LOCAL_C500_MOCK = '1'/);
assert.match(hardwareMockE2e, /validateHardwareMockSnapshot/);
assert.match(hardwareMockContract, /currentBest\?\.verified, true/);
assert.match(hardwareMockContract, /every provider run must have exact token usage/);
assert.doesNotMatch(hardwareMockE2e, /runtimeId\s*===\s*['"](?:codex-cli|claude-code)['"]/);
assert.match(runtimeRegistry, /productionWorkflowCapabilities/);
assert.match(runtimeRegistry, /inspectRuntimeCapabilities/);
assert.doesNotMatch(codexClient, /OPERATOR_CODEX_WINDOWS_SANDBOX \|\| 'unelevated'/);
assert.match(productionApi, /mxSmi:\s*checkCommand\('mx-smi', \[\]\)/);
assert.doesNotMatch(productionApi, /ixsmi/i);
assert.match(productionApi, /resolveLocalC500LaunchMode/);
assert.doesNotMatch(productionApi, /OPERATOR_LOCAL_C500_MOCK:\s*'1'/);
assert.match(server, /createLocalC500ServiceClient/);
assert.match(server, /createOperatorTestQueue\(\{ serviceClient: activeTestServiceClient \}\)/);
assert.match(server, /createRuntimeStatePipelineService/);
assert.match(server, /pipeline: runtimeStatePipelineService/);
assert.match(server, /runtimeLifecycleService\.read\(\)/);
assert.match(server, /runtimeLifecycleService\.advance\(\)/);
assert.match(runtimeStatePipeline, /Object\.freeze\(\{ advance \}\)/);
assert.match(runtimeStatePipeline, /runtimeAdvance\.advance/);
assert.match(runtimeAdvance, /advanceIteration\(automatic\.state, iteration\)/);
assert.match(runtimeAdvance, /autopilot\.advance/);
assert.match(candidateActions, /type:\s*'apply-patch'/);
assert.match(validationActions, /type:\s*'start-benchmark'/);
assert.match(`${strictSourceAutopilot}\n${candidateBaselineAutopilot}`, /baseline_research_started/);
assert.match(`${strictSourceAutopilot}\n${candidateBaselineAutopilot}`, /baseline_source_unresolved/);
assert.match(backend, /kind:\s*'local-c500'/);
assert.match(runner, /shutil\.which\("mx-smi"\)/);
assert.doesNotMatch(runner, /ixsmi/i);
assert.equal(packageJson.scripts['tester:c500'], 'node tools/local-c500-tester/launcher.cjs');
assert.equal(packageJson.scripts['e2e:agent-runtime-hardware-mock'], 'node scripts/e2e-agent-runtime-hardware-mock.mjs');

const rendered = renderDashboardSnapshot({
  mission: { id: 'MIS_PRODUCTION', title: 'C550 operator optimization', goal: 'minimize latency', status: 'running' },
  state: {
    stage: 'validation',
    missionPaused: false,
    agent: { status: 'executing', phase: '异构验证' },
    iterationStats: { loopStatus: 'running', round: 2 },
    baseline: { status: 'complete', kind: 'pytorch_reference' },
    benchmark: { status: 'running', progress: 50, testTaskId: 'local_c500_TASK' },
    currentBest: { candidateId: 'candidate-01', value: '42 us', improvement: '1.2x' },
    runtimeEvents: [{ id: 'event-1', createdAt: 'now', type: 'operator_test.queued' }],
  },
  health: { testBackend: { kind: 'local-c500', mock: false }, __bridge: { apiUrl: 'http://127.0.0.1:4275' } },
  tasks: [{ taskId: 'local_c500_TASK', status: 'running' }],
});
assert.match(rendered, /C550 Production Workflow Tester/);
assert.match(rendered, /MIS_PRODUCTION/);
assert.match(rendered, /local_c500_TASK/);
assert.match(rendered, /pytorch_reference/);
assert.match(rendered, /rounds\s+3/);

assert.doesNotThrow(() => Dashboard({
  snapshot: { state: {}, mission: null, health: null, tasks: null },
  message: 'Connecting to production runtime...',
}));

console.log('local-c500 production TUI architecture test passed');
