import { readFile } from 'node:fs/promises';

const inputPath = process.argv[2];
if (!inputPath) {
  console.error('用法：node scripts/report-c500-iteration.mjs <export.json>');
  process.exit(2);
}

const document = JSON.parse(await readFile(inputPath, 'utf8'));
const state = document.state || document;
const mission = document.mission || state.missions?.find((item) => item.id === state.activeMissionId) || {};
const number = (value) => Number.isFinite(Number(value)) ? Number(value) : null;
const firstMeasurement = (benchmark) => {
  const measurements = benchmark?.result?.benchmark || benchmark?.benchmark || [];
  if (!Array.isArray(measurements) || !measurements.length) return null;
  const target = String(mission.hardware?.[0] || '').toLowerCase();
  return measurements.find((item) => String(item.environment || '').toLowerCase() === target) || measurements[0];
};
const candidateNumber = (item) => {
  const id = item?.candidateId || item?.benchmark?.candidate?.id || '';
  const match = String(id).match(/(\d+)$/);
  return match ? Number(match[1]) : null;
};
const rounds = [];
const addRound = (item) => {
  if (!item?.benchmark || item.benchmark.purpose !== 'candidate') return;
  const measurement = firstMeasurement(item.benchmark);
  if (!measurement || !Number.isFinite(number(measurement.value))) return;
  const key = item.runId || item.benchmark.runId || item.benchmark.testTaskId || item.candidateId;
  if (rounds.some((round) => round.key === key)) return;
  rounds.push({
    key,
    runId: item.runId || item.benchmark.runId || null,
    candidateId: item.candidateId || item.benchmark.candidate?.id || null,
    round: candidateNumber(item),
    value: number(measurement.value),
    unit: measurement.unit || 'us',
    environment: measurement.environment || null,
    correctness: measurement.correctness || null,
    startedAt: item.benchmark.startedAt || item.startedAt || null,
    completedAt: item.benchmark.completedAt || item.completedAt || null,
    durationMs: number(item.benchmark.durationMs),
  });
};
for (const item of state.runHistory || []) addRound(item);
if (state.benchmark?.status === 'complete') addRound({ runId: state.benchmark.runId, benchmark: state.benchmark, candidateId: state.benchmark.candidate?.id });
rounds.sort((a, b) => (a.round ?? 999) - (b.round ?? 999) || String(a.completedAt).localeCompare(String(b.completedAt)));

const baselineEvidence = state.baseline?.evidence || {};
const baselineValue = number(baselineEvidence.value);
const minimizes = !String(mission.metric || '').toLowerCase().includes('throughput');
const speedup = (value) => baselineValue && value ? (minimizes ? baselineValue / value : value / baselineValue) : null;
const improvement = (value) => baselineValue && value ? (minimizes ? (baselineValue - value) / baselineValue : (value - baselineValue) / baselineValue) * 100 : null;
const tokenUsage = state.tokenUsage || {};
const tokenRuns = tokenUsage.runs || {};
const tokenFor = (runId) => runId && tokenRuns[runId] ? number(tokenRuns[runId].totalTokens) || 0 : 0;
const eventTimes = (state.runtimeEvents || []).map((event) => Date.parse(event.timestamp)).filter(Number.isFinite);
const startEvent = (state.runtimeEvents || []).find((event) => event.type === 'mission.run_started' || event.type === 'mission.run_requested');
const endEvents = (state.runtimeEvents || []).filter((event) => ['knowledge.maintenance_completed', 'decision.auto_adopted', 'mission.stopped'].includes(event.type));
const startMs = Date.parse(startEvent?.timestamp || state.missionBudgetStartedAt || '') || Math.min(...eventTimes);
const endMs = Math.max(...endEvents.map((event) => Date.parse(event.timestamp)).filter(Number.isFinite), ...eventTimes);
const totalWallClockMs = Number.isFinite(startMs) && Number.isFinite(endMs) && endMs >= startMs ? endMs - startMs : null;
const report = {
  schemaVersion: 'operator-studio.c500-iteration-report/v1',
  missionId: state.activeMissionId || mission.id || null,
  title: mission.title || null,
  operatorProfile: mission.operatorProfile?.id || null,
  environment: baselineEvidence.environment || mission.hardware?.[0] || null,
  baseline: { value: baselineValue, unit: baselineEvidence.unit || null, runId: baselineEvidence.runId || null, liveHardware: baselineEvidence.liveHardware === true },
  rounds: rounds.map((round) => ({ ...round, speedup: speedup(round.value), improvementPercent: improvement(round.value), agentTokens: tokenFor(round.runId) })),
  tokenUsage: {
    totalTokens: number(tokenUsage.totalTokens) || 0,
    inputTokens: number(tokenUsage.inputTokens) || 0,
    outputTokens: number(tokenUsage.outputTokens) || 0,
    reasoningTokens: number(tokenUsage.reasoningTokens) || 0,
    cacheReadTokens: number(tokenUsage.cacheReadTokens) || 0,
    cacheWriteTokens: number(tokenUsage.cacheWriteTokens) || 0,
    coverage: tokenUsage.coverage || '0/0 runs exact',
    completeness: tokenUsage.completeness || 'unavailable',
  },
  timing: { startedAt: Number.isFinite(startMs) ? new Date(startMs).toISOString() : null, completedAt: Number.isFinite(endMs) ? new Date(endMs).toISOString() : null, totalWallClockMs },
};
console.log(JSON.stringify(report, null, 2));
if (rounds.length !== 3) {
  console.error(`警告：检测到 ${rounds.length} 个已完成候选轮次，期望 3 个。请确认 Mission 已完成三轮。`);
  process.exitCode = 1;
}
