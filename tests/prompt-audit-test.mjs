// Provider-neutral prompt audit contract (§14.5 / §6.13).
//
// Scope of the doubles used here and why the labels are exact:
//   - experience repository: the REAL filesystem repository (createExperienceRepository)
//     running against a per-test temporary root. Not an in-memory port double.
//   - Agent provider: an injected client double. It is the only way to observe the
//     exact string handed to `start` without launching a real Agent process, and it
//     reads the pre-send audit file *inside* its own start() call, so write-before-send
//     ordering is proven rather than inferred after the fact.
//   - workspace/git: a real temporary directory (git init is performed by the
//     production agent boundary), never a shared project path.
//
// The audit is a PRE-SEND artifact. These tests prove the audited string equals the
// string passed to the provider start port; they do not (and must not) claim to prove
// what a live provider process received or followed.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

// Point runtime-side caches (git-trust config etc.) at this test's unique root before
// any module that reads storage-paths.mjs is imported. The root is removed in finally.
const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'operator-prompt-audit-'));
const bridgeDir = path.join(tempRoot, 'bridge');
const workspace = path.join(tempRoot, 'workspace');
process.env.OPERATOR_RUNTIME_DIR = path.join(tempRoot, 'runtime');
process.env.OPERATOR_DATA_DIR = path.join(tempRoot, 'data');
delete process.env.OPERATOR_RUNTIME_MODE;

const sha256Hex = (value) => createHash('sha256').update(value, 'utf8').digest('hex');
const utf8Bytes = (value) => Buffer.byteLength(value, 'utf8');

try {
  const { createExperienceRepository } = await import('../client-runtime/experience-repository.mjs');
  const { createExperienceService } = await import('../client-runtime/application/experience-service.mjs');
  const { createRoundExperienceService } = await import('../client-runtime/application/round-experience-service.mjs');
  const { createAgentRuntime } = await import('../client-runtime/agent-runtime.mjs');

  const timers = {
    setTimeout: (callback, ms) => setTimeout(callback, ms),
    clearTimeout: (handle) => clearTimeout(handle),
  };
  const resolveAccess = ({ mission }) => ({ projectId: mission.projectId, allowedProjectIds: [mission.projectId] });
  const unusedVerifier = async () => ({ verified: false, code: 'NOT_USED_IN_PROMPT_AUDIT_TEST' });
  let idCounter = 0;
  const makeStore = async (name) => {
    const repository = createExperienceRepository({ rootDir: path.join(tempRoot, 'stores', name) });
    let reads = 0;
    // Counting port wrapper around the real filesystem repository: the counter lets us
    // prove a frozen round does not re-read/re-select; it does not replace the store.
    const counting = { read: async () => { reads += 1; return repository.read(); }, transact: (mutator) => repository.transact(mutator) };
    const service = createExperienceService({ repository: counting, now: () => new Date().toISOString(), createId: () => `exp_${name}_${++idCounter}` });
    const roundExperience = createRoundExperienceService({ experienceService: service, resolveAccess, verifyObservationEvidence: unusedVerifier, timers });
    return { repository, service, roundExperience, reads: () => reads };
  };

  await mkdir(workspace, { recursive: true });
  await mkdir(bridgeDir, { recursive: true });

  const chineseContent = '经验：在 sm86 上消除冗余设备拷贝，保持 dtype=float32 与 32x256 shape；该结论只来自本轮真实运行。';
  const chineseSummary = '共享 GPU 开发证据（不可发布）：latency p50 = 11.264 us。';
  const chineseTitle = '向量化加载经验（中文 UTF-8 断言）';

  // ---------------------------------------------------------------------------
  // 1. Real repository read produces the frozen context AND the selection sidecar.
  //    The selection must stay aligned with the frozen items (same read).
  // ---------------------------------------------------------------------------
  const store = await makeStore('main');
  const projectId = 'proj_audit';
  const mission = {
    id: 'MIS_AUDIT', projectId, title: 'Audit mission', repository: 'fixture-repo',
    goal: 'optimize run.py', metric: 'latency p50', hardware: ['nvidia-gpu'], operator: 'generic_affine', tags: ['affine'],
  };
  const created = await store.service.create({
    projectId, visibility: 'project', title: chineseTitle, content: chineseContent, author: 'operator',
    confidence: 'medium', scope: { operator: 'generic_affine', tags: ['affine'], hardware: ['nvidia-gpu'], architecture: ['sm86'] },
  });
  const record = created.experience;
  const roundId = `${mission.id}:round:1`;
  const auditStore = await makeStore('audit');
  const auditService = createExperienceService({
    repository: auditStore.repository,
    now: () => new Date().toISOString(),
    createId: () => `exp_audit_${++idCounter}`,
  });
  const selectionRecord = (await auditService.create({
    projectId, visibility: 'project', title: chineseTitle, content: chineseContent, author: 'operator',
    confidence: 'medium', scope: { operator: 'generic_affine', tags: ['affine'], hardware: ['nvidia-gpu'], architecture: ['sm86'] },
  })).experience;
  const { context, selection } = await auditService.retrieveWithSelection({
    projectId, allowedProjectIds: [projectId], missionId: mission.id, roundId,
    scope: { operator: 'generic_affine', tags: ['affine'], hardware: ['nvidia-gpu'], architecture: ['sm86'] },
  });
  assert.equal(context.items.length, 1);
  assert.equal(context.items[0].id, selectionRecord.id);
  assert.equal(selection.contextId, context.contextId);
  assert.equal(selection.repositoryRevision, context.repositoryRevision);
  assert.deepEqual(selection.selected.map((item) => [item.id, item.version]), [[selectionRecord.id, 1]]);
  assert.equal(selection.selected[0].source, 'human');
  assert.equal(context.items[0].content, chineseContent, 'frozen context must carry the full UTF-8 content');

  // ---------------------------------------------------------------------------
  // 2. Both providers: the audited pre-send string is byte-identical to the string
  //    passed to start.goal, and the provider start double itself reads the audit
  //    file before returning (write-before-send ordering).
  // ---------------------------------------------------------------------------
  const makeState = () => ({
    activeMissionId: mission.id,
    missions: [mission],
    iterationStats: {
      roundBudget: { roundId, roundNumber: 1, startedAt: new Date().toISOString(), deadlineAt: new Date(Date.now() + 900000).toISOString(), budgetMs: 900000, status: 'active' },
      roundExperience: context,
      roundExperienceSelection: selection,
    },
  });

  for (const [mode, clientKey] of [['claude-code', 'claudeClient'], ['codex-cli', 'codexClient']]) {
    const runtimeBridge = path.join(bridgeDir, mode);
    await mkdir(runtimeBridge, { recursive: true });
    let capturedGoal = null;
    let auditSeenInsideStart = null;
    const providerDouble = {
      describe: async () => ({ installed: true, loggedIn: true, version: 'prompt-audit-double' }),
      start: async (input) => {
        // Read the audit INSIDE start: if the audit were written after the provider
        // call, this would fail with ENOENT. That is the ordering proof.
        const auditPath = path.join(runtimeBridge, 'prompt-audits', `${input.runId}.json`);
        const audit = JSON.parse(await readFile(auditPath, 'utf8'));
        assert.equal(audit.deliveryStage, 'prepared-before-send');
        assert.equal(audit.prompt, input.goal, 'audit prompt must equal the provider start.goal');
        assert.equal(audit.promptBytes, utf8Bytes(input.goal));
        assert.equal(audit.promptDigest, 'sha256:' + sha256Hex(input.goal));
        assert.ok(audit.prompt.includes(chineseContent), 'audited prompt must contain the Chinese experience content');
        auditSeenInsideStart = audit;
        capturedGoal = input.goal;
        return { runId: input.runId, threadId: 'thread-audit', startedAt: new Date().toISOString(), workspace: input.workspace };
      },
      readRun: async () => ({ runId: 'unused', status: 'running' }),
      readEvents: async () => [],
      cancel: async () => ({ status: 'cancel_requested' }),
      eventText: () => '',
    };
    const runtime = createAgentRuntime({ mode, bridgeDir: runtimeBridge, codexWorkspace: tempRoot, [clientKey]: providerDouble });
    const state = makeState();
    const started = await runtime.startRun({ state, mission, goal: 'Optimize the affine kernel for sm86.', workspace, experienceContext: context, roundId });
    assert.equal(started.handled, true);
    assert.ok(capturedGoal, `${mode}: provider start must have been invoked`);
    // Recompute independently from the captured string (never from the audit object).
    assert.equal('sha256:' + sha256Hex(capturedGoal), auditSeenInsideStart.promptDigest);
    assert.equal(utf8Bytes(capturedGoal), auditSeenInsideStart.promptBytes);
    assert.ok(utf8Bytes(capturedGoal) > capturedGoal.length, 'Chinese content must make UTF-8 bytes exceed character count');
    const auditPath = path.join(runtimeBridge, 'prompt-audits', `${state.agent.runId}.json`);
    const onDisk = JSON.parse(await readFile(auditPath, 'utf8'));
    assert.equal(onDisk.prompt, capturedGoal);
    assert.equal(onDisk.promptDigest, 'sha256:' + sha256Hex(capturedGoal));
    assert.equal(onDisk.promptBytes, utf8Bytes(capturedGoal));
    assert.equal(state.agent.promptAudit.digest, onDisk.promptDigest);
    assert.equal(state.agent.promptAudit.path, auditPath);
    assert.ok(onDisk.prompt.includes(selectionRecord.id), 'audit prompt must expose the selected experience ID');
    assert.ok(onDisk.prompt.includes(chineseSummary) === false, 'fixture summary is not fabricated into the prompt');
    assert.equal(onDisk.selection?.contextId, context.contextId);
    assert.deepEqual(onDisk.selection?.selected?.map((item) => [item.id, item.version]), [[selectionRecord.id, 1]]);
  }

  // ---------------------------------------------------------------------------
  // 3. Write failure is fail-closed: no provider send happens and the error is explicit.
  // ---------------------------------------------------------------------------
  {
    const blockedParent = path.join(tempRoot, 'blocked-parent');
    await writeFile(blockedParent, 'not a directory\n', 'utf8');
    const blockedBridge = path.join(blockedParent, 'bridge');
    let startCalls = 0;
    const providerDouble = {
      describe: async () => ({ installed: true, loggedIn: true }),
      start: async () => { startCalls += 1; return { runId: 'x', threadId: 'x', startedAt: new Date().toISOString() }; },
      readRun: async () => ({ status: 'running' }), readEvents: async () => [], cancel: async () => ({}), eventText: () => '',
    };
    const runtime = createAgentRuntime({ mode: 'claude-code', bridgeDir: blockedBridge, codexWorkspace: tempRoot, claudeClient: providerDouble });
    await assert.rejects(
      runtime.startRun({ state: makeState(), mission, goal: 'audit write must fail', workspace, experienceContext: context, roundId }),
      (error) => error.code === 'PROMPT_AUDIT_WRITE_FAILED',
    );
    assert.equal(startCalls, 0, 'a failed pre-send audit must prevent the provider send');
  }

  // ---------------------------------------------------------------------------
  // 4. Version freeze: an already-prepared round returns the frozen context unchanged
  //    and does not re-read/re-select, even after the record advances to version 2.
  // ---------------------------------------------------------------------------
  {
    const store4 = await makeStore('freeze');
    const project4 = 'proj_freeze';
    const mission4 = { id: 'MIS_FREEZE', projectId: project4, hardware: ['nvidia-gpu'], architecture: ['sm86'], operator: 'generic_affine', tags: [] };
    const first = (await store4.service.create({
      projectId: project4, visibility: 'project', title: '冻结版本', content: '第一版中文内容', author: 'operator',
      confidence: 'medium', scope: { operator: 'generic_affine', tags: [], hardware: ['nvidia-gpu'], architecture: ['sm86'] },
    })).experience;
    const state4 = { activeMissionId: mission4.id, missions: [mission4], iterationStats: {} };
    const round4 = `${mission4.id}:round:1`;
    const scope4 = { operator: 'generic_affine', tags: [], hardware: ['nvidia-gpu'], architecture: ['sm86'] };
    const firstContext = await store4.roundExperience.prepare({ state: state4, mission: mission4, roundId: round4, scope: scope4 });
    assert.equal(firstContext.items[0].version, 1);
    assert.equal(firstContext.items[0].content, '第一版中文内容');
    const readsAfterFirst = store4.reads();
    await store4.service.update(first.id, { content: '第二版中文内容' }, { projectId: project4, expectedVersion: 1 });
    const secondContext = await store4.roundExperience.prepare({ state: state4, mission: mission4, roundId: round4, scope: scope4 });
    assert.equal(secondContext.contextId, firstContext.contextId, 'a frozen round must not be refreshed');
    assert.equal(secondContext.items[0].version, 1, 'old version stays frozen for the admitted round');
    assert.equal(secondContext.items[0].content, '第一版中文内容');
    assert.equal(store4.reads(), readsAfterFirst, 'reusing a frozen round must not re-read the repository');
    const head = await store4.service.read(first.id, { projectId: project4 });
    assert.equal(head.experience.version, 2, 'the store itself advanced to version 2');
  }

  // ---------------------------------------------------------------------------
  // 5. Selection exclusions are traceable, and a contextId mismatch is fail-closed:
  //    the mismatched context is never committed to round state.
  // ---------------------------------------------------------------------------
  {
    const store5 = await makeStore('exclusions');
    const project5 = 'proj_exclusions';
    const mission5 = { id: 'MIS_EXCL', projectId: project5, hardware: ['nvidia-gpu'], architecture: ['sm86'], operator: 'generic_affine', tags: [] };
    const matching = (await store5.service.create({
      projectId: project5, visibility: 'project', title: 'sm86 可迁移摘要', content: 'sm86 适用', author: 'operator',
      confidence: 'medium', scope: { operator: 'generic_affine', tags: [], hardware: ['nvidia-gpu'], architecture: ['sm86'] },
    })).experience;
    const sm100 = (await store5.service.create({
      projectId: project5, visibility: 'project', title: 'sm100 专用实现', content: '仅 Blackwell', author: 'operator',
      confidence: 'medium', scope: { operator: 'generic_affine', tags: [], hardware: ['nvidia-gpu'], architecture: ['sm100'] },
    })).experience;
    const audited = await store5.service.retrieveWithSelection({
      projectId: project5, allowedProjectIds: [project5], missionId: mission5.id, roundId: `${mission5.id}:round:1`,
      scope: { operator: 'generic_affine', tags: [], hardware: ['nvidia-gpu'], architecture: ['sm86'] },
    });
    assert.deepEqual(audited.context.items.map((item) => item.id), [matching.id]);
    const exclusion = audited.selection.excluded.find((item) => item.id === sm100.id);
    assert.ok(exclusion, 'the sm100 record must appear in the auditable exclusion list');
    assert.equal(exclusion.reason, 'scope', 'a shared NVIDIA tag must not let sm100 match an sm86 query');
    assert.equal(exclusion.version, 1);
    assert.equal(audited.selection.selected.length, audited.context.items.length);
    assert.deepEqual(audited.selection.selected.map((item) => item.id), [matching.id]);
  }
  {
    // A retrieval whose selection claims a different contextId must be rejected and
    // must not commit roundExperience / roundExperienceSelection.
    const store6 = await makeStore('mismatch');
    const project6 = 'proj_mismatch';
    const mission6 = { id: 'MIS_MISMATCH', projectId: project6, hardware: ['nvidia-gpu'], architecture: ['sm86'], operator: 'generic_affine', tags: [] };
    const real = store6.service;
    const tampered = {
      ...real,
      retrieveWithSelection: async (query) => {
        const audited = await real.retrieveWithSelection(query);
        return { context: audited.context, selection: { ...audited.selection, contextId: 'EXPCTX_' + 'f'.repeat(64) } };
      },
    };
    const { createRoundExperienceService } = await import('../client-runtime/application/round-experience-service.mjs');
    const round6 = createRoundExperienceService({ experienceService: tampered, resolveAccess, verifyObservationEvidence: unusedVerifier, timers });
    const state6 = { activeMissionId: mission6.id, missions: [mission6], iterationStats: {} };
    await assert.rejects(
      round6.prepare({ state: state6, mission: mission6, roundId: `${mission6.id}:round:1` }),
      (error) => error.code === 'ROUND_EXPERIENCE_SELECTION_CONFLICT',
    );
    assert.equal(state6.iterationStats.roundExperience, undefined, 'a mismatched context must never be committed');
    assert.equal(state6.iterationStats.roundExperienceSelection, undefined);
    assert.equal(state6.iterationStats.roundExperienceStatus?.status, 'failed');
  }

  assert.ok(record.id && record.version === 1);
  console.log('[prompt-audit] provider-neutral pre-send audit, UTF-8/SHA-256, fail-closed write, version freeze, selection exclusions and contextId mismatch contracts passed');
} finally {
  await rm(tempRoot, { recursive: true, force: true });
}
