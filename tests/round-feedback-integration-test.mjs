// Independent Phase 1 acceptance: two production rounds, connected only through production
// projection/archive/prepare/runtime ports.
//
// What is REAL here (no hand-filled connectivity evidence):
//   - ExperienceService + domain contract (createExperienceService / experience-contract.mjs).
//   - Experience repository: the real filesystem repository (createExperienceRepository) on a
//     per-test temp root. It is wrapped in a read-counting port proxy ONLY to observe reads;
//     the storage itself is not replaced.
//   - Mission lifecycle: createMissionProjectState().createMission / resetMissionRunState,
//     i.e. the production archive that produces roundFacts.
//   - Result projection: applyOperatorTestSnapshot on a hand-built fixture matching the queue
//     snapshot shape from tools/local-shared-gpu-runner.py (targetProbe/device/driverVersion), and the
//     production shared-GPU observation verifier.
//   - Round orchestration: createMainRoundOrchestrationService + createAgentRoundService, and
//     the production round budget contract.
//   - Manual path: agent-commands 'runs.prepare' capture/replay.
//   - Prompt/authored prompt: production createAgentRuntime, which builds and audits the exact
//     string handed to the provider start port.
//
// What is an injected PORT DOUBLE:
//   - the Agent provider client (claude/codex). It captures `start.goal`; no Agent process runs.
//   - the local-shared-gpu execution adapter (no GPU is executed); the RESULT SHAPE is the real
//     runner shape, and the queue/projection/verification path downstream is production code.
//   - package admission/readTask, checkpoint creation and rejected-round recovery ports.
//     Runtime workspace boundaries use real temp directories; this test does not perform a
//     real Git rollback. Recovery behavior itself has a separate module test and live evidence.
//
// iterationContext / roundFacts / resolvedTarget are never assigned by this test. They are only
// read back after production code produces them.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'operator-round-feedback-'));
process.env.OPERATOR_RUNTIME_DIR = path.join(tempRoot, 'runtime');
process.env.OPERATOR_DATA_DIR = path.join(tempRoot, 'data');
delete process.env.OPERATOR_RUNTIME_MODE;

const sha256Hex = (value) => createHash('sha256').update(value, 'utf8').digest('hex');
const digest = (label) => `sha256:${sha256Hex(label)}`;
const clock = Date.parse('2026-09-12T00:00:00.000Z');
const iso = (ms = clock) => new Date(ms).toISOString();
let idCounter = 0;

try {
  const { createMissionProjectState, selectRoundFactsForPrompt } = await import('../client-runtime/mission-project-state.mjs');
  const { applyOperatorTestSnapshot } = await import('../client-runtime/operator-test-evidence.mjs');
  const { createExperienceRepository } = await import('../client-runtime/experience-repository.mjs');
  const { createExperienceService } = await import('../client-runtime/application/experience-service.mjs');
  const { createRoundExperienceService } = await import('../client-runtime/application/round-experience-service.mjs');
  const { createSharedGpuExperienceVerifier } = await import('../client-runtime/application/shared-gpu-experience-verifier.mjs');
  const { createAgentRoundService } = await import('../client-runtime/application/agent-round-service.mjs');
  const { createMainRoundOrchestrationService } = await import('../client-runtime/application/main-round-orchestration-service.mjs');
  const { createAgentRuntime } = await import('../client-runtime/agent-runtime.mjs');
  const { createAgentCommands } = await import('../client-runtime/application/agent-commands.mjs');
  const { ensureRoundBudgetStarted, completeRoundBudget, ROUND_BUDGET_MS } = await import('../client-runtime/round-budget-contract.mjs');
  const { isManagedWorkspaceRuntimeMode } = await import('../client-runtime/agent-runtime/capabilities.mjs');
  const { appendRuntimeEvent, addAuditEvent } = await import('../client-runtime/runtime-events.mjs');
  const { EXPERIENCE_LIMITS } = await import('../client-runtime/experience-contract.mjs');

  assert.equal(ROUND_BUDGET_MS, 15 * 60 * 1000);
  const timers = { setTimeout: (cb, ms) => setTimeout(cb, ms), clearTimeout: (handle) => clearTimeout(handle) };

  // ---------------------------------------------------------------------------
  // Real-shape snapshot builder (mirrors tools/local-shared-gpu-runner.py output).
  // ---------------------------------------------------------------------------
  const buildSnapshot = ({ taskId, missionId, queueRunId, candidateId, patchDigestRaw, binding, primaryValue = 11.264, architecture = 'sm86', hardware = 'nvidia-gpu', driverVersion = '551.78', device = 'NVIDIA GeForce RTX 3060 Laptop GPU', correctnessPassed = true, error = null, status = 'completed', purpose = 'candidate', includeExperienceEvidence = true }) => {
    const evidence = {
      missionId, candidateId, runId: queueRunId, patchDigest: `sha256:${patchDigestRaw}`,
      packageDigest: binding.packageDigest, environmentDigest: binding.environmentDigest, acceptanceDigest: binding.acceptanceDigest,
      hardware, executionMode: 'gpu', outcome: correctnessPassed ? 'passed' : 'failed', operation: 'test', liveHardware: true,
      ...(architecture ? { architecture } : {}),
    };
    const cases = ['minimal', 'representative', 'boundary', 'ragged'].map((name) => ({
      case: name, dtype: 'float32', maxDiff: 1e-6, rmse: 1e-7, cosDiff: 1e-8, passed: correctnessPassed,
    }));
    const correctness = {
      passed: correctnessPassed, total: 4, passedCases: correctnessPassed ? 4 : 0,
      failedCase: correctnessPassed ? null : 3, failedCaseName: correctnessPassed ? null : 'boundary',
      failedCaseCategory: correctnessPassed ? null : 'boundary', caseResults: cases,
      error: correctnessPassed ? null : 'boundary case mismatch',
    };
    const measurements = [
      { environment: 'local-shared-gpu', metric: 'latency p50', profile: 'primary', value: primaryValue, unit: 'us', samples: 10, warmup: 3, p95: primaryValue * 1.08, correctness },
      { environment: 'local-shared-gpu', metric: 'latency p50', profile: 'small', value: primaryValue * 0.87, unit: 'us', samples: 10, warmup: 3, p95: primaryValue, correctness },
    ];
    const environment = {
      requested: ['local-shared-gpu'], runtime: 'local-shared-gpu-runner/v1', service: 'local-shared-gpu-adapter',
      source: 'local-shared-gpu', hardware, executionMode: 'gpu', liveHardware: true, publishable: false,
      ...(architecture ? { architecture } : {}), device, driverVersion,
      targetProbe: { deviceName: device, driverVersion, architecture },
    };
    return {
      taskId, status, progress: status === 'completed' ? 100 : 40, completedAt: iso(), durationMs: 2000,
      resourceRelease: { confirmed: true, status: 'confirmed', resources: [] },
      ...(error ? { error } : {}),
      payload: { missionId, requestId: queueRunId, purpose, ...binding, workspaceId: missionId, target: { hardware: [hardware], architecture }, build: {}, adapter: {} },
      result: status === 'completed' ? {
        schemaVersion: 'operator-studio.shared-gpu-result/v1', status: 'completed',
        benchmark: measurements, environment, executionPackage: { ...binding, workspaceId: missionId }, publishable: false,
        ...(includeExperienceEvidence ? { experienceEvidence: evidence } : {}),
        tracer: { format: 'operator-trace/v1', status: 'completed', events: [{ name: 'mctracer', category: 'tool' }] },
        profiler: { format: 'operator-profile/v1', status: 'completed', metrics: { latencyP50Us: primaryValue } },
      } : null,
    };
  };

  // ---------------------------------------------------------------------------
  // Scenario harness
  // ---------------------------------------------------------------------------
  const createScenario = async ({ name, hardware = ['local-shared-gpu'], operator = 'generic_affine', tags = ['affine'], correctnessCases = 4 }) => {
    const rootDir = path.join(tempRoot, 'scenarios', name);
    const missionWorkspaceRoot = path.join(tempRoot, 'workspaces', name);
    const projectState = createMissionProjectState({
      rootDir,
      workspaceDir: missionWorkspaceRoot,
      workspaceDirForMission: (missionId) => path.join(missionWorkspaceRoot, missionId),
      missionSourceDirFor: (missionId) => path.join(rootDir, 'sources', missionId),
    });
    const state = { missions: [], projects: [], activeMissionId: null, activeProjectId: null, runtimeEvents: [], auditEvents: [], iterationStats: {} };
    projectState.createMission(state, {
      title: `Scenario ${name}`, goal: `Optimize the affine kernel for ${name}`, metric: 'latency p50',
      hardware, operator, tags, repository: `repo-${name}`, testMatrix: { correctnessCases },
      objective: { targetRelativeImprovement: 0.999999 },
    });
    const mission = state.missions.find((item) => item.id === state.activeMissionId);
    const repository = createExperienceRepository({ rootDir: path.join(tempRoot, 'stores', name) });
    let reads = 0;
    const countingRepository = { read: async () => { reads += 1; return repository.read(); }, transact: (mutator) => repository.transact(mutator) };
    const experienceService = createExperienceService({
      repository: countingRepository, now: () => iso(), createId: () => `exp_${name}_${++idCounter}`,
    });
    const tasks = new Map();
    const admissions = new Map();
    const verifier = createSharedGpuExperienceVerifier({
      executionPackageStore: {
        verifyAdmission: async (request) => {
          if (!admissions.has(request.admissionId)) throw new Error(`unknown admission ${request.admissionId}`);
          return { admission: { preparedArtifactDigest: admissions.get(request.admissionId) }, manifest: { requestId: request.requestId }, environment: {} };
        },
      },
      packageAdapter: { verifyPreparedArtifact: async () => ({ valid: true }) },
      readTask: async (taskId) => tasks.get(taskId) || null,
      now: () => clock,
    });
    const roundExperience = createRoundExperienceService({
      experienceService,
      resolveAccess: ({ mission: bound }) => ({ projectId: bound.projectId, allowedProjectIds: [bound.projectId] }),
      verifyObservationEvidence: verifier, timers,
    });
    const bridgeDir = path.join(tempRoot, 'bridges', name);
    const workspaceRoot = path.join(tempRoot, 'workspaces', name);
    return {
      name, rootDir, projectState, state, mission, repository, experienceService, roundExperience,
      verifier, tasks, admissions, bridgeDir, workspaceRoot, reads: () => reads, timers,
      workspaceForMission: (missionId = mission.id) => path.join(missionWorkspaceRoot, missionId),
    };
  };

  // Round-1 state: a real queue result was projected, the Agent finished terminal, and the
  // candidate/currentBest/assets are PRIOR PERSISTENT-STATE FIXTURES (seed), not outputs of
  // this deterministic test. The queue projection and everything after it runs for real.
  const seedRoundOne = ({ scenario, candidateId = 'candidate-r1', priorCandidateId = 'candidate-r0', queueRunId = 'queue-run-1', primaryValue = 11.264, currentBestValue = 9.5, architecture = 'sm86', device, driverVersion, purpose = 'candidate', gateSnapshot = true, includeExperienceEvidence = true }) => {
    const { state, mission } = scenario;
    ensureRoundBudgetStarted(state, { nowMs: clock });
    const roundId = state.iterationStats.roundBudget.roundId;
    const patchDigestRaw = sha256Hex(`${scenario.name}:${candidateId}`);
    const binding = {
      packageDigest: digest(`${scenario.name}:package`), admissionId: `admission_${scenario.name}`,
      preparedArtifactDigest: digest(`${scenario.name}:artifact`), environmentDigest: digest(`${scenario.name}:environment`),
      acceptanceDigest: digest(`${scenario.name}:acceptance`),
    };
    scenario.admissions.set(binding.admissionId, binding.preparedArtifactDigest);
    // Prior persistent state (fixture): the round-1 candidate and the earlier adopted best.
    state.iterationStats = { ...state.iterationStats, round: 0 };
    state.agent = {
      status: 'completed', runId: 'agent_round_1', roundId, missionId: mission.id, runtimeKind: 'claude-code',
      goal: mission.goal, threadId: 'thread-round-1', phase: '候选验证完成', toolCalls: [], messages: [],
    };
    state.appliedCandidateId = candidateId;
    state.candidateEvaluations = [
      { id: candidateId, title: `${candidateId} vectorized load`, change: 'merge boundary copies into one vectorized load', files: ['run.py'], patchDigest: patchDigestRaw, candidateGenerationPath: 'structured_edit', degraded: false },
      { id: priorCandidateId, title: 'prior adopted best', change: 'prior direction', files: ['run.py'], patchDigest: sha256Hex(`${scenario.name}:prior`), status: 'active', classification: 'eligible', decision: 'adopted' },
    ];
    state.currentBest = { candidateId: priorCandidateId, version: 'cnd.00', value: currentBestValue, improvement: '−20.0%', status: 'active', measurements: [{ profile: 'primary', value: currentBestValue }] };
    state.publishedAssets = [{ id: `asset.${priorCandidateId}`, sourceCandidate: priorCandidateId, status: 'validated', version: 'v1.0' }];
    state.workflowRecovery = {
      ...(state.workflowRecovery || {}),
      checkpoints: [{ id: 'cp-round-1', stableDigest: digest(`${scenario.name}:checkpoint`), createdAt: iso() }],
    };
    state.benchmark = {
      ...state.benchmark, status: 'running', progress: 10, testTaskId: `task_${scenario.name}`, runId: queueRunId,
      purpose, candidate: { id: candidateId, digest: `sha256:${patchDigestRaw}` }, matrix: structuredClone(mission.testMatrix), logs: [],
    };
    const snapshot = buildSnapshot({
      taskId: `task_${scenario.name}`, missionId: mission.id, queueRunId, candidateId, patchDigestRaw, binding,
      primaryValue, architecture, device, driverVersion, purpose, includeExperienceEvidence,
    });
    scenario.tasks.set(snapshot.taskId, snapshot);
    if (gateSnapshot !== false) applyOperatorTestSnapshot(state, snapshot);
    return { roundId, patchDigestRaw, patchDigest: `sha256:${patchDigestRaw}`, binding, snapshot, queueRunId };
  };

  const advanceToRoundTwo = async (scenario, seed, { mode = 'claude-code', recovery = true } = {}) => {
    const { state, mission, projectState } = scenario;
    completeRoundBudget(state, { nowMs: clock });
    state.iterationStats = { ...state.iterationStats, round: 1 };
    ensureRoundBudgetStarted(state, { nowMs: clock, completedRoundId: seed.roundId });
    const roundTwoId = state.iterationStats.roundBudget.roundId;
    assert.equal(roundTwoId, `${mission.id}:round:2`);

    const workspace = scenario.workspaceForMission();
    await mkdir(workspace, { recursive: true });
    const providerStarts = [];
    const client = {
      describe: async () => ({ installed: true, loggedIn: true, version: 'deterministic-provider-double' }),
      start: async (input) => {
        providerStarts.push(input.goal);
        return { runId: input.runId, threadId: 'thread-round-2', startedAt: iso(), workspace: input.workspace };
      },
      readRun: async () => ({ status: 'running' }), readEvents: async () => [], cancel: async () => ({}), eventText: () => '',
    };
    const agentRuntime = createAgentRuntime({
      mode, bridgeDir: scenario.bridgeDir, codexWorkspace: scenario.workspaceRoot,
      ...(mode === 'claude-code' ? { claudeClient: client } : { codexClient: client }),
    });
    const agentRound = createAgentRoundService({
      resetMissionRunState: projectState.resetMissionRunState,
      resetMissionWorkspace: async () => {},
      createWorkspaceCheckpoint: async (missionId, label) => ({ id: `cp-${label}`, missionId, label, stableDigest: digest(`${scenario.name}:round2-checkpoint`), createdAt: iso() }),
      startAgentRun: (target, goal, options) => projectState.startAgentRun(target, goal, options),
      appendRuntimeEvent, isManagedWorkspaceRuntimeMode, agentRuntime,
      roundExperience: scenario.roundExperience, nowMs: () => clock,
    });
    const orchestration = createMainRoundOrchestrationService({
      agentRuntime,
      preflight: { prepare: async () => ({ mission, preflight: { workspace } }) },
      recovery: {
        restoreRejectedRound: async () => (recovery
          ? { candidateId: 'candidate-r1', candidateDigest: seed.patchDigest, checkpointId: 'cp-round-1', stableDigest: digest(`${scenario.name}:checkpoint`), workspaceClean: true, restoredAt: iso() }
          : null),
      },
      artifactGuard: { assertReady: () => {} },
      agentRound, appendRuntimeEvent, addAuditEvent,
    });
    const result = await orchestration.start({ state, goal: 'Round 2: continue from the archived round-1 facts.' });
    assert.equal(providerStarts.length, 1, 'exactly one provider start for round 2');
    const prompt = providerStarts[0];
    const auditPath = path.join(scenario.bridgeDir, 'prompt-audits', `${state.agent.runId}.json`);
    const audit = JSON.parse(await readFile(auditPath, 'utf8'));
    assert.equal(audit.deliveryStage, 'prepared-before-send');
    assert.equal(audit.prompt, prompt, 'audited pre-send prompt must equal provider start.goal');
    assert.equal(audit.promptDigest, `sha256:${sha256Hex(prompt)}`);
    assert.equal(audit.promptBytes, Buffer.byteLength(prompt, 'utf8'));
    const factsRaw = prompt.split('----- BEGIN MISSION ITERATION CONTEXT -----\n')[1]?.split('\n----- END MISSION ITERATION CONTEXT -----')[0];
    assert.ok(factsRaw, 'round-2 prompt must embed the archived iteration context');
    const facts = JSON.parse(factsRaw);
    assert.deepEqual(audit.roundFacts, facts, 'audit roundFacts must be the same projection sent to the provider');
    return { prompt, audit, facts, roundTwoId, result, providerStarts, workspace };
  };

  const parseExperienceContext = (prompt) => {
    const raw = prompt.split('----- BEGIN UNTRUSTED EXPERIENCE DATA -----\n')[1]?.split('\n----- END UNTRUSTED EXPERIENCE DATA -----')[0];
    assert.ok(raw, 'round-2 prompt must embed the frozen experience context');
    return JSON.parse(raw);
  };

  // The prompt embeds the context as JSON, so embedded newlines are escaped. The parsed
  // context equality above proves the full content; here we additionally require every
  // non-empty content line to be present literally in the provider prompt.
  const promptCarriesExperience = (prompt, experience) => prompt.includes(experience.id)
    && experience.content.split('\n').every((line) => !line.trim() || prompt.includes(line));

  const results = [];

  // ===========================================================================
  // A. Main two-round connectivity (claude-code), including rollback origin.
  // ===========================================================================
  {
    const scenario = await createScenario({ name: 'connectivity' });
    const seed = seedRoundOne({ scenario });

    // The execution target came from the real snapshot projection, not from mission.hardware.
    assert.deepEqual(scenario.state.iterationStats.resolvedTarget.hardware, ['nvidia-gpu']);
    assert.deepEqual(scenario.state.iterationStats.resolvedTarget.architecture, ['sm86']);
    assert.deepEqual(scenario.mission.hardware, ['local-shared-gpu'], 'mission hardware declares the backend, never the hardware target');
    assert.equal(scenario.state.iterationStats.resolvedTarget.sourceTaskId, seed.snapshot.taskId);
    assert.equal(scenario.state.iterationStats.resolvedTarget.device, 'NVIDIA GeForce RTX 3060 Laptop GPU');
    assert.equal(scenario.state.iterationStats.resolvedTarget.driverVersion, '551.78');
    // Accept Gate reference disposition: correctness+evidence complete, performance target unmet.
    assert.equal(scenario.state.decisionReview.gate.result, 'reference');
    assert.equal(scenario.state.decisionReview.gate.passed, false);
    assert.deepEqual(scenario.state.decisionReview.gate.failedRules, ['baseline.current_reference', 'performance.target'], 'the reference round truthfully retains the unmet performance target and the missing baseline');
    assert.equal(scenario.state.failureRecords.length, 0, 'a reference result must not fabricate a failureRecord');

    // Round-1 observation is recorded through the production verifier + real repository.
    const collected = await scenario.roundExperience.collect({ state: scenario.state, mission: scenario.mission });
    assert.equal(collected.status, 'recorded');
    const roundOneExperience = collected.records[0].experience;
    assert.ok(roundOneExperience.id && roundOneExperience.version === 1);
    assert.equal(roundOneExperience.verification.publishable, false);
    assert.equal(roundOneExperience.evidence.hardware, 'nvidia-gpu');
    assert.equal(roundOneExperience.scope.architecture[0], 'sm86');

    const before = { iterationContext: scenario.mission.iterationContext };
    const roundTwo = await advanceToRoundTwo(scenario, seed);
    const facts = roundTwo.facts;

    // Previous round identity and candidate binding.
    assert.equal(facts.schemaVersion, 'operator-studio.round-facts/v1');
    assert.equal(facts.target.roundId, roundTwo.roundTwoId);
    assert.equal(facts.target.missionId, scenario.mission.id);
    assert.equal(facts.target.projectId, scenario.mission.projectId);
    assert.equal(facts.previous.runId, 'agent_round_1');
    assert.equal(facts.previous.roundId, seed.roundId);
    assert.equal(facts.previous.roundIdSource, 'run');
    assert.equal(facts.previous.missionId, scenario.mission.id);
    assert.equal(facts.previous.queueRequestId, seed.queueRunId);
    assert.equal(facts.previous.candidateId, 'candidate-r1');
    assert.equal(facts.previous.candidateDigest, seed.patchDigest);
    assert.equal(facts.previous.runtimeKind, 'claude-code');
    // Candidate summary, correctness, failure/Gate, rollback and currentBest are all present.
    assert.equal(facts.candidate.id, 'candidate-r1');
    assert.equal(facts.candidate.title, 'candidate-r1 vectorized load');
    assert.equal(facts.candidate.direction, 'merge boundary copies into one vectorized load');
    assert.deepEqual(facts.candidate.files, ['run.py']);
    assert.equal(facts.candidate.generationPath, 'structured_edit');
    assert.equal(facts.candidate.degraded, false);
    assert.equal(facts.correctness.status, 'passed');
    assert.equal(facts.correctness.total, 4);
    assert.equal(facts.correctness.environments.length, 2);
    assert.equal(facts.failure, null, 'the reference round has no failure channel, truthfully');
    assert.equal(facts.gate.result, 'reference');
    assert.equal(facts.gate.passed, false);
    assert.equal(facts.gate.failedRules.includes('performance.target'), true);
    assert.ok(facts.gate.summary.includes('未达到性能目标'));
    assert.equal(facts.decision.outcome, 'reference');
    assert.equal(facts.rollback.performed, true);
    assert.equal(facts.rollback.status, 'performed');
    assert.equal(facts.rollback.checkpointId, 'cp-round-1');
    assert.equal(facts.rollback.workspaceClean, true);
    assert.equal(facts.rollback.candidateId, 'candidate-r1');
    assert.equal(facts.currentBest.candidateId, 'candidate-r0');
    assert.equal(facts.currentBest.version, 'cnd.00');
    assert.equal(facts.currentBest.status, 'active');
    assert.equal(facts.currentBest.candidateClassification, 'eligible');
    assert.equal(facts.currentBest.candidateDecision, 'adopted');
    assert.equal(facts.currentBest.assetStatus, 'validated');
    assert.equal(facts.currentBest.assetVersion, 'v1.0');
    // The queue projection carried both fixed profiles.
    assert.deepEqual(facts.correctness.environments.map((item) => item.profile), ['primary', 'small']);

    // Round-1 experience reaches round 2 by ID + version + full content, via the real prompt.
    const context = parseExperienceContext(roundTwo.prompt);
    assert.equal(context.items.length, 1);
    assert.equal(context.items[0].id, roundOneExperience.id);
    assert.equal(context.items[0].version, 1);
    assert.equal(context.items[0].content, roundOneExperience.content);
    assert.ok(roundTwo.prompt.includes(roundOneExperience.id));
    assert.equal(promptCarriesExperience(roundTwo.prompt, roundOneExperience), true, 'provider prompt must carry the full round-1 experience content');
    assert.ok(roundTwo.prompt.includes('Candidate=candidate-r1'));
    assert.equal(roundTwo.audit.selection.selected.length, 1);
    assert.deepEqual(roundTwo.audit.selection.selected.map((item) => [item.id, item.version, item.source]),
      [[roundOneExperience.id, 1, 'execution']]);
    assert.equal(roundTwo.audit.selection.contextId, context.contextId);
    assert.equal(roundTwo.audit.selection.excluded.some((item) => item.reason === 'scope'), false);
    // Nothing was hand-filled into the mission definition.
    assert.equal(scenario.mission.iterationContext, before.iterationContext);
    assert.equal(scenario.mission.iterationContext, undefined);
    assert.equal(selectRoundFactsForPrompt(scenario.state, scenario.mission).target.roundId, roundTwo.roundTwoId);

    results.push({
      case: 'two-round-connectivity', provider: 'claude-code',
      experience: { id: roundOneExperience.id, version: 1 },
      factsBinding: { previousRunId: facts.previous.runId, previousRoundId: facts.previous.roundId, candidateId: facts.candidate.id, candidateDigest: facts.candidate.digest },
      audit: { path: path.join(scenario.bridgeDir, 'prompt-audits', `${scenario.state.agent.runId}.json`), digest: roundTwo.audit.promptDigest, bytes: roundTwo.audit.promptBytes, selectionContextId: roundTwo.audit.selection.contextId },
    });
  }

  // ===========================================================================
  // B. Same provider contract for codex-cli (parameterized, no divergent path).
  // ===========================================================================
  {
    const scenario = await createScenario({ name: 'codex' });
    const seed = seedRoundOne({ scenario });
    const collected = await scenario.roundExperience.collect({ state: scenario.state, mission: scenario.mission });
    const roundOneExperience = collected.records[0].experience;
    const roundTwo = await advanceToRoundTwo(scenario, seed, { mode: 'codex-cli' });
    const context = parseExperienceContext(roundTwo.prompt);
    assert.equal(roundTwo.prompt.includes(roundOneExperience.id), true);
    assert.equal(promptCarriesExperience(roundTwo.prompt, roundOneExperience), true);
    assert.equal(context.items[0].id, roundOneExperience.id);
    assert.equal(roundTwo.facts.gate.result, 'reference');
    assert.equal(roundTwo.audit.runtimeMode, 'codex-cli');
    results.push({ case: 'two-round-connectivity', provider: 'codex-cli', experience: { id: roundOneExperience.id, version: 1 }, audit: { path: roundTwo.audit.path, digest: roundTwo.audit.promptDigest } });
  }

  // ===========================================================================
  // C. Negative: backend name is not a hardware target.
  // ===========================================================================
  {
    const scenario = await createScenario({ name: 'backend-target', hardware: ['local-shared-gpu'] });
    ensureRoundBudgetStarted(scenario.state, { nowMs: clock });
    await assert.rejects(
      scenario.roundExperience.prepare({ state: scenario.state, mission: scenario.mission, roundId: scenario.state.iterationStats.roundBudget.roundId }),
      (error) => error.code === 'ROUND_EXPERIENCE_TARGET_INVALID',
    );
    assert.equal(scenario.state.iterationStats.roundExperience, undefined);
    results.push({ case: 'backend-as-hardware-fails-explicitly', code: 'ROUND_EXPERIENCE_TARGET_INVALID' });
  }

  // ===========================================================================
  // D. Negative: same NVIDIA vendor, different architecture must not bleed.
  // ===========================================================================
  {
    const scenario = await createScenario({ name: 'arch-scope' });
    const seed = seedRoundOne({ scenario });
    const collected = await scenario.roundExperience.collect({ state: scenario.state, mission: scenario.mission });
    assert.equal(collected.recorded, 1);
    await scenario.experienceService.create({
      projectId: scenario.mission.projectId, visibility: 'project', title: 'sm100 only kernel', content: 'Blackwell-only implementation notes',
      author: 'operator', confidence: 'medium', scope: { operator: scenario.mission.operator, tags: scenario.mission.tags, hardware: ['nvidia-gpu'], architecture: ['sm100'] },
    });
    const prepared = await scenario.roundExperience.prepare({ state: scenario.state, mission: scenario.mission, roundId: seed.roundId });
    assert.equal(prepared.items.length, 1);
    const sm100 = scenario.state.iterationStats.roundExperienceSelection.excluded.find((item) => item.reason === 'scope');
    assert.ok(sm100, 'sm100 record must be excluded with a traceable scope reason');
    assert.equal(prepared.items.every((item) => item.scope.architecture?.[0] === 'sm86'), true);

    // A conflicting sm100 projection is still reported as a mismatch against the sm86 target.
    const conflicting = buildSnapshot({
      taskId: 'task_arch-scope_sm100', missionId: scenario.mission.id, queueRunId: 'queue-run-sm100',
      candidateId: 'candidate-r1', patchDigestRaw: seed.patchDigestRaw, binding: seed.binding, architecture: 'sm100',
    });
    scenario.tasks.set(conflicting.taskId, conflicting);
    scenario.state.benchmark = { ...scenario.state.benchmark, testTaskId: conflicting.taskId, runId: conflicting.payload.requestId };
    applyOperatorTestSnapshot(scenario.state, conflicting);
    const mismatch = scenario.state.iterationStats.resolvedTargetMismatch;
    assert.ok(mismatch, 'a conflicting architecture projection must be recorded');
    assert.equal(mismatch.issues.some((item) => item.field === 'architecture' && item.expected.includes('sm86') && item.actual.includes('sm100')), true);
    results.push({ case: 'architecture-dimension-separated', excludedReason: 'scope', mismatchIssues: mismatch.issues.length });
  }

  // ===========================================================================
  // E. Negative: wrong task snapshot is a no-op; cross-Mission evidence never binds.
  // ===========================================================================
  {
    const scenario = await createScenario({ name: 'isolation' });
    ensureRoundBudgetStarted(scenario.state, { nowMs: clock });
    scenario.state.benchmark = { ...scenario.state.benchmark, testTaskId: 'task_owner', status: 'running' };
    const foreign = buildSnapshot({ taskId: 'task_other', missionId: scenario.mission.id, queueRunId: 'queue-other', candidateId: 'candidate-x', patchDigestRaw: sha256Hex('x'), binding: { packageDigest: digest('x-p'), admissionId: 'admission_x', preparedArtifactDigest: digest('x-a'), environmentDigest: digest('x-e'), acceptanceDigest: digest('x-c') } });
    const before = JSON.stringify(scenario.state.benchmark);
    applyOperatorTestSnapshot(scenario.state, foreign);
    assert.equal(JSON.stringify(scenario.state.benchmark), before, 'a snapshot for another task must not touch this benchmark');
    assert.equal(scenario.state.iterationStats.resolvedTarget, undefined);

    // Cross-Mission payload/evidence cannot project a target...
    const cross = buildSnapshot({ taskId: 'task_owner', missionId: 'MIS_OTHER', queueRunId: 'queue-cross', candidateId: 'candidate-x', patchDigestRaw: sha256Hex('x'), binding: { packageDigest: digest('x-p'), admissionId: 'admission_x', preparedArtifactDigest: digest('x-a'), environmentDigest: digest('x-e'), acceptanceDigest: digest('x-c') } });
    scenario.state.benchmark = { ...scenario.state.benchmark, testTaskId: 'task_owner', runId: 'queue-cross', purpose: 'candidate', candidate: { id: 'candidate-x', digest: `sha256:${sha256Hex('x')}` } };
    applyOperatorTestSnapshot(scenario.state, cross);
    assert.equal(scenario.state.iterationStats.resolvedTarget, undefined, 'another Mission result must not create a target here');
    // ...and cannot be recorded as this Mission's experience.
    await assert.rejects(
      scenario.roundExperience.record({ state: scenario.state, mission: scenario.mission, observation: { evidence: cross.result.experienceEvidence } }),
      (error) => error.code === 'ROUND_EXPERIENCE_EVIDENCE_CONFLICT',
    );
    results.push({ case: 'task-and-mission-isolation', codes: ['no-op-snapshot', 'ROUND_EXPERIENCE_EVIDENCE_CONFLICT'] });
  }

  // ===========================================================================
  // F. Negative: a baseline round clears the benchmark but keeps the resolved target.
  // ===========================================================================
  {
    const scenario = await createScenario({ name: 'baseline-target' });
    ensureRoundBudgetStarted(scenario.state, { nowMs: clock });
    const binding = { packageDigest: digest('b-p'), admissionId: 'admission_b', preparedArtifactDigest: digest('b-a'), environmentDigest: digest('b-e'), acceptanceDigest: digest('b-c') };
    scenario.admissions.set(binding.admissionId, binding.preparedArtifactDigest);
    const snapshot = buildSnapshot({ taskId: 'task_baseline', missionId: scenario.mission.id, queueRunId: 'queue-baseline', candidateId: null, patchDigestRaw: sha256Hex('b'), binding, purpose: 'baseline' });
    snapshot.payload.candidate = null;
    scenario.tasks.set(snapshot.taskId, snapshot);
    scenario.state.benchmark = { ...scenario.state.benchmark, status: 'running', testTaskId: snapshot.taskId, runId: 'queue-baseline', purpose: 'baseline', candidate: null, matrix: structuredClone(scenario.mission.testMatrix) };
    applyOperatorTestSnapshot(scenario.state, snapshot);
    assert.equal(scenario.state.benchmark.status, 'idle');
    assert.equal(scenario.state.benchmark.testTaskId, null);
    assert.equal(scenario.state.benchmark.result, null);
    assert.equal(scenario.state.baseline.status, 'complete');
    assert.deepEqual(scenario.state.iterationStats.resolvedTarget.hardware, ['nvidia-gpu']);
    assert.deepEqual(scenario.state.iterationStats.resolvedTarget.architecture, ['sm86']);
    results.push({ case: 'baseline-clears-benchmark-keeps-target', target: scenario.state.iterationStats.resolvedTarget.hardware });
  }

  // ===========================================================================
  // G. Zero experience: the prompt still carries complete round facts.
  // ===========================================================================
  {
    const scenario = await createScenario({ name: 'zero-experience' });
    // A completed result whose runner emitted no experienceEvidence envelope: the real verifier
    // skips it, so the round-2 query genuinely has zero matching records.
    const seed = seedRoundOne({ scenario, includeExperienceEvidence: false });
    const storeBefore = await scenario.repository.read();
    assert.equal(storeBefore.records.length, 0, 'no experience is recorded in this scenario');
    const roundTwo = await advanceToRoundTwo(scenario, seed);
    const context = parseExperienceContext(roundTwo.prompt);
    assert.equal(context.items.length, 0, 'a zero-observation round must still produce a valid empty context');
    assert.equal(roundTwo.audit.selection.selected.length, 0);
    assert.equal(roundTwo.facts.candidate.id, 'candidate-r1');
    assert.equal(roundTwo.facts.correctness.status, 'passed');
    assert.equal(roundTwo.facts.failure, null);
    assert.equal(roundTwo.facts.gate.result, 'reference');
    assert.equal(roundTwo.facts.rollback.performed, true);
    assert.equal(roundTwo.facts.currentBest.candidateId, 'candidate-r0');
    results.push({ case: 'zero-experience-facts-complete', items: 0, gate: roundTwo.facts.gate.result });
  }

  // ===========================================================================
  // H1. The real 20-item cap is reachable and records beyond it are traceable.
  // ===========================================================================
  {
    const scenario = await createScenario({ name: 'item-cap' });
    const seed = seedRoundOne({ scenario });
    for (let index = 0; index < 22; index += 1) {
      await scenario.experienceService.create({
        projectId: scenario.mission.projectId, visibility: 'project',
        title: `small guidance ${index}`, content: `guidance ${index}`, author: 'operator', confidence: 'low',
        scope: { operator: scenario.mission.operator, tags: scenario.mission.tags, hardware: ['nvidia-gpu'], architecture: ['sm86'] },
      });
    }
    const query = {
      projectId: scenario.mission.projectId, allowedProjectIds: [scenario.mission.projectId],
      missionId: scenario.mission.id, roundId: seed.roundId, limit: EXPERIENCE_LIMITS.contextItems,
      scope: { operator: scenario.mission.operator, tags: scenario.mission.tags, hardware: ['nvidia-gpu'], architecture: ['sm86'] },
    };
    const capped = await scenario.experienceService.retrieveWithSelection(query);
    assert.equal(capped.context.items.length, EXPERIENCE_LIMITS.contextItems, 'the real 20-item cap must be reachable');
    assert.equal(capped.selection.itemLimit, 20);
    assert.equal(capped.selection.byteLimit, 65536);
    assert.equal(capped.selection.requestedLimit, EXPERIENCE_LIMITS.contextItems);
    assert.equal(capped.selection.excluded.filter((item) => item.reason === 'limit').length, 2);
    assert.ok(Buffer.byteLength(JSON.stringify(capped.context)) < EXPERIENCE_LIMITS.contextBytes);
    results.push({ case: 'item-cap', items: capped.context.items.length, maxItems: EXPERIENCE_LIMITS.contextItems, excludedByLimit: 2 });
  }

  // ===========================================================================
  // H2. The real 64KiB byte cap holds and facts still reach the provider prompt.
  // ===========================================================================
  {
    const scenario = await createScenario({ name: 'byte-budget' });
    const seed = seedRoundOne({ scenario });
    for (let index = 0; index < 12; index += 1) {
      await scenario.experienceService.create({
        projectId: scenario.mission.projectId, visibility: 'project',
        title: `bulk guidance ${index}`, content: `guidance ${index} ` + 'z'.repeat(7900), author: 'operator', confidence: 'low',
        scope: { operator: scenario.mission.operator, tags: scenario.mission.tags, hardware: ['nvidia-gpu'], architecture: ['sm86'] },
      });
    }
    const query = {
      projectId: scenario.mission.projectId, allowedProjectIds: [scenario.mission.projectId],
      missionId: scenario.mission.id, roundId: seed.roundId, limit: EXPERIENCE_LIMITS.contextItems,
      scope: { operator: scenario.mission.operator, tags: scenario.mission.tags, hardware: ['nvidia-gpu'], architecture: ['sm86'] },
    };
    const capped = await scenario.experienceService.retrieveWithSelection(query);
    assert.ok(Buffer.byteLength(JSON.stringify(capped.context)) <= EXPERIENCE_LIMITS.contextBytes, 'the 64KiB byte cap must hold');
    assert.equal(capped.context.items.length < EXPERIENCE_LIMITS.contextItems, true, 'oversized records must stop at the byte budget');
    assert.equal(capped.selection.excluded.some((item) => item.reason === 'budget'), true, 'records beyond the byte cap must be traceable with reason "budget"');
    assert.equal(capped.selection.byteLimit, 65536);

    // Round 2 still runs and the captured prompt keeps the complete facts under a full budget.
    const roundTwo = await advanceToRoundTwo(scenario, seed);
    const context = parseExperienceContext(roundTwo.prompt);
    assert.ok(context.items.length > 0);
    assert.ok(Buffer.byteLength(JSON.stringify(context)) <= EXPERIENCE_LIMITS.contextBytes);
    assert.equal(roundTwo.facts.candidate.id, 'candidate-r1');
    assert.equal(roundTwo.facts.correctness.status, 'passed');
    assert.equal(roundTwo.facts.failure, null);
    assert.equal(roundTwo.facts.gate.result, 'reference');
    assert.equal(roundTwo.facts.rollback.performed, true);
    assert.equal(roundTwo.facts.currentBest.assetStatus, 'validated');
    results.push({ case: 'byte-budget-facts-complete', items: context.items.length, contextBytes: Buffer.byteLength(JSON.stringify(context)), maxItems: EXPERIENCE_LIMITS.contextItems, maxBytes: EXPERIENCE_LIMITS.contextBytes });
  }

  // ===========================================================================
  // I. Real failure channel: operator failure snapshot -> failureRecords -> prompt.
  // ===========================================================================
  {
    const scenario = await createScenario({ name: 'operator-failure' });
    // Round 1 already ran and projected a real execution target (completed, reference gate).
    const seed = seedRoundOne({ scenario });
    assert.deepEqual(scenario.state.iterationStats.resolvedTarget.hardware, ['nvidia-gpu']);
    // A second queue submission for the same candidate fails in the runner.
    const failure = { code: 'OPERATOR_TEST_FAILED', message: 'candidate run.py raised at import time', role: 'backend', phase: 'runner', retryable: false, details: {} };
    const snapshot = buildSnapshot({
      taskId: `task_${scenario.name}_failure`, missionId: scenario.mission.id, queueRunId: 'queue-run-1b',
      candidateId: 'candidate-r1', patchDigestRaw: seed.patchDigestRaw, binding: seed.binding, status: 'failed', error: failure,
    });
    scenario.tasks.set(snapshot.taskId, snapshot);
    // A new submission resets the benchmark slot exactly like resetMissionRunState does.
    scenario.state.benchmark = {
      ...scenario.state.benchmark, status: 'running', progress: 0, testTaskId: snapshot.taskId, runId: 'queue-run-1b',
      purpose: 'candidate', candidate: { id: 'candidate-r1', digest: seed.patchDigest }, matrix: structuredClone(scenario.mission.testMatrix),
      result: null, lastServiceError: null, completedAt: null, logs: [],
    };
    applyOperatorTestSnapshot(scenario.state, snapshot);
    assert.equal(scenario.state.failureRecords.length, 1, 'a real failed candidate snapshot must write a failureRecord');
    assert.equal(scenario.state.failureRecords[0].candidateId, 'candidate-r1');
    assert.equal(scenario.state.benchmark.lastServiceError.code, 'OPERATOR_TEST_FAILED');
    // No operator experience is recorded from a run with no result payload.
    const collected = await scenario.roundExperience.collect({ state: scenario.state, mission: scenario.mission });
    assert.equal(collected.recorded, 0);

    const roundTwo = await advanceToRoundTwo(scenario, seed);
    assert.equal(roundTwo.facts.failure.classification, 'operator');
    assert.equal(roundTwo.facts.failure.code, 'OPERATOR_TEST_FAILED');
    assert.equal(roundTwo.facts.failure.source, 'benchmark.lastServiceError');
    assert.ok(roundTwo.prompt.includes('OPERATOR_TEST_FAILED'));
    results.push({ case: 'operator-failure-channel', classification: roundTwo.facts.failure.classification, code: roundTwo.facts.failure.code });
  }

  // ===========================================================================
  // J. Infrastructure failure: classified as infrastructure and records no operator experience.
  // ===========================================================================
  {
    const scenario = await createScenario({ name: 'infra-failure' });
    const seed = seedRoundOne({ scenario });
    const snapshot = buildSnapshot({
      taskId: `task_${scenario.name}_failure`, missionId: scenario.mission.id, queueRunId: 'queue-run-1b',
      candidateId: 'candidate-r1', patchDigestRaw: seed.patchDigestRaw, binding: seed.binding, status: 'failed',
      error: { code: 'REMOTE_TIMEOUT', message: 'remote api unreachable: connect timed out', role: 'backend', phase: 'transport', retryable: true, details: {} },
    });
    scenario.tasks.set(snapshot.taskId, snapshot);
    scenario.state.benchmark = {
      ...scenario.state.benchmark, status: 'running', progress: 0, testTaskId: snapshot.taskId, runId: 'queue-run-1b',
      purpose: 'candidate', candidate: { id: 'candidate-r1', digest: seed.patchDigest }, matrix: structuredClone(scenario.mission.testMatrix),
      result: null, lastServiceError: null, completedAt: null, logs: [],
    };
    applyOperatorTestSnapshot(scenario.state, snapshot);
    assert.equal(scenario.state.failureRecords.length, 0, 'infrastructure failure must not reject the candidate');
    assert.equal(scenario.state.benchmark.lastServiceError.code, 'REMOTE_TIMEOUT');
    assert.equal(scenario.state.agent.status, 'awaiting_action', 'an infrastructure failure keeps the round open for retry');
    const collected = await scenario.roundExperience.collect({ state: scenario.state, mission: scenario.mission });
    assert.equal(collected.recorded, 0);
    assert.equal((await scenario.repository.read()).records.length, 0);
    // The owning Agent process is an external resource: the operator acknowledged the outage and
    // it is now terminal. Only that external status is injected; the archive below is production.
    scenario.state.agent = { ...scenario.state.agent, status: 'failed', resourceRelease: { confirmed: true, status: 'confirmed', resources: [] } };
    completeRoundBudget(scenario.state, { nowMs: clock });
    scenario.state.iterationStats = { ...scenario.state.iterationStats, round: 1 };
    ensureRoundBudgetStarted(scenario.state, { nowMs: clock, completedRoundId: seed.roundId });
    scenario.projectState.resetMissionRunState(scenario.state, 'Round 2 after the infrastructure outage.');
    const facts = scenario.state.iterationStats.roundFacts;
    assert.equal(facts.failure.classification, 'infrastructure');
    assert.equal(facts.failure.code, 'REMOTE_TIMEOUT');
    assert.equal(facts.failure.source, 'benchmark.lastServiceError');
    results.push({ case: 'infrastructure-failure-classification', classification: facts.failure.classification, recorded: 0 });
  }

  // ===========================================================================
  // K. Archive determinism negatives.
  // ===========================================================================
  {
    const scenario = await createScenario({ name: 'archive-determinism' });
    const seed = seedRoundOne({ scenario });
    completeRoundBudget(scenario.state, { nowMs: clock });
    scenario.state.iterationStats = { ...scenario.state.iterationStats, round: 1 };
    ensureRoundBudgetStarted(scenario.state, { nowMs: clock, completedRoundId: seed.roundId });
    const roundTwoId = scenario.state.iterationStats.roundBudget.roundId;

    // Duplicate reset for the same run must replace in place and preserve FIRST source facts.
    scenario.projectState.resetMissionRunState(scenario.state, 'first reset goal');
    const firstArchive = structuredClone(scenario.state.runHistory[0]);
    assert.equal(firstArchive.roundFacts.previous.goal, scenario.mission.goal);
    scenario.state.agent = { ...scenario.state.agent, goal: 'rewritten goal' };
    scenario.projectState.resetMissionRunState(scenario.state, 'second reset goal');
    assert.equal(scenario.state.runHistory.length, 1, 'one runId must keep exactly one archive entry');
    assert.equal(scenario.state.runHistory[0].runId, 'agent_round_1');
    assert.equal(scenario.state.runHistory[0].roundFacts.previous.goal, scenario.mission.goal, 'replay must reuse the first frozen source facts, not the rewritten agent goal');
    assert.equal(scenario.state.iterationStats.roundFacts.previous.goal, scenario.mission.goal);
    assert.equal(scenario.state.agent.goal, 'second reset goal');
    assert.notEqual(scenario.state.runHistory[0].roundFacts, scenario.state.iterationStats.roundFacts, 'archived facts must be an independent copy');
    assert.notEqual(scenario.state.runHistory[0].roundFacts.previous, scenario.state.iterationStats.roundFacts.previous);
    assert.equal(scenario.state.runHistory[0].roundFacts.target.roundId, roundTwoId, 'facts target follows the admitted round, not the source round');
    assert.equal(scenario.state.iterationStats.roundFacts.previous.roundIdSource, 'run');

    // An old run without roundId must not be backfilled from the advanced budget.
    const legacy = await createScenario({ name: 'legacy-round-id' });
    seedRoundOne({ scenario: legacy, gateSnapshot: false });
    completeRoundBudget(legacy.state, { nowMs: clock });
    legacy.state.iterationStats = { ...legacy.state.iterationStats, round: 1 };
    ensureRoundBudgetStarted(legacy.state, { nowMs: clock, completedRoundId: legacy.state.iterationStats.roundBudget.roundId });
    delete legacy.state.agent.roundId;
    legacy.projectState.resetMissionRunState(legacy.state, 'legacy goal');
    assert.equal(legacy.state.iterationStats.roundFacts.previous.roundId, null);
    assert.equal(legacy.state.iterationStats.roundFacts.previous.roundIdSource, 'unknown');
    // The raw legacy field may fall back to the live budget, but it is explicitly marked as such
    // and sourceRoundId stays null, so it is never mistaken for the original round identity.
    assert.equal(legacy.state.runHistory[0].sourceRoundId, null);
    assert.equal(legacy.state.runHistory[0].roundIdSource, 'roundBudget');
    assert.equal(legacy.state.runHistory[0].roundId, `${legacy.mission.id}:round:2`);

    // JSON restore: a frozen round is not refreshed and frozen facts stay valid.
    const frozenBefore = await scenario.roundExperience.prepare({ state: scenario.state, mission: scenario.mission, roundId: roundTwoId });
    const factsBefore = selectRoundFactsForPrompt(scenario.state, scenario.mission);
    const restored = JSON.parse(JSON.stringify(scenario.state));
    const restoredMission = restored.missions.find((item) => item.id === restored.activeMissionId);
    const readsBefore = scenario.reads();
    const frozen = await scenario.roundExperience.prepare({ state: restored, mission: restoredMission, roundId: roundTwoId });
    assert.equal(scenario.reads(), readsBefore, 'a restored frozen round must not re-read the repository');
    assert.equal(frozen.contextId, frozenBefore.contextId, 'a restored round must reuse the same frozen context');
    assert.deepEqual(selectRoundFactsForPrompt(restored, restoredMission), factsBefore, 'restored round facts must not be refreshed');
    results.push({ case: 'archive-determinism', duplicateRunEntries: 1, legacyRoundIdSource: 'unknown' });
  }

  // ===========================================================================
  // L. Manual capture/replay must not re-select or mis-bind the round.
  // ===========================================================================
  {
    const scenario = await createScenario({ name: 'manual-replay' });
    const seed = seedRoundOne({ scenario });
    const collected = await scenario.roundExperience.collect({ state: scenario.state, mission: scenario.mission });
    const roundOneExperience = collected.records[0].experience;
    completeRoundBudget(scenario.state, { nowMs: clock });
    scenario.state.iterationStats = { ...scenario.state.iterationStats, round: 1 };
    ensureRoundBudgetStarted(scenario.state, { nowMs: clock, completedRoundId: seed.roundId });
    const roundTwoId = scenario.state.iterationStats.roundBudget.roundId;
    const workspace = scenario.workspaceForMission();
    await mkdir(workspace, { recursive: true });

    const providerStarts = [];
    const client = {
      describe: async () => ({ installed: true, loggedIn: true, version: 'deterministic-provider-double' }),
      start: async (input) => { providerStarts.push(input.goal); return { runId: input.runId, threadId: 'thread-manual', startedAt: iso(), workspace: input.workspace }; },
      readRun: async () => ({ status: 'running' }), readEvents: async () => [], cancel: async () => ({}), eventText: () => '',
    };
    const agentRuntime = createAgentRuntime({ mode: 'claude-code', bridgeDir: path.join(scenario.bridgeDir, 'manual'), codexWorkspace: scenario.workspaceRoot, claudeClient: client });
    const commands = createAgentCommands({
      addAuditEvent, agentRuntime, appendRuntimeEvent,
      artifactDirForMission: () => scenario.rootDir, baselineDirForMission: () => scenario.rootDir,
      buildRuntimePreflight: async () => ({ ready: true, workspace }),
      createWorkspaceCheckpoint: async (missionId, label) => ({ id: `cp-${label}`, missionId, label, stableDigest: digest(`${scenario.name}:manual`), createdAt: iso() }),
      hashKey: (value) => sha256Hex(String(value)).slice(0, 16),
      isManagedWorkspaceRuntimeMode, isStrictZeroSourceMission: () => false, mkdir, path,
      researchDirForMission: () => scenario.rootDir, resetMissionRunState: scenario.projectState.resetMissionRunState,
      resetMissionWorkspace: async () => {}, selectResearchBaselineSource: () => null, selectResearchDirection: () => 'direction',
      startAgentRun: (target, goal, options) => scenario.projectState.startAgentRun(target, goal, options),
      roundExperience: scenario.roundExperience, now: () => new Date(clock),
    });
    const records = [];
    const recordIntent = async (intent) => { records.push(structuredClone(intent)); };
    const runEffect = async (effect) => effect();
    const first = await commands.runs.prepare({ state: scenario.state, body: { goal: 'Manual round 2', workspace }, intent: {}, recordIntent, runEffect });
    assert.equal(records.length, 1);
    assert.equal(first.payload.roundBudget.roundId, roundTwoId);
    assert.equal(first.payload.roundFacts.previous.roundId, seed.roundId);
    // Replay with the frozen intent: same round identity, same context, same facts, no re-selection.
    const readsBeforeReplay = scenario.reads();
    const second = await commands.runs.prepare({ state: scenario.state, body: { goal: 'Manual round 2', workspace }, intent: records[0], recordIntent, runEffect });
    assert.equal(second.payload.roundBudget.roundId, roundTwoId);
    assert.equal(second.payload.roundExperience.contextId, first.payload.roundExperience.contextId);
    assert.deepEqual(second.payload.roundFacts, first.payload.roundFacts);
    assert.equal(second.payload.roundFacts.target.roundId, roundTwoId);
    assert.equal(second.payload.roundFacts.previous.roundId, seed.roundId);
    assert.equal(providerStarts.length, 2, 'capture/replay performs the provider effect twice by design');
    assert.equal(providerStarts[0], providerStarts[1], 'replayed prompt must be identical');
    assert.equal(promptCarriesExperience(providerStarts[1], roundOneExperience), true, 'replayed prompt still carries the frozen round-1 experience');
    assert.equal(providerStarts[1].includes(roundOneExperience.id), true);
    // Applying the recorded payload reconstructs state without re-deriving facts.
    commands.runs.apply(scenario.state, second.payload);
    assert.deepEqual(scenario.state.iterationStats.roundFacts, first.payload.roundFacts);
    assert.equal(scenario.state.iterationStats.roundBudget.roundId, roundTwoId);
    assert.equal(scenario.reads(), readsBeforeReplay, 'replay must reuse the frozen intent instead of re-reading/re-selecting from the repository');
    results.push({ case: 'manual-capture-replay', roundId: roundTwoId, replayIdentical: true, experienceId: roundOneExperience.id });
  }

  console.log(JSON.stringify({ ok: true, results }, null, 2));
} finally {
  await rm(tempRoot, { recursive: true, force: true });
}
