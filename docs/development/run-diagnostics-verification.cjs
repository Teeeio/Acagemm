// Root's fixed, fail-fast verification entry. No shell or network installation.
const { spawnSync } = require('node:child_process');
const checks = [
  ['offline-dependencies', ['docs/development/run-diagnostics-offline-deps.cjs']],
  ['nonhardware-including-release', ['F:/Node/node_modules/npm/bin/npm-cli.js', 'run', 'verify:non-hardware-robustness']],
  ['cancellation-liveness', ['tests/agent-cancellation-liveness-test.mjs']],
  ['timeout-recovery', ['tests/agent-runtime-timeout-recovery-test.mjs']],
];
for (const [name, args] of checks) {
  console.log('[diagnostics-verification] START ' + name);
  const result = spawnSync(process.execPath, args, { stdio: 'inherit', windowsHide: true });
  console.log('[diagnostics-verification] END ' + name + ' ' + JSON.stringify({ status: result.status, signal: result.signal, error: result.error?.code || null }));
  if (result.error || result.status !== 0) process.exit(1);
}
