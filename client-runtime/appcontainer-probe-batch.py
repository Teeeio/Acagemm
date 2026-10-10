"""Frozen operator diagnostic, not a Mission/Provider/GPU workflow.

Default CLI only prints a packet. --execute AND the exact packet digest AND a
human approval reference are required. No native APIs are used during import.
"""
import argparse
import ast
import ctypes as c
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import sys
import time
from types import SimpleNamespace

sys.dont_write_bytecode = True

def load_provisioning():
    path = Path(__file__).with_name('appcontainer-provisioning.py')
    spec = importlib.util.spec_from_file_location('operator_provisioning', path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def run_batch(packet, backend, save, clock=time.monotonic):
    """One attempt, no retries. All safety effects reside in the injected port."""
    start = clock()
    result = {'batchId': packet['batchId'], 'status': 'preparing', 'stages': {},
              'profileOwned': False, 'aclClean': True, 'release': None, 'errors': []}
    def record():
        result['elapsedSeconds'] = round(clock()-start, 3)
        save(result)
    def check_budget():
        if clock()-start >= packet['budget']['totalSeconds']-packet['budget']['cleanupReserveSeconds']:
            raise RuntimeError('Batch deadline reserves cleanup; no further grant/probe')
    try:
        backend.preflight()
        check_budget()
        result['profileOwned'] = backend.create_profile()
        record()
        # ACL outcome is unknown from launch intent until a bound terminal receipt.
        result['aclClean'] = False
        result['stages']['grant'] = {'state':'launch-intent'}
        record()
        grant = backend.grant()
        result['stages']['grant'] = grant
        if not grant['process']['terminated']:
            raise RuntimeError('Grant helper release unknown')
        if grant['payload']['state'] != 'granted':
            result['aclClean'] = grant['payload']['state'] in ('clean','grant-failed-rolled-back')
            raise RuntimeError('Grant did not complete; no child probe')
        record()
        check_budget()
        probe = backend.probe()
        result['stages']['probe'] = probe
        result['release'] = probe['release']
        if not probe['passed']:
            raise RuntimeError('File-only Read is insufficient; scope expansion is forbidden')
        result['status'] = 'observed'
    except Exception as error:
        result['profileOwned'] = result['profileOwned'] or getattr(backend,'profile_owned',False)
        receipt = getattr(error, 'receipt', None)
        result['errors'].append({'phase':'execution','message':str(error),'code':getattr(error,'code',None),'receipt':receipt})
        result['status'] = 'blocked'
        if receipt and receipt.get('state') == 'cancelled' and receipt.get('launched') is False:
            result['aclClean'] = backend.verify_original()
    finally:
        release = result['release'] or backend.release_observation()
        result['release'] = release
        grant_process = result['stages'].get('grant',{}).get('process') or next(
            (e['receipt'] for e in result['errors'] if (e.get('receipt') or {}).get('terminated')), None)
        # No competing revoke while an elevated grant may still be running.
        if result['profileOwned'] and not result['aclClean'] and grant_process and grant_process.get('terminated'):
            if release.get('confirmed') is True and release.get('activeProcessCount') == 0:
                try:
                    revoke = backend.revoke(release)
                    result['stages']['revoke'] = revoke
                    result['aclClean'] = revoke['process']['terminated'] and revoke['payload']['state']=='clean' and backend.verify_original()
                except Exception as error:
                    result['errors'].append({'phase':'revoke','message':str(error),'code':getattr(error,'code',None),
                                             'receipt':getattr(error,'receipt',None)})
        if result['profileOwned'] and result['aclClean']:
            result['aclClean'] = backend.verify_original()
        if result['profileOwned'] and result['aclClean'] and release.get('confirmed') is True:
            try:
                result['profileDeleted'] = backend.delete_profile()
                if not result['profileDeleted']: raise RuntimeError('Profile deletion/residue unconfirmed')
            except Exception as error:
                result['errors'].append({'phase':'profile-cleanup','message':str(error)})
        else:
            result['profileDeleted'] = False
        if not result['aclClean'] or (result['profileOwned'] and not result.get('profileDeleted')):
            result['status'] = 'cleanup-required'
        elif result['status'] == 'observed' and not result['errors']:
            result['status'] = 'completed'
        result['withinBudget'] = clock()-start <= packet['budget']['totalSeconds']
        if not result['withinBudget'] and result['status']=='completed': result['status']='blocked'
        record()
    return result


def current_user_sid(boundary):
    from ctypes import wintypes as w
    token = w.HANDLE()
    if not boundary._advapi32.OpenProcessToken(boundary._kernel32.GetCurrentProcess(), 8, c.byref(token)):
        raise RuntimeError('Cannot query helper user identity')
    try:
        actual = boundary.sid_text(boundary._token_user_sid(token))
    finally:
        boundary._kernel32.CloseHandle(token)
    return actual


def elevated_stage(packet, action, approval_ref, release):
    P = load_provisioning()
    acl, boundary, _ = P.load_pinned_dispatch(packet['dispatchPins'])
    if current_user_sid(boundary) != packet['hostUserSid']: raise RuntimeError('UAC changed account; no owner/account switching is authorized')
    if action=='grant' and time.time() >= packet['executionDeadlineUtc']:
        raise RuntimeError('Grant deadline expired before mutation')
    transaction = {'schemaVersion':'operator-studio.acl-transaction/v1','transactionId':packet['batchId'],
                   'approvalRef':approval_ref,'packageSid':packet['profile']['packageSid'],'targets':packet['targets']}
    journal_path = Path(packet['journalPath'])
    if journal_path.resolve().parent != Path(packet['outputRoot']).resolve(): raise RuntimeError('Journal escaped frozen output root')
    journal = json.loads(journal_path.read_text(encoding='utf-8')) if journal_path.exists() else None
    if action=='grant' and journal is not None: raise RuntimeError('Existing transaction must not be re-granted')
    if action=='revoke' and journal is None: raise RuntimeError('Missing original transaction journal')
    class DeadlineAclPort(P.NativeAclPort):
        def grant_read(self, path, sid):
            if time.time() >= packet['executionDeadlineUtc']: raise RuntimeError('Grant deadline expired')
            return super().grant_read(path,sid)
    tx = P.NarrowAclTransaction(transaction, DeadlineAclPort(acl), lambda value:P.atomic_json(journal_path,value), journal)
    return tx.grant() if action=='grant' else tx.cleanup(release)


class NativeBatchBackend:
    def __init__(self, packet, approval_ref):
        self.packet, self.approval_ref = packet, approval_ref
        self.P = load_provisioning()
        self.acl, self.boundary, self.runner = self.P.load_pinned_dispatch(packet['dispatchPins'])
        self.port = self.P.NativeAclPort(self.acl)
        self.profile_owned = False
        self.worker = self.job = None
        self.release = {'confirmed':True,'activeProcessCount':0,'source':'not-started'}
        self.observers = []
        self.calls = 0
        self.helper_unknown = False
        self.probe_identity = {}

    def preflight(self):
        import winreg
        for filename, expected in self.packet['sourcePins'].items():
            if hashlib.sha256(Path(filename).read_bytes()).hexdigest()!=expected: raise RuntimeError('Frozen source changed: '+filename)
        if Path(self.packet['reportPath']).exists() or Path(self.packet['journalPath']).exists(): raise RuntimeError('Existing batch receipt/journal; no replay')
        if self.mapping() is not None or self.profile_dir().exists(): raise RuntimeError('Preexisting profile must not be adopted')
        if Path(sys.executable).resolve()!=Path(self.packet['hostPython']).resolve(): raise RuntimeError('Unexpected host Python')
        if current_user_sid(self.boundary)!=self.packet['hostUserSid']: raise RuntimeError('Unexpected host account; no profile created')
        if not self.verify_original(): raise RuntimeError('File identity/owner/DACL changed since packet preparation')

    def profile_dir(self):
        return Path(os.environ['LOCALAPPDATA'])/'Packages'/self.packet['profile']['name']

    def mapping(self):
        import winreg
        name = r'Software\Classes\Local Settings\Software\Microsoft\Windows\CurrentVersion\AppContainer\Mappings'+'\\'+self.packet['profile']['packageSid']
        try:
            with winreg.OpenKey(winreg.HKEY_CURRENT_USER,name) as key: return winreg.QueryValueEx(key,'Moniker')[0]
        except FileNotFoundError: return None

    def verify_original(self):
        for target in self.packet['targets']:
            current=self.port.snapshot(target['path'])
            if (current['identity']!=target['identity'] or current['fingerprint']!=target['beforeFingerprint']
                    or current['ownerSid']!=target['ownerSid']): return False
        return True

    def create_profile(self):
        native = self.boundary._userenv.CreateAppContainerProfile
        def owned(*args):
            code=native(*args)
            if code!=0: raise RuntimeError('CreateAppContainerProfile did not return S_OK; no ownership')
            self.profile_owned=True
            return code
        self.boundary._userenv.CreateAppContainerProfile=owned
        try:
            self.package=self.boundary.create_appcontainer_profile(self.packet['profile']['name'])
        finally: self.boundary._userenv.CreateAppContainerProfile=native
        if self.boundary.sid_text(self.package)!=self.packet['profile']['packageSid'] or self.mapping()!=self.packet['profile']['name']:
            raise RuntimeError('New profile identity mismatch; reconciliation required')
        self.capability,_=self.boundary.derive_capability_sid(self.packet['profile']['capabilityName'])
        if self.boundary.sid_text(self.capability)!=self.packet['profile']['capabilitySid']: raise RuntimeError('Capability identity changed')
        return self.profile_owned

    def uac_stage(self, action, release=None):
        self.calls+=1
        if self.calls>2: raise RuntimeError('Maximum two UAC calls; no automatic retry')
        filename = Path(__file__).resolve()
        expected = self.packet['sourcePins'][str(filename)]
        payload = json.dumps([self.packet,action,self.approval_ref,release],ensure_ascii=True)
        # Pin this caller before executing it inside the existing UAC transport.
        source = '\n'.join(['sys.dont_write_bytecode=True','import hashlib,importlib.util',
          'p='+repr(str(filename)), 'assert hashlib.sha256(open(p,"rb").read()).hexdigest()=='+repr(expected),
          's=importlib.util.spec_from_file_location("frozen_probe_batch",p)',
          'm=importlib.util.module_from_spec(s)','s.loader.exec_module(m)',
          'def _run():','    return m.elevated_stage(*json.loads(sys.argv[1]))'])
        root=Path(self.packet['outputRoot'])
        observer=self.P.NativeProcessObserver(root/(action+'-process.json'));self.observers.append(observer)
        try:
            return self.P.observed_uac_call(self.runner,observer,source,root/(action+'-result.json'),
                                           argv=(payload,),timeout=self.packet['budget']['helperWaitSeconds'])
        except self.P.ProvisioningBlocked as error:
            self.helper_unknown=bool(error.receipt and error.receipt.get('state')!='cancelled' and not error.receipt.get('terminated'))
            raise

    def grant(self): return self.uac_stage('grant')
    def revoke(self,release): return self.uac_stage('revoke',release)

    def probe(self):
        from ctypes import wintypes as w
        source_path=Path(self.packet['jobModule'])
        source=source_path.read_text(encoding='utf-8')
        node=next(n for n in ast.parse(source).body if isinstance(n,ast.ClassDef) and n.name=='_WindowsJob')
        namespace={'ctypes':c,'os':os,'WorkspaceError':RuntimeError,'new_job_name':lambda:self.packet['jobName']}
        exec(compile(ast.Module(body=[node],type_ignores=[]),str(source_path),'exec'),namespace)
        Job=namespace['_WindowsJob']
        native=self.boundary._verify_appcontainer_child
        journal_path=Path(self.packet['journalPath'])
        transaction={'schemaVersion':'operator-studio.acl-transaction/v1','transactionId':self.packet['batchId'],
                     'approvalRef':self.approval_ref,'packageSid':self.packet['profile']['packageSid'],'targets':self.packet['targets']}
        tx=self.P.NarrowAclTransaction(transaction,self.port,lambda value:self.P.atomic_json(journal_path,value),
                                       json.loads(journal_path.read_text(encoding='utf-8')))
        tx.claim_consumer()
        identity=self.probe_identity
        def fenced(pi,**kwargs):
            self.release={'confirmed':False,'activeProcessCount':None,'source':'windows-job-object'}
            try:
                state=native(pi,**kwargs)
                self.job=Job(SimpleNamespace(_handle=pi.hProcess))
                observer=self.P.NativeProcessObserver(Path(self.packet['outputRoot'])/'probe-process.json')
                identity.update(observer.identity(pi.hProcess))
                if not self.job.assigned or not self.job.kill_on_close: raise RuntimeError('Job assignment not confirmed')
                return state
            except BaseException:
                self.boundary._kernel32.TerminateProcess(pi.hProcess,1)
                self.boundary._kernel32.WaitForSingleObject(pi.hProcess,3000)
                raise
        self.boundary._verify_appcontainer_child=fenced
        try:
            self.worker=self.boundary.spawn_appcontainer_worker(self.packet['probe']['argv'],cwd=self.packet['probe']['cwd'],
              package_sid=self.package,capability_sids=[self.capability],profile_name=self.packet['profile']['name'],
              env={k:os.environ[k] for k in ('SystemRoot','WINDIR','LOCALAPPDATA') if k in os.environ})
        finally: self.boundary._verify_appcontainer_child=native
        resumed=self.boundary._child_appcontainer_state(self.worker.pid)
        for token in (self.worker.observed,resumed):
            if token['pid']!=self.worker.pid or token['is_appcontainer'] is not True or token['package_sid']!=self.packet['profile']['packageSid'] or token['capabilities_enabled']!=[self.packet['profile']['capabilitySid']]:
                raise RuntimeError('Probe real token mismatch')
        self.worker.stdin.close()
        code=self.worker.wait(timeout=self.packet['budget']['probeSeconds'])
        release=self.drain_job(identity)
        if release.get('confirmed') is not True: raise RuntimeError('Probe whole-tree release is unknown')
        stdout=self.worker.stdout.read(32768).decode('utf-8')
        stderr=self.worker.stderr.read(8192).decode('utf-8')
        rows=[json.loads(line) for line in stdout.splitlines() if line.strip()]
        files=[t['path'] for t in self.packet['targets']]
        passed=code==0 and all(any(row['path']==p and row.get('genericReadOneByte',{}).get('readSuccess') and row['genericReadOneByte'].get('bytesRead')==1 for row in rows) for p in files)
        suspended=self.worker.observed
        self.worker.close();self.worker=None
        return {'passed':passed,'exitCode':code,'observations':rows,'stderr':stderr,'release':release,
                'suspendedToken':suspended,'afterResumeToken':resumed}

    def drain_job(self, identity=None):
        from ctypes import wintypes as w
        if not self.job: return self.release
        class Accounting(c.Structure):
            _fields_=[(n,c.c_int64) for n in ('user','kernel','periodUser','periodKernel')]+[(n,w.DWORD) for n in ('pageFaults','total','active','terminated')]
        kernel=self.job.kernel
        kernel.QueryInformationJobObject.argtypes=[w.HANDLE,c.c_int,c.c_void_p,w.DWORD,c.c_void_p]
        kernel.QueryInformationJobObject.restype=w.BOOL
        def active():
            info=Accounting()
            if not kernel.QueryInformationJobObject(self.job.handle,1,c.byref(info),c.sizeof(info),None): raise RuntimeError('Job accounting unknown')
            return info.active
        count=active()
        if count:
            kernel.TerminateJobObject.argtypes=[w.HANDLE,w.UINT];kernel.TerminateJobObject.restype=w.BOOL
            if not kernel.TerminateJobObject(self.job.handle,1): raise RuntimeError('Job termination failed')
            until=time.monotonic()+self.packet['budget']['releaseSeconds']
            while count and time.monotonic()<until: time.sleep(.02);count=active()
        if identity is None: identity=self.probe_identity
        self.release={'source':'windows-job-object','confirmed':count==0,'activeProcessCount':count,
                      'jobName':self.job.name,**(identity or {})}
        if count==0: self.job.close();self.job=None
        return self.release

    def release_observation(self):
        if self.helper_unknown: return {'confirmed':False,'activeProcessCount':None,'source':'helper-unknown'}
        try: return self.drain_job()
        except Exception: return {'confirmed':False,'activeProcessCount':None,'source':'job-unknown'}

    def delete_profile(self):
        if not self.profile_owned or self.mapping()!=self.packet['profile']['name']: return False
        code=self.boundary._userenv.DeleteAppContainerProfile(self.packet['profile']['name'])
        return code==0 and self.mapping() is None and not self.profile_dir().exists()


def main():
    parser=argparse.ArgumentParser()
    parser.add_argument('--packet',required=True)
    parser.add_argument('--packet-sha256',required=True)
    parser.add_argument('--approval-ref')
    parser.add_argument('--execute',action='store_true')
    args=parser.parse_args()
    raw=Path(args.packet).read_bytes()
    if hashlib.sha256(raw).hexdigest()!=args.packet_sha256: raise SystemExit('Frozen packet digest changed')
    packet=json.loads(raw)
    if not args.execute:
        print(json.dumps({'status':'prepared-not-executed','batchId':packet['batchId'],'budget':packet['budget'],'targets':packet['targets']},ensure_ascii=True))
        return
    if not args.approval_ref: raise SystemExit('Explicit human approval reference is required')
    if packet.get('schemaVersion')!='operator-studio.permission-batch/v1': raise SystemExit('Unexpected packet schema')
    packet['executionDeadlineUtc']=time.time()+packet['budget']['totalSeconds']-packet['budget']['cleanupReserveSeconds']
    P=load_provisioning()
    backend=NativeBatchBackend(packet,args.approval_ref)
    result=run_batch(packet,backend,lambda value:P.atomic_json(packet['reportPath'],value))
    print(json.dumps(result,ensure_ascii=True))
    raise SystemExit(0 if result['status']=='completed' else 1)

if __name__=='__main__': main()
