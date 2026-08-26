import assert from 'node:assert/strict';
import { renderWorkflowSummary } from '../tools/local-c500-tester/workflow-summary.mjs';

const tasks = [100, 92, 84, 75].map((value, index) => ({
  status: 'completed',
  payload: {
    purpose: index === 0 ? 'baseline' : 'candidate',
    candidate: { id: index === 0 ? 'baseline' : `candidate-0${index}`, digest: `sha256:${index}` },
  },
  result: { benchmark: [{ value }] },
}));

const state = {
  stage: 'published',
  activeMissionId: 'MIS_SUMMARY',
  missions: [{ id: 'MIS_SUMMARY', title: 'FlashInfer MLA Paged Attention' }],
  currentBest: { candidateId: 'candidate-03', value: '75 us' },
  runtimeEvents: [{ type: 'decision.auto_adopted', payload: { candidate: 'candidate-03', gate: { passed: true, publishable: false } } }],
  researchAgent: {},
  baseline: {},
  iterationStats: { loopStatus: 'completed' },
};

const report = renderWorkflowSummary({ state, tasks, initialization: { codeFiles: 0, sourceEntries: 0 } });
assert.match(report, /Result: PASS \(simulation only\)/);
assert.match(report, /\| 完成 \|/);
console.log('[workflow-summary] published Gate archive renders PASS');
