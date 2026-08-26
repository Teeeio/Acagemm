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
const appPort = await findAvailablePort(Number(inheritedEnv.PORT || 4173), new Set([testServicePort]));
const remoteMode = inheritedEnv.OPERATOR_TEST_MODE === 'remote';
const testServiceScript = remoteMode ? 'test-service/remote-adapter-server.mjs' : 'test-service/mock-server.mjs';
const env = {
  ...inheritedEnv,
  TEST_SERVICE_PORT: String(testServicePort),
  OPERATOR_TEST_SERVICE_URL: `http://127.0.0.1:${testServicePort}`,
  OPERATOR_RUNTIME_MODE: 'codex-cli',
  // 远程模式（mock 模式忽略）：真实 operator-iteration-platform 连接
  OPERATOR_API_BASE_URL: inheritedEnv.OPERATOR_API_BASE_URL || 'https://frp-cat.com:58637',
  OPERATOR_API_USERNAME: inheritedEnv.OPERATOR_API_USERNAME || 'demo_admin',
  OPERATOR_API_PASSWORD: inheritedEnv.OPERATOR_API_PASSWORD || 'demo123',
  OPERATOR_API_SYSTEM_ID: inheritedEnv.OPERATOR_API_SYSTEM_ID || 'system-demo',
  OPERATOR_TEST_TARGET_PLATFORMS: inheritedEnv.OPERATOR_TEST_TARGET_PLATFORMS || 'gpu-iluvatar-mainstream,npu-ascend-910',
  OPERATOR_TLS_ALLOW_SELF_SIGNED: inheritedEnv.OPERATOR_TLS_ALLOW_SELF_SIGNED || '1',
};

const launch = (script, extraEnv = {}) => {
  const child = spawn(process.execPath, [script], { cwd: root, env: { ...env, ...extraEnv }, stdio: 'inherit' });
  children.push(child);
  child.on('exit', (code) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.error(`[operator-studio] A required local service exited (${code ?? 'unknown'}). Stopping the incomplete stack.`);
    children.forEach((entry) => { if (entry !== child) entry.kill(); });
    process.exitCode = code || 1;
  });
  return child;
};

launch(testServiceScript);
launch('client-runtime/local-server.mjs', { API_PORT: String(appPort), SERVE_WEB: 'true' });

console.log(`[operator-studio] Open http://127.0.0.1:${appPort}`);
console.log(`[operator-studio] ${remoteMode ? `Remote test service (adapter → ${env.OPERATOR_API_BASE_URL})` : 'Mock test service'}: http://127.0.0.1:${testServicePort}`);
if (restrictedUserContext) console.warn('[operator-studio] Codex Runtime disabled: start Operator Studio from your normal Windows user terminal.');

let shuttingDown = false;
const shutdown = () => {
  shuttingDown = true;
  children.forEach((child) => child.kill());
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
