import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { createSourceRegistryIntegrityService } from '../client-runtime/application/source-registry-integrity-service.mjs';
import { classifySourceRegistryIntegrity, SOURCE_MODIFIED_CODES, SOURCE_UNVERIFIABLE_CODES } from '../client-runtime/source-registry-integrity.mjs';
import { createWorkspaceManager } from '../client-runtime/workspace-manager.mjs';

const execFileAsync = promisify(execFile);

// ---- 纯判定 ----
// 只有来源级错误码参与判定。没有错误码就没有结论：判定层不臆造证据。
assert.deepEqual(classifySourceRegistryIntegrity().verdict, 'clean');
assert.deepEqual(classifySourceRegistryIntegrity({ inspection: { errors: null } }).verdict, 'clean');
assert.deepEqual(classifySourceRegistryIntegrity({ inspection: {} }).reasonCode, null);

const dirty = classifySourceRegistryIntegrity({
  inspection: { errors: [{ code: 'SOURCE_REPOSITORY_DIRTY', source: 'upstream', changedFiles: ['reference.cu'] }] },
});
assert.equal(dirty.verdict, 'modified');
assert.equal(dirty.reasonCode, 'source_root_modified');
assert.deepEqual(dirty.modified[0].changedFiles, ['reference.cu']);

// 引用级错误码不进判定：它们讲的是「某个 mission 声称用了什么」，不是来源根自身状态。
// 以整份 errors 为依据，巡检就会因 mission 级声明问题（未登记的仓库、已被上游推进的旧 commit）
// 报「来源被改」。2026-09-20 起仓库级引用是一等 scope，注册端不再产生 PATH_INVALID，
// 但这条约束与注册端写法无关——引用级错误码整体不参与判定。
const referenceNoise = classifySourceRegistryIntegrity({
  inspection: {
    errors: [
      { code: 'SOURCE_REFERENCE_PATH_INVALID', source: 'https://example.invalid/up.git', detail: '来源引用必须使用仓库内相对路径。' },
      { code: 'SOURCE_REFERENCE_SCOPE_INVALID', source: 'https://example.invalid/up.git', detail: '来源引用的 scope 只能是 file 或 repository。' },
    ],
  },
});
assert.equal(referenceNoise.verdict, 'clean', 'reference-level errors must never be read as "the source was modified"');
assert.deepEqual(referenceNoise.ignoredCodes, ['SOURCE_REFERENCE_PATH_INVALID', 'SOURCE_REFERENCE_SCOPE_INVALID']);
assert.deepEqual(referenceNoise.modified, []);

// 未知码同样不参与判定，但如实回传，便于诊断。
const unknown = classifySourceRegistryIntegrity({ inspection: { errors: [{ code: 'SOMETHING_NEW', source: 'x' }] } });
assert.equal(unknown.verdict, 'clean');
assert.deepEqual(unknown.ignoredCodes, ['SOMETHING_NEW']);

// 核验不了 ≠ 被改过：不可知不能冒充可证。
const invalid = classifySourceRegistryIntegrity({ inspection: { errors: [{ code: 'SOURCE_REPOSITORY_INVALID', source: 'broken' }] } });
assert.equal(invalid.verdict, 'unverifiable');
assert.equal(invalid.reasonCode, 'source_root_unverifiable');

// 两者同时存在：被改过是可证结论，优先于不可知。
const both = classifySourceRegistryIntegrity({
  inspection: { errors: [{ code: 'SOURCE_REPOSITORY_DIRTY', source: 'upstream' }, { code: 'SOURCE_REPOSITORY_INVALID', source: 'broken' }] },
});
assert.equal(both.verdict, 'modified');
assert.equal(both.unverifiable.length, 1, 'the unverifiable evidence must survive alongside the stronger verdict');
assert.deepEqual(SOURCE_MODIFIED_CODES, ['SOURCE_REPOSITORY_DIRTY', 'SOURCE_REPOSITORY_TREE_MISMATCH']);
assert.equal(SOURCE_UNVERIFIABLE_CODES.includes('SOURCE_REPOSITORY_TREE_MISMATCH'), false,
  'a tree pin mismatch is evidence of modification, not merely of being unable to verify');

// ---- 真实 Git 仓库：tree pin 偏离必须给出可区分的码 ----
const root = await mkdtemp(path.join(os.tmpdir(), 'operator-source-integrity-'));
const manager = createWorkspaceManager();

try {
  const sourceRoot = path.join(root, 'sources');
  const upstream = path.join(sourceRoot, 'upstream');
  await mkdir(upstream, { recursive: true });
  await writeFile(path.join(upstream, 'reference.cu'), '// upstream reference\n', 'utf8');
  await execFileAsync('git', ['init'], { cwd: upstream });
  await execFileAsync('git', ['config', 'user.name', 'Source Integrity Test'], { cwd: upstream });
  await execFileAsync('git', ['config', 'user.email', 'source-integrity@local.invalid'], { cwd: upstream });
  await execFileAsync('git', ['add', '-A'], { cwd: upstream });
  await execFileAsync('git', ['commit', '-m', 'upstream baseline'], { cwd: upstream });
  const pinnedTree = (await execFileAsync('git', ['rev-parse', 'HEAD^{tree}'], { cwd: upstream })).stdout.trim();
  // 登记 tree pin（agent-runtime 注册快照来源时就是这么写的）。
  await execFileAsync('git', ['config', 'operatorStudio.sourceTree', pinnedTree], { cwd: upstream });

  const verified = await manager.inspectSources(sourceRoot, []);
  assert.equal(verified.ready, true, JSON.stringify(verified));
  assert.equal(classifySourceRegistryIntegrity({ inspection: verified }).verdict, 'clean');

  // 已提交的改动：工作区干净，只有 tree pin 能发现内容换过了。
  await writeFile(path.join(upstream, 'reference.cu'), '// upstream changed and committed\n', 'utf8');
  await execFileAsync('git', ['add', '-A'], { cwd: upstream });
  await execFileAsync('git', ['commit', '-m', 'upstream moved'], { cwd: upstream });
  const currentTree = (await execFileAsync('git', ['rev-parse', 'HEAD^{tree}'], { cwd: upstream })).stdout.trim();
  assert.notEqual(currentTree, pinnedTree);
  const status = (await execFileAsync('git', ['status', '--porcelain=v1'], { cwd: upstream })).stdout.trim();
  assert.equal(status, '', 'the scenario under test depends on a clean working tree');
  const mismatch = await manager.inspectSources(sourceRoot, []);
  assert.equal(mismatch.ready, false);
  assert.equal(mismatch.errors[0].code, 'SOURCE_REPOSITORY_TREE_MISMATCH',
    'a committed modification must not be reported as a generic structural failure');
  assert.equal(mismatch.errors[0].recordedTree, pinnedTree);
  assert.equal(mismatch.errors[0].tree, currentTree);
  // 一个 pin 校验不过的来源不会进入 sources[]：它不是「一个可用的来源」，所以既不上报为可用，
  // 也不进 Source Registry。判定完全由 errors 承载——这正是判定层必须读错误码而不是读 sources 的原因。
  assert.deepEqual(mismatch.sources, [], 'a source failing its tree pin must not be listed as a usable source');
  const mismatchVerdict = classifySourceRegistryIntegrity({ inspection: mismatch });
  assert.equal(mismatchVerdict.verdict, 'modified');
  assert.equal(mismatchVerdict.reasonCode, 'source_root_modified');

  // 未提交变更 → DIRTY，同样是 modified。先把 pin 复位到当前 tree，让这一条只测改动本身。
  await execFileAsync('git', ['config', 'operatorStudio.sourceTree', currentTree], { cwd: upstream });
  await writeFile(path.join(upstream, 'reference.cu'), '// uncommitted drift\n', 'utf8');
  const dirtyInspection = await manager.inspectSources(sourceRoot, []);
  assert.equal(dirtyInspection.errors[0].code, 'SOURCE_REPOSITORY_DIRTY');
  assert.equal(classifySourceRegistryIntegrity({ inspection: dirtyInspection }).verdict, 'modified');

  // 结构故障仍然必须是 SOURCE_REPOSITORY_INVALID，不能被新码吞掉；且只能算「核验不了」。
  // 先复位未提交改动，让这份巡检里只剩结构性故障。
  await execFileAsync('git', ['checkout', '--', 'reference.cu'], { cwd: upstream });
  const notARepository = path.join(sourceRoot, 'not-a-repository');
  await mkdir(notARepository, { recursive: true });
  const structural = await manager.inspectSources(sourceRoot, []);
  assert.ok(structural.errors.some((error) => error.code === 'SOURCE_REPOSITORY_INVALID' && error.source === 'not-a-repository'));
  assert.ok(!structural.errors.some((error) => error.code === 'SOURCE_REPOSITORY_TREE_MISMATCH' && error.source === 'not-a-repository'));
  assert.equal(structural.errors.length, 1, JSON.stringify(structural.errors));
  assert.equal(classifySourceRegistryIntegrity({ inspection: structural }).verdict, 'unverifiable');

  // 残骸一：获取中断留下的临时克隆目录（`<name>.acquiring-<uuid>`）。它不是登记来源，必须完全
  // 不出现在巡检结果里——把它当第三方来源核验，就会把本地网络失败报成「上游有未提交变更」。
  const leftover = path.join(sourceRoot, 'flashinfer.acquiring-a0d2f568-fb82-44da-b29e-8dd5608efd62');
  await mkdir(leftover, { recursive: true });
  await writeFile(path.join(leftover, 'reference.cu'), '// half-fetched\n', 'utf8');
  await execFileAsync('git', ['init'], { cwd: leftover });
  const withLeftover = await manager.inspectSources(sourceRoot, []);
  assert.ok(!withLeftover.sources.some((source) => source.id.includes('.acquiring-')),
    JSON.stringify(withLeftover.sources.map((source) => source.id)));
  assert.ok(!withLeftover.errors.some((error) => String(error.source || '').includes('.acquiring-')),
    JSON.stringify(withLeftover.errors));

  // 残骸二：检出中断——HEAD 存在但 index 从未写入，git status 把每个文件读成删除。它看起来像
  // 几千条未提交变更，实际不是上游改动证据：必须报 CHECKOUT_INCOMPLETE 且只算「核验不了」。
  const aborted = path.join(sourceRoot, 'aborted-checkout');
  await mkdir(aborted, { recursive: true });
  await writeFile(path.join(aborted, 'kernel.cu'), '// upstream kernel\n', 'utf8');
  await execFileAsync('git', ['init'], { cwd: aborted });
  await execFileAsync('git', ['config', 'user.name', 'Source Integrity Test'], { cwd: aborted });
  await execFileAsync('git', ['config', 'user.email', 'source-integrity@local.invalid'], { cwd: aborted });
  await execFileAsync('git', ['add', '-A'], { cwd: aborted });
  await execFileAsync('git', ['commit', '-m', 'upstream baseline'], { cwd: aborted });
  await rm(path.join(aborted, '.git', 'index'), { force: true });
  const abortedInspection = await manager.inspectSources(sourceRoot, []);
  const abortedError = abortedInspection.errors.find((error) => error.source === 'aborted-checkout');
  assert.equal(abortedError?.code, 'SOURCE_REPOSITORY_CHECKOUT_INCOMPLETE', JSON.stringify(abortedInspection.errors));
  assert.ok(!abortedInspection.errors.some((error) => error.source === 'aborted-checkout' && error.code === 'SOURCE_REPOSITORY_DIRTY'),
    'an aborted checkout must not be reported as a source modification');
  const abortedSource = abortedInspection.sources.find((source) => source.id === 'aborted-checkout');
  assert.equal(abortedSource?.checkoutIncomplete, true);
  assert.deepEqual(abortedSource?.changedFiles, [],
    'an aborted checkout must not publish a change list the UI would render as N uncommitted changes');
  const abortedVerdict = classifySourceRegistryIntegrity({ inspection: abortedInspection });
  assert.equal(abortedVerdict.verdict, 'unverifiable');
  assert.equal(abortedVerdict.reasonCode, 'source_root_unverifiable');
  assert.equal(abortedVerdict.modified.length, 0, 'a local fetch failure must never be classified as a source modification');

  // ---- 应用服务：升级成 needs_human 并留持久事件 ----
  const events = [];
  const service = createSourceRegistryIntegrityService({
    inspectSources: async () => mismatch,
    appendRuntimeEvent: (...args) => events.push(args),
  });
  const blocked = await service.inspect({ state: { activeMissionId: 'MIS_INTEGRITY', iterationStats: { round: 3 } }, mission: { sourceRoot } });
  assert.equal(blocked.valid, false);
  assert.equal(blocked.verdict, 'modified');
  assert.equal(blocked.state.iterationStats.loopStatus, 'needs_human');
  assert.equal(blocked.state.iterationStats.loopStatusReason, 'source_root_modified');
  assert.equal(blocked.state.iterationStats.round, 3, 'escalation must not drop existing iteration stats');
  assert.equal(events[0][1], 'source_registry.integrity_failed');
  assert.equal(events[0][2].verdict, 'modified');

  // 未配置 sourceRoot：不巡检、不升级、不发事件。
  const skipped = await service.inspect({ state: { activeMissionId: 'MIS_INTEGRITY' }, mission: {} });
  assert.equal(skipped.valid, true);
  assert.equal(skipped.verdict, 'skipped');
  assert.equal(events.length, 1);

  // 核验不了时理由码必须不同，不得把它说成「被改过」。
  const unverifiableService = createSourceRegistryIntegrityService({
    inspectSources: async () => structural,
    appendRuntimeEvent: (...args) => events.push(args),
  });
  const unverifiable = await unverifiableService.inspect({ state: { activeMissionId: 'MIS_INTEGRITY' }, mission: { sourceRoot } });
  assert.equal(unverifiable.verdict, 'unverifiable');
  assert.equal(unverifiable.state.iterationStats.loopStatusReason, 'source_root_unverifiable');

  // 干净时不动状态、不发事件。
  const cleanService = createSourceRegistryIntegrityService({
    inspectSources: async () => verified,
    appendRuntimeEvent: (...args) => events.push(args),
  });
  const cleanState = { activeMissionId: 'MIS_INTEGRITY', iterationStats: { round: 1 } };
  const cleanResult = await cleanService.inspect({ state: cleanState, mission: { sourceRoot } });
  assert.equal(cleanResult.valid, true);
  assert.equal(cleanResult.verdict, 'clean');
  assert.deepEqual(cleanState.iterationStats, { round: 1 });
  assert.equal(events.length, 2);

  // 只认来源本身：服务必须传空引用清单。带上带空 path 的历史引用会让每次巡检都失败。
  // 同时确认巡检的是调用方给的根（采集路径用的那个），而不是 mission 上另配的根。
  const inspected = [];
  const recordingService = createSourceRegistryIntegrityService({
    inspectSources: async (root, references) => { inspected.push({ root, references }); return verified; },
    appendRuntimeEvent: () => {},
  });
  await recordingService.inspect({ state: { activeMissionId: 'MIS_INTEGRITY' }, mission: { sourceRoot: '/elsewhere' }, sourceRoot });
  assert.deepEqual(inspected, [{ root: sourceRoot, references: [] }],
    'the gate must ask about sources (not registered references) and about the root acquisition actually used');
  await recordingService.inspect({ state: { activeMissionId: 'MIS_INTEGRITY' }, mission: { sourceRoot } });
  assert.equal(inspected[1].root, sourceRoot, 'without an explicit root it must fall back to mission.sourceRoot');

  console.log('[source-registry-integrity] classification, escalation, and tree pin detection passed');
} finally {
  await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
}
