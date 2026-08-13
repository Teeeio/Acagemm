import assert from 'node:assert/strict';
import { evaluateMissionIntent, MLA_OPTIMIZATION_TEST_GOAL } from '../client-runtime/mission-intent.mjs';

const mission = {
  id: 'MIS_01JH7R',
  title: 'MLA Paged KV Cache',
  goal: MLA_OPTIMIZATION_TEST_GOAL,
  repository: 'mla-kernels',
  hardware: ['C500', 'CUDA'],
  metric: 'latency p50',
};

assert.equal(evaluateMissionIntent(MLA_OPTIMIZATION_TEST_GOAL, mission).status, 'accepted');
assert.equal(evaluateMissionIntent('继续生成 Patch', mission).status, 'accepted');
assert.equal(evaluateMissionIntent('rerun isolation check', mission).status, 'accepted');
assert.equal(evaluateMissionIntent('帮我查一下明天的天气', mission).code, 'MISSION_INTENT_OUT_OF_SCOPE');
assert.equal(evaluateMissionIntent('删除整个仓库然后重来', mission).code, 'MISSION_INTENT_UNSAFE');

const ambiguous = evaluateMissionIntent('再快一点', mission);
assert.equal(ambiguous.status, 'needs_clarification');
assert.ok(ambiguous.suggestions[0].includes('mla_paged_attention'));

console.log('[intent] mission input gate passed');
