// Native local clients pin an operator-owned Runtime. This is connection identity,
// not authentication, provider admission, or a replacement workflow.
import path from 'node:path';
import {readFile} from 'node:fs/promises';
import {inspectIndependentExperiment} from '../../client-runtime/experiment-storage.mjs';
import {setTimeout as delay} from 'node:timers/promises';

export const RUNTIME_ATTACHMENT_SCHEMA = 'operator-studio.runtime-attachment/v1';
const conflict = message => Object.assign(new Error(message), {code:'LOCAL_C500_RUNTIME_ATTACHMENT_CONFLICT'});
const positivePid = value => Number.isSafeInteger(value) && value > 0;
const connectionKeys=['OPERATOR_GPU_PYTHON','OPERATOR_GPU_NVIDIA_SMI','OPERATOR_LOCAL_C500_TIMEOUT_SECONDS',
  'OPERATOR_REQUIRE_INDEPENDENT_SUPERVISOR','OPERATOR_MAIN_AGENT_BUDGET_MS','OPERATOR_MAIN_AGENT_STALL_MS',
  'OPERATOR_PROCESS_BOUNDARY','CLAUDE_COMMAND','TEMP','TMP','OPERATOR_GPU_BUILD_TMP','TORCH_EXTENSIONS_DIR',
  'XDG_CACHE_HOME','PYTHONDONTWRITEBYTECODE','PYTHONUTF8'];
const experimentIdentity=value=>value ? Object.fromEntries(['experimentId','manifestDigest','snapshotDigest','sourceDigest',
  'configurationDigest','condition','memoryMode','initialRepositoryRevision','initialRecordCount','memoryPolicy','agentPolicy']
  .map(key=>[key,value[key]])) : null;

export function runtimeAttachmentEnvironment(record) {
  const bridge = record?.bridge;
  if (record?.schemaVersion !== RUNTIME_ATTACHMENT_SCHEMA || !positivePid(bridge?.pid)
    || !positivePid(bridge?.ownerPid) || !Number.isInteger(bridge?.port) || bridge.port < 1 || bridge.port > 65535
    || !Number.isFinite(Date.parse(bridge.startedAt)) || !path.isAbsolute(bridge.runtimeDir || '')
    || !path.isAbsolute(bridge.dataDir || '') || !path.isAbsolute(record.testerHome || '')
    || record.apiUrl !== `http://127.0.0.1:${bridge.port}`
    || !['local-c500','local-shared-gpu'].includes(record.backendKind)
    || typeof record.runtimeMode !== 'string' || !record.runtimeMode) throw conflict('Invalid pinned local Runtime identity.');
  if (path.resolve(bridge.runtimeDir) !== path.resolve(record.testerHome,'runtime')
    || path.resolve(bridge.dataDir) !== path.resolve(record.testerHome,'data')) throw conflict('Pinned Runtime directories do not belong to the declared home.');
  return {
    ...Object.fromEntries(connectionKeys.filter(key=>typeof record.connectionConfiguration?.[key]==='string').map(key=>[key,record.connectionConfiguration[key]])),
    LOCAL_C500_TESTER_HOME:record.testerHome, LOCAL_C500_API_PORT:String(bridge.port), LOCAL_C500_API_URL:record.apiUrl,
    OPERATOR_TEST_BACKEND:record.backendKind, OPERATOR_RUNTIME_MODE:record.runtimeMode,
    OPERATOR_LOCAL_C500_MOCK:record.mock===true?'1':'0',OPERATOR_LOCAL_C500_SIMULATION:record.simulation===true?'1':'0',
    OPERATOR_SIMULATION:record.simulation===true?'1':'0',OPERATOR_LOCAL_C500_MOCK_SCENARIO:record.scenario || '',
    OPERATOR_RUNTIME_CONNECTION_MODE:'attach-only', OPERATOR_RUNTIME_EXPECTED_PID:String(bridge.pid),
    OPERATOR_RUNTIME_EXPECTED_OWNER_PID:String(bridge.ownerPid), OPERATOR_RUNTIME_EXPECTED_STARTED_AT:bridge.startedAt,
  };
}

export function assertRuntimeAttachment(current,{environment,testerHome,apiPort,backendKind,runtimeMode,ownerAlive}) {
  const bridge = current?.__bridge || {};
  if (environment.OPERATOR_RUNTIME_CONNECTION_MODE !== 'attach-only') return;
  const expectedPid = Number(environment.OPERATOR_RUNTIME_EXPECTED_PID);
  const expectedOwner = Number(environment.OPERATOR_RUNTIME_EXPECTED_OWNER_PID);
  if (!positivePid(expectedPid) || !positivePid(expectedOwner) || !ownerAlive
    || current?.service !== 'operator-studio-client-runtime' || bridge.pid !== expectedPid
    || bridge.ownerPid !== expectedOwner || bridge.port !== apiPort
    || bridge.startedAt !== environment.OPERATOR_RUNTIME_EXPECTED_STARTED_AT
    || !Number.isFinite(Date.parse(bridge.startedAt))
    || path.resolve(bridge.runtimeDir || '') !== path.resolve(testerHome,'runtime')
    || path.resolve(bridge.dataDir || '') !== path.resolve(testerHome,'data')
    || current.testBackend?.kind !== backendKind || current.runtime?.mode !== runtimeMode) {
    throw conflict('The pinned operator-owned Runtime is unavailable or changed; this client will not start or replace it.');
  }
}

export function createRuntimeAttachmentRecord({health,testerHome,supervisorPreflight,preparationIdentity=null}) {
  const record = {schemaVersion:RUNTIME_ATTACHMENT_SCHEMA,apiUrl:`http://127.0.0.1:${health?.__bridge?.port}`,
    testerHome:path.resolve(testerHome),bridge:health?.__bridge,backendKind:health?.testBackend?.kind,
    runtimeMode:health?.runtime?.mode,supervisorPreflight,preparationIdentity,
    mock:health?.testBackend?.mock===true,simulation:health?.testBackend?.simulation===true,scenario:health?.testBackend?.scenario || null,
    connectionConfiguration:Object.fromEntries(connectionKeys.filter(key=>typeof process.env[key]==='string').map(key=>[key,process.env[key]])),
    observedAt:new Date().toISOString(),ownership:'original-manual-TUI',
    supervisionAdmission:'CPU bootstrap observation only; every real provider start verifies its own supervisor'};
  runtimeAttachmentEnvironment(record);
  return record;
}

export async function inspectRuntimeAttachment(file,{read=readFile,request=fetch,retryDelays=[250,1000,3000],sleep=delay}={}) {
  const record=JSON.parse(await read(path.resolve(file),'utf8'));
  let environment=runtimeAttachmentEnvironment(record);
  if(record.bridge.experimentIsolation){
    const experiment=await inspectIndependentExperiment({rootDir:record.testerHome,manifestDigest:record.bridge.experimentIsolation.manifestDigest});
    environment={...experiment.environment,...environment};
  }
  let response;
  for(let attempt=0;;attempt++){
    try {response=await request(`${record.apiUrl}/api/health`,{redirect:'error',signal:AbortSignal.timeout(3000)});break;}
    catch(error){
      if(!['TypeError','AbortError','TimeoutError'].includes(error.name)||attempt>=retryDelays.length)throw error;
      await sleep(retryDelays[attempt]); // GET only; never retry an effect or extend an execution clock.
    }
  }
  if (!response.ok) throw conflict('The original Runtime health endpoint did not accept the connection.');
  const health=await response.json();
  assertRuntimeAttachment(health,{environment,testerHome:record.testerHome,apiPort:record.bridge.port,
    backendKind:record.backendKind,runtimeMode:record.runtimeMode,ownerAlive:true});
  if (JSON.stringify(experimentIdentity(health.__bridge.experimentIsolation))!==JSON.stringify(experimentIdentity(record.bridge.experimentIsolation))) {
    throw conflict('The attached Runtime experiment identity changed.');
  }
  return {record,environment,health};
}
