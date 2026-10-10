import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { probeAcceleratorRuntime } from '../client-runtime/accelerator-package-adapter.mjs';
import { findAcceleratorBackend } from '../client-runtime/accelerator-backends.mjs';
const args = process.argv.slice(2);
const backendId = args.find(value => !value.startsWith('--'));
const probeDevice = args.includes('--probe-device');
const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
try {
  if (!findAcceleratorBackend(backendId) || args.some(value => value !== backendId && value !== '--probe-device')) throw Object.assign(new Error('Usage: node scripts/preflight-accelerator.mjs local-metax-c500|local-ascend910b [--probe-device]'), { code: 'ACCELERATOR_ARGUMENT_INVALID' });
  const report = await probeAcceleratorRuntime({ backendId, rootDir, probeDevice });
  console.log(JSON.stringify(report,null,2));
  // Metadata is an inspection, never executable readiness.
  process.exitCode = probeDevice ? report.ready === true ? 0 : 1 : report.status === 'blocked' ? 1 : 0;
} catch (error) {
  console.log(JSON.stringify({ backendId, status:'blocked', ready:false, publishable:false, deviceProbed:false, code:error.code || 'ACCELERATOR_PREFLIGHT_FAILED', detail:error.message, details:error.details || null },null,2));
  process.exitCode=1;
}
