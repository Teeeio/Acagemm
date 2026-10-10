"""Shared Windows process adapter. Uses the existing AppContainer launcher.

Provisioning is external: no profile creation/deletion, ACL change or credentials.
The helper owns the existing Job protocol and relays only the selected process.
"""
import base64
import ctypes as c
from ctypes import wintypes as w
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import sys
import threading
import time
from types import ModuleType
import winreg

sys.dont_write_bytecode = True
K = c.WinDLL('kernel32', use_last_error=True)
for name, result, args in (
    ('CreateJobObjectW',w.HANDLE,[c.c_void_p,w.LPCWSTR]),
    ('SetInformationJobObject',w.BOOL,[w.HANDLE,c.c_int,c.c_void_p,w.DWORD]),
    ('AssignProcessToJobObject',w.BOOL,[w.HANDLE,w.HANDLE]),
    ('QueryInformationJobObject',w.BOOL,[w.HANDLE,c.c_int,c.c_void_p,w.DWORD,c.c_void_p]),
    ('TerminateJobObject',w.BOOL,[w.HANDLE,w.UINT]),
    ('CloseHandle',w.BOOL,[w.HANDLE]),
    ('OpenProcess',w.HANDLE,[w.DWORD,w.BOOL,w.DWORD]),
    ('WaitForSingleObject',w.DWORD,[w.HANDLE,w.DWORD]),
    ('GetProcessTimes',w.BOOL,[w.HANDLE,c.POINTER(w.FILETIME),c.POINTER(w.FILETIME),c.POINTER(w.FILETIME),c.POINTER(w.FILETIME)]),
):
    function = getattr(K,name)
    function.restype, function.argtypes = result,args

class Basic(c.Structure):
    _fields_ = [('user',c.c_int64),('kernel',c.c_int64),('flags',w.DWORD),('min',c.c_size_t),('max',c.c_size_t),('active',w.DWORD),('affinity',c.c_size_t),('priority',w.DWORD),('scheduling',w.DWORD)]
class Io(c.Structure):
    _fields_ = [('counter'+str(i),c.c_uint64) for i in range(6)]
class Extended(c.Structure):
    _fields_ = [('basic',Basic),('io',Io)]+[('size'+str(i),c.c_size_t) for i in range(4)]
class Accounting(c.Structure):
    _fields_ = [('time'+str(i),c.c_int64) for i in range(4)]+[(name,w.DWORD) for name in ('pageFaults','total','active','terminated')]

def fail(api):
    raise OSError(c.get_last_error(),api+' failed')
def at():
    return datetime.now(timezone.utc).isoformat()
def creation(handle):
    times = [w.FILETIME() for _ in range(4)]
    if not K.GetProcessTimes(handle,*(c.byref(value) for value in times)):
        fail('GetProcessTimes')
    value = (times[0].dwHighDateTime<<32)|times[0].dwLowDateTime
    return datetime.fromtimestamp((value-116444736000000000)/10000000,timezone.utc).isoformat()
def sidecar(filename, value):
    target = Path(filename)
    temporary = target.with_name(target.name+'.'+str(os.getpid())+'.tmp')
    temporary.write_text(json.dumps(value,ensure_ascii=True),encoding='utf-8')
    os.replace(temporary,target)
def active(job):
    info = Accounting()
    if not K.QueryInformationJobObject(job,1,c.byref(info),c.sizeof(info),None):
        fail('QueryInformationJobObject')
    return info.active

def run(config_path):
    cfg = {}
    for line in Path(config_path).read_text(encoding='utf-8-sig').splitlines():
        name,encoded = line.split('=',1)
        cfg[name] = base64.b64decode(encoded).decode('utf-8')
    plan = json.loads(cfg['appcontainerPlan'])
    argv = json.loads(cfg['argv'])
    if not argv or argv[0] != cfg['filePath'] or Path(cfg['cwd']).resolve()!=Path(plan['cwd']).resolve():
        raise RuntimeError('Execution command/workspace does not match its plan')
    module_file = Path(plan['boundaryModule'])
    source = module_file.read_bytes()
    if hashlib.sha256(source).hexdigest()!=plan['boundaryModuleSha256']:
        raise RuntimeError('Approved AppContainer implementation changed')
    boundary = ModuleType('operator_existing_appcontainer')
    boundary.__file__ = str(module_file)
    exec(compile(source,str(module_file),'exec'),boundary.__dict__)
    mapping = r'Software\Classes\Local Settings\Software\Microsoft\Windows\CurrentVersion\AppContainer\Mappings'+'\\'+plan['packageSid']
    with winreg.OpenKey(winreg.HKEY_CURRENT_USER,mapping) as entry:
        if winreg.QueryValueEx(entry,'Moniker')[0]!=plan['profileName']:
            raise RuntimeError('Provisioned AppContainer profile identity differs')
    package = c.c_void_p()
    convert = boundary._advapi32.ConvertStringSidToSidW
    convert.argtypes, convert.restype = [w.LPCWSTR,c.POINTER(c.c_void_p)],w.BOOL
    if not convert(plan['packageSid'],c.byref(package)):
        fail('ConvertStringSidToSidW')
    capabilities = []
    for text in plan['capabilitySids']:
        sid = c.c_void_p()
        if not convert(text,c.byref(sid)):
            fail('ConvertStringSidToSidW')
        capabilities.append(sid)
    c.set_last_error(0)
    job = K.CreateJobObjectW(None,cfg['jobName'])
    error = c.get_last_error()
    if not job or error==183:
        if job: K.CloseHandle(job)
        raise OSError(error,'Cannot create unique execution Job')
    owner,worker = None,None
    streams,threads,stream_errors = [],[],[]
    identity = None
    try:
        limits = Extended()
        limits.basic.flags = 0x2000
        if not K.SetInformationJobObject(job,9,c.byref(limits),c.sizeof(limits)):
            fail('SetInformationJobObject')
        owner = K.OpenProcess(0x100000|0x1000,False,int(cfg['ownerPid']))
        if not owner or datetime.fromisoformat(creation(owner))>datetime.fromisoformat(cfg['ownerRequestedAt'].replace('Z','+00:00')):
            raise RuntimeError('Original execution owner is unavailable or reused')
        verify = boundary._verify_appcontainer_child
        def verify_fenced(pi,**kwargs):
            try:
                observed = verify(pi,**kwargs)
                if not K.AssignProcessToJobObject(job,pi.hProcess):
                    fail('AssignProcessToJobObject')
                return observed
            except BaseException:
                boundary._kernel32.TerminateProcess(pi.hProcess,1)
                boundary._kernel32.WaitForSingleObject(pi.hProcess,3000)
                raise
        boundary._verify_appcontainer_child = verify_fenced
        # Preserve the already prepared provider/runner environment. Windows owns
        # AppContainer profile storage; credentials are never read here.
        worker = boundary.spawn_appcontainer_worker(argv,cwd=cfg['cwd'],package_sid=package,
            capability_sids=capabilities,env=dict(os.environ),profile_name=plan['profileName'])
        observed = boundary._child_appcontainer_state(worker.pid)
        for state in (worker.observed,observed):
            if state['is_appcontainer'] is not True or state['package_sid']!=plan['packageSid'] or state['capabilities_enabled']!=plan['capabilitySids']:
                raise RuntimeError('Observed AppContainer token differs from plan')
        identity = dict(jobName=cfg['jobName'],pid=worker.pid,processCreatedAt=creation(worker.process),startedAt=at(),
            executionBoundary=dict(kind='appcontainer',approvalRef=plan['approvalRef'],suspendedToken=worker.observed,afterResumeToken=observed))
        sidecar(cfg['readyPath'],identity)
        def pump(source,destination,close_destination=False):
            try:
                while True:
                    data = source.read(65536)
                    if not data: break
                    destination.write(data)
                    destination.flush()
            except BrokenPipeError:
                pass # a target may deliberately stop consuming stdin
            except BaseException as error:
                stream_errors.append(str(error))
            finally:
                if close_destination: destination.close()
        for name,pipe in (('stdoutPath',worker.stdout),('stderrPath',worker.stderr)):
            stream = open(cfg[name],'wb',buffering=0)
            streams.append(stream)
            threads.append(threading.Thread(target=pump,args=(pipe,stream),daemon=True))
        if cfg.get('stdinPath'):
            stream = open(cfg['stdinPath'],'rb')
            streams.append(stream)
            threads.append(threading.Thread(target=pump,args=(stream,worker.stdin,True),daemon=True))
        else:
            worker.stdin.close()
        for thread in threads: thread.start()
        owner_lost = False
        while worker.poll() is None:
            if K.WaitForSingleObject(owner,0)==0:
                if not K.TerminateJobObject(job,1): fail('TerminateJobObject')
                owner_lost = True
            time.sleep(0.05)
        code = worker.wait(timeout=3)
        deadline = time.monotonic()+5
        while active(job) and time.monotonic()<deadline: time.sleep(0.05)
        if active(job):
            if not K.TerminateJobObject(job,1): fail('TerminateJobObject')
            deadline = time.monotonic()+5
            while active(job) and time.monotonic()<deadline: time.sleep(0.05)
        count = active(job)
        for thread in threads: thread.join(timeout=2)
        if any(thread.is_alive() for thread in threads) or stream_errors:
            raise RuntimeError('Execution stream completion is unconfirmed')
        receipt = {**identity,'completedAt':at(),'exitCode':code,'release':'confirmed' if count==0 else 'unconfirmed',
            'releaseProof':dict(activeProcessCount=count,confirmed=count==0,ownerWatchdog=True,ownerLost=owner_lost,checkedAt=at())}
        sidecar(cfg['receiptPath'],receipt)
        print(json.dumps(receipt,ensure_ascii=True),flush=True)
        return 0 if count==0 else 1
    finally:
        # Closing this non-inheritable kill-on-close Job fences every child even
        # when startup/token verification or stream handling failed.
        K.CloseHandle(job)
        if worker:
            try: worker.wait(timeout=3)
            finally: worker.close()
        for stream in streams: stream.close()
        if owner: K.CloseHandle(owner)
        boundary._kernel32.LocalFree(package)
        for sid in capabilities: boundary._kernel32.LocalFree(sid)

if __name__=='__main__':
    try:
        sys.exit(run(sys.argv[1]))
    except Exception as error:
        # Control diagnostic only; never reproduce the environment or stdin.
        print(type(error).__name__+': '+str(error),file=sys.stderr,flush=True)
        sys.exit(1)
