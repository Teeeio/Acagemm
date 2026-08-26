'use strict';

const fs = require('fs');
const path = require('path');
const childProcess = require('child_process');

const projectRoot = path.resolve(__dirname, '..', '..');
const tuiPath = path.join(__dirname, 'tui.mjs');
const nodeVersion = '24.19.0';
const installBase = process.env.OPERATOR_BUNDLED_NODE_HOME
  ? path.resolve(process.env.OPERATOR_BUNDLED_NODE_HOME)
  : path.join(projectRoot, '.local-c500-node');
const bundledNode = path.join(installBase, 'node-v' + nodeVersion + '-linux-x64', 'bin', 'node');
const installer = path.join(projectRoot, 'scripts', 'install-bundled-node.sh');
const tuiArgs = [tuiPath].concat(process.argv.slice(2));

function exitFrom(result, label) {
  if (result.error) {
    console.error(label + ': ' + result.error.message);
    process.exit(1);
  }
  process.exit(typeof result.status === 'number' ? result.status : 1);
}

function runNode(executable, environment) {
  const result = childProcess.spawnSync(executable, tuiArgs, {
    cwd: projectRoot,
    env: environment || process.env,
    stdio: 'inherit',
  });
  exitFrom(result, 'Unable to start the C500 tester');
}

const currentMajor = Number(String(process.versions.node || '0').split('.')[0]);
if (currentMajor >= 20) runNode(process.execPath);

if (process.platform !== 'linux' || process.arch !== 'x64') {
  console.error('The C500 tester requires Node.js 20+; current runtime is ' + process.version + '.');
  console.error('Automatic bundled Node fallback is available only on Linux x86_64.');
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
runNode(bundledNode, bundledEnvironment);
