import { spawn } from 'node:child_process';
import net from 'node:net';

const root = new URL('../', import.meta.url);
const children = [];
const inheritedEnv = { ...process.env };
const restrictedUserContext = /CodexSandboxOffline/i.test(`${inheritedEnv.USERNAME || ''} ${inheritedEnv.USERPROFILE || ''}`);

const isPortAvailable = (port) => new Promise((resolve) => {
  const probe = net.createServer();
  probe.once('error', () => resolve(false));
  probe.listen(port, '127.0.0.1', () => probe.close(() => resolve(true)));
});

const findAvailablePort = async (preferred, reserved = new Set()) => {
  for (let port = preferred; port < preferred + 20; port += 1) {
    if (!reserved.has(port) && await isPortAvailable(port)) return port;
  }
  throw new Error(`No available local port found in ${preferred}-${preferred + 19}.`);
};

const testServicePort = await findAvailablePort(Number(inheritedEnv.TEST_SERVICE_PORT || 4180));
const apiPort = await findAvailablePort(4174, new Set([testServicePort]));
const webPort = await findAvailablePort(Number(inheritedEnv.WEB_PORT || 5173), new Set([testServicePort, apiPort]));
const env = {
  ...inheritedEnv,
  TEST_SERVICE_PORT: String(testServicePort),
  OPERATOR_TEST_SERVICE_URL: `http://127.0.0.1:${testServicePort}`,
  OPERATOR_RUNTIME_MODE: 'codex-cli',
};

const launch = (command, args, extraEnv = {}) => {
  const child = spawn(command, args, { cwd: root, env: { ...env, ...extraEnv }, stdio: 'inherit' });
  children.push(child);
  child.on('exit', (code) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.error(`[operator-studio] A required local service exited (${code ?? 'unknown'}). Stopping the incomplete stack.`);
    children.forEach((entry) => { if (entry !== child) entry.kill(); });
    process.exitCode = code || 1;
  });
};

launch(process.execPath, ['test-service/mock-server.mjs']);
launch(process.execPath, ['client-runtime/local-server.mjs'], { API_PORT: String(apiPort), SERVE_WEB: 'false' });
launch(process.execPath, ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', String(webPort), '--strictPort'], {
  OPERATOR_API_PROXY_TARGET: `http://127.0.0.1:${apiPort}`,
});

console.log(`[operator-studio] Open http://127.0.0.1:${webPort}`);
console.log(`[operator-studio] Runtime API: http://127.0.0.1:${apiPort}`);
console.log(`[operator-studio] Mock test service: http://127.0.0.1:${testServicePort}`);
if (restrictedUserContext) console.warn('[operator-studio] Codex Runtime disabled: start Operator Studio from your normal Windows user terminal.');

let shuttingDown = false;
const shutdown = () => {
  shuttingDown = true;
  children.forEach((child) => child.kill());
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
