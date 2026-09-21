import assert from 'node:assert/strict';
import {
  buildSemanticBaselineSource,
  missionDeclaresBaselineSource,
  resolveBaselineRunPlan,
} from '../client-runtime/baseline-resolver.mjs';
import { createBaselineSourceService } from '../client-runtime/application/baseline-source-service.mjs';
import { createAutopilotStrictSourceService } from '../client-runtime/application/autopilot-strict-source-service.mjs';
import { createBaselineRequirementState } from '../client-runtime/evidence-state.mjs';

// 规则：**零来源** Mission 允许在拿不到可核验来源时跳过权威要求（语义 baseline），
// **规定了来源**的 Mission 不允许——那会把任务换成「以 Mission 描述为正确性判据」。

const matrix = { environments: ['C500'], stages: ['Correctness'], correctnessCases: 1 };
const mandatedSource = {
  authority: 'upstream',
  repository: 'https://github.com/flashinfer-ai/flashinfer',
  commit: 'f479fe2817e2f927e2778d8b1c6033beed8477c1',
  path: 'include/flashinfer/attention/decode.cuh',
  operator: 'MLA paged attention',
};
const semanticSource = buildSemanticBaselineSource({ id: 'MIS_X', operator: 'MLA paged attention' }, {});
const semanticRunPy = [
  'def get_inputs():',
  '    import torch',
  '    return {"x": torch.ones((1,), device="cuda")}',
  '',
  'def run(inputs):',
  '    return inputs["x"]',
  '',
  'def reference(inputs):',
  '    return inputs["x"]',
  '',
].join('\n');
const zeroSourcePolicy = { mode: 'agent-flexible', strictZeroSource: true, localFirst: true, allowDiscoveredSources: true, allowSemanticFallback: true };
const zeroSourceMission = { id: 'MIS_ZERO', title: 'MLA', operator: 'MLA paged attention', sourcePolicy: zeroSourcePolicy };
const mandatedMission = { ...zeroSourceMission, id: 'MIS_MANDATED', baseline: { source: mandatedSource } };

// 只看 Mission 自身的声明。运行时 state.baseline.source 可能正是语义来源，不能当判据。
assert.equal(missionDeclaresBaselineSource(zeroSourceMission), false);
assert.equal(missionDeclaresBaselineSource(mandatedMission), true);
assert.equal(missionDeclaresBaselineSource({ upstream: { reference: mandatedSource } }), true);
assert.equal(missionDeclaresBaselineSource({ baseline: { source: mandatedSource }, state: { baseline: { source: semanticSource } } }), true);

// 规定了来源：从任何入口交进来的语义来源都必须被拒。
await assert.rejects(
  resolveBaselineRunPlan({ mission: mandatedMission, matrix, body: { baselineSource: semanticSource, materializerResult: { runPy: semanticRunPy, report: {} } } }),
  (error) => error.code === 'BASELINE_MANDATED_SOURCE_NO_SUBSTITUTE' && error.status === 409,
);

// 零来源：允许跳过，但必须如实记录跳过。
const semanticPlan = await resolveBaselineRunPlan({
  mission: zeroSourceMission,
  matrix,
  body: { baselineSource: semanticSource, materializerResult: { runPy: semanticRunPy, report: { summary: 'derived from Mission semantics' } } },
});
assert.equal(semanticPlan.baselineSource.semanticFallback, true);
assert.equal(semanticPlan.resolution.strategy, 'semantic_fallback');
assert.equal(semanticPlan.resolution.attemptedAuthority, false);
assert.equal(semanticPlan.resolution.skippedAuthority, true);
assert.ok(semanticPlan.resolution.skippedAuthorityReason);

// 留痕字段必须能穿过 baseline 状态的字段白名单，否则 UI 与证据都读不到。
const projected = createBaselineRequirementState({ kind: 'pytorch_reference', resolution: semanticPlan.resolution });
assert.equal(projected.resolution.skippedAuthority, true);
assert.equal(projected.resolution.strategy, 'semantic_fallback');

const authoritativePlan = await resolveBaselineRunPlan({
  mission: zeroSourceMission,
  matrix,
  body: { baselineSource: { ...mandatedSource, expandedSingleFile: true }, materializerResult: { runPy: semanticRunPy, report: {} } },
});
assert.equal(authoritativePlan.resolution.strategy, 'authoritative_first');
assert.equal(authoritativePlan.resolution.attemptedAuthority, true);
assert.equal(authoritativePlan.resolution.skippedAuthority, false);

// 选源服务：规定了来源时，即使 allowSemanticFallback=true 也不产出语义来源。
const sourceService = createBaselineSourceService({
  isFixedOperatorMission: () => false,
  isStrictZeroSourceMission: (mission) => mission.sourcePolicy?.strictZeroSource === true,
  selectResearchBaselineSource: () => null,
  buildSemanticBaselineSource,
  inferAuthoritativeBaselineSource: () => null,
  isSemanticBaselineSource: (source) => Boolean(source && source.semanticFallback === true),
});
const terminalResearchState = { researchAgent: { status: 'completed', runId: 'run-1' }, researchNotes: [] };
const zeroSelection = sourceService.select({ state: terminalResearchState, mission: zeroSourceMission });
assert.equal(zeroSelection.semanticFallback, true);
const mandatedSelection = sourceService.select({ state: terminalResearchState, mission: mandatedMission });
assert.equal(mandatedSelection.source, null);
assert.equal(mandatedSelection.semanticFallback, false);

// 自动流转：规定了来源、研究已终态且没有可用来源 → 停成「来源未解析」，而不是继续跑语义 baseline。
const autopilot = createAutopilotStrictSourceService({
  isStrictZeroSourceMission: (mission) => mission.sourcePolicy?.strictZeroSource === true,
  isResearchAgentActive: (research) => ['running', 'cancel_requested'].includes(research.status),
  selectResearchBaselineSource: () => null,
  buildSemanticBaselineSource,
  startResearch: async () => { throw new Error('startResearch must not run'); },
  startBaseline: async ({ state }) => ({ ...state, baseline: { ...(state.baseline || {}), status: 'running' } }),
  startMainRound: async () => { throw new Error('startMainRound must not run'); },
  researchDirForMission: () => '/tmp',
});
const finishedResearch = { status: 'completed', runId: 'run-1', runPhase: 'acquire', acquireHandled: true };
const mandatedAdvance = await autopilot.advance({ state: { researchAgent: { ...finishedResearch }, iterationStats: {} }, mission: mandatedMission });
assert.equal(mandatedAdvance.action, 'needs_human');
assert.equal(mandatedAdvance.state.iterationStats.loopStatus, 'needs_human');
assert.equal(mandatedAdvance.state.iterationStats.loopStatusReason, 'baseline_source_unresolved');

const zeroAdvance = await autopilot.advance({ state: { researchAgent: { ...finishedResearch }, iterationStats: {} }, mission: zeroSourceMission });
assert.equal(zeroAdvance.action, 'baseline_started');

process.stdout.write('[mandated-source-no-substitute] mandated source cannot be substituted; zero-source skip is marked\n');
