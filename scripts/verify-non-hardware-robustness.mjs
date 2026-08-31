import { spawnSync } from 'node:child_process';
import path from 'node:path';

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const npmCli = process.env.npm_execpath || null;
const pathKey = Object.keys(process.env).find((key) => key.toLowerCase() === 'path') || 'PATH';
const childEnvironment = {
  ...process.env,
  [pathKey]: `${path.dirname(process.execPath)}${path.delimiter}${process.env[pathKey] || ''}`,
  OPERATOR_HARDWARE_DISABLED: '1',
};

for (const key of [
  'OPERATOR_LOCAL_C500_COMMAND',
  'OPERATOR_LOCAL_C500_MCTRACER_COMMAND',
  'OPERATOR_LOCAL_C500_MCPROFILER_COMMAND',
  'OPERATOR_LOCAL_C500_MOCK_SCENARIO',
  'OPERATOR_LOCAL_C500_SIMULATION',
  'OPERATOR_SIMULATION',
  'OPERATOR_MUXI_DEVICE',
  'OPERATOR_RUNTIME_MODE',
  'OPERATOR_TEST_BACKEND',
  'CLAUDE_COMMAND',
  'CODEX_COMMAND',
  'OPENCODE_BASE_URL',
]) delete childEnvironment[key];

const checks = [
  'verify:local-c500-release',
  'test:local-c500-no-hardware-guard',
  'test:semantic-snapshot',
  'test:semantic-snapshot-extreme',
  'test:accept-gate-semantic-extreme',
  'test:semantic-tui',
  'test:semantic-tui-extreme',
  'test:module-extreme-contract',
  'test:legacy-run-stop-recovery',
  'test:runtime',
  'test:agent-boundary',
  'test:baseline-materializer',
  'test:baseline-resolver',
  'test:codex',
  'test:opencode',
  'test:boundary',
  'test:three-layer',
  'test:journal',
  'test:mission-budget',
  'test:mission-panel',
  'test:native-directory-picker',
  'test:runner-aliases',
  'test:state-store-projection',
  'test:workflow-summary',
  'test:release',
  'test:smoke',
  'test:local-c500-e2e',
];

console.log(`[non-hardware-check] runtime ${process.version}; physical hardware execution is disabled`);
for (const check of checks) {
  console.log(`\n[non-hardware-check] ${check}`);
  const result = spawnSync(npmCli ? process.execPath : npm, npmCli ? [npmCli, 'run', check] : ['run', check], {
    cwd: process.cwd(),
    env: childEnvironment,
    stdio: 'inherit',
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    console.error(`[non-hardware-check] FAILED: ${check}`);
    process.exit(result.status || 1);
  }
}

console.log('\n[non-hardware-check] PASS: 76 checks completed without physical hardware');
