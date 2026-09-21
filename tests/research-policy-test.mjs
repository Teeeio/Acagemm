// 研究策略与输出解析的生产路径测试（§8 A / B）。
//
// 覆盖：统一研究入口策略、显式阶段、已建立 baseline 的优化不默认重新采集来源、
// 运行故障不触发完整研究、来源门禁不被关闭研究绕过。
// 以及：裸/围栏/带说明文字 JSON、正确结果后的无关工具 JSON、冲突候选、schema 不符、
// 空仓库数组在允许与禁止 fallback 两种契约下的处理。
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  RESEARCH_ADVISORY_BUDGET_MS,
  RESEARCH_ACQUISITION_BUDGET_MS,
  RESEARCH_TRIGGERS,
  classifyResearchFaults,
  resolveAutomaticResearch,
  resolveManualResearch,
  resolveResearchConfig,
} from '../client-runtime/research-policy.mjs';
import {
  RESEARCH_RESULT_REASONS,
  extractResearchResult,
  parseResearchResult,
  repairResearchFormatting,
} from '../client-runtime/agent-result.mjs';
import { acquireSelectedSources, annotateCloneFailure, isTransientSourceError, researchScopeForMission } from '../client-runtime/agent-runtime.mjs';
import { createAutopilotFixedProfileService } from '../client-runtime/application/autopilot-fixed-profile-service.mjs';
import { createAutopilotStrictSourceService } from '../client-runtime/application/autopilot-strict-source-service.mjs';
import { createBaselineMaterializerRecoveryService } from '../client-runtime/application/baseline-materializer-recovery-service.mjs';

const agentMessage = (text) => ({ type: 'item.completed', item: { type: 'agent_message', text } });
const toolEvent = (text, itemType = 'command_execution') => ({ type: 'item.completed', item: { type: itemType, text } });
const notesResult = (overrides = {}) => JSON.stringify({
  schemaVersion: 'operator-studio.research-notes/v2',
  summary: 'async dispatch 降低 host 固定开销',
  findings: ['async dispatch 减少同步等待'],
  suggestedDirections: ['尝试 async plan descriptor cache'],
  sources: [{ title: 'Kernel Dispatch', url: 'https://example.invalid/paper', type: 'paper' }],
  ...overrides,
});
const acquisitionResult = (repositories) => JSON.stringify({
  schemaVersion: 'operator-studio.source-acquisition/v2',
  summary: 'selected sources',
  sourceAcquisition: { repositories, semanticFallback: false, fallbackReason: '' },
});

// ---- A. 统一策略：自动联网研究默认关闭，且只认 webResearchEnabled ----
// 缺省（无 sourcePolicy / 无该键 / 显式 null / 显式 false）一律关闭——这是本次改动翻转的核心行为。
const automaticTriggers = Object.values(RESEARCH_TRIGGERS).filter((value) => value !== RESEARCH_TRIGGERS.MANUAL);
const disabledMissions = [
  { id: 'MIS_NO_POLICY' },
  { id: 'MIS_EMPTY_POLICY', sourcePolicy: {} },
  { id: 'MIS_EXPLICIT_NULL', sourcePolicy: { webResearchEnabled: null } },
  { id: 'MIS_OFF', sourcePolicy: { webResearchEnabled: false } },
];
for (const mission of disabledMissions) {
  assert.equal(resolveResearchConfig(mission).automaticEnabled, false, `${mission.id} must default to off`);
  for (const trigger of automaticTriggers) {
    const resolution = resolveAutomaticResearch({ mission, trigger });
    assert.equal(resolution.allowed, false, `automatic research must be denied for ${trigger} on ${mission.id}`);
    assert.equal(resolution.reasonCode, 'RESEARCH_DISABLED_BY_POLICY');
  }
}
const disabledMission = disabledMissions.at(-1);

// 硬改名：旧字段名不再被读取。留任一条兼容通道，都会让「默认关闭」在新旧配置混用时失效。
assert.equal(resolveResearchConfig({ id: 'MIS_LEGACY', sourcePolicy: { researchEnabled: true } }).automaticEnabled, false,
  'the pre-rename field name must not enable research');
assert.equal(resolveResearchConfig({ id: 'MIS_LEGACY_POLICY', researchPolicy: { enabled: true } }).automaticEnabled, false,
  'the legacy researchPolicy.enabled fallback must not enable research either');

// 只有显式 true 才开启；开启后各自动入口照常裁决（否则「默认关闭」会被误做成「永远关闭」）。
const enabledMission = { id: 'MIS_ON', sourcePolicy: { webResearchEnabled: true } };
assert.equal(resolveResearchConfig(enabledMission).automaticEnabled, true);
for (const trigger of automaticTriggers) {
  assert.equal(resolveAutomaticResearch({ mission: enabledMission, trigger }).allowed, true, `enabling must allow ${trigger}`);
}

// 关闭自动研究不影响本地经验与已审查 Wiki 的配置读取：那一路径不受 webResearchEnabled 约束。
assert.equal(resolveResearchConfig(disabledMission).requiresVerifiableSource, false,
  'disabling research must not weaken the source policy itself');
assert.equal(resolveResearchConfig({ id: 'M', sourcePolicy: { mode: 'agent-research-only', webResearchEnabled: false } }).requiresVerifiableSource, true,
  'the source gate stays intact when research is disabled');

// 手动研究不受 webResearchEnabled 约束，只受显式 manualEnabled 约束。
assert.equal(resolveManualResearch({ mission: disabledMission, phase: 'acquire' }).allowed, true);
assert.equal(resolveManualResearch({ mission: { id: 'M', researchPolicy: { manualEnabled: false } }, phase: 'acquire' }).allowed, false);
assert.equal(resolveManualResearch({ mission: { id: 'M' }, phase: 'nope' }).reasonCode, 'RESEARCH_PHASE_UNKNOWN');

// 阶段与预算：建议型研究用短预算（60–120s 量级默认值），必要来源采集用独立策略。
const advisory = resolveAutomaticResearch({ mission: enabledMission, trigger: RESEARCH_TRIGGERS.STAGNATION });
assert.equal(advisory.phase, 'advisory');
assert.equal(advisory.budgetMs, RESEARCH_ADVISORY_BUDGET_MS);
assert.equal(advisory.budgetMs, 90_000);
assert.equal(resolveAutomaticResearch({ mission: enabledMission, trigger: RESEARCH_TRIGGERS.TUNNEL_VISION }).phase, 'advisory');
assert.equal(resolveAutomaticResearch({ mission: enabledMission, trigger: RESEARCH_TRIGGERS.EXPERIENCE }).phase, 'experience');
const acquisition = resolveAutomaticResearch({ mission: enabledMission, trigger: RESEARCH_TRIGGERS.BASELINE_SOURCE });
assert.equal(acquisition.phase, 'acquire');
assert.equal(acquisition.budgetMs, RESEARCH_ACQUISITION_BUDGET_MS);
// 预算可配置，不是写死的通用上限。
assert.equal(resolveAutomaticResearch({ mission: { id: 'M', sourcePolicy: { webResearchEnabled: true, researchBudgetMs: 60_000 } }, trigger: RESEARCH_TRIGGERS.STAGNATION }).budgetMs, 60_000);
assert.equal(resolveAutomaticResearch({ mission: { id: 'M', sourcePolicy: { webResearchEnabled: true, researchBudgetMs: 10 } }, trigger: RESEARCH_TRIGGERS.STAGNATION }).budgetMs, 30_000,
  'out-of-range budgets are clamped to the documented bounds');

// ---- A. 固定 profile 与严格来源入口：关闭研究时不偷偷启动 ----
let fixedStarts = 0;
const fixedEvents = [];
const fixedService = createAutopilotFixedProfileService({
  isResearchAgentActive: () => false,
  startResearch: async () => { fixedStarts += 1; return {}; },
  startMainRound: async ({ state }) => state,
  researchDirForMission: () => '/tmp/research',
  appendRuntimeEvent: (state, type, payload) => fixedEvents.push({ type, payload }),
});
const fixedDisabledState = {
  activeMissionId: 'MIS_OFF', baseline: { status: 'complete' }, runtimeEvents: [],
  researchAgent: { status: 'idle', runId: null }, agent: { status: 'running', runId: 'codex_MAIN' },
  iterationStats: {},
};
const fixedOutcome = await fixedService.advance({ state: fixedDisabledState, mission: disabledMission });
assert.equal(fixedStarts, 0, 'fixed profile must not start research when webResearchEnabled is false');
assert.equal(fixedOutcome.action, 'none');

// 缺省（未设该键）同样必须走「跳过」分支。这条分支若只匹配显式 false，缺省的 undefined 就会两头
// 落空：既不启动研究，也不留任何事件——而缺省恰恰是绝大多数 Mission 的取值。
fixedEvents.length = 0;
const fixedDefaultOutcome = await fixedService.advance({
  state: { ...fixedDisabledState, activeMissionId: 'MIS_DEFAULT' },
  mission: { id: 'MIS_DEFAULT' },
});
assert.equal(fixedStarts, 0, 'an unset switch must not start experience research');
assert.equal(fixedDefaultOutcome.action, 'none');
assert.equal(fixedEvents.filter((event) => event.type === 'research.skipped_disabled').length, 1,
  'the default-off case must emit research.skipped_disabled instead of falling through silently');

// 固定 profile 的研究方向不再写死 C550：硬件从当前任务契约派生。
let fixedDirection = null;
const enabledFixedService = createAutopilotFixedProfileService({
  isResearchAgentActive: () => false,
  startResearch: async ({ direction, runPhase, budgetMs }) => { fixedStarts += 1; fixedDirection = direction; assert.equal(runPhase, 'experience'); assert.equal(budgetMs, RESEARCH_ADVISORY_BUDGET_MS); return {}; },
  startMainRound: async ({ state }) => state,
  researchDirForMission: () => '/tmp/research',
  appendRuntimeEvent: () => {},
});
await enabledFixedService.advance({
  state: { ...fixedDisabledState, missions: [{ id: 'MIS_ON', hardware: ['MetaX C588'], operatorProfile: { language: 'triton' } }] },
  mission: { id: 'MIS_ON', title: 'paged attention', hardware: ['MetaX C588'], operatorProfile: { language: 'triton' }, sourcePolicy: { webResearchEnabled: true } },
});
assert.equal(fixedStarts, 1);
assert.match(fixedDirection, /MetaX C588/);
assert.doesNotMatch(fixedDirection, /C550/, 'research direction must not hardcode historical hardware');

// 严格来源入口：关闭研究时返回显式人工状态，而不是启动采集或放宽门禁。
let strictStarts = 0;
const strictService = createAutopilotStrictSourceService({
  isStrictZeroSourceMission: () => true,
  isResearchAgentActive: () => false,
  selectResearchBaselineSource: () => null,
  buildSemanticBaselineSource: () => null,
  startResearch: async () => { strictStarts += 1; return {}; },
  startBaseline: async ({ state }) => state,
  startMainRound: async ({ state }) => state,
  researchDirForMission: () => '/tmp/research',
});
const strictDisabled = await strictService.advance({
  state: { activeMissionId: 'MIS_OFF', baseline: { status: 'missing' }, researchAgent: {}, researchNotes: [], iterationStats: {} },
  mission: disabledMission,
  candidate: null,
});
assert.equal(strictStarts, 0);
assert.equal(strictDisabled.action, 'needs_human');
assert.equal(strictDisabled.state.iterationStats.loopStatusReason, 'research_disabled_source_unresolved');

// 恢复入口（materializer 拒绝后改选来源）同样不会被关闭开关绕开。
let recoveryStarts = 0;
const recoveryService = createBaselineMaterializerRecoveryService({
  consumeWorkflowRecoveryBudget: () => ({ allowed: true, attempt: 1, component: 'baseline-materializer', limit: 1 }),
  startResearch: async () => { recoveryStarts += 1; return {}; },
  researchDirForMission: () => '/tmp/research',
  appendRuntimeEvent: () => {},
});
const recovery = await recoveryService.recover({
  state: { activeMissionId: 'MIS_OFF', baseline: {}, runtimeEvents: [], iterationStats: {} },
  mission: disabledMission,
  baselineSource: null,
  materializer: { status: 'failed', source: { repository: 'https://example.invalid/r.git', commit: 'abc', path: 'a.py' }, error: { code: 'BASELINE_MATERIALIZER_FAILED' } },
});
assert.equal(recoveryStarts, 0);
assert.equal(recovery.action, 'needs_human');

// ---- A. 运行故障不触发完整领域研究 ----
assert.equal(classifyResearchFaults({ failureRecords: [{ failure: { code: 'ECONNREFUSED' } }] }).runtimeFaultOnly, true);
assert.equal(classifyResearchFaults({ failureRecords: [{ failure: { code: 'RESEARCH_SCHEMA_MISMATCH' } }] }).runtimeFaultOnly, true);
assert.equal(classifyResearchFaults({ failureRecords: [{ failure: { code: 'OPERATOR_TEST_FAILED' }, decisionReason: '数值偏差超阈值' }] }).runtimeFaultOnly, false);
assert.equal(classifyResearchFaults({
  failureRecords: [{ failure: { code: 'ECONNREFUSED' } }, { failure: { code: 'OPERATOR_TEST_FAILED' } }],
}).runtimeFaultOnly, false, 'mixed failures are not a pure runtime fault');
assert.equal(classifyResearchFaults({ failureRecords: [] }).faultClass, 'knowledge_gap');

// ---- B. 输出解析 ----
const valid = JSON.parse(notesResult());
assert.deepEqual(extractResearchResult([agentMessage(notesResult())], { phase: 'advisory' }).result, valid);
assert.equal(extractResearchResult([agentMessage(notesResult())], { phase: 'advisory' }).format, 'structured-json');

// Markdown 围栏包裹
const fenced = '以下是结论：\n```json\n' + notesResult() + '\n```\n以上。';
assert.deepEqual(extractResearchResult([agentMessage(fenced)], { phase: 'advisory' }).result, valid);

// 少量前后说明文字，但包含唯一明确目标 JSON
assert.deepEqual(extractResearchResult([agentMessage(`分析如下。${notesResult()} 完毕。`)], { phase: 'advisory' }).result, valid);

// 正确结果之后又出现无关工具 JSON：不得覆盖目标结果
const withToolAfter = [
  agentMessage(notesResult()),
  toolEvent('{"stdout":"total 0","exit_code":0}'),
  toolEvent('{"command":"git clone https://example.invalid/x.git"}', 'command_execution'),
];
const afterTool = extractResearchResult(withToolAfter, { phase: 'advisory' });
assert.deepEqual(afterTool.result, valid, 'unrelated tool JSON must not replace the researcher result');
assert.equal(afterTool.reasonCode, null);
// 即使无关 JSON 以研究员消息形式出现，schema 不符也不会被当成结果
const probeAsMessage = extractResearchResult([agentMessage(notesResult()), agentMessage('{"command":"ls","output":"x"}')], { phase: 'advisory' });
assert.deepEqual(probeAsMessage.result, valid);
assert.ok(probeAsMessage.diagnostics.rejected.length >= 1);

// 多个冲突候选：返回明确诊断，不随意接受
const conflicting = extractResearchResult([agentMessage(`${notesResult()} ${notesResult({ summary: '另一个完全不同的结论' })}`)], { phase: 'advisory' });
assert.equal(conflicting.result, null);
assert.equal(conflicting.reasonCode, RESEARCH_RESULT_REASONS.AMBIGUOUS);

// 错误 schema 仍被拒绝
const wrongSchema = extractResearchResult([agentMessage(JSON.stringify({ schemaVersion: 'operator-studio.agent-result/v1', candidates: [] }))], { phase: 'advisory' });
assert.equal(wrongSchema.result, null);
assert.equal(wrongSchema.reasonCode, RESEARCH_RESULT_REASONS.SCHEMA_MISMATCH);

// 没有研究员消息 → 明确「没有发现结果」，而不是从工具事件里捞
const noMessage = extractResearchResult([toolEvent(notesResult())], { phase: 'advisory' });
assert.equal(noMessage.result, null);
assert.equal(noMessage.reasonCode, RESEARCH_RESULT_REASONS.NOT_FOUND);

// 结果不属于本次运行 → 拒绝
const foreignRun = extractResearchResult([agentMessage(notesResult({ researchRunId: 'codex_research_OTHER' }))], { phase: 'advisory', runId: 'codex_research_MINE' });
assert.equal(foreignRun.result, null);
assert.equal(foreignRun.reasonCode, RESEARCH_RESULT_REASONS.RUN_MISMATCH);

// 「仅修格式」的确定性修复：剥围栏、剥说明文字，不做语义补全
const repaired = repairResearchFormatting('前缀\n```json\n{"a":1}\n```\n后缀');
assert.ok(repaired.some((entry) => entry.text === '{"a":1}'));
assert.equal(parseResearchResult([agentMessage('plain research notes')], { phase: 'advisory' }).outcome, 'no_result');
assert.equal(parseResearchResult([agentMessage('plain research notes')], { phase: 'advisory' }).format, 'text-fallback');

// ---- B. 来源选择：提取与验证分离，门禁不放宽 ----
const sourceRoot = await mkdtemp(join(tmpdir(), 'research-output-'));
try {
  await assert.rejects(
    acquireSelectedSources({ events: [toolEvent(acquisitionResult([{ name: 'x', url: 'https://example.invalid/x.git' }]))], sourceRoot, researchDir: sourceRoot, runId: 'r1' }),
    (error) => error.code === 'RESEARCH_SOURCE_SELECTION_INVALID' && error.reasonCode === RESEARCH_RESULT_REASONS.NOT_FOUND,
    '结果只能来自研究员消息，不能从工具事件里捞',
  );
  await assert.rejects(
    acquireSelectedSources({ events: [agentMessage(notesResult())], sourceRoot, researchDir: sourceRoot, runId: 'r1' }),
    (error) => error.code === 'RESEARCH_SOURCE_SELECTION_INVALID' && error.reasonCode === RESEARCH_RESULT_REASONS.SCHEMA_MISMATCH,
    '阶段 schema 不符必须拒绝',
  );
  // 空仓库数组：契约不允许 semantic fallback 时拒绝（门禁不变）
  await assert.rejects(
    acquireSelectedSources({ events: [agentMessage(acquisitionResult([]))], sourceRoot, researchDir: sourceRoot, runId: 'r1', allowSemanticFallback: false }),
    (error) => error.code === 'RESEARCH_SOURCE_SELECTION_INVALID' && error.reasonCode === 'RESEARCH_SOURCE_POLICY_REJECTED',
  );
  // 契约允许时，空数组是合法输入，进入语义 fallback 并写出清单
  const fallbackAcquired = await acquireSelectedSources({
    events: [agentMessage(acquisitionResult([]))],
    sourceRoot, researchDir: sourceRoot, runId: 'r1', allowSemanticFallback: true,
  });
  assert.deepEqual(fallbackAcquired, []);
  const manifest = JSON.parse(await readFile(join(sourceRoot, 'acquisition-result.json'), 'utf8'));
  assert.equal(manifest.semanticFallback.requested, true);
} finally {
  await rm(sourceRoot, { recursive: true, force: true });
}

// ---- C. 克隆失败要说出原因，且不偷偷变成重试 ----
// execFile 超时杀进程时给的是 {code: null, killed: true, stderr: ''}：原样抛出等于没有原因。
const timeoutFailure = Object.assign(new Error('Command failed: git clone'), { code: null, killed: true, signal: 'SIGTERM' });
annotateCloneFailure(timeoutFailure, { attempt: 2 });
assert.equal(timeoutFailure.code, 'RESEARCH_SOURCE_CLONE_TIMEOUT');
assert.match(timeoutFailure.message, /第 2 次尝试/);
assert.match(timeoutFailure.message, /stderr/);
// 超时不是临时错误：单次上限 180s，把它当临时错误就是在 10 分钟采集预算里跑三倍墙钟。
assert.equal(isTransientSourceError(timeoutFailure), false);
assert.equal(isTransientSourceError(Object.assign(new Error('Command failed: git'), { code: null, killed: true, stderr: '' })), false);
// 有 stderr 的真实网络错误仍然是临时错误，重试预算照旧生效。
assert.equal(isTransientSourceError(Object.assign(new Error('git clone failed'), { stderr: 'fatal: unable to access: Could not resolve host: github.com' })), true);
// 非超时失败保持原有码，不冒充超时。
const otherFailure = annotateCloneFailure(Object.assign(new Error('git clone failed'), { code: null, stderr: 'fatal: repository not found' }));
assert.equal(otherFailure.code, 'RESEARCH_SOURCE_CLONE_FAILED');
assert.equal(isTransientSourceError(otherFailure), false, 'permanent errors must not be retried');

// 适用范围从当前冻结任务契约派生，不写死历史目标。
const scope = researchScopeForMission({
  hardware: ['MetaX C588'], operatorProfile: { dtype: 'fp16', operator: 'paged_attention' },
  testScenario: { matrix: { shape: [{ batch: 1, seq: 2048 }] } },
});
assert.deepEqual(scope.hardware, ['metax c588']);
assert.deepEqual(scope.dtype, ['fp16']);
assert.equal(scope.operator, 'paged_attention');
assert.equal(JSON.stringify(scope).includes('c550'), false);

console.log('[research-policy] unified entry policy, explicit phases, gated sources, and result extraction passed');
