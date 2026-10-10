import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { canonicalJson } from '../execution-package-contract.mjs';
import { resolvePythonExecutable } from '../platform-runtime.mjs';

export const METAX_C500_ENVIRONMENT_ID = 'metax-c500';
export const METAX_C500_TARGET = Object.freeze({ platform: 'metax-maca', device: 'gpu' });
export const METAX_C500_RUNNER = fileURLToPath(new URL('../../tools/metax-c500/runner.py', import.meta.url));
export const METAX_C500_PACKAGE_ADAPTER = Object.freeze({ id: 'python-metax-c500', version: '1', languages: ['python'] });
export const METAX_C500_PACKAGE_PORT = Object.freeze({
  adapterId: METAX_C500_PACKAGE_ADAPTER.id, language: 'python',
  environmentId: METAX_C500_ENVIRONMENT_ID, candidateEntrypoint: 'run.py',
  acceptanceEntrypoint: 'oracle.py', checks: Object.freeze(['correctness', 'benchmark']),
});
const hash = (value) => 'sha256:' + createHash('sha256').update(canonicalJson(value)).digest('hex');
const fail = (code, message, details = {}) => Object.assign(new Error(message), { code, status: 422, retryable: false, details });
const exec = promisify(execFile);
const defaultRun = (command, args, options) => exec(command, args, { windowsHide: true, maxBuffer: 1024 * 1024, ...options });

// Pins come from the actual vendor image, never from a C550 whitelist or MUSA.
export const assertMetaxC500VersionPolicy = (policy) => {
  if (!policy || typeof policy !== 'object' || Array.isArray(policy)) throw fail('METAX_C500_VERSION_POLICY_REQUIRED', 'Pin actual C500 vendor-image versions before probing.');
  for (const key of ['python', 'torch', 'maca', 'driver']) {
    if (typeof policy[key] !== 'string' || !policy[key].trim()) throw fail('METAX_C500_VERSION_POLICY_REQUIRED', 'C500 policy requires python, torch, maca and driver.', { missing: key });
  }
  for (const [key, value] of Object.entries(policy)) {
    if (!['python', 'torch', 'maca', 'driver', 'triton', 'compiler'].includes(key) || typeof value !== 'string' || !value.trim()) throw fail('METAX_C500_VERSION_POLICY_INVALID', 'Unknown or empty pinned version.', { key });
  }
  return structuredClone(policy);
};

export const probeMetaxC500Runtime = async ({ run = defaultRun, python = resolvePythonExecutable(),
  versionPolicy, timeoutMs = 30000, signal, mxSmi, compiler } = {}) => {
  const policy = assertMetaxC500VersionPolicy(versionPolicy);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30000) throw fail('METAX_C500_PROBE_TIMEOUT_INVALID', 'Probe timeout must be 1..30000 ms.');
  const args = [METAX_C500_RUNNER, '--stage', 'probe', '--versions-json', JSON.stringify(policy)];
  if (mxSmi) args.push('--mx-smi', mxSmi);
  if (compiler) args.push('--compiler', compiler);
  let output;
  try { output = await run(python, args, { timeout: timeoutMs, signal }); }
  catch (error) {
    let record;
    try { record = JSON.parse(String(error.stdout || '').trim()); } catch { /* retain transport failure */ }
    if (record?.error?.code) throw fail(record.error.code, record.error.message, record.error.details || {});
    throw fail('METAX_C500_PROBE_FAILED', 'C500 probe returned no successful receipt.', { cause: error.code || null, message: error.message });
  }
  let probe;
  try { probe = JSON.parse(String(output.stdout || '').trim()); }
  catch { throw fail('METAX_C500_PROBE_INVALID', 'C500 probe must return one JSON receipt.'); }
  if (probe?.status !== 'ready') throw fail(probe?.error?.code || 'METAX_C500_PROBE_INVALID', probe?.error?.message || 'C500 probe failed.', probe?.error?.details || {});
  const observed = probe.observed;
  if (observed?.vendor !== 'metax' || !/\bC500\b/i.test(observed.deviceName || '')
    || observed.timer?.kind !== 'maca-torch-event' || observed.timer?.validated !== true) throw fail('METAX_C500_PROBE_INVALID', 'Actual MetaX C500 and validated device Event timer required.');
  for (const [key, expected] of Object.entries(policy)) if (observed.versions?.[key] !== expected) throw fail('METAX_C500_VERSION_MISMATCH', 'Observed runtime differs from the pin.', { key, expected, actual: observed.versions?.[key] ?? null });
  const { rawMxSmi, ...identity } = observed;
  const isolation = { kind: 'shared-host-gpu', enforced: false };
  const boundaryPolicy = { allowSharedHostGpu: true, packageBoundary: 'adapter-enforced' };
  const environment = { id: METAX_C500_ENVIRONMENT_ID, target: METAX_C500_TARGET,
    digest: hash({ observed: identity, versionPolicy: policy, target: METAX_C500_TARGET, isolation, policy: boundaryPolicy }),
    isolation, policy: boundaryPolicy, observed: identity, versionPolicy: policy };
  return { environment, capabilities: { ...observed, target: METAX_C500_TARGET, publishable: false } };
};

export const createMetaxC500EnvironmentResolver = ({ probe = probeMetaxC500Runtime, probeOptions = {}, cacheTtlMs = 30000 } = {}) => {
  let cached = null, cachedAt = 0, inFlight = null;
  return Object.freeze({
    async resolve(id, { refresh = false, signal, deadline } = {}) {
      if (id !== METAX_C500_ENVIRONMENT_ID) throw fail('PACKAGE_ENVIRONMENT_UNKNOWN', 'This resolver only probes metax-c500.', { id });
      if (refresh) { cached = null; cachedAt = 0; }
      if (!inFlight && cached && Date.now() - cachedAt < cacheTtlMs) return structuredClone(cached);
      const remaining = deadline ? Date.parse(deadline) - Date.now() : 30000;
      if (!Number.isFinite(remaining) || remaining <= 0 || signal?.aborted) throw fail('METAX_C500_PROBE_TIMEOUT', 'C500 inspection deadline expired.');
      inFlight ||= Promise.resolve().then(() => probe({ ...probeOptions, signal, timeoutMs: Math.max(1, Math.min(30000, probeOptions.timeoutMs || 30000, remaining)) }));
      let result;
      try { result = await inFlight; } finally { inFlight = null; }
      if (result?.environment?.id !== id || canonicalJson(result.environment.target) !== canonicalJson(METAX_C500_TARGET)
        || result.environment.observed?.vendor !== 'metax' || !/\bC500\b/i.test(result.environment.observed.deviceName || '')) throw fail('PACKAGE_ENVIRONMENT_INVALID', 'Resolver received another target.');
      cached = structuredClone(result.environment); cachedAt = Date.now();
      return structuredClone(cached);
    },
    clear() { cached = null; cachedAt = 0; },
  });
};
