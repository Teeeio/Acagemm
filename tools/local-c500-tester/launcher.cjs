'use strict';

const fs = require('fs');
const path = require('path');
const childProcess = require('child_process');
const crypto = require('crypto');

const projectRoot = path.resolve(__dirname, '..', '..');
const tuiPath = path.join(__dirname, 'tui.mjs');
const nodeVersion = '24.19.0';
const installBase = path.join(projectRoot, '.local-c500-node');
const bundledNode = path.join(installBase, 'node-v' + nodeVersion + '-linux-x64', 'bin', 'node');
const installer = path.join(projectRoot, 'scripts', 'install-bundled-node.sh');
const npmCliRelative = path.join('lib', 'node_modules', 'npm', 'bin', 'npm-cli.js');
const dependencyArchive = path.join(projectRoot, 'vendor', 'node', 'node-modules-linux-x64.tar.gz');
const dependencyArchiveSha256 = '04ebed39d8752ffb614e0659360037f0455a1704bfe208d4617d99709a380e3d';
const tuiArgs = [tuiPath].concat(process.argv.slice(2));

function exitFrom(result, label) {
  if (result.error) {
    console.error(label + ': ' + result.error.message);
    process.exit(1);
  }
  process.exit(typeof result.status === 'number' ? result.status : 1);
}

function runNode(executable, environment) {
  const launchEnvironment = Object.assign({}, environment || process.env, {
    LOCAL_C500_TESTER_HOME: path.join(projectRoot, '.local-c500-production'),
    LOCAL_C500_API_PORT: '4275',
    OPERATOR_RUNTIME_MODE: 'claude-code',
    CLAUDE_COMMAND: 'claude',
    OPERATOR_TEST_BACKEND: 'local-c500',
    OPERATOR_AUTO_TICK: '1',
    OPERATOR_LOCAL_C500_MOCK: '0',
  });
  delete launchEnvironment.LOCAL_C500_API_URL;
  delete launchEnvironment.OPERATOR_LOCAL_C500_COMMAND;
  delete launchEnvironment.OPERATOR_LOCAL_C500_MOCK_SCENARIO;
  delete launchEnvironment.OPERATOR_MUXI_DEVICE;
  const result = childProcess.spawnSync(executable, tuiArgs, {
    cwd: projectRoot,
    env: launchEnvironment,
    stdio: 'inherit',
  });
  exitFrom(result, 'Unable to start the C500 tester');
}

function dependenciesReady() {
  const ink = path.join(projectRoot, 'node_modules', 'ink', 'package.json');
  if (!fs.existsSync(ink)) return false;
  if (process.platform === 'linux') return fs.existsSync(path.join(projectRoot, 'node_modules', '@esbuild', 'linux-x64', 'bin', 'esbuild'));
  return true;
}

function installDependencies(nodeExecutable, environment) {
  if (dependenciesReady()) return;
  if (process.platform === 'linux' && fs.existsSync(dependencyArchive)) {
    const archiveHash = crypto.createHash('sha256').update(fs.readFileSync(dependencyArchive)).digest('hex');
    if (archiveHash !== dependencyArchiveSha256) {
      console.error('Bundled dependency archive checksum mismatch: ' + archiveHash);
      process.exit(1);
    }
    const modules = path.join(projectRoot, 'node_modules');
    if (fs.existsSync(modules)) fs.renameSync(modules, path.join(projectRoot, '.local-c500-stale-node-modules-' + Date.now()));
    console.error('[c500-launcher] extracting bundled Linux dependencies');
    const extracted = childProcess.spawnSync('tar', ['-xzf', dependencyArchive, '-C', projectRoot], { cwd: projectRoot, env: environment, stdio: 'inherit' });
    if (extracted.error || extracted.status !== 0) exitFrom(extracted, 'Bundled dependency extraction failed');
    const binDir = path.join(projectRoot, 'node_modules', '.bin');
    fs.mkdirSync(binDir, { recursive: true });
    const vite = path.join(binDir, 'vite');
    fs.writeFileSync(vite, '#!/usr/bin/env sh\nexec node "$(dirname "$0")/../vite/bin/vite.js" "$@"\n', 'utf8');
    fs.chmodSync(vite, 0o755);
    const esbuild = path.join(projectRoot, 'node_modules', '@esbuild', 'linux-x64', 'bin', 'esbuild');
    if (fs.existsSync(esbuild)) fs.chmodSync(esbuild, 0o755);
    if (!dependenciesReady()) {
      console.error('Bundled Linux dependencies are incomplete.');
      process.exit(1);
    }
    return;
  }
  const npmCli = path.join(path.dirname(path.dirname(nodeExecutable)), npmCliRelative);
  const args = [npmCli, 'ci'];
  console.error('[c500-launcher] installing locked dependencies');
  const installed = childProcess.spawnSync(nodeExecutable, args, {
    cwd: projectRoot,
    env: environment,
    stdio: 'inherit',
  });
  if (installed.error || installed.status !== 0) exitFrom(installed, 'Locked dependency installation failed');
  if (!dependenciesReady()) {
    console.error('Locked dependencies are incomplete after npm ci.');
    process.exit(1);
  }
}

const currentMajor = Number(String(process.versions.node || '0').split('.')[0]);
if (process.platform !== 'linux') {
  if (currentMajor >= 20) {
    installDependencies(process.execPath, process.env);
    runNode(process.execPath);
  }
  console.error('The C500 tester requires Node.js 20+; current runtime is ' + process.version + '.');
  console.error('Automatic bundled Node fallback is available only on Linux x86_64.');
  process.exit(1);
}

if (process.arch !== 'x64') {
  console.error('The bundled C500 tester supports Linux x86_64 only; current architecture is ' + process.arch + '.');
  process.exit(1);
}

if (!fs.existsSync(bundledNode)) {
  const installed = childProcess.spawnSync('bash', [installer], {
    cwd: projectRoot,
    env: process.env,
    stdio: 'inherit',
  });
  if (installed.error || installed.status !== 0) exitFrom(installed, 'Bundled Node installation failed');
}

if (!fs.existsSync(bundledNode)) {
  console.error('Bundled Node executable is missing after installation: ' + bundledNode);
  process.exit(1);
}

const bundledEnvironment = Object.assign({}, process.env, {
  PATH: path.dirname(bundledNode) + path.delimiter + (process.env.PATH || ''),
});
console.error('[c500-launcher] system ' + process.version + ' -> bundled Node v' + nodeVersion);
installDependencies(bundledNode, bundledEnvironment);
runNode(bundledNode, bundledEnvironment);
