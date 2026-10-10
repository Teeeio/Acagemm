import { canonicalJson, contentDigest } from './execution-package-contract.mjs';
import { coverageIsComplete } from './correctness-coverage.mjs';
import { summarizeExperimentMemory } from './experiment-memory.mjs';

export const EVALUATION_SCHEMA = 'operator-studio.iteration-evaluation/v1';
const copy = value => value == null ? null : structuredClone(value);
const number = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
const positive = value => number(value) !== null && value > 0;
const terminal = status => ['complete', 'completed', 'failed', 'cancelled', 'timed_out', 'quarantined'].includes(status);
const countBy = (items, field) => items.reduce((counts, item) => {
  const key = String(field(item) || 'unknown');
  counts[key] = (counts[key] || 0) + 1;
  return counts;
}, {});
const invalid = message => { throw Object.assign(new Error(message), { code: 'EVALUATION_RECORD_INVALID', status: 503 }); };

// Input is the committed latest-fact view, never revisions or UI windows.
// Identical replays count once; conflicting versions must be resolved by storage.
function uniqueRecords(records, missionId) {
  const unique = new Map();
  for (const record of records) {
    if (record.missionId !== missionId || record.key !== JSON.stringify([record.kind, missionId, record.id])) invalid('Evaluation record scope/identity mismatch.');
    if (unique.has(record.key) && canonicalJson(unique.get(record.key)) !== canonicalJson(record)) invalid('Evaluation requires the latest trace view.');
    unique.set(record.key, record);
  }
  return [...unique.values()].sort((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
}

const profilesOf = test => Array.isArray(test.result?.benchmark) ? test.result.benchmark : [];
const profileKey = profile => JSON.stringify([profile.profile || null, profile.environment || null]);
const completed = test => ['complete', 'completed'].includes(test.status) && test.resourceRelease?.confirmed !== false;
const bindingMatches = test => {
  const expected = test.executionPackage, actual = test.result?.executionPackage;
  return Boolean(expected?.admissionId && expected.workspaceId && actual
    && ['packageDigest', 'environmentDigest', 'acceptanceDigest', 'workspaceId'].every(key => expected[key] && expected[key] === actual[key]));
};
const decisionFor = (test, missionId) => {
  const decision = test.evidenceDecision;
  const binding = decision?.binding;
  return binding && binding.missionId === missionId && binding.runId === test.runId
    && binding.candidateId === test.candidate?.id && binding.candidateDigest
    && binding.candidateDigest === test.candidate?.digest ? decision : null;
};
const direction = metric => {
  const value = String(metric || '').toLowerCase().replaceAll('_', ' ').trim();
  if (/^(latency(?: p(?:50|95|99))?|duration|time)$/.test(value)) return 'lower';
  if (/^(throughput|bandwidth|flops|tflops|gflops|tops|items per second)$/.test(value)) return 'higher';
  return null;
};
const dispersion = profile => ({
  samples: number(profile.samples), p95: number(profile.p95 ?? profile.p95Us),
  min: number(profile.min ?? profile.minUs), max: number(profile.max ?? profile.maxUs),
  standardDeviation: number(profile.stddev ?? profile.stdUs),
  settled: typeof profile.settled === 'boolean' ? profile.settled : null,
});

function compareProfiles(test, baseline, decision) {
  const candidateProfiles = profilesOf(test), baselineProfiles = profilesOf(baseline || {});
  const keys = [...new Set([...candidateProfiles, ...baselineProfiles].map(profileKey))].sort();
  return keys.map(key => {
    const candidates = candidateProfiles.filter(item => profileKey(item) === key);
    const baselines = baselineProfiles.filter(item => profileKey(item) === key);
    const candidate = candidates[0], reference = baselines[0];
    const reasons = [];
    if (!baseline) reasons.push('baseline_not_recorded');
    if (!completed(test) || (baseline && !completed(baseline))) reasons.push('test_not_complete');
    if (!decision || decision.correctness?.passed !== true || decision.benchmark?.valid !== true) reasons.push('canonical_evidence_not_qualified');
    if (!bindingMatches(test) || (baseline && !bindingMatches(baseline))) reasons.push('receipt_binding_unavailable_or_conflicting');
    if (baseline && ['environmentDigest', 'acceptanceDigest'].some(field => !test.executionPackage?.[field] || test.executionPackage[field] !== baseline.executionPackage?.[field])) reasons.push('comparison_conditions_mismatch');
    if (candidates.length !== 1 || baselines.length !== 1 || !candidate?.profile) reasons.push('profile_missing_or_ambiguous');
    if (![candidate, reference].every(item => item?.correctness?.passed === true && coverageIsComplete(item.correctness))) reasons.push('correctness_not_complete');
    if (![candidate?.value, reference?.value].every(positive)) reasons.push('measurement_unavailable_or_nonpositive');
    if (!candidate?.unit || candidate.unit !== reference?.unit) reasons.push('unit_missing_or_mismatched');
    if (!candidate?.metric || candidate.metric !== reference?.metric || !direction(candidate.metric)) reasons.push('metric_missing_or_mismatched');
    if (candidate?.settled === false || reference?.settled === false) reasons.push('measurement_unsettled');
    const comparable = reasons.length === 0;
    return {
      profile: candidate?.profile || reference?.profile || null,
      environment: candidate?.environment || reference?.environment || null,
      metric: candidate?.metric || reference?.metric || null, unit: candidate?.unit || reference?.unit || null,
      value: number(candidate?.value), baselineValue: number(reference?.value),
      variation: dispersion(candidate || {}), baselineVariation: dispersion(reference || {}),
      comparable, reasons,
      speedup: comparable ? direction(candidate.metric) === 'lower' ? reference.value / candidate.value : candidate.value / reference.value : null,
    };
  });
}

function timingSummary(items, stage) {
  const observations = items.map(item => item.stageTimings?.[stage]);
  const values = observations.filter(item => item?.status === 'observed' && number(item.durationMs) !== null).map(item => item.durationMs);
  return { observed: values.length, unknown: items.length - values.length,
    sumObservedMs: values.length ? values.reduce((sum, value) => sum + value, 0) : null,
    meanObservedMs: values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null };
}

function tokenSummary(ledger, generations) {
  const entries = new Map(Object.entries(ledger?.runs || {}));
  // Missing provider observations must also enter the denominator.
  for (const run of generations) if (!entries.has(run.runId)) entries.set(run.runId, null);
  const rows = [...entries.entries()].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([runId, usage]) => ({
    runId, phase: usage?.phase || null, completeness: usage?.completeness || 'unavailable',
    totalTokens: usage?.completeness === 'exact' ? number(usage.totalTokens) : null,
  }));
  const known = rows.filter(item => item.totalTokens !== null);
  return { runs: rows, observedRuns: known.length, unknownRuns: rows.length - known.length,
    totalTokens: rows.length && known.length === rows.length ? known.reduce((sum, item) => sum + item.totalTokens, 0) : null,
    observedSubtotalTokens: known.length ? known.reduce((sum, item) => sum + item.totalTokens, 0) : null,
    cost: { value: null, currency: null, status: 'not_observed' } };
}

/** Deterministic descriptive report; never creates a Gate verdict or publication grant. */
export function buildIterationEvaluation({ missionId, records = [], source = {} } = {}) {
  if (typeof missionId !== 'string' || !missionId || !Array.isArray(records)) invalid('Evaluation requires a Mission and trace records.');
  const facts = uniqueRecords(records, missionId);
  const ofKind = kind => facts.filter(item => item.kind === kind);
  const mission = ofKind('mission')[0]?.data || {};
  const archived = ofKind('round').map(item => item.data);
  const generationMap = new Map(archived.filter(item => item.runId).map(item => [item.runId, item]));
  for (const record of ofKind('agent-run')) generationMap.set(record.id, record.data);
  const generations = [...generationMap.values()];
  const tests = ofKind('test').map(item => item.data);
  const testById = new Map(tests.map(item => [item.runId, item]));
  const events = ofKind('runtime-event');
  const decisions = ofKind('decision').map(item => ({ id: item.id, ...copy(item.data) }));
  const performance = tests.filter(item => item.purpose === 'candidate').map(test => {
    const decision = decisionFor(test, missionId);
    const baselineId = test.comparisonBaseline?.runId || null;
    const baseline = testById.get(baselineId);
    const matchedBaseline = baseline?.purpose === 'baseline' ? baseline : null;
    return {
      runId: test.runId, candidate: copy(test.candidate), status: test.status,
      baselineRunId: baselineId, baselineKind: test.comparisonBaseline?.kind || null,
      decision: copy(decision), source: copy(test.result?.environment),
      profiles: compareProfiles(test, matchedBaseline, decision),
    };
  });
  const selectEvents = predicate => events.filter(item => predicate(item.data)).map(item => ({ id: item.id, type: item.data.type, timestamp: item.data.timestamp || null, payload: copy(item.data.payload) }));
  const humanFeedback = selectEvents(event => event.type === 'mission.human_feedback_added');
  const humanResolutions = decisions.filter(item => ['human', 'user', 'operator', 'human_review', 'human_recovery', 'direct_action'].includes(item.resolution?.source));
  const budgets = selectEvents(event => ['loop.round_budget_exceeded', 'loop.budget_completed'].includes(event.type)
    || (event.type === 'research.advisory_budget_stop' && event.payload?.reason === 'budget_exhausted'));
  const qualifiedDecisions = performance.map(item => item.decision).filter(Boolean);
  const firstOrigin = generations.map(item => item.generationOrigin).filter(item => item?.workspace?.digest && item.capturedAt)
    .sort((a, b) => a.capturedAt < b.capturedAt ? -1 : a.capturedAt > b.capturedAt ? 1 : 0)[0];
  const baselines = tests.filter(item => item.purpose === 'baseline').map(item => ({
    runId: item.runId, kind: item.baselineKind || null, status: item.status,
    source: copy(item.baselineSource), executionPackage: copy(item.executionPackage),
    profiles: copy(profilesOf(item)),
  }));
  return {
    schemaVersion: EVALUATION_SCHEMA, missionId, experiment: copy(mission.experiment),
    memory: summarizeExperimentMemory({ experiment: mission.experiment, generations }),
    source: { ...copy(source), recordCount: facts.length, recordsDigest: contentDigest(canonicalJson(facts)) },
    publication: { grantedByReport: false },
    reliability: {
      tests: { total: tests.length, terminal: tests.filter(item => terminal(item.status)).length,
        byStatus: countBy(tests, item => item.status), releaseUnconfirmed: tests.filter(item => item.resourceRelease?.confirmed === false).length },
      generationRuns: generations.length,
      failures: tests.filter(item => ['failed', 'timed_out', 'quarantined'].includes(item.status)).map(item => ({
        runId: item.runId, purpose: item.purpose || null, status: item.status,
        error: copy(item.lastServiceError), failureClass: item.lastServiceError?.classification || 'unclassified',
      })),
      generationFailures: generations.filter(item => item.error || item.failure || item.timedOut === true || item.candidateValidation?.passed === false || ['failed', 'error', 'cancelled', 'timed_out'].includes(item.status)).map(item => ({
        runId: item.runId, status: item.status, timedOut: item.timedOut === true,
        error: copy(item.error || item.failure || item.primaryFailure), providerRetries: copy(item.providerRetries),
        resourceRelease: copy(item.resourceRelease), candidateValidation: copy(item.candidateValidation),
      })),
      humanFeedback, humanResolutions, budgetExhaustions: budgets,
      assistanceRequests: selectEvents(event => event.type === 'loop.needs_human'),
      workflowFailure: copy(mission.workflowFailure),
    },
    efficiency: {
      observedGateProgress: countBy(qualifiedDecisions, item => item.progress?.status),
      adoptionEligibility: countBy(qualifiedDecisions, item => item.adoption?.status),
      resolvedOutcomes: countBy(decisions.filter(item => item.status === 'resolved'), item => item.resolution?.outcome),
      unqualifiedCandidateTests: performance.length - qualifiedDecisions.length,
      timing: {
        preparation: timingSummary(generations, 'preparation'), generation: timingSummary(generations, 'generation'),
        queue: timingSummary(tests, 'queue'), dispatch: timingSummary(tests, 'dispatch'), test: timingSummary(tests, 'test'),
      },
      tokenUsage: tokenSummary(mission.tokenUsage, generations),
      // Observed durations may overlap and are never added into a fake wall clock.
      wallClockMs: null,
    },
    references: {
      correctnessOracle: { source: copy(mission.baseline?.source), status: mission.baseline?.source ? 'declared' : 'not_observed', performanceRoleInferred: false },
      initialImplementation: { workspaceDigest: firstOrigin?.workspace.digest || null, status: firstOrigin ? 'first_observed_generation_start' : 'not_observed', measuredRunId: null },
      measuredBaselines: baselines,
      competitiveBaseline: { status: 'not_identified', runId: null },
    },
    performance, decisions,
    limitations: [
      'Counts describe recorded facts; missing legacy history remains unknown.',
      'Speedups use the submission-bound baseline and matching conditions; this report grants no verdict or publication authority.',
      'The first observed workspace is not proof of the original implementation or its performance.',
      'Missing dispersion, token usage and cost remain null. Stage sums are not end-to-end wall time.',
    ],
  };
}

const cell = value => value == null ? '未知' : String(value).replaceAll('|', '\\|').replaceAll('\n', ' ');
export function renderIterationEvaluationMarkdown(report) {
  return [
    '# Mission 迭代评价', '', `Mission：${cell(report.missionId)}`, '',
    `数据覆盖：${cell(report.source.coverage?.status)}；此前历史：${cell(report.source.coverage?.priorHistory)}`, '',
    '## 系统可靠性', '',
    `生成运行：${report.reliability.generationRuns}；测试记录：${report.reliability.tests.total}；测试终态：${report.reliability.tests.terminal}。`, '',
    `测试失败：${report.reliability.failures.length}；人工反馈：${report.reliability.humanFeedback.length}；预算耗尽记录：${report.reliability.budgetExhaustions.length}。`, '',
    '## 迭代效率', '', '| 阶段 | 已测 / 未知 | 已测时长合计 ms |', '| --- | --- | --- |',
    ...Object.entries(report.efficiency.timing).map(([stage, value]) => `| ${stage} | ${value.observed} / ${value.unknown} | ${cell(value.sumObservedMs)} |`), '',
    `Token 总量：${cell(report.efficiency.tokenUsage.totalTokens)}；费用：未知。`, '',
    '## 经验与实验隔离', '',
    `经验模式：${cell(report.memory?.mode)}；读取条件：${cell(report.memory?.condition)}；积累链：${cell(report.memory?.chainId)}。`, '',
    `发送前经验审计一致：${report.memory?.preparedConsistentRuns ?? 0}；未知：${report.memory?.unknownRuns ?? 0}；冲突：${report.memory?.conflictingRuns ?? 0}。`, '',
    `初始经验快照：${cell(report.memory?.binding?.initialSnapshotDigest)}；实验清单：${cell(report.memory?.binding?.manifestDigest)}。`, '',
    '## 各场景性能', '', '| 测试 | 场景 | 候选测量 | 基线测量 | 加速比 | 不可比较原因 |', '| --- | --- | --- | --- | --- | --- |',
    ...report.performance.flatMap(test => test.profiles.map(profile => `| ${cell(test.runId)} | ${cell(profile.profile)} | ${cell(profile.value)} ${cell(profile.unit)} | ${cell(profile.baselineValue)} | ${cell(profile.speedup)} | ${cell(profile.reasons.join(', '))} |`)), '',
    '此报告不授予发布资格。完整原始记录、逐轮决策、测量波动与缺失字段见 JSON 导出。', '',
  ].join('\n');
}
