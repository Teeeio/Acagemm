import { spawnSync } from 'node:child_process';

// Linux-only acceptance entry point. On Windows/macOS the portable contract
// tests still run in the normal release gate, while this command remains a
// no-op so shared development machines do not claim Linux hardware evidence.
if (process.platform !== 'linux') {
  console.log(`[linux-compatibility] skipped on ${process.platform}; run this command on Linux x86_64 for POSIX process-group evidence.`);
  process.exit(0);
}

const npm = process.env.npm_execpath ? process.execPath : 'npm';
const npmArgs = (name) => process.env.npm_execpath
  ? [process.env.npm_execpath, 'run', name]
  : ['run', name];
const checks = ['test:platform-runtime', 'test:execution-package-import', 'test:local-c500-recovery'];
for (const check of checks) {
  console.log(`[linux-compatibility] ${check}`);
  const result = spawnSync(npm, npmArgs(check), { cwd: process.cwd(), env: process.env, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status || 1);
}
console.log('[linux-compatibility] PASS: Linux path resolution, ZIP/tar import and POSIX process-group recovery checks completed');
