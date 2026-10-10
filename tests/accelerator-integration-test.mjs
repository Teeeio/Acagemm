import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { findAcceleratorBackend } from '../client-runtime/accelerator-backends.mjs';
import { probeAcceleratorRuntime, createAcceleratorEnvironmentResolver, createAcceleratorPackageAdapter } from '../client-runtime/accelerator-package-adapter.mjs';
import { targetCapabilityAvailability, capabilitySupportsLanguage } from '../client-runtime/target-capability-registry.mjs';
import { createExecutionPackageStore, contentDigest } from '../client-runtime/execution-package-store.mjs';
import { evaluateAcceptGate } from '../client-runtime/accept-gate.mjs';
import { completeCorrectness } from '../client-runtime/correctness-coverage.mjs';
import { isDevelopmentAcceleratorCoreEvidence, hasPublicationRestriction } from '../client-runtime/evidence-decision.mjs';
import { extractEnvironmentTarget } from '../client-runtime/operator-test-evidence.mjs';
import { createOperatorTestQueue } from '../client-runtime/operator-test-queue.mjs';
import { createSupervisedPreparationExecutor } from '../client-runtime/local-c500-service-client.mjs';
import { createBenchmarkPackagePreparer } from '../client-runtime/application/benchmark-package-preparation-service.mjs';
import { createOperatorTestTool } from '../client-runtime/operator-test-tool.mjs';
import { assertMissionExecutor, resolveLocalC500LaunchMode, assertProductionPreflight } from '../tools/local-c500-tester/production-api.mjs';
const rootDir=process.cwd();
const policies={
  'local-metax-c500':{python:'3.11',torch:'vendor.metax',maca:'1',driver:'2'},
  'local-ascend910b':{python:'3.11',torch:'2',torch_npu:'2',cann:'8',driver:'9'},
};
const config=id=>({OPERATOR_ALLOW_SHARED_ACCELERATOR:'1',[id==='local-metax-c500'?'OPERATOR_METAX_C500_VERSIONS_JSON':'OPERATOR_ASCEND910B_VERSIONS_JSON']:JSON.stringify(policies[id])});
const report=id=>id==='local-metax-c500'?{status:'ready',observed:{vendor:'metax',deviceName:'MetaX C500',versions:policies[id],timer:{validated:true,kind:'maca-torch-event'},pythonExecutable:'/cpu-test/python',mxSmiExecutable:'/cpu-test/mx-smi'}}
  :{status:'device_probed',deviceProbed:true,liveHardware:true,pythonVersion:'3.11',targetProbe:{deviceName:'Ascend910B',torchVersion:'2',torchNpuVersion:'2',driverVersion:'9',versions:{cann:'8'}}};
const rejects=(fn,code)=>assert.rejects(fn,error=>error.code===code);
test('implemented adapters stay machine-unverified and non-publishable',()=>{
  for(const id of Object.keys(policies)){const backend=findAcceleratorBackend(id),entry=targetCapabilityAvailability(id);
    assert.equal(entry.available,false);assert.equal(entry.capability.adapterId,backend.adapter.id);assert.equal(capabilitySupportsLanguage(id,'pytorch-python'),false);
    assert.equal(entry.capability.publishable,false);
  }
});
test('metadata inspection uses -I distributions only and never becomes ready',async()=>{
  let args;
  const result=await probeAcceleratorRuntime({backendId:'local-ascend910b',rootDir,environment:{},run:async(_,a)=>{args=a;return{stdout:JSON.stringify({platform:'Linux',packages:{torch:'2','torch-npu':'2'},ready:true,deviceProbed:true})};}});
  assert.ok(args.includes('-I'));assert.match(args[3],/importlib.metadata/);assert.doesNotMatch(args[3],/import torch/);
  assert.equal(result.ready,false);assert.equal(result.deviceProbed,false);assert.equal(result.publishable,false);
});
test('hardware-disabled, unapproved boundary and missing pins stop before subprocess',async()=>{
  let calls=0;const run=async()=>{calls++;return{stdout:'{}'}};
  const common={backendId:'local-metax-c500',rootDir,probeDevice:true,run};
  await rejects(()=>probeAcceleratorRuntime({...common,environment:{OPERATOR_HARDWARE_DISABLED:'1'}}),'ACCELERATOR_HARDWARE_DISABLED');
  await rejects(()=>probeAcceleratorRuntime({...common,environment:{}}),'EXECUTION_ISOLATION_UNAVAILABLE');
  await rejects(()=>probeAcceleratorRuntime({...common,environment:{OPERATOR_ALLOW_SHARED_ACCELERATOR:'1'}}),'ACCELERATOR_VERSION_POLICY_REQUIRED');
  assert.equal(calls,0);
});
test('exact target plus version pins bind a distinct environment; foreign device/version rejected',async()=>{
  for(const id of Object.keys(policies)){
    const common={backendId:id,rootDir,probeDevice:true,environment:config(id)};
    const result=await probeAcceleratorRuntime({...common,run:async()=>({stdout:JSON.stringify(report(id))})});
    assert.equal(result.ready,true);assert.deepEqual(result.environment.target,findAcceleratorBackend(id).target);
    assert.equal(result.publishable,false);
    const wrong=report(id);(wrong.observed||wrong.targetProbe).deviceName='NVIDIA';
    await rejects(()=>probeAcceleratorRuntime({...common,run:async()=>({stdout:JSON.stringify(wrong)})}),'ACCELERATOR_DEVICE_UNQUALIFIED');
    const mismatch=report(id);if(mismatch.observed)mismatch.observed.versions={...mismatch.observed.versions,driver:'wrong'};else mismatch.targetProbe.driverVersion='wrong';
    await rejects(()=>probeAcceleratorRuntime({...common,run:async()=>({stdout:JSON.stringify(mismatch)})}),'ACCELERATOR_VERSION_MISMATCH');
  }
});
test('failed resolver refresh removes previous environment; never substitutes another id',async()=>{
  let calls=0,broken=false;
  const probe=async()=>{calls++;if(broken)throw Object.assign(Error('offline'),{code:'OFFLINE'});return await probeAcceleratorRuntime({backendId:'local-metax-c500',rootDir,probeDevice:true,environment:config('local-metax-c500'),run:async()=>({stdout:JSON.stringify(report('local-metax-c500'))})});};
  const resolver=createAcceleratorEnvironmentResolver({backendId:'local-metax-c500',probe});
  await resolver.resolve('metax-c500');await resolver.resolve('metax-c500');assert.equal(calls,1);
  await rejects(()=>resolver.resolve('local-ascend910b'),'PACKAGE_ENVIRONMENT_UNKNOWN');
  broken=true;await rejects(()=>resolver.resolve('metax-c500',{refresh:true}),'OFFLINE');
  await rejects(()=>resolver.resolve('metax-c500'),'OFFLINE');assert.equal(calls,3);
});
test('Mission intake selects C500/910B exactly and rejects foreign languages; legacy remains C550',()=>{
  for(const id of Object.keys(policies)){const b=findAcceleratorBackend(id);const spec={hardware:[b.hardware],implementation:{language:'pytorch-python'}};
    assert.equal(assertMissionExecutor(spec,{kind:id}),spec);
    assert.throws(()=>assertMissionExecutor({...spec,hardware:['C550']},{kind:id}),e=>e.code==='MISSION_TARGET_BACKEND_MISMATCH');
    assert.throws(()=>assertMissionExecutor({...spec,implementation:{language:'cuda-cpp-extension'}},{kind:id}),e=>e.code==='MISSION_LANGUAGE_BACKEND_UNSUPPORTED');
    assert.equal(resolveLocalC500LaunchMode({OPERATOR_TEST_BACKEND:id}).id,id);
  }
  assert.equal(resolveLocalC500LaunchMode({}).id,'real-c550');
});
test('Doctor cannot accept metadata-only, foreign or publishable qualification',()=>{
  const id='local-ascend910b';
  const doctor={executionMode:id,runtime:{testBackend:{kind:id,qualificationRequired:true,publishable:false,mock:false}},
    checks:{python:{status:'ok'},targetQualification:{status:'ok',ready:true,deviceProbed:true,publishable:false,backendId:id}}};
  assert.equal(assertProductionPreflight(doctor,{requireAgent:false}),doctor);
  for(const patch of [{ready:false},{deviceProbed:false},{publishable:true},{backendId:'local-metax-c500'},{status:'metadata_only'}]){
    assert.throws(()=>assertProductionPreflight({...doctor,checks:{...doctor.checks,targetQualification:{...doctor.checks.targetQualification,...patch}}},{requireAgent:false}),e=>e.code==='LOCAL_C500_PREFLIGHT_FAILED');
  }
});
const fakeValidator=(_,args,options,callback)=>{
  const child=new EventEmitter();child.kill=()=>true;
  queueMicrotask(()=>{callback(null,'','');child.emit('close',0,null);});
  return child;
};
test('same store/admission/test-tool contract runs both adapters; package byte drift stops submission',async t=>{
  const root=await mkdtemp(path.resolve('.tmp-accelerator-package-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const h=contentDigest('binding');
  for(const id of Object.keys(policies)){
    const descriptor=findAcceleratorBackend(id);
    const qualification=await probeAcceleratorRuntime({backendId:id,rootDir,probeDevice:true,environment:config(id),run:async()=>({stdout:JSON.stringify(report(id))})});
    let environment=qualification.environment;
    const adapter=createAcceleratorPackageAdapter({backendId:id,rootDir:path.join(root,id,'adapter'),execFileImpl:fakeValidator,prepareLoad:async input=>({preparationId:input.preparationId,packageDigest:input.packageDigest,environmentDigest:input.environmentDigest,
      buildLoad:{status:'passed',candidateLoaded:true,oracleLoaded:true,independentOracle:true,targetProbe:input.environment.observed,nativeBuild:{artifacts:[]},candidateRunPyDigest:input.manifest.layers.find(layer=>layer.role==='candidate').files[0].digest,oracleDigest:input.manifest.layers.find(layer=>layer.role==='acceptance').files[0].digest},resourceRelease:{confirmed:true,evidenceRef:'explicit CPU test double; no target process'}})});
    const store=createExecutionPackageStore({rootDir:path.join(root,id,'store'),environments:{resolve:async()=>environment},adapters:{[adapter.id]:adapter}});
    const input={language:'python',adapter:descriptor.adapter,environmentId:descriptor.packagePort.environmentId,binding:{missionId:'m1',workspaceId:'w1',candidateId:'c1',candidateDigest:h},
      candidateEntrypoint:'run.py',candidateFiles:{'run.py':'def run(inputs): return inputs\n'},
      acceptance:{entrypoint:'oracle.py',files:{'oracle.py':'def reference(inputs): return inputs\n'},testSpec:{cases:['minimal','boundary']},semanticDigest:h}};
    const pkg=await store.assemble(input),admission=await store.prepare(pkg.packageDigest);
    let submits=0;
    let outcome='completed';
    const service={submit:async payload=>{submits++;return{taskId:payload.requestId,status:'queued'}},get:async taskId=>({taskId,status:outcome==='unconfirmed'?'completed':outcome,completedAt:new Date().toISOString(),
      resourceRelease:{confirmed:outcome!=='unconfirmed',evidenceRef:'explicit simulation port; no target process'},
      result:outcome==='completed'?{environment:{source:'simulation',hardware:descriptor.hardware,executionMode:'simulation',liveHardware:false,publishable:false},binding:input.binding,correctness:{status:'passed',totalCases:2,passedCases:2},benchmark:[{profileId:'fixture',value:1,unit:'us',simulation:true}]}:null,
      error:outcome==='failed'?{code:'FIXTURE_BUILD_FAILED',phase:'build',category:'implementation_error',retryable:false}:null})};
    const queue=createOperatorTestQueue({serviceClient:service,filePath:path.join(root,id,'queue.jsonl')});t.after(()=>queue.dispose());
    const backend={capabilities:async()=>({backendId:id,queryIsReadOnly:true,idempotentSubmission:true,targets:[descriptor.target],adapters:[descriptor.adapter]}),
      submit:queue.submit,get:queue.readTask,cancel:queue.cancel,findByRequestId:queue.findByRequestId,advance:async taskId=>{await queue.process();return queue.readTask(taskId)}};
    const tool=createOperatorTestTool({backend,packages:store});
    const request={operator:'fixture',matrix:{environments:[descriptor.hardware],stages:['correctness','benchmark']},purpose:'candidate',requestId:'r1',missionId:'m1',workspaceId:'w1',candidate:{id:'c1',digest:h},packageDigest:pkg.packageDigest,admissionId:admission.admissionId,
      environmentDigest:environment.digest,acceptanceDigest:pkg.manifest.acceptance.digest,target:descriptor.target,checks:['correctness','benchmark'],deadline:new Date(Date.now()+60000).toISOString(),limits:{timeoutSeconds:10}};
    const queued=await tool.submit(request);assert.equal(queued.status,'waiting');assert.equal(submits,0);
    const beforeQuery=await readFile(queue.path,'utf8');assert.equal((await tool.get(queued.taskId)).status,'waiting');assert.equal(await readFile(queue.path,'utf8'),beforeQuery);
    await tool.advance(queued.taskId);assert.equal(submits,1);
    const completed=await tool.advance(queued.taskId);assert.equal(completed.status,'completed');assert.equal(completed.resourceRelease.confirmed,true);
    assert.equal(completed.result.environment.liveHardware,false);assert.equal(completed.result.environment.publishable,false);assert.equal(completed.result.environment.source,'simulation');
    assert.deepEqual(completed.result.binding,input.binding);assert.equal((await queue.readTask(queued.taskId)).result.correctness.totalCases,2);
    outcome='failed';const failedTask=await tool.submit({...request,requestId:'r2'});await tool.advance(failedTask.taskId);const failed=await tool.advance(failedTask.taskId);
    assert.equal(failed.status,'failed');assert.equal(failed.error.code,'FIXTURE_BUILD_FAILED');assert.equal(failed.resourceRelease.confirmed,true);
    outcome='unconfirmed';const unknown=await tool.submit({...request,requestId:'r3'});await tool.advance(unknown.taskId);const quarantined=await tool.advance(unknown.taskId);
    assert.equal(quarantined.status,'quarantined');assert.equal(quarantined.error.code,'OPERATOR_TEST_RELEASE_UNCONFIRMED');assert.equal(quarantined.resourceRelease.confirmed,false);
    const blocked=await tool.submit({...request,requestId:'r4'});await tool.advance(blocked.taskId);assert.equal((await tool.get(blocked.taskId)).status,'waiting');assert.equal(submits,3);
    const artifact=await adapter.verifyPreparedArtifact({manifest:pkg.manifest,environment,preparedArtifactDigest:admission.preparedArtifactDigest});
    await writeFile(path.join(artifact.root,'run.py'),'changed');
    await rejects(()=>tool.submit(request),'PACKAGE_PREPARED_ARTIFACT_CHANGED');assert.equal(submits,3);
    environment={...environment,policy:{...environment.policy,allowSharedHostGpu:false,publishable:true}};
    await rejects(()=>store.prepare(pkg.packageDigest),'EXECUTION_ISOLATION_UNAVAILABLE');
  }
});


test('native candidate mapping and original execution deadline survive preparation',async()=>{
  let assembled,options;const descriptor=findAcceleratorBackend('local-metax-c500'),h=contentDigest('frozen');
  const prepare=createBenchmarkPackagePreparer({packageAdapter:descriptor.adapter,packagePort:descriptor.packagePort,executionPackageStore:{assemble:async value=>{assembled=value;return{packageDigest:h}},prepare:async(_,o)=>{options=o;return{}}}});
  const deadline=new Date(Date.now()+5000).toISOString();
  const input={request:{missionId:'m1',candidate:{id:'c1',digest:h},runPy:'candidate',oracleRunPy:'reference',implementationFiles:{'kernel.cpp':'native','helper.py':'helper'},deadline,limits:{timeoutSeconds:600}},mission:{id:'m1',implementation:{language:'mxmaca-cpp-extension'}},matrix:{testSpec:{cases:['frozen']}}};
  const result=await prepare(input);assert.equal(assembled.candidateFiles['kernel.cpp'],'native');assert.equal(assembled.dependencyFiles['helper.py'],'helper');assert.equal(assembled.dependencyFiles['kernel.cpp'],undefined);
  assert.equal(result.deadline,deadline);assert.equal(options.deadline,deadline);
  await rejects(()=>prepare({...input,request:{...input.request,deadline:new Date(Date.now()-1).toISOString()}}),'PACKAGE_PREPARE_TIMEOUT');
});

test('supervised admission refuses disabled/expired/busy lanes before spawning',async t=>{
  const home=await mkdtemp(path.resolve('.tmp-accelerator-preparation-'));t.after(()=>rm(home,{recursive:true,force:true}));let calls=0;
  const input={preparationId:'fixture',packageDigest:contentDigest('p'),environmentDigest:contentDigest('e'),root:home,deadline:new Date(Date.now()+2000).toISOString(),command:{executable:process.execPath,argv:['-e','process.exit(0)']}};
  const spawnImpl=()=>{calls++;throw Error('must not spawn')};
  await rejects(()=>createSupervisedPreparationExecutor({root:path.join(home,'disabled'),environment:{OPERATOR_HARDWARE_DISABLED:'1'},spawnImpl}).execute(input),'ACCELERATOR_HARDWARE_DISABLED');
  const executor=createSupervisedPreparationExecutor({root:path.join(home,'busy'),environment:{},spawnImpl,isBlocked:async()=>true});
  await rejects(()=>executor.execute({...input,deadline:new Date(Date.now()-1).toISOString()}),'PACKAGE_PREPARE_TIMEOUT');
  await rejects(()=>executor.execute(input),'OPERATOR_TEST_QUEUE_BUSY');assert.equal(calls,0);assert.equal(await executor.hasBarrier(),false);
});

test('supervised admission accepts only its bound original receipt and quarantines foreign release',async t=>{
  const home=await mkdtemp(path.resolve('.tmp-accelerator-preparation-'));t.after(()=>rm(home,{recursive:true,force:true}));let foreign=false;
  const spawnImpl=(_,args)=>{const child=new EventEmitter();child.pid=987654;child.unref=()=>{};
    setImmediate(async()=>{const directory=args[1],claim=JSON.parse(await readFile(path.join(directory,'execution-claim.json'),'utf8'));
      const current={...claim,pid:876543,supervisorPid:child.pid,platform:process.platform,jobObject:process.platform==='win32',jobName:'explicit-CPU-port-double'};
      await writeFile(path.join(directory,'execution-claim.json'),JSON.stringify(current));
      await writeFile(path.join(directory,'runner.stdout.log'),JSON.stringify(JSON.stringify({status:'ready',buildLoad:{status:'passed',fixture:true}})));
      await writeFile(path.join(directory,'execution-exit.json'),JSON.stringify({...current,ownerId:foreign?'foreign':claim.ownerId,closed:true,completedAt:new Date().toISOString(),exitCode:0,resourceRelease:{confirmed:true},jobTerminalReceipt:{release:'confirmed',jobName:current.jobName,releaseProof:{activeProcessCount:0}}}));child.emit('close',0);});return child;};
  const executor=createSupervisedPreparationExecutor({root:path.join(home,'broker'),environment:{},spawnImpl});
  const input={preparationId:'fixture',packageDigest:contentDigest('p'),environmentDigest:contentDigest('e'),root:home,deadline:new Date(Date.now()+2000).toISOString(),command:{executable:process.execPath,argv:['-e','process.exit(0)']}};
  const receipt=await executor.execute(input);assert.equal(receipt.resourceRelease.confirmed,true);assert.equal(receipt.buildLoad.fixture,true);assert.equal(await executor.hasBarrier(),false);
  foreign=true;const rejected=await executor.execute({...input,preparationId:'foreign'});assert.equal(rejected.resourceRelease.confirmed,false);assert.equal(await executor.hasBarrier(),true);
});


test('new target launchers require existing dependencies and never install/fallback',async()=>{
  const source=await readFile('tools/local-c500-tester/launcher.cjs','utf8'),require=createRequire(import.meta.url);
  for(const backend of Object.keys(policies))for(const platform of ['linux','win32'])for(const arch of ['x64','arm64'])for(const ready of [false,true]){
    const commands=[],errors=[];const fakeProcess={argv:['node','launcher','--backend',backend,'doctor'],env:{},versions:{node:'22.23.2'},version:'v22.23.2',platform,arch,execPath:'/existing/node',exit:code=>{throw Object.assign(Error('exit'),{fixtureExit:code})}};
    const fakeFs={existsSync:file=>ready&&(String(file).replaceAll('\\','/').endsWith('ink/package.json')||/[/\\]@esbuild[/\\]linux-(x64|arm64)[/\\]bin[/\\]esbuild$/.test(String(file)))};
    assert.throws(()=>vm.runInNewContext(source,{require:name=>name==='fs'?fakeFs:name==='child_process'?{spawnSync:(command,args,options)=>{commands.push({command,args,options});return{status:0}}}:require(name),__dirname:path.resolve('tools/local-c500-tester'),process:fakeProcess,console:{error:value=>errors.push(value)}}),error=>error.fixtureExit===(ready?0:1));
    assert.equal(commands.length,ready?1:0);if(ready){assert.equal(commands[0].command,'/existing/node');assert.match(commands[0].args[0],/tui.mjs$/);assert.equal(commands[0].options.env.OPERATOR_TEST_BACKEND,backend);}else assert.match(errors.join(' '),/No automatic installation/);
  }
});


test('dedicated local core results reach the unchanged Gate and stay nonpublishable',()=>{
  // Pure protocol fixtures with synthetic measurements; no hardware observation occurred.
  for(const id of Object.keys(policies)){
    const descriptor=findAcceleratorBackend(id),hardware=descriptor.hardware;
    const environment=id==='local-metax-c500'?{source:'metax-c500',service:'python-metax-c500',hardware,liveHardware:true,publishable:false,targetProbe:report(id).observed}
      :{source:id,service:'ascend910b-adapter',hardware,executionMode:'npu',liveHardware:true,publishable:false,targetProbe:{...report(id).targetProbe,tool:'torch_npu.npu'}};
    const state={activeMissionId:'m1',appliedCandidateId:'c1',missions:[{id:'m1',hardware:[hardware],metric:'latency p50',goal:'latency < 45 us',objective:{mode:'threshold',targetLatencyUs:45},baseline:{required:false}}],candidateEvaluations:[{id:'c1',patchDigest:'fixture'}],benchmark:{candidate:{id:'c1',digest:'fixture'},matrix:{correctnessCases:24}},baseline:{required:false},testMatrix:{correctnessCases:24}};
    const result={environment,benchmark:[{environment:hardware,value:40,unit:'us',correctness:completeCorrectness(24)}]};
    assert.equal(isDevelopmentAcceleratorCoreEvidence(environment),true);const gate=evaluateAcceptGate(state,result);
    assert.equal(gate.passed,true,JSON.stringify(gate.failedRules));assert.equal(gate.publishable,false);assert.equal(gate.decision.execution.kind,'live');
    assert.equal(extractEnvironmentTarget(environment,{status:'completed'}).hardware[0],hardware.toLowerCase());
    assert.equal(extractEnvironmentTarget({...environment,hardware:id},{status:'completed'}),null);
    for(const patch of [{service:'foreign'},{hardware:'foreign'},{targetProbe:{}},{publishable:true}]){const wrong={...environment,...patch};assert.equal(isDevelopmentAcceleratorCoreEvidence(wrong),false);assert.equal(evaluateAcceptGate(state,{...result,environment:wrong}).passed,false);assert.equal(hasPublicationRestriction(wrong),true);}
    for(const [patch,kind] of [[{simulated:true},'simulation'],[{mock:true},'simulation'],[{executionMode:'simulation'},'simulation'],[{executionMode:'cpu'},'cpu'],[{runtime:'local-cpu'},'cpu'],[{provider:{kind:'mock'}},'simulation']]){
      const nonLive={...environment,...patch};assert.equal(isDevelopmentAcceleratorCoreEvidence(nonLive),false);
      const reference=evaluateAcceptGate(state,{...result,environment:nonLive});assert.equal(reference.decision.execution.kind,kind);assert.equal(reference.liveHardware,false);assert.equal(reference.publishable,false);
      assert.equal(extractEnvironmentTarget(nonLive,{status:'completed'}),null,'a contradictory live flag cannot produce an observed accelerator target');
    }
    const simulatedResult=evaluateAcceptGate(state,{...result,simulated:true});assert.equal(simulatedResult.decision.execution.kind,'simulation');assert.equal(simulatedResult.liveHardware,false);assert.equal(simulatedResult.publishable,false);
    const incomplete={...result,benchmark:[{...result.benchmark[0],correctness:{passed:true,total:24,passedCases:23}}]};assert.equal(evaluateAcceptGate(state,incomplete).passed,false);
    assert.equal(evaluateAcceptGate(state,{...result,benchmark:[{...result.benchmark[0],value:0}]}).passed,false);
    assert.equal(hasPublicationRestriction({...environment,publishable:true}),true);
  }
});
