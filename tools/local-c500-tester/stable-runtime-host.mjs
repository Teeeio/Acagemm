// One manual terminal owns the existing TUI/Runtime. No daemon, listener, new
// authority, credentials, or state-storage path is introduced here.
import path from 'node:path';
import {mkdir,writeFile,access} from 'node:fs/promises';
import {openSync,writeSync,closeSync} from 'node:fs';
import {preflightIndependentSupervisor} from '../../client-runtime/windows-job-object.mjs';
import {createRuntimeAttachmentRecord} from './runtime-attachment.mjs';

export async function startStableRuntimeHost({recordFile,preparationIdentity=null,beforeRuntime=async()=>{},
  preflight=preflightIndependentSupervisor,loadClient=()=>import('./production-api.mjs'),
  showTui=async({signal})=>{const {main}=await import('./tui.mjs');return main({args:[],signal});},
  processEvents=process}) {
  if (process.env.OPERATOR_RUNTIME_CONNECTION_MODE==='attach-only') throw new Error('A connected client cannot become the manual Runtime owner.');
  process.env.OPERATOR_REQUIRE_INDEPENDENT_SUPERVISOR='1';
  const file=path.resolve(recordFile);
  try {await access(file);throw Object.assign(new Error('This manual-host record already exists; inspect the original instance instead of replaying startup.'),{code:'LOCAL_C500_HOST_RECORD_EXISTS'});}
  catch(error){if(error.code!=='ENOENT')throw error;}
  await mkdir(path.dirname(file),{recursive:true});
  const admission=await preflight({environment:process.env,tempRoot:path.join(path.dirname(file),'host-supervisor-preflight')});
  if (admission.ready!==true || admission.supervisionRequired!==true
    || admission.supervision?.outsideInheritedJobs!==true || admission.supervision?.checkedBeforeResume!==true) {
    throw Object.assign(new Error(admission.detail || 'Independent supervisor admission is unavailable.'),
      {code:admission.code || 'PROCESS_BOUNDARY_SUPERVISOR_LIFETIME_UNAVAILABLE'});
  }
  // Credential selection, when explicitly supplied by an approved wrapper,
  // occurs only after the actual manual caller has passed CPU admission.
  await beforeRuntime();
  const client=await loadClient();
  let ready=false,runtimePid=null,record,failure,cleanupError,logFd=null;
  const controller=new AbortController();
  let exitReason={kind:'unknown',signal:null,errorCode:null};
  const errorCode=error=>typeof error?.code==='string'&&/^[A-Z0-9_]{1,80}$/.test(error.code)?error.code:null;
  const log=(event,details={})=>{
    if(logFd!==null)writeSync(logFd,JSON.stringify({at:new Date().toISOString(),event,...details})+'\n');
  };
  const signalCodes={SIGINT:130,SIGTERM:143,SIGHUP:129};
  const handlers=Object.keys(signalCodes).map(signal=>[signal,()=>{
    if(exitReason.kind==='unknown')exitReason={kind:'captured-signal',signal,errorCode:null};
    log('signal_received',{signal,exitReason});
    if(!processEvents.exitCode)processEvents.exitCode=signalCodes[signal];
    controller.abort();
  }]);
  const onExit=exitCode=>log('process_exit_observed',{exitReason,exitCode,cleanupConfirmed:false});
  for(const [signal,handler]of handlers)processEvents.on(signal,handler);
  processEvents.once('exit',onExit);
  try {
    const health=await client.ensureProductionRuntime({existingRuntimePolicy:'cancel'});
    if (health.__bridge?.ownerPid!==process.pid) throw new Error('The manual TUI must own its Runtime; another owner cannot be adopted.');
    runtimePid=health.__bridge.pid;
    record=createRuntimeAttachmentRecord({health,testerHome:client.testerHome,supervisorPreflight:admission,preparationIdentity});
    await writeFile(file,JSON.stringify(record,null,2)+'\n',{flag:'wx'});ready=true;
    logFd=openSync(`${file}.lifecycle.jsonl`,'wx');
    log('host_ready',{ownerPid:record.bridge.ownerPid,runtimePid});
    console.log(JSON.stringify({phase:'manual_TUI_host_ready',recordFile:file,apiUrl:record.apiUrl,
      ownerPid:record.bridge.ownerPid,runtimePid:record.bridge.pid,modelStarts:0,gpuTasks:0,
      instruction:'Keep this original terminal/TUI open; compatible clients can connect to this exact Runtime.'}));
    if(!controller.signal.aborted)await showTui({signal:controller.signal});
    if(exitReason.kind==='unknown')exitReason={kind:'normal-return',signal:null,errorCode:null};
    log('exit_requested',{exitReason});
  } catch(error) {
    failure=error;
    if(exitReason.kind==='unknown')exitReason={kind:'exception',signal:null,errorCode:errorCode(error)};
    log('exit_requested',{exitReason});
  } finally {
    let stopped=false;
    try {
      stopped=await client.stopProductionRuntime();
      if(!stopped&&runtimePid){try{process.kill(runtimePid,0);}catch(error){if(error.code==='ESRCH')stopped=true;}}
    } catch(error) {cleanupError=error;}
    try {
      if(ready)await writeFile(`${file}.closed.json`,JSON.stringify({closedAt:new Date().toISOString(),runtimeStopped:stopped,
        exitReason,cleanupErrorCode:errorCode(cleanupError),ownership:'original-manual-TUI',
        releaseAuthority:'Runtime stop is not a model/GPU release receipt'})+'\n',{flag:'wx'});
      log('host_cleanup_finished',{exitReason,runtimeStopped:stopped,cleanupErrorCode:errorCode(cleanupError)});
    } finally {
      for(const [signal,handler]of handlers)processEvents.removeListener(signal,handler);
      processEvents.removeListener('exit',onExit);
      if(logFd!==null)closeSync(logFd);
    }
  }
  if(failure)throw failure;
  if(cleanupError)throw cleanupError;
  return record;
}
