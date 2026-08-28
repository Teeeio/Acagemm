import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { spawn } from 'node:child_process';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const smokeRoot = path.join(rootDir, 'runtime', `smoke-${process.pid}`);
const port = 4199;
const testServicePort = 4200;
const baseUrl = `http://127.0.0.1:${port}`;
const execFileAsync = promisify(execFile);
const testService = spawn('node', ['test-service/mock-server.mjs'], {
  cwd: rootDir,
  stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, TEST_SERVICE_PORT: String(testServicePort) },
});
const child = spawn('node', ['client-runtime/local-server.mjs'], {
  cwd: rootDir,
  stdio: ['ignore', 'pipe', 'pipe'],
  env: {
    ...process.env,
    API_PORT: String(port),
    SERVE_WEB: 'false',
    OPERATOR_DATA_DIR: path.join(smokeRoot, 'data'),
    OPERATOR_RUNTIME_DIR: path.join(smokeRoot, 'runtime'),
    OPERATOR_RUNTIME_MODE: 'reference-fixture',
    OPERATOR_TEST_SERVICE_URL: `http://127.0.0.1:${testServicePort}`,
  },
});

const request = async (pathname, options = {}) => {
  const response = await fetch(`${baseUrl}${pathname}`, { ...options, headers: { 'Content-Type': 'application/json', ...(options.headers || {}) } });
  const payload = await response.json();
  if (!response.ok) throw new Error(`${payload.code ? `${payload.code}: ` : ''}${payload.error || `HTTP ${response.status}`}`);
  return payload;
};

const requestFailure = async (pathname, options = {}) => {
  const response = await fetch(`${baseUrl}${pathname}`, { ...options, headers: { 'Content-Type': 'application/json', ...(options.headers || {}) } });
  const payload = await response.json();
  assert.equal(response.ok, false, `${pathname} should have failed`);
  return { status: response.status, payload };
};

const waitForServer = async () => {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try { await request('/api/health'); return; } catch { await new Promise((resolve) => setTimeout(resolve, 100)); }
  }
  throw new Error('Mock API did not start.');
};

try {
  await waitForServer();
  await request('/api/reset', { method: 'POST' });
  const initialProjects = await request('/api/projects');
  assert.ok(initialProjects.projects.some((project) => project.repository === 'mla-kernels'));
  const alternateProject = initialProjects.projects.find((project) => project.repository === 'flashinfer-c500');
  const switchedProject = await request(`/api/projects/${alternateProject.id}/select`, { method: 'POST', body: '{}' });
  assert.equal(switchedProject.state.activeProjectId, alternateProject.id);
  assert.equal(switchedProject.state.missions.find((mission) => mission.id === switchedProject.state.activeMissionId).projectId, alternateProject.id);
  const browsedRoot = await request(`/api/filesystem/directories?path=${encodeURIComponent(smokeRoot)}`);
  assert.equal(path.resolve(browsedRoot.directory.path), path.resolve(smokeRoot));
  const createdDirectory = await request('/api/filesystem/directories', { method: 'POST', body: JSON.stringify({ parent: smokeRoot, name: 'initialized-repository' }) });
  const createdProjectResponse = await request('/api/projects', { method: 'POST', body: JSON.stringify({ name: 'Smoke repository', root: createdDirectory.directory.path, defaultBranch: 'HEAD', initializeGit: true }) });
  assert.equal(createdProjectResponse.project.name, 'Smoke repository');
  assert.equal(createdProjectResponse.project.layout, 'three-layer');
	  assert.equal((await stat(path.join(createdDirectory.directory.path, 'repository', '.git'))).isDirectory(), true);
	  assert.equal((await stat(path.join(createdDirectory.directory.path, 'sources'))).isDirectory(), true);
	  assert.equal((await stat(path.join(createdDirectory.directory.path, '.operator-studio', 'artifacts'))).isDirectory(), true);
	  const projectId = createdProjectResponse.project.id;
	  const archivedProject = await request(`/api/projects/${projectId}`, { method: 'PATCH', body: JSON.stringify({ status: 'archived' }) });
	  assert.equal(archivedProject.project.status, 'archived');
	  await request(`/api/projects/${projectId}`, { method: 'DELETE' });

	  const remoteRepository = path.join(smokeRoot, 'remote-baseline');
	  await mkdir(remoteRepository, { recursive: true });
	  await execFileAsync('git', ['init'], { cwd: remoteRepository });
	  await execFileAsync('git', ['config', 'user.name', 'Smoke Test'], { cwd: remoteRepository });
	  await execFileAsync('git', ['config', 'user.email', 'smoke-test@local.invalid'], { cwd: remoteRepository });
	  await writeFile(path.join(remoteRepository, 'kernel.cu'), '// remote iteration baseline\n', 'utf8');
	  await execFileAsync('git', ['add', '-A'], { cwd: remoteRepository });
	  await execFileAsync('git', ['commit', '-m', 'remote baseline'], { cwd: remoteRepository });
	  const emptyProjectRoot = path.join(smokeRoot, 'empty-baseline-project');
	  await mkdir(emptyProjectRoot, { recursive: true });
	  const emptyProjectResponse = await request('/api/projects', { method: 'POST', body: JSON.stringify({ name: 'Empty baseline project', root: emptyProjectRoot, initializeGit: true }) });
	  const emptyMission = await request('/api/missions', { method: 'POST', body: JSON.stringify({ title: 'Empty Baseline Mission', goal: '优化 MLA Paged KV Cache 在 C500 上的 small batch 延迟', projectId: emptyProjectResponse.project.id, hardware: ['C500'] }) });
	  const emptyMissionId = emptyMission.state.activeMissionId;
	  const blockedPreflight = (await request(`/api/runtime/preflight?missionId=${emptyMissionId}`)).preflight;
	  assert.equal(blockedPreflight.ready, false);
	  assert.equal(blockedPreflight.workspaceCheck.code, 'WORKSPACE_BASELINE_EMPTY');
	  const bootstrapResponse = await request(`/api/projects/${emptyProjectResponse.project.id}/bootstrap`, { method: 'POST', body: JSON.stringify({ gitUrl: remoteRepository, gitRef: 'HEAD' }) });
	  assert.equal(bootstrapResponse.bootstrap.trackedFiles, 1);
	  assert.equal((await readFile(path.join(emptyProjectRoot, 'repository', 'kernel.cu'), 'utf8')).trim(), '// remote iteration baseline');
	  assert.equal((await readFile(path.join(emptyProjectRoot, '.operator-studio', 'workspaces', emptyMissionId, 'repository', 'kernel.cu'), 'utf8')).trim(), '// remote iteration baseline');
	  const readyPreflight = (await request(`/api/runtime/preflight?missionId=${emptyMissionId}`)).preflight;
	  assert.equal(readyPreflight.ready, true);
	  assert.equal(readyPreflight.workspaceCheck.code, 'WORKSPACE_READY');
	  assert.equal(readyPreflight.workspaceCheck.baselineEmpty, false);

	  const linkedProject = initialProjects.projects.find((project) => project.repository === 'mla-kernels');
	  const linkedDelete = await requestFailure(`/api/projects/${linkedProject.id}`, { method: 'DELETE' });
	  assert.equal(linkedDelete.status, 409);
	  const mission = await request('/api/missions', { method: 'POST', body: JSON.stringify({ title: 'Smoke Mission', goal: '优化 MLA Paged KV Cache 在 C500 上的 small batch 延迟', repository: 'mla-kernels', hardware: ['C500'] }) });
	  assert.equal(mission.state.missions.length, 5);
  assert.equal(mission.state.agent.status, 'idle');
  assert.equal(mission.state.knowledgeMaintenance.status, 'idle');
  const missionId = mission.state.activeMissionId;
  const workspacePath = path.join(smokeRoot, 'runtime', 'workspaces', missionId, 'repository');
  const seedMissionId = mission.state.missions.find((item) => item.id !== missionId).id;
  const newWorkspace = (await request('/api/workspace')).workspace;
  assert.match(newWorkspace, new RegExp(`workspaces/${missionId}/repository`));
  const runtimePreflight = (await request(`/api/runtime/preflight?missionId=${missionId}`)).preflight;
  assert.equal(runtimePreflight.ready, true);
  assert.equal(runtimePreflight.workspaceCheck.code, 'WORKSPACE_READY');
  assert.equal(runtimePreflight.agentCheck.code, 'AGENT_RUNTIME_READY');
  await request(`/api/missions/${seedMissionId}/select`, { method: 'POST' });
  const seedWorkspace = (await request('/api/workspace')).workspace;
  assert.match(seedWorkspace, new RegExp(`workspaces/${seedMissionId}/repository`));
  assert.notEqual(seedWorkspace, newWorkspace);
  await assert.rejects(readFile(path.join(smokeRoot, 'runtime', 'workspaces', seedMissionId, 'repository', 'kernels', 'plan_cache.hpp'), 'utf8'));
  await request(`/api/missions/${missionId}/select`, { method: 'POST' });
  const concurrentMatrix = { environments: ['C500'], stages: ['Correctness'] };
  await Promise.all([
    request('/api/state', { method: 'PATCH', body: JSON.stringify({ missionPaused: true }) }),
    request('/api/state', { method: 'PATCH', body: JSON.stringify({ testMatrix: concurrentMatrix }) }),
  ]);
  const concurrentState = (await request('/api/state')).state;
  assert.equal(concurrentState.missionPaused, true);
  assert.deepEqual(concurrentState.testMatrix.environments, concurrentMatrix.environments);
  assert.deepEqual(concurrentState.testMatrix.stages, concurrentMatrix.stages);
  const pausedReplacementRoot = path.join(smokeRoot, 'paused-replacement-project');
  const pausedReplacementProject = await request('/api/projects', { method: 'POST', body: JSON.stringify({ name: 'Paused replacement project', root: pausedReplacementRoot, initializeGit: true }) });
  const pausedReplacementMission = await request('/api/missions', { method: 'POST', body: JSON.stringify({ title: 'Paused Replacement Mission', goal: '验证旧 Mission 暂停时可以创建新 Mission', projectId: pausedReplacementProject.project.id, hardware: ['C500'] }) });
  assert.notEqual(pausedReplacementMission.state.activeMissionId, missionId);
  assert.equal(pausedReplacementMission.state.missionPaused, false, 'new Mission lifecycle must not inherit the old Mission pause');
  await request(`/api/missions/${missionId}/select`, { method: 'POST' });
  await request('/api/state', { method: 'PATCH', body: JSON.stringify({ missionPaused: false }) });
  const startedMission = await request(`/api/missions/${missionId}/runs`, { method: 'POST', body: '{}' });
  assert.equal(startedMission.state.agent.status, 'running');
  assert.equal(startedMission.state.agent.artifacts[0].title, '正在读取仓库上下文');
  assert.equal(startedMission.state.runtime.mode, 'reference-fixture');
  const startedEvents = await request(`/api/missions/${missionId}/events`);
  assert.deepEqual(startedEvents.events.map((event) => event.type), ['mission.resumed', 'mission.run_started']);
  let agentState;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    agentState = (await request('/api/state')).state;
    if (agentState.agent.status === 'awaiting_action') break;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  assert.equal(agentState.agent.status, 'awaiting_action');
  assert.equal(agentState.agent.currentAction.type, 'candidate.plan');
  assert.equal(agentState.agent.currentAction.approvalRequired, false);
  assert.match(agentState.agent.artifacts.find((artifact) => artifact.kind === 'Candidate Plan').title, /Smoke Mission/);
  assert.match(agentState.agent.toolCalls.find((call) => call.name === 'Experience Search').summary, /C500/);
  const candidateEvents = await request(`/api/missions/${missionId}/events?after=${startedEvents.nextSequence}`);
  assert.equal(candidateEvents.events[0].type, 'candidate.plan_created');
  assert.ok(candidateEvents.events[0].sequence > startedEvents.nextSequence);
  const redirectWithoutCheckpoint = await request('/api/actions/request-review', { method: 'POST', body: JSON.stringify({ outcome: 'redirect', note: 'try redirect before any checkpoint' }) });
  assert.equal(redirectWithoutCheckpoint.state.decisionReview.status, 'awaiting_review');
  const missingCheckpoint = await requestFailure('/api/actions/resolve-review', { method: 'POST', body: JSON.stringify({ outcome: 'redirect', note: 'must not mutate state' }) });
  assert.equal(missingCheckpoint.status, 409);
  assert.equal(missingCheckpoint.payload.code, 'WORKSPACE_CHECKPOINT_MISSING');
  const afterMissingCheckpoint = (await request('/api/state')).state;
  assert.equal(afterMissingCheckpoint.stage, 'candidate');
  assert.equal(afterMissingCheckpoint.decisionReview.status, 'awaiting_review');
  await request('/api/actions/cancel-review', { method: 'POST' });
  const applied = await request('/api/actions/apply-patch', { method: 'POST', body: JSON.stringify({ candidate: 'candidate-02' }) });
  assert.equal(applied.state.patchApplied, true);
  assert.equal(applied.state.stage, 'validation');
  assert.equal(applied.state.agent.status, 'awaiting_action');
  assert.equal(applied.state.agent.currentAction.approvalRequired, false);
  assert.ok(applied.policyChecks.every((check) => check.passed));
  const patchedFile = await readFile(path.join(workspacePath, 'kernels', 'paged_attention.cu'), 'utf8');
  assert.match(patchedFile, /plan_cache\.get_or_build/);

  const rolledBack = await request('/api/actions/rollback-stage', { method: 'POST' });
  assert.equal(rolledBack.state.stage, 'candidate');
  assert.equal(rolledBack.state.patchApplied, false);
  assert.equal(rolledBack.state.workflowRecovery.worktree.status, 'restored');
  assert.equal(rolledBack.state.workflowRecovery.invalidatedArtifacts.length, 0);
  assert.equal(rolledBack.state.agent.currentAction.type, 'candidate.plan');
  const restoredSource = await readFile(path.join(workspacePath, 'kernels', 'paged_attention.cu'), 'utf8');
  assert.doesNotMatch(restoredSource, /plan_cache\.get_or_build/);
  await assert.rejects(readFile(path.join(workspacePath, 'kernels', 'plan_cache.hpp'), 'utf8'));
  const reapplied = await request('/api/actions/apply-patch', { method: 'POST', body: JSON.stringify({ candidate: 'candidate-02' }) });
  assert.equal(reapplied.state.workflowRecovery.checkpoints.length, 2);
  const matrix = { environments: ['C500'], stages: ['Correctness', 'Full Benchmark'] };
  const baselineRunPy = [
    'def get_inputs():',
    '    return {"value": 1}',
    '',
    'def run(inputs):',
    '    return inputs["value"]',
    '',
    'def reference(inputs):',
    '    return inputs["value"]',
    '',
  ].join('\n');
  await request('/api/actions/start-benchmark', {
    method: 'POST',
    body: JSON.stringify({
      purpose: 'baseline',
      runPy: baselineRunPy,
      baselineSource: {
        authority: 'upstream',
        repository: 'https://github.com/flashinfer-ai/flashinfer.git',
        commit: 'smoke-fixture',
        path: 'tests/reference.py',
        operator: 'paged_attention',
        expandedSingleFile: true,
      },
      matrix,
      timeoutSeconds: 1,
    }),
  });
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const baselineState = (await request('/api/state')).state;
    if (baselineState.baseline?.status === 'complete' && baselineState.benchmark?.status === 'idle') break;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  await request('/api/actions/start-benchmark', { method: 'POST', body: JSON.stringify({ matrix, timeoutSeconds: 1 }) });
  const reviewRequested = await request('/api/actions/request-review', { method: 'POST', body: JSON.stringify({ outcome: 'supplement', note: '补充一个长尾 shape 回归结果' }) });
  assert.equal(reviewRequested.state.stage, 'validation');
  assert.equal(reviewRequested.state.decisionReview.status, 'awaiting_review');
  let state;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    state = (await request('/api/state')).state;
    if (state.stage === 'evidence' && state.benchmark.status === 'complete') break;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  assert.equal(state.stage, 'evidence');
  assert.equal(state.decisionReview.status, 'awaiting_review');
  assert.deepEqual(state.testMatrix.environments, matrix.environments);
  assert.deepEqual(state.testMatrix.stages, matrix.stages);
  assert.equal(state.benchmark.result.benchmark.length, 1);
  assert.equal(state.benchmark.result.tracer.format, 'operator-trace/v1');
  assert.equal(state.benchmark.result.profiler.format, 'operator-profile/v1');
  assert.equal(state.benchmark.source.kind, 'operator-test-service');
  assert.equal(state.agent.status, 'awaiting_approval');
  assert.equal(state.decisionReview.request.originStage, 'validation');
  const blockedAdoption = await requestFailure('/api/actions/adopt', { method: 'POST', body: JSON.stringify({ note: 'must not bypass review' }) });
  assert.equal(blockedAdoption.status, 409);
  assert.equal(blockedAdoption.payload.code, 'DECISION_REVIEW_PENDING');
  const redirected = await request('/api/actions/resolve-review', { method: 'POST', body: JSON.stringify({ outcome: 'redirect', note: 'rebuild candidate direction' }) });
  assert.equal(redirected.state.stage, 'candidate');
  assert.equal(redirected.state.patchApplied, false);
  assert.equal(redirected.state.decisionReview.resolution.outcome, 'redirect');
  assert.equal(redirected.state.workflowRecovery.lastRecovery.type, 'intervention_redirect');
  assert.ok(redirected.state.workflowRecovery.invalidatedArtifacts.some((artifact) => artifact.type === 'benchmark'));
  const reappliedAfterRedirect = await request('/api/actions/apply-patch', { method: 'POST', body: JSON.stringify({ candidate: 'candidate-02' }) });
  assert.equal(reappliedAfterRedirect.state.stage, 'validation');
  await request('/api/actions/start-benchmark', { method: 'POST', body: JSON.stringify({ timeoutSeconds: 1 }) });
  for (let attempt = 0; attempt < 20; attempt += 1) {
    state = (await request('/api/state')).state;
    if (state.stage === 'published' && state.knowledgeMaintenance.status === 'completed') break;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  assert.equal(state.stage, 'published');
  assert.equal(state.decisionReview.status, 'resolved');
  assert.equal(state.decisionReview.resolution.source, 'policy');
  assert.equal(state.candidateEvaluations.find((candidate) => candidate.id === 'candidate-02').classification, 'accepted');
  assert.ok(state.failureRecords.every((record) => !record.id.startsWith('candidate-')));
  assert.equal(state.failureRecords[0].failure.disposition, 'candidate_removed');
  assert.equal(state.failureRecords[0].extractedExperience.status, 'extracted');
  const workflowEvents = await request(`/api/missions/${missionId}/events`);
  assert.deepEqual(workflowEvents.events.map((event) => event.sequence), workflowEvents.events.map((event) => event.sequence).toSorted((left, right) => left - right));
  assert.ok(workflowEvents.events.some((event) => event.type === 'patch.applied'));
  assert.ok(workflowEvents.events.some((event) => event.type === 'operator_test.completed'));
  assert.ok(workflowEvents.events.some((event) => event.type === 'decision.auto_adopted'));
  const adopted = { state };
  assert.equal(adopted.state.stage, 'published');
  assert.equal(adopted.state.decisionReview.status, 'resolved');
  assert.equal(adopted.state.decisionReview.resolution.source, 'policy');
  assert.match(adopted.state.knowledgeDrafts[0].trigger, /50μs/);
  assert.equal(adopted.state.knowledgeDrafts[0].evidenceRefs.length, 5);
  assert.equal(adopted.state.knowledgeMaintenance.status, 'completed');
  assert.equal(adopted.state.knowledgeMaintenance.summary.autoPublished, 0);
  assert.equal(adopted.state.knowledgeMaintenance.summary.reviewRequired, 3);
  assert.equal(adopted.state.publishedAssets.length, 3);
  assert.equal(adopted.state.publishedAssets[0].version, 'v1.3');
  assert.deepEqual(adopted.state.publishedAssets.map((asset) => asset.version), ['v1.3', 'v1.0', 'v2.4']);
  assert.ok(adopted.state.knowledgeMaintenance.changes.every((change) => change.outcome === 'simulation_only'));
  assert.ok(adopted.state.publishedAssets.every((asset) => asset.status === 'simulation' && asset.evidenceLevel === '模拟证据'));
  assert.equal(adopted.state.knowledgeMaintenance.changes.filter((change) => change.action === 'update').length, 2);
  assert.equal(adopted.state.knowledgeMaintenance.changes.filter((change) => change.action === 'create').length, 1);
  assert.match(adopted.state.publishedAssets[0].procedure, /shape bucket/);
  assert.equal(adopted.state.runtimeEvents.filter((event) => event.type === 'knowledge.maintenance_completed').length, 1);

  const immutableBefore = JSON.stringify({ drafts: adopted.state.knowledgeDrafts, assets: adopted.state.publishedAssets, maintenance: adopted.state.knowledgeMaintenance, events: adopted.state.runtimeEvents, audit: adopted.state.auditEvents });
  const immutablePatch = await requestFailure('/api/knowledge/drafts/exp.async-plan-cache', { method: 'PATCH', body: JSON.stringify({ title: 'silently changed' }) });
  assert.equal(immutablePatch.status, 409);
  assert.equal(immutablePatch.payload.code, 'KNOWLEDGE_IMMUTABLE');
  const retiredSingle = await requestFailure('/api/knowledge/publish', { method: 'POST', body: '{}' });
  assert.equal(retiredSingle.status, 410);
  assert.equal(retiredSingle.payload.code, 'KNOWLEDGE_PUBLISH_RETIRED');
  const retiredBatch = await requestFailure('/api/knowledge/publish-all', { method: 'POST', body: '{}' });
  assert.equal(retiredBatch.status, 410);
  assert.equal(retiredBatch.payload.code, 'KNOWLEDGE_PUBLISH_RETIRED');
  const replayedAdoption = await request('/api/actions/adopt', { method: 'POST', body: JSON.stringify({ note: 'duplicate request' }) });
  assert.equal(replayedAdoption.idempotent, true);
  assert.equal(replayedAdoption.state.runtimeEvents.filter((event) => event.type === 'knowledge.maintenance_completed').length, 1);
  const immutableAfter = await request('/api/state');
  assert.equal(JSON.stringify({ drafts: immutableAfter.state.knowledgeDrafts, assets: immutableAfter.state.publishedAssets, maintenance: immutableAfter.state.knowledgeMaintenance, events: immutableAfter.state.runtimeEvents, audit: immutableAfter.state.auditEvents }), immutableBefore);
  const referenced = await request('/api/knowledge/references', { method: 'POST', body: JSON.stringify({ assetId: 'exp.c500-cache-layout', title: '沐曦 C500 片上缓存与数据布局准则', version: 'v2.1', reason: 'smoke reuse' }) });
  assert.ok(referenced.state.knowledgeReferences.some((item) => item.assetId === 'exp.c500-cache-layout' && item.missionId === missionId));
  const reverted = await request('/api/actions/revert-adoption', { method: 'POST', body: '{}' });
  assert.equal(reverted.state.stage, 'published');
  assert.equal(reverted.state.currentBest.candidateId, 'candidate-01');
  assert.equal(reverted.state.decisionReview.resolution.outcome, 'reverted');
  assert.ok(reverted.state.publishedAssets.every((asset) => asset.status === 'superseded'));
  assert.equal(reverted.state.workflowRecovery.lastRecovery.type, 'adoption_revert');
  assert.ok(reverted.state.runtimeEvents.some((event) => event.type === 'decision.adoption_reverted'));
  const revertedSource = await readFile(path.join(workspacePath, 'kernels', 'paged_attention.cu'), 'utf8');
  assert.doesNotMatch(revertedSource, /plan_cache\.get_or_build/);
  const replayedRevert = await request('/api/actions/revert-adoption', { method: 'POST', body: '{}' });
  assert.equal(replayedRevert.idempotent, true);
  const rerun = await request(`/api/missions/${missionId}/runs`, { method: 'POST', body: JSON.stringify({ goal: 'rerun isolation check' }) });
  assert.equal(rerun.state.stage, 'diagnosis');
  assert.equal(rerun.state.benchmark.status, 'idle');
  assert.equal(rerun.state.publishedAssets.length, 0);
  assert.equal(rerun.state.knowledgeMaintenance.status, 'idle');
  assert.equal(rerun.state.runHistory[0].runId, startedMission.state.agent.runId);
  console.log('[smoke] full mission workflow passed');
} finally {
  child.kill();
  testService.kill();
  await Promise.all([child, testService].map((process) => process.exitCode === null ? new Promise((resolve) => process.once('exit', resolve)) : Promise.resolve()));
  await rm(smokeRoot, { recursive: true, force: true });
}
