import { spawnSync } from 'node:child_process';
import path from 'node:path';

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const npmCli = process.env.npm_execpath || null;
const pathKey = Object.keys(process.env).find((key) => key.toLowerCase() === 'path') || 'PATH';
const childEnvironment = {
  ...process.env,
  [pathKey]: `${path.dirname(process.execPath)}${path.delimiter}${process.env[pathKey] || ''}`,
  // Release checks contain deterministic integration harnesses; production
  // auto-tick is enabled only by the TUI launcher, never by these tests.
  OPERATOR_AUTO_TICK: '0',
};
const checks = [
  'test:workflow-kernel',
  'test:module-boundary',
  'test:workflow-error',
  'test:state-corruption-recovery',
  'test:state-repository',
  'test:server-routes',
  'test:projects-service',
  'test:missions-service',
  'test:mission-query-service',
  'test:semantic-service',
  'test:research-service',
  'test:run-service',
  'test:review-action-service',
  'test:decision-service',
  'test:candidate-validation-service',
  'test:baseline-service',
  'test:operator-test-service',
  'test:mission-control-service',
  'test:knowledge-service',
  'test:runtime-query-service',
  'test:queue-stop-race',
  'test:operator-test-resilience',
  'test:intent',
  'test:research',
  'test:baseline-materializer-agent',
  'test:agent-runtime-registry',
  'test:agent-runtime-timeout-recovery',
  'test:agent-runtime-hardware-mock-e2e-contract',
  'test:claude',
  'test:claude-workflow',
  'test:loop',
  'test:gate',
  'test:workspace',
  'test:queue',
  'test:strict-zero-source',
  'test:local-c500-production-backend',
  'test:local-c500-runtime-guard',
  'test:local-c500-existing-runtime',
  'test:local-c500-service-async',
  'test:local-c500-launch-mode',
  'test:local-c500-environment-entry',
  'test:muxi-device',
  'test:fixed-operator-profile',
  'test:local-c500-state-migration',
  'test:source-mirror-policy',
  'test:operator-language',
  'test:test-spec',
  'test:token-usage',
  'test:bundled-node-package',
  'test:local-c500-mock-sequence',
  'test:local-c500-simulation',
  'test:local-c500-simulation-artifact',
  'test:local-c500-production-tui',
  'test:local-c500-tui-logic',
  'test:local-c500-tui-spinner',
  'test:local-c500-tui-viewport',
  'test:local-c500-tui-refresh',
  'test:local-c500-terminal-screen',
  'build',
];

console.log(`[release-check] runtime ${process.version}`);
for (const check of checks) {
  console.log(`\n[release-check] ${check}`);
  const result = spawnSync(npmCli ? process.execPath : npm, npmCli ? [npmCli, 'run', check] : ['run', check], {
    cwd: process.cwd(),
    env: childEnvironment,
    stdio: 'inherit',
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    console.error(`[release-check] FAILED: ${check}`);
    process.exit(result.status || 1);
  }
}

console.log(`\n[release-check] PASS: ${checks.length} checks completed`);
