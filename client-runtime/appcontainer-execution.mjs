import { createHash } from 'node:crypto';
import { readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { preflightAppContainerResources, assertResourceReadiness } from './appcontainer-resource-preflight.mjs';

export const APPCONTAINER_PLAN_SCHEMA = 'operator-studio.appcontainer-plan/v1';
const fail = (code, message) => Object.assign(new Error(message), { code });
const within = (root, value) => {
  const relative = path.relative(path.resolve(root), path.resolve(value));
  return !relative || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative));
};

// A selected boundary is a requirement, never a best-effort provider option.
export const appContainerRequested = (environment = {}) => {
  const kinds = [process.env.OPERATOR_PROCESS_BOUNDARY, environment.OPERATOR_PROCESS_BOUNDARY].filter(Boolean);
  if (kinds.some(kind => !['appcontainer', 'shared-host'].includes(kind)) || new Set(kinds).size > 1) {
    throw fail('PROCESS_BOUNDARY_CONFIG_INVALID', 'Unknown or conflicting process boundary configuration.');
  }
  return kinds.includes('appcontainer');
};

export const requireBoundarySupervisor = ({ environment, platform = process.platform, supervised }) => {
  if (appContainerRequested(environment) && (platform !== 'win32' || !supervised)) {
    throw fail('APPCONTAINER_SUPERVISOR_REQUIRED', 'AppContainer execution requires the Windows process supervisor.');
  }
};

export const normalizeAppContainerPlan = (plan, { cwd, filePath, argv, platform = process.platform }) => {
  if (platform !== 'win32') throw fail('APPCONTAINER_HOST_UNSUPPORTED', 'AppContainer execution requires a Windows host.');
  if (plan?.schemaVersion !== APPCONTAINER_PLAN_SCHEMA || typeof plan.approvalRef !== 'string' || !plan.approvalRef.trim()) {
    throw fail('APPCONTAINER_PLAN_NOT_APPROVED', 'An explicit operator-owned execution plan is required.');
  }
  if (!path.isAbsolute(filePath || '') || !Array.isArray(argv) || !argv.length || argv.some(value => typeof value !== 'string' || value.includes('\0'))
    || path.resolve(argv[0]) !== path.resolve(filePath) || /^(cmd|powershell|pwsh)(\.exe)?$/i.test(path.basename(filePath))) {
    throw fail('APPCONTAINER_ARGV_REQUIRED', 'AppContainer requires structured native argv; shell command strings are not supported.');
  }
  if (!path.isAbsolute(plan.cwd || '') || path.resolve(plan.cwd) !== path.resolve(cwd)) {
    throw fail('APPCONTAINER_PLAN_SCOPE_CONFLICT', 'The execution plan does not match this workspace.');
  }
  if (!/^(acagemm|dispatch)-[a-zA-Z0-9_.-]+$/.test(plan.profileName || '')
    || !/^S-1-15-2-(?:\d+-){6}\d+$/.test(plan.packageSid || '')) {
    throw fail('APPCONTAINER_PLAN_IDENTITY_INVALID', 'The execution plan has an invalid profile identity.');
  }
  const capabilities = plan.capabilitySids;
  if (!Array.isArray(capabilities) || !capabilities.length || capabilities.length > 16
    || capabilities.some(value => !/^S-1-15-3-(?:\d+-)*\d+$/.test(value))
    || new Set(capabilities).size !== capabilities.length) {
    throw fail('APPCONTAINER_PLAN_IDENTITY_INVALID', 'The execution plan has invalid or duplicate capability identities.');
  }
  if (!path.isAbsolute(plan.boundaryModule || '') || within(cwd, plan.boundaryModule)
    || !/^[a-f0-9]{64}$/.test(plan.boundaryModuleSha256 || '') || !path.isAbsolute(plan.pythonExecutable || '') || within(cwd, plan.pythonExecutable)) {
    throw fail('APPCONTAINER_IMPLEMENTATION_INVALID', 'A pinned existing boundary module and host Python are required.');
  }
  return { schemaVersion: APPCONTAINER_PLAN_SCHEMA, approvalRef: plan.approvalRef,
    cwd: path.resolve(cwd), profileName: plan.profileName, packageSid: plan.packageSid,
    capabilitySids: [...capabilities].sort(), boundaryModule: plan.boundaryModule,
    boundaryModuleSha256: plan.boundaryModuleSha256, pythonExecutable: plan.pythonExecutable,
    resourceReceiptFile: plan.resourceReceiptFile, resourceReceiptSha256: plan.resourceReceiptSha256,
    resourceLeaseId: plan.resourceLeaseId };
};

// This adapter consumes provisioned identities. It never creates profiles,
// grants ACLs, reads provider credentials or installs a resource registry.
export const resolveAppContainerPlan = async ({ environment = {}, cwd, filePath, argv, inspectResources }) => {
  if (!appContainerRequested(environment)) return null;
  const filename = process.env.OPERATOR_APPCONTAINER_PLAN_FILE || environment.OPERATOR_APPCONTAINER_PLAN_FILE;
  if (!filename || !path.isAbsolute(filename)) throw fail('APPCONTAINER_PLAN_MISSING', 'No operator execution-plan file is configured.');
  const realCwd = await realpath(cwd);
  const resolved = await realpath(filename);
  if (within(realCwd, resolved)) throw fail('APPCONTAINER_PLAN_SCOPE_CONFLICT', 'An Agent-writable workspace cannot own its execution plan.');
  const bytes = await readFile(resolved);
  if (bytes.length > 65536) throw fail('APPCONTAINER_PLAN_INVALID', 'Execution-plan file exceeds its size limit.');
  let document;
  try { document = JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/, '')); }
  catch { throw fail('APPCONTAINER_PLAN_INVALID', 'Execution-plan file is not valid JSON.'); }
  if (!document || typeof document !== 'object') throw fail('APPCONTAINER_PLAN_INVALID', 'Execution-plan document must be an object.');
  const plans = Array.isArray(document.plans) ? document.plans : [document];
  const matching = plans.filter(plan => typeof plan?.cwd === 'string' && path.resolve(plan.cwd) === path.resolve(cwd));
  if (matching.length !== 1) throw fail('APPCONTAINER_PLAN_SCOPE_CONFLICT', 'Exactly one provisioned plan must match this workspace.');
  const plan = normalizeAppContainerPlan(matching[0], { cwd, filePath, argv });
  const modulePath = await realpath(plan.boundaryModule);
  const pythonExecutable = await realpath(plan.pythonExecutable);
  if (within(realCwd, modulePath) || within(realCwd, pythonExecutable)) throw fail('APPCONTAINER_IMPLEMENTATION_INVALID', 'The boundary implementation and host Python cannot be Agent-writable.');
  const digest = createHash('sha256').update(await readFile(modulePath)).digest('hex');
  if (digest !== plan.boundaryModuleSha256) throw fail('APPCONTAINER_IMPLEMENTATION_DRIFT', 'The approved boundary implementation changed.');
  const resolvedPlan = { ...plan, cwd: realCwd, boundaryModule: modulePath, pythonExecutable };
  const resourcePreflight = assertResourceReadiness(await preflightAppContainerResources(resolvedPlan, { filePath, inspectResources }));
  return { ...resolvedPlan, resourcePreflight };
};

// Reuse launch admission for the interactive preflight. No provider probe is
// allowed before this check; failure gives instructions, never provisioning.
export const preflightAppContainerExecution = async ({ environment = {}, platform = process.platform, supervised, ...scope }) => {
  try {
    requireBoundarySupervisor({ environment, platform, supervised });
    const plan = await resolveAppContainerPlan({ ...scope, environment });
    return { ready: true, processBoundary: plan ? 'appcontainer' : 'shared-host',
      ...(plan ? { resourcePreflight: plan.resourcePreflight } : {}) };
  } catch (error) {
    const code = /^(APPCONTAINER_|PROCESS_BOUNDARY_)/.test(error.code || '') ? error.code : 'APPCONTAINER_PRECHECK_FAILED';
    const nextAction = code === 'PROCESS_BOUNDARY_CONFIG_INVALID'
      ? '请统一选择 shared-host 或 appcontainer，核对进程与请求中的 OPERATOR_PROCESS_BOUNDARY。'
      : code === 'APPCONTAINER_RESOURCE_PERMISSION_REQUIRED'
        ? '请由 operator 审批缺失资源的最小授权；应用不会自行修改 ACL 或触发 UAC。'
        : code.startsWith('APPCONTAINER_RESOURCE_')
          ? '请由 operator 核对当前租约、资源登记、只读探针及回收回执，提供与本次执行匹配的有效 resource receipt。'
          : '请由 operator 核对当前 Mission Workspace、原生可执行文件和监督器，并通过 OPERATOR_APPCONTAINER_PLAN_FILE 指定工作区外的已批准计划。';
    return { ready: false, code, detail: `${error.message} ${nextAction}`, nextAction,
      ...(error.resourcePreflight ? { resourcePreflight: error.resourcePreflight } : {}) };
  }
};

export const assertAppContainerEvidence = (evidence, plan, pid) => {
  if (!evidence || evidence.kind !== 'appcontainer' || evidence.approvalRef !== plan.approvalRef) {
    throw fail('APPCONTAINER_EVIDENCE_INVALID', 'AppContainer identity evidence is missing or unbound.');
  }
  for (const state of [evidence.suspendedToken, evidence.afterResumeToken]) {
    if (state?.pid !== pid || state.is_appcontainer !== true || state.package_sid !== plan.packageSid
      || !Array.isArray(state.capabilities_enabled)
      || JSON.stringify([...state.capabilities_enabled].sort()) !== JSON.stringify(plan.capabilitySids)) {
      throw fail('APPCONTAINER_EVIDENCE_INVALID', 'Observed AppContainer identity differs from the execution plan.');
    }
  }
  return evidence;
};
