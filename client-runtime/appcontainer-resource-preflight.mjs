import { createHash } from 'node:crypto';
import { readFile, realpath } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

export const RESOURCE_RECEIPT_SCHEMA = 'operator-studio.appcontainer-resources/v1';
const blocked = (code, message, resources = []) => ({ ready: false, blocked: true, code, message,
  resources, evidenceKind: 'admission-observation', publishable: false });
const within = (root, value) => {
  const relative = path.relative(root, value);
  return !relative || (relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative));
};
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const equal = (a, b) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));

// Pure admission projection. It never produces hardware/Queue/Gate verdicts.
export const evaluateResourceReadiness = (receipt, plan, observation, { filePath, now = Date.now() } = {}) => {
  if (receipt?.schemaVersion !== RESOURCE_RECEIPT_SCHEMA || !Array.isArray(receipt.resources) || !receipt.resources.length
    || receipt.resources.length > 64 || new Set(receipt.resources.map(r => r.resourceId)).size !== receipt.resources.length) {
    return blocked('APPCONTAINER_RESOURCE_NOT_REGISTERED', 'Resources have no valid operator-owned registration receipt.');
  }
  if (receipt.state === 'cleanup-required' || receipt.process?.terminated !== true
    || receipt.process.waitResult !== 0 || receipt.process.exitCode !== 0
    || !Number.isInteger(receipt.process.pid) || receipt.process.pid <= 0 || !receipt.process.processCreatedAt) {
    return blocked('APPCONTAINER_RESOURCE_CLEANUP_REQUIRED', 'Resource provisioning or cleanup has no confirmed terminal outcome.');
  }
  if (receipt.state !== 'ready' || receipt.leaseId !== plan.resourceLeaseId || receipt.approvalRef !== plan.approvalRef
    || receipt.profileName !== plan.profileName || receipt.packageSid !== plan.packageSid
    || !equal(receipt.capabilitySids, plan.capabilitySids)
    || path.resolve(receipt.cwd || '') !== path.resolve(plan.cwd)
    || path.resolve(receipt.commandPath || '') !== path.resolve(filePath || '')) {
    return blocked('APPCONTAINER_RESOURCE_LEASE_CONFLICT', 'Resource receipt does not match this execution lease or executable.');
  }
  const until = Date.parse(receipt.expiresAt);
  if (!Number.isFinite(until) || until <= now) return blocked('APPCONTAINER_RESOURCE_LEASE_EXPIRED', 'The resource lease expired; automatic renewal is not permitted.');
  if (!receipt.resources.some(r => path.resolve(r.path || '') === path.resolve(filePath || '') && r.rights === 'read_execute')) {
    return blocked('APPCONTAINER_RESOURCE_NOT_REGISTERED', 'The selected executable has no registered execution resource.');
  }
  const probe = receipt.readProbe;
  if (probe?.packageSid !== plan.packageSid || !equal(probe.capabilitySids, plan.capabilitySids)
    || probe.isAppContainer !== true || !Number.isInteger(probe.pid) || probe.pid <= 0
    || !probe.processCreatedAt || probe.release?.confirmed !== true || probe.release.activeProcessCount !== 0
    || !Number.isFinite(Date.parse(probe.checkedAt)) || Date.parse(probe.checkedAt) > now
    || Date.parse(probe.checkedAt) >= until) {
    return blocked('APPCONTAINER_RESOURCE_PROBE_MISSING', 'A bound actual child probe and zero-member release receipt are required.');
  }
  if (observation?.profileMatches !== true || !Array.isArray(observation.resources)) {
    return blocked('APPCONTAINER_RESOURCE_PROFILE_MISSING', 'The provisioned profile is missing or differs from this lease.');
  }
  const failures = [];
  for (const resource of receipt.resources) {
    const current = observation.resources.find(r => r.resourceId === resource.resourceId);
    const mask = resource.rights === 'read' ? 0x120089 : resource.rights === 'read_execute' ? 0x1200a9 : null;
    if (!resource.resourceId || !path.isAbsolute(resource.path || '') || !mask || !resource.identity
      || !/^[a-f0-9]{64}$/.test(resource.aclFingerprint || '') || resource.probePassed !== true) {
      failures.push({ resourceId: resource.resourceId, path: resource.path, reason: 'registration-invalid' }); continue;
    }
    if (!current || current.error || current.reparse || current.nullDacl || current.unparsedTypes?.length
      || !equal(current.identity, resource.identity)) {
      failures.push({ resourceId: resource.resourceId, path: resource.path, reason: 'identity-unavailable-or-changed' }); continue;
    }
    const allowedSids = [plan.packageSid, ...plan.capabilitySids];
    const granted = (current.aces || []).some(a => a.type === 0 && allowedSids.includes(a.sid) && (a.mask & mask) === mask);
    if (!granted) {
      failures.push({ resourceId: resource.resourceId, path: resource.path,
        reason: current.hasWriteDac === true ? 'grant-missing' : 'provisioning-permission-required' }); continue;
    }
    if (current.fingerprint !== resource.aclFingerprint) failures.push({ resourceId: resource.resourceId, path: resource.path, reason: 'acl-drift' });
  }
  if (failures.length) {
    const permission = failures.some(r => r.reason === 'provisioning-permission-required');
    return blocked(permission ? 'APPCONTAINER_RESOURCE_PERMISSION_REQUIRED' : 'APPCONTAINER_RESOURCE_NOT_READY',
      permission ? 'An operator must authorize resource provisioning before execution.' : 'Resource identity, grants or ACL evidence changed.', failures);
  }
  return { ready: true, blocked: false, code: 'APPCONTAINER_RESOURCES_READY', leaseId: receipt.leaseId,
    expiresAt: receipt.expiresAt, evidenceKind: 'admission-observation', publishable: false };
};

export const inspectNativeResources = (receipt, plan) => new Promise((resolve, reject) => {
  const script = fileURLToPath(new URL('./appcontainer-resource-inspector.py', import.meta.url));
  const child = execFile(plan.pythonExecutable, ['-I', '-B', script],
    { windowsHide: true, timeout: 10_000, maxBuffer: 1024 * 1024 }, (error, stdout) => {
      if (error) { reject(error); return; }
      try { resolve(JSON.parse(stdout)); } catch (cause) { reject(cause); }
    });
  child.stdin.on('error', () => {});
  child.stdin.end(JSON.stringify({ receipt, plan }));
});

export const preflightAppContainerResources = async (plan, { filePath, now, inspectResources = inspectNativeResources } = {}) => {
  if (!path.isAbsolute(plan.resourceReceiptFile || '') || !/^[a-f0-9]{64}$/.test(plan.resourceReceiptSha256 || '') || !plan.resourceLeaseId) {
    return blocked('APPCONTAINER_RESOURCE_NOT_REGISTERED', 'No pinned operator resource receipt is configured.');
  }
  try {
    const filename = await realpath(plan.resourceReceiptFile);
    if (within(await realpath(plan.cwd), filename)) return blocked('APPCONTAINER_RESOURCE_RECEIPT_UNTRUSTED', 'An Agent-writable workspace cannot own resource readiness.');
    const bytes = await readFile(filename);
    if (bytes.length > 131072 || createHash('sha256').update(bytes).digest('hex') !== plan.resourceReceiptSha256) {
      return blocked('APPCONTAINER_RESOURCE_RECEIPT_DRIFT', 'The operator resource receipt changed.');
    }
    const receipt = JSON.parse(bytes.toString('utf8'));
    receipt.cwd = await realpath(receipt.cwd);
    receipt.commandPath = await realpath(receipt.commandPath);
    filePath = await realpath(filePath);
    receipt.resources = await Promise.all(receipt.resources.map(async resource => ({ ...resource, path: await realpath(resource.path) })));
    // Reject invalid/stale/cleanup receipts before any native inspection.
    const preliminary = evaluateResourceReadiness(receipt, plan, { profileMatches: true, resources: [] }, { filePath, now: now ?? Date.now() });
    if (!['APPCONTAINER_RESOURCE_NOT_READY', 'APPCONTAINER_RESOURCE_PERMISSION_REQUIRED'].includes(preliminary.code)) return preliminary;
    const observation = await inspectResources(receipt, plan);
    return evaluateResourceReadiness(receipt, plan, observation, { filePath, now: now ?? Date.now() });
  } catch (error) {
    return blocked('APPCONTAINER_RESOURCE_PRECHECK_FAILED', 'Resource preflight could not be verified; execution remains blocked.',
      [{ reason: error.code || 'inspection-failed' }]);
  }
};

export const assertResourceReadiness = report => {
  if (report?.ready !== true) throw Object.assign(new Error(report?.message || 'Resource preflight is unavailable.'),
    { code: report?.code || 'APPCONTAINER_RESOURCE_PRECHECK_FAILED', resourcePreflight: report });
  return report;
};
