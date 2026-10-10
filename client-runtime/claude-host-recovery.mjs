import { execFile } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';

const ANCHOR_SCHEMA = 'operator-studio.local-host-anchor/v1';
const PROOF_SCHEMA = 'operator-studio.local-host-termination/v1';
const hash = value => 'sha256:' + createHash('sha256').update(value).digest('hex');
const validTime = value => typeof value === 'string' && Number.isFinite(Date.parse(value));
const failure = (code, message) => Object.assign(new Error(message), { code, status: 409 });
const hostScript = `$ErrorActionPreference='Stop';[Console]::OutputEncoding=[Text.UTF8Encoding]::new();$machine=(Get-ItemProperty -LiteralPath 'HKLM:\\SOFTWARE\\Microsoft\\Cryptography' -Name MachineGuid).MachineGuid;$digest=[Security.Cryptography.SHA256]::Create().ComputeHash([Text.Encoding]::UTF8.GetBytes([string]$machine));$fingerprint=[BitConverter]::ToString($digest).Replace('-','').ToLowerInvariant();$boot=(Get-ItemProperty -LiteralPath 'HKLM:\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Memory Management\\PrefetchParameters' -Name BootId).BootId;[ordered]@{hostFingerprint=$fingerprint;bootCounter=$boot;bootStartedAt=(Get-CimInstance Win32_OperatingSystem).LastBootUpTime.ToUniversalTime().ToString('o');observedAt=[DateTime]::UtcNow.ToString('o')}|ConvertTo-Json -Compress`;
export const readLocalHostExecutionIdentity = async () => {
  if (process.platform !== 'win32') throw failure('LOCAL_HOST_RECOVERY_UNSUPPORTED', 'This host recovery proof is supported only for local Windows execution.');
  const encoded = Buffer.from(hostScript, 'utf16le').toString('base64');
  const value = await new Promise((resolve, reject) => execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded],
    { windowsHide: true, timeout: 15000, maxBuffer: 65536, encoding: 'utf8' }, (error, stdout) => {
      if (error) reject(failure('LOCAL_HOST_IDENTITY_UNAVAILABLE', 'Operating-system host/boot identity cannot be verified.'));
      else { try { resolve(JSON.parse(stdout.replace(/^\uFEFF/, ''))); } catch { reject(failure('LOCAL_HOST_IDENTITY_UNAVAILABLE', 'Invalid operating-system identity response.')); } }
    }));
  if (!/^[a-f0-9]{64}$/.test(value.hostFingerprint || '') || !Number.isSafeInteger(value.bootCounter) || value.bootCounter < 0
    || !validTime(value.bootStartedAt) || !validTime(value.observedAt) || Date.parse(value.bootStartedAt) > Date.parse(value.observedAt)) {
    throw failure('LOCAL_HOST_IDENTITY_UNAVAILABLE', 'Host fingerprint, boot counter and times must all be known.');
  }
  return value;
};
export const verifyLocalHostTermination = ({ anchor, currentHost, runId, missionId, recordDigest }) => {
  if (anchor?.schemaVersion !== ANCHOR_SCHEMA || anchor.runId !== runId || anchor.missionId !== missionId
    || anchor.recordDigest !== recordDigest || !validTime(anchor.runStartedAt)
    || !validTime(anchor.host?.observedAt) || !validTime(anchor.host?.bootStartedAt)
    || !Number.isSafeInteger(anchor.host?.bootCounter)) throw failure('LOCAL_HOST_ANCHOR_CONFLICT', 'Original run checkpoint is absent or its identity changed.');
  if (currentHost?.hostFingerprint !== anchor.host.hostFingerprint) throw failure('LOCAL_HOST_IDENTITY_CONFLICT', 'Checkpoint belongs to another computer.');
  if (!Number.isSafeInteger(currentHost.bootCounter) || currentHost.bootCounter <= anchor.host.bootCounter
    || !validTime(currentHost.bootStartedAt) || !validTime(currentHost.observedAt)
    || Date.parse(currentHost.bootStartedAt) <= Date.parse(anchor.host.observedAt)
    || Date.parse(currentHost.bootStartedAt) <= Date.parse(anchor.runStartedAt)
    || Date.parse(currentHost.observedAt) < Date.parse(currentHost.bootStartedAt)) {
    throw failure('LOCAL_HOST_RESTART_NOT_VERIFIED', 'A later full restart of this same computer has not been verified; resources remain quarantined.');
  }
  return { schemaVersion: PROOF_SCHEMA, runId, missionId, recordDigest, anchorDigest: hash(JSON.stringify(anchor)),
    previousHost: anchor.host, currentHost, localExecutionTerminated: true,
    originalProcessExitCode: null, originalProcessExitAt: null, remoteModelOutcome: 'unknown', remoteModelCost: 'unknown' };
};
const readJson = async filename => JSON.parse((await readFile(filename, 'utf8')).replace(/^\uFEFF/, ''));
const optionalJson = async filename => { try { return await readJson(filename); } catch (error) { if (error.code === 'ENOENT') return null; throw error; } };
export const createClaudeHostRecovery = ({ runsDir, readHostIdentity = readLocalHostExecutionIdentity }) => {
  const checked = async runId => {
    if (!/^[A-Za-z0-9_-]+$/.test(runId || '')) throw failure('CLAUDE_RUN_ID_INVALID', 'Invalid run identity.');
    const bytes = await readFile(path.join(runsDir, runId + '.json'));
    const record = JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/, ''));
    if (record.runId !== runId || record.provider !== 'claude-code' || !record.missionId || !validTime(record.startedAt)
      || !path.isAbsolute(record.workspace || '') || record.process) throw failure('LOCAL_HOST_RECOVERY_INELIGIBLE', 'Only this local legacy Claude run without process identity is eligible.');
    return { record, recordDigest: hash(bytes), anchorPath: path.join(runsDir, runId + '.host-anchor.json'), proofPath: path.join(runsDir, runId + '.host-termination.json') };
  };
  const capture = async runId => {
    const value = await checked(runId);
    let anchor = await optionalJson(value.anchorPath);
    if (anchor) {
      if (anchor.recordDigest !== value.recordDigest || anchor.runId !== runId || anchor.missionId !== value.record.missionId) throw failure('LOCAL_HOST_ANCHOR_CONFLICT', 'Existing checkpoint no longer matches the original run.');
      return { action: 'capture', anchor, releaseConfirmed: false };
    }
    const host = await readHostIdentity();
    if (Date.parse(host.observedAt) < Date.parse(value.record.startedAt)) throw failure('LOCAL_HOST_CLOCK_CONFLICT', 'Checkpoint clock predates the original run.');
    anchor = { schemaVersion: ANCHOR_SCHEMA, runId, missionId: value.record.missionId,
      recordDigest: value.recordDigest, runStartedAt: value.record.startedAt, host,
      executionAuthority: 'local-windows-claude-stdio', remoteModelOutcome: 'unknown' };
    try { await writeFile(value.anchorPath, JSON.stringify(anchor, null, 2) + '\n', { flag: 'wx' }); }
    catch (error) { if (error.code !== 'EEXIST') throw error; return capture(runId); }
    return { action: 'capture', anchor, releaseConfirmed: false };
  };
  const recover = async runId => {
    const value = await checked(runId); const anchor = await optionalJson(value.anchorPath);
    const currentHost = await readHostIdentity();
    const proof = verifyLocalHostTermination({ anchor, currentHost, runId, missionId: value.record.missionId, recordDigest: value.recordDigest });
    const existing = await optionalJson(value.proofPath);
    if (existing && existing.anchorDigest !== proof.anchorDigest) throw failure('LOCAL_HOST_PROOF_CONFLICT', 'A different recovery proof is already recorded.');
    if (!existing) await writeFile(value.proofPath, JSON.stringify(proof, null, 2) + '\n', { flag: 'wx' });
    return { action: 'recover', proof: existing || proof, releaseConfirmed: true };
  };
  const project = async record => {
    if (record.process || !record.runId) return record;
    const proofPath = path.join(runsDir, record.runId + '.host-termination.json');
    const proof = await optionalJson(proofPath); if (!proof) return record;
    const value = await checked(record.runId); const anchor = await optionalJson(value.anchorPath);
    const validated = verifyLocalHostTermination({ anchor, currentHost: proof.currentHost, runId: record.runId, missionId: record.missionId, recordDigest: value.recordDigest });
    if (proof.schemaVersion !== PROOF_SCHEMA || proof.runId !== record.runId || proof.missionId !== record.missionId || proof.recordDigest !== value.recordDigest
      || proof.remoteModelCost !== 'unknown' || proof.anchorDigest !== validated.anchorDigest || proof.localExecutionTerminated !== true
      || proof.remoteModelOutcome !== 'unknown' || proof.originalProcessExitCode !== null || proof.originalProcessExitAt !== null) throw failure('LOCAL_HOST_PROOF_CONFLICT', 'Recorded host proof is invalid.');
    const now = await readHostIdentity();
    if (now.hostFingerprint !== proof.currentHost.hostFingerprint || now.bootCounter < proof.currentHost.bootCounter
      || Date.parse(now.bootStartedAt) < Date.parse(proof.currentHost.bootStartedAt)) throw failure('LOCAL_HOST_IDENTITY_CONFLICT', 'Current host cannot confirm the recorded reboot proof.');
    return { ...record, status: 'cancelled', completedAt: null, executionOutcome: 'unknown_interrupted', localHostRecovery: proof,
      resourceRelease: { confirmed: true, status: 'confirmed', source: 'verified-local-host-restart',
        reason: 'A later boot session on the same computer ended the prior local execution environment; remote model outcome remains unknown.', proof } };
  };
  return Object.freeze({ capture, recover, project });
};
