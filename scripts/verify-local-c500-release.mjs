import { spawnSync } from 'node:child_process';

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const checks = [
  'test:workflow-kernel',
  'test:operator-test-resilience',
  'test:intent',
  'test:research',
  'test:loop',
  'test:gate',
  'test:workspace',
  'test:queue',
  'test:strict-zero-source',
  'test:local-c500-production-backend',
  'test:local-c500-launch-mode',
  'test:source-mirror-policy',
  'test:local-c500-mock-sequence',
  'test:local-c500-diff',
  'test:local-c500-workflow',
  'test:local-c500-discovery',
  'test:local-c500-agent',
  'test:local-c500-generation',
  'test:local-c500-gate',
  'test:local-c500-adoption',
  'test:local-c500-production-tui',
  'test:local-c500-tui-logic',
  'test:local-c500-tui-spinner',
  'test:local-c500-tui-viewport',
  'test:local-c500-terminal-screen',
  'build',
];

for (const check of checks) {
  console.log(`\n[release-check] ${check}`);
  const result = spawnSync(npm, ['run', check], {
    cwd: process.cwd(),
    env: process.env,
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
