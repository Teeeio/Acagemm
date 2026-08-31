import assert from 'node:assert/strict';
import { detectMuxiDevice, parseMuxiDevice } from '../client-runtime/muxi-device.mjs';
import { assertProductionPreflight } from '../tools/local-c500-tester/production-api.mjs';

assert.equal(parseMuxiDevice('MetaX C550'), 'C550');
assert.equal(parseMuxiDevice('device: C500'), 'C500');
assert.equal(parseMuxiDevice('unknown accelerator'), null);

const probe = (command) => command === 'python'
  ? { status: 0, stdout: 'MetaX C550\n', stderr: '' }
  : { status: 0, stdout: 'C500', stderr: '' };
assert.deepEqual(detectMuxiDevice({}, probe), { device: 'C550', source: 'torch.cuda', detail: 'MetaX C550' });
assert.equal(detectMuxiDevice({ OPERATOR_MUXI_DEVICE: 'C500' }, probe).device, 'C500');
assert.deepEqual(detectMuxiDevice({}, () => ({ status: 1, stdout: '', stderr: '' })), { device: 'C550', source: 'release-default' });

const validDoctor = {
  runtime: { runtime: { mode: 'claude-code', connected: true }, testBackend: { mock: false, liveHardware: true } },
  checks: { python: { status: 'ok' }, mxSmi: { status: 'ok' }, device: { status: 'ok', detail: 'C550 / torch.cuda' }, stack: { status: 'ok' }, cudaSmoke: { status: 'ok' } },
};
assert.equal(assertProductionPreflight(validDoctor), validDoctor);
assert.throws(() => assertProductionPreflight({ ...validDoctor, checks: { ...validDoctor.checks, device: { status: 'assumed', detail: 'C550 / release-default' } } }), /实际探测到目标 C550/);
assert.throws(() => assertProductionPreflight({ ...validDoctor, checks: { ...validDoctor.checks, device: { status: 'ok', detail: 'C500 / torch.cuda' } } }), /实际探测到目标 C550/);

for (const mode of ['claude-code', 'codex-cli']) {
  const hardwareMockDoctor = {
    executionMode: 'hardware-mock',
    runtime: { runtime: { mode, connected: true }, testBackend: { mock: true, liveHardware: false } },
    checks: {},
  };
  assert.equal(assertProductionPreflight(hardwareMockDoctor), hardwareMockDoctor);
}
assert.throws(() => assertProductionPreflight({
  executionMode: 'hardware-mock',
  runtime: { runtime: { mode: 'opencode-server', connected: true }, testBackend: { mock: true, liveHardware: false } },
  checks: {},
}), /缺少能力.*research/);
assert.throws(() => assertProductionPreflight({
  executionMode: 'hardware-mock',
  runtime: { runtime: { mode: 'claude-code', connected: true }, testBackend: { mock: false, liveHardware: true } },
  checks: {},
}), /hardware-mock/);

console.log('[muxi-device] C550 detection and production preflight passed');
