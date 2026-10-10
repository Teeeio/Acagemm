import { createMetaxC500PackageAdapter, probeMetaxC500Runtime } from './metax-c500/index.mjs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { canonicalJson } from './execution-package-contract.mjs';
import { createSharedGpuPackageAdapter } from './local-shared-gpu-package-adapter.mjs';
import { findAcceleratorBackend } from './accelerator-backends.mjs';
import { resolvePythonExecutable } from './platform-runtime.mjs';
const runDefault = promisify(execFile);
const fail = (code, message, details = {}) => Object.assign(new Error(message), { code, status: 503, retryable: false, details });
const digest = value => 'sha256:' + createHash('sha256').update(canonicalJson(value)).digest('hex');
const byteDigest = bytes => 'sha256:' + createHash('sha256').update(bytes).digest('hex');
const pins = (id, environment) => {
  const raw = environment[id === 'local-metax-c500' ? 'OPERATOR_METAX_C500_VERSIONS_JSON' : 'OPERATOR_ASCEND910B_VERSIONS_JSON'];
  let value; try { value = JSON.parse(raw || 'null'); } catch { throw fail('ACCELERATOR_VERSION_POLICY_INVALID', 'Target version pins must be a JSON object.'); }
  const required = id === 'local-metax-c500' ? ['python', 'torch', 'maca', 'driver'] : ['python', 'torch', 'torch_npu', 'cann', 'driver'];
  if (!value || typeof value !== 'object' || Array.isArray(value) || required.some(key => typeof value[key] !== 'string' || !value[key].trim())
    || Object.keys(value).some(key => ![...required, 'compiler', 'triton'].includes(key))) throw fail('ACCELERATOR_VERSION_POLICY_REQUIRED', 'Pin the actual target image versions before device qualification.', { backendId: id, required });
  return value;
};
export const probeAcceleratorRuntime = async ({ backendId, rootDir, python = resolvePythonExecutable({ rootDir }), probeDevice = false,
  environment = process.env, run = runDefault, timeoutMs = 30000 } = {}) => {
  const backend = findAcceleratorBackend(backendId);
  if (!backend) throw fail('ACCELERATOR_BACKEND_UNKNOWN', 'Unregistered accelerator backend.');
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > 30000) throw fail('ACCELERATOR_PROBE_LIMIT_INVALID', 'Probe timeout must be between 1 and 30000 ms.');
  const runner = path.join(rootDir, ...backend.runner.split('/'));
  let args;
  if (!probeDevice) {
    // -I metadata inspection never imports torch or initializes an accelerator.
    const script = "import json,platform,importlib.metadata as m,shutil\np={}\nfor n in ('torch','torch-npu','triton','ninja'):\n try: p[n]=m.version(n)\n except m.PackageNotFoundError: p[n]=None\nprint(json.dumps({'status':'metadata_only','platform':platform.system(),'machine':platform.machine(),'pythonVersion':platform.python_version(),'packages':p,'tools':{n:shutil.which(n) for n in ('mx-smi','npu-smi','c++','bisheng')},'deviceProbed':False,'liveHardware':False,'publishable':False}))";
    args = ['-I', '-B', '-c', script];
  } else {
    if (environment.OPERATOR_HARDWARE_DISABLED === '1') throw fail('ACCELERATOR_HARDWARE_DISABLED', 'Hardware is disabled; no device probe is started.');
    if (environment.OPERATOR_ALLOW_SHARED_ACCELERATOR !== '1') throw fail('EXECUTION_ISOLATION_UNAVAILABLE', 'The target requires explicit shared development execution policy or a registered host boundary.');
    const policy = pins(backendId, environment);
    args = backendId === 'local-metax-c500' ? ['-I', '-B', runner, '--stage', 'probe', '--versions-json', JSON.stringify(policy)]
      : ['-I', '-B', runner, '--preflight', '--probe-device'];
    if (backendId === 'local-metax-c500' && environment.OPERATOR_METAX_C500_COMPILER) args.push('--compiler', environment.OPERATOR_METAX_C500_COMPILER);
  }
  let result;
  try { result = await run(python, args, { cwd: rootDir, env: environment, windowsHide: true, encoding: 'utf8', timeout: timeoutMs, maxBuffer: 1024 * 1024 }); }
  catch (error) { throw fail('ACCELERATOR_PROBE_FAILED', 'Target probe failed; no replacement device or cached environment is admitted.', { backendId, code: error.code || null, stderr: String(error.stderr || '').slice(0,2000) }); }
  let report; try { report = JSON.parse(String(result.stdout || '').trim()); } catch { throw fail('ACCELERATOR_PROBE_INVALID', 'Target probe returned invalid JSON.'); }
  if (!probeDevice) {
    const required = backendId === 'local-metax-c500' ? ['torch'] : ['torch', 'torch-npu'];
    const missingDependencies = required.filter(name => !report.packages?.[name]);
    return { ...report, backendId, status: report.platform !== 'Linux' || missingDependencies.length ? 'blocked' : 'metadata_only', missingDependencies, ready: false, deviceProbed: false, liveHardware: false, publishable: false };
  }
  const observed = backendId === 'local-metax-c500' ? report.observed : report.targetProbe;
  const valid = backendId === 'local-metax-c500' ? report.status === 'ready' && observed?.vendor === 'metax' && /\bC500\b/i.test(observed.deviceName || '')
    && observed.timer?.validated === true : report.status === 'device_probed' && report.deviceProbed === true && report.liveHardware === true && /Ascend\s*910B/i.test(observed?.deviceName || '');
  if (!valid) throw fail('ACCELERATOR_DEVICE_UNQUALIFIED', 'The exact target device/API was not observed.', { backendId, report });
  const policy = pins(backendId, environment);
  const versions = backendId === 'local-metax-c500' ? observed.versions : { python: report.pythonVersion, torch: observed.torchVersion,
    torch_npu: observed.torchNpuVersion, cann: observed.versions?.cann, driver: observed.driverVersion, compiler: observed.versions?.compiler ?? null };
  for (const [key, expected] of Object.entries(policy)) if (versions?.[key] !== expected) throw fail('ACCELERATOR_VERSION_MISMATCH', 'Observed target version differs from its configured pin.', { backendId, key, expected, actual: versions?.[key] ?? null });
  const capabilities = { backendId, target: backend.target, observed, versions, python, runnerDigest: byteDigest(await readFile(runner)),
    engineDigest: byteDigest(await readFile(path.join(rootDir, 'tools', 'local-c500-runner.py'))), publishable: false,
    isolation: { kind: 'shared-host-accelerator', enforced: false }, policy: { allowSharedHostAccelerator: true, packageBoundary: 'adapter-enforced', publishable: false } };
  if (backendId === 'local-metax-c500') {
    const qualified = await probeMetaxC500Runtime({ python, versionPolicy: policy, run: async () => result });
    return { backendId, status: 'device_qualified', ready: true, deviceProbed: true, liveHardware: true, publishable: false, ...qualified };
  }
  return { backendId, status: 'device_qualified', ready: true, deviceProbed: true, liveHardware: true, publishable: false, capabilities,
    environment: { id: backend.id, digest: digest(capabilities), target: backend.target, isolation: capabilities.isolation, policy: capabilities.policy } };
};
export const createAcceleratorEnvironmentResolver = ({ backendId, probeOptions = {}, probe = probeAcceleratorRuntime, cacheTtlMs = 30000 } = {}) => {
  if (!findAcceleratorBackend(backendId)) throw new TypeError('Registered accelerator backend required.');
  let cached = null, cachedAt = 0, pending = null;
  return Object.freeze({
    async resolve(environmentId, { refresh = false } = {}) {
      if (environmentId !== findAcceleratorBackend(backendId).packagePort.environmentId) throw fail('PACKAGE_ENVIRONMENT_UNKNOWN', 'This resolver never substitutes another target.', { environmentId, backendId });
      if (refresh) { cached = null; cachedAt = 0; }
      if (!pending && cached && Date.now() - cachedAt < cacheTtlMs) return structuredClone(cached);
      pending ||= Promise.resolve().then(() => probe({ ...probeOptions, backendId, probeDevice: true }));
      let result; try { result = await pending; } finally { pending = null; }
      if (result?.ready !== true || result.deviceProbed !== true || result.publishable !== false || result.environment?.id !== findAcceleratorBackend(backendId).packagePort.environmentId
        || canonicalJson(result.environment.target) !== canonicalJson(findAcceleratorBackend(backendId).target)
        || (backendId !== 'local-metax-c500' && (result.environment.policy?.allowSharedHostAccelerator !== true || result.environment.policy?.publishable !== false)))
        throw fail('PACKAGE_ENVIRONMENT_UNVERIFIED', 'Only a fresh exact-device qualification may prepare development packages.');
      cached = structuredClone(result.environment); cachedAt = Date.now(); return structuredClone(cached);
    },
    clear() { cached = null; cachedAt = 0; },
  });
};
// Reuse immutable staging, AST/local-import validation, content digests and
// released preparation receipts. C500 additionally requires supervised build/load.
export const createAcceleratorPackageAdapter = ({ backendId, rootDir, execFileImpl, prepareLoad } = {}) => {
  const backend = findAcceleratorBackend(backendId);
  if (!backend) throw new TypeError('Registered accelerator backend required.');
  if (backendId === 'local-metax-c500') return createMetaxC500PackageAdapter({ rootDir, execFileImpl, prepareLoad });
  const shared = createSharedGpuPackageAdapter({ rootDir, ...(execFileImpl ? { execFileImpl } : {}) });
  return Object.freeze({ ...shared, ...backend.adapter });
};
