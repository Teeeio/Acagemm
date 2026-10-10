import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { createPosixProcessIdentity, inspectPosixProcess, requestPosixCancellation, recoverPosixProcessRecord, startPosixSupervisedProcess } from '../client-runtime/posix-process-supervisor.mjs';
import { readLinuxProcessIdentity, inspectLinuxIdentity, inspectLinuxGroup } from '../client-runtime/posix-process-identity.mjs';
const owner = { pid: 11, bootId: 'boot', startTicks: '99', groupId: 11, sessionId: 11, state: 'S' };
const worker = { ...owner, pid: 22, groupId: 22, sessionId: 22, startTicks: '100' };
const supervisor = { ...owner, pid: 33, groupId: 33, sessionId: 33, startTicks: '101' };
const fixture = async t => {
  const runsDir = await mkdtemp(path.resolve('.tmp-posix-contract-'));
  t.after(() => rm(runsDir, { recursive: true, force: true }));
  const identity = await createPosixProcessIdentity({ runsDir, runId: 'r1', missionId: 'm1', readIdentity: async () => owner });
  const record = { runId: 'r1', missionId: 'm1', process: identity, status: 'running', diagnostics: {} };
  await mkdir(identity.jobDir);
  const ready = { schemaVersion: identity.schemaVersion, token: identity.token, runId: 'r1', missionId: 'm1', owner, supervisor, worker, startedAt: new Date().toISOString() };
  const receipt = { ...ready, exitCode: 0, signal: null, completedAt: new Date().toISOString(), release: 'confirmed',
    releaseProof: { confirmed: true, state: 'absent', activeProcessCount: 0, checkedAt: new Date().toISOString() } };
  const save = (name, value) => writeFile(identity[name + 'Path'], JSON.stringify(value));
  const inspect = () => inspectPosixProcess({ record, runsDir, inspectIdentity: async () => ({ state: 'active' }) });
  return { runsDir, identity, record, ready, receipt, save, inspect };
};
test('Linux stat parser handles spaces and parentheses in command; pins boot/start ticks', async () => {
  const fields = ['S','1','22','22', ...Array(15).fill('0'), '678', ...Array(5).fill('0')];
  const value = await readLinuxProcessIdentity(22, { read: async file => file.endsWith('boot_id') ? 'boot\n' : '22 (name (x)) ' + fields.join(' ') });
  assert.equal(value.startTicks, '678'); assert.equal(value.groupId,22); assert.equal(value.bootId,'boot');
});
test('PID reuse and inaccessible /proc never become active or released', async () => {
  assert.equal((await inspectLinuxIdentity(owner,{readIdentity:async()=>({...owner,startTicks:'changed'})})).state,'reused');
  assert.equal((await inspectLinuxIdentity(owner,{readIdentity:async()=>{throw Object.assign(Error(),{code:'EACCES'});}})).state,'unknown');
  assert.equal((await inspectLinuxGroup(22,{signal:()=>{throw Object.assign(Error(),{code:'EPERM'});}})).confirmed,false);
});
test('group release requires absence or a complete zombie census', async () => {
  assert.equal((await inspectLinuxGroup(22,{signal:()=>{throw Object.assign(Error(),{code:'ESRCH'});}})).confirmed,true);
  assert.equal((await inspectLinuxGroup(22,{signal:()=>{},list:async()=>['22'],readIdentity:async()=>({...worker,state:'Z'})})).state,'zombies_only');
  assert.equal((await inspectLinuxGroup(22,{signal:()=>{},list:async()=>['22'],readIdentity:async()=>{throw Error('denied');}})).confirmed,false);
});
test('missing startup or vanished supervisor does not prove release', async t => {
  const f=await fixture(t);assert.equal((await f.inspect()).confirmed,false);
  await f.save('ready',f.ready);
  const state=await inspectPosixProcess({record:f.record,runsDir:f.runsDir,inspectIdentity:async()=>({state:'absent'})});
  assert.equal(state.code,'POSIX_AGENT_EXIT_RECEIPT_MISSING');
});
test('token, Mission, process reuse, boot and path conflicts are rejected', async t => {
  const f=await fixture(t);
  for(const patch of [{token:'foreign'},{missionId:'m2'},{worker:{...worker,bootId:'other'}},{worker:{...worker,groupId:99}}]) {
    await f.save('ready',{...f.ready,...patch});assert.equal((await f.inspect()).confirmed,false);
  }
  await f.save('ready',f.ready);f.record.process={...f.identity,worker:{...worker,startTicks:'old'}};
  assert.equal((await f.inspect()).confirmed,false);
  f.record.process={...f.identity,receiptPath:path.resolve('foreign')};assert.equal((await f.inspect()).confirmed,false);
});
test('terminal close without exact released receipt stays quarantined', async t => {
  const f=await fixture(t);await f.save('ready',f.ready);
  for(const patch of [{token:'foreign'},{supervisor:{...supervisor,startTicks:'reused'}},{release:'unconfirmed'},
    {releaseProof:{...f.receipt.releaseProof,activeProcessCount:1}},{releaseProof:{...f.receipt.releaseProof,state:'unknown'}},{exitCode:null,signal:null}]) {
    await f.save('receipt',{...f.receipt,...patch});assert.equal((await f.inspect()).confirmed,false);
  }
});
test('matched receipt recovers completed result and preserves original permission failure', async t => {
  const f=await fixture(t);await f.save('ready',f.ready);await f.save('receipt',f.receipt);
  const inspection=await f.inspect();assert.equal(inspection.confirmed,true);
  const recovered=recoverPosixProcessRecord(f.record,inspection,[{type:'result',subtype:'success'}]);
  assert.equal(recovered.status,'completed');assert.equal(recovered.resourceRelease.source,'linux-process-group');
  assert.equal(recoverPosixProcessRecord({...f.record,error:{code:'CLAUDE_TOOL_PERMISSION_DENIED'}},inspection,[{type:'result'}]).status,'failed');
  assert.equal(recoverPosixProcessRecord(recovered,inspection,[{type:'result',subtype:'success'}]),recovered);
});
test('recovery cancellation writes only token request and requires actual receipt', async t => {
  const f=await fixture(t);await f.save('ready',f.ready);
  setTimeout(()=>void f.save('receipt',{...f.receipt,releaseProof:{...f.receipt.releaseProof,cancelled:true}}),30);
  const result=await requestPosixCancellation({record:f.record,runsDir:f.runsDir,timeoutMs:300,inspectIdentity:async()=>({state:'active'})});
  assert.equal(result.confirmed,true);assert.equal(JSON.parse(await readFile(f.identity.cancelPath,'utf8')).token,f.identity.token);
});
test('Linux CPU group protocol: persistence precedes provider; normal result receipt', { skip: process.platform !== 'linux' }, async t => {
  const runsDir=await mkdtemp(path.resolve('.tmp-posix-native-'));t.after(()=>rm(runsDir,{recursive:true,force:true}));
  const identity=await createPosixProcessIdentity({runsDir,runId:'native1',missionId:'m1'});
  const marker=path.join(runsDir,'bound');let bound=false;
  const child=startPosixSupervisedProcess({identity,command:process.execPath,args:['-e',"const fs=require('fs');if(!fs.existsSync(process.argv[1]))process.exit(7);console.log(JSON.stringify({type:'result',subtype:'success'}));",marker],cwd:runsDir,environment:process.env,stdinText:'',
    onIdentity:async()=>{bound=true;await writeFile(marker,'bound');}});
  let output='';child.stdout.on('data',b=>output+=b);child.on('error',()=>{});
  await child.ready;const receipt=await child.settled;assert.equal(bound,true);assert.equal(receipt.exitCode,0);assert.equal(receipt.releaseProof.confirmed,true);assert.match(output,/success/);
});
test('Linux CPU group protocol: SIGTERM-resistant descendants receive SIGKILL', { skip: process.platform !== 'linux' }, async t => {
  const runsDir=await mkdtemp(path.resolve('.tmp-posix-native-'));t.after(()=>rm(runsDir,{recursive:true,force:true}));
  const identity=await createPosixProcessIdentity({runsDir,runId:'native2',missionId:'m1'});
  const child=startPosixSupervisedProcess({identity,command:process.execPath,args:['-e',"require('child_process').spawn(process.execPath,['-e',\"process.on('SIGTERM',()=>{});setInterval(()=>{},1000)\"],{stdio:'inherit'});process.on('SIGTERM',()=>{});console.log('started');setInterval(()=>{},1000);"],cwd:runsDir,environment:process.env,stdinText:'',onIdentity:async()=>{}});
  child.on('error',()=>{});await child.ready;await new Promise(resolve=>child.stdout.once('data',resolve));
  const receipt=await child.terminate();assert.equal(receipt.releaseProof.confirmed,true);assert.equal(receipt.releaseProof.cancelled,true);
});
