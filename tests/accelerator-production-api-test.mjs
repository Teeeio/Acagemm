import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import { once } from 'node:events';
import { findAcceleratorBackend } from '../client-runtime/accelerator-backends.mjs';
import { contentDigest } from '../client-runtime/execution-package-contract.mjs';
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const port=()=>new Promise((resolve,reject)=>{const server=net.createServer();server.once('error',reject);server.listen(0,'127.0.0.1',()=>{const value=server.address().port;server.close(error=>error?reject(error):resolve(value));});});
for(const id of ['local-metax-c500','local-ascend910b'])test(id+' production composition: health/read-only queue and blocked package admission',async()=>{
  const home=await mkdtemp(path.resolve('.tmp-accelerator-api-'));
  const number=await port(),base='http://127.0.0.1:'+number;
  const environment={...process.env,API_PORT:String(number),SERVE_WEB:'false',OPERATOR_RUNTIME_MODE:'reference-fixture',OPERATOR_AUTO_TICK:'0',OPERATOR_HARDWARE_DISABLED:'1',
    OPERATOR_TEST_BACKEND:id,OPERATOR_LOCAL_C500_MOCK:'0',OPERATOR_LOCAL_C500_SIMULATION:'0',OPERATOR_RUNTIME_DIR:path.join(home,'runtime'),
    OPERATOR_DATA_DIR:path.join(home,'data'),OPERATOR_LOCAL_C500_DIR:path.join(home,'tasks'),OPERATOR_EXECUTION_PACKAGE_DIR:path.join(home,'packages')};
  delete environment.OPERATOR_LOCAL_C500_COMMAND;delete environment.OPERATOR_EXPERIMENT_ROOT;delete environment.OPERATOR_CLAUDE_EXPERIMENT_ISOLATION;
  const server=spawn(process.execPath,['client-runtime/local-server.mjs'],{cwd:process.cwd(),env:environment,stdio:['ignore','ignore','pipe']});
  let stderr='';server.stderr.on('data',b=>stderr+=b);let spawnError,actuallyClosed=false;server.on('error',e=>spawnError=e);const closed=once(server,'close').then(value=>{actuallyClosed=true;return value;});
  try{
    let health;
    const deadline=Date.now()+20000;
    while(Date.now()<deadline){if(spawnError)throw spawnError;if(server.exitCode!==null)throw Error(stderr);try{const r=await fetch(base+'/api/health');if(r.ok){health=await r.json();break;}}catch{}await pause(40);}
    assert.ok(health,stderr||'No health');
    assert.equal(health.testBackend.kind,id);assert.equal(health.testBackend.publishable,false);assert.equal(health.testBackend.qualificationRequired,true);
    assert.equal(health.testBackend.liveHardware,false);
    const queue=await(await fetch(base+'/api/operator-tests')).json();assert.deepEqual(queue.tasks,[]);
    const source=path.join(home,'source');await mkdir(source);await writeFile(path.join(source,'run.py'),'def run(inputs): return inputs\n');await writeFile(path.join(source,'oracle.py'),'def reference(inputs): return inputs\n');
    const h=contentDigest('binding');
    const request={sourcePath:source,sourceType:'directory',language:'python',adapter:findAcceleratorBackend(id).adapter,environmentId:findAcceleratorBackend(id).packagePort.environmentId,
      candidateEntrypoint:'run.py',acceptanceEntrypoint:'oracle.py',binding:{missionId:'m1',workspaceId:'w1',candidateId:'c1',candidateDigest:h},
      acceptance:{semanticDigest:h,testSpec:{cases:['minimal','boundary']}}};
    const result=await fetch(base+'/api/execution-packages/import',{method:'POST',headers:{'Content-Type':'application/json',Origin:base},body:JSON.stringify(request)});
    const body=await result.json();assert.equal(result.status,503,JSON.stringify(body));assert.equal(body.code,'ACCELERATOR_HARDWARE_DISABLED');
    assert.deepEqual((await(await fetch(base+'/api/operator-tests')).json()).tasks,[]);
    const taskFiles=await readdir(path.join(home,'tasks')).catch(e=>{if(e.code==='ENOENT')return[];throw e;});assert.deepEqual(taskFiles,[]);
  }finally{
    if(server.exitCode===null)server.kill('SIGTERM');await Promise.race([closed,pause(5000)]);
    assert.equal(actuallyClosed,true,'Fixture server must actually close before cleanup');
    await rm(home,{recursive:true,force:true});
  }
});
