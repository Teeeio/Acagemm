import assert from 'node:assert/strict';
import { normalizeRunnerId, runnerMatches, normalizeRunnerList } from '../client-runtime/runner-aliases.mjs';

assert.equal(normalizeRunnerId('天数 Iluvatar'), 'gpu-iluvatar-mainstream');
assert.equal(normalizeRunnerId('Iluvatar MR-V100'), 'gpu-iluvatar-mainstream');
assert.equal(normalizeRunnerId('昇腾 Ascend runner'), 'npu-ascend-910');
assert.equal(normalizeRunnerId('gpu-iluvatar-mainstream'), 'gpu-iluvatar-mainstream');
assert.equal(normalizeRunnerId('gpu-muxi-c500'), 'gpu-muxi-c500');
assert.equal(runnerMatches('天数 Iluvatar', 'gpu-iluvatar-mainstream'), true);
assert.equal(runnerMatches('昇腾 Ascend runner', 'npu-ascend-910'), true);
assert.equal(runnerMatches('gpu-cuda', 'npu-ascend-910'), false);
assert.deepEqual(normalizeRunnerList(['天数 Iluvatar', '昇腾 Ascend runner']), ['gpu-iluvatar-mainstream', 'npu-ascend-910']);

console.log('[runner-aliases] normalization and matching passed');
