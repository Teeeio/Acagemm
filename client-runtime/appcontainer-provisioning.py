"""Operator-only, file-scoped ACL transactions and observed existing UAC transport.

Importing this module is inert. No profile, ACL, identity or privilege is changed
without explicitly calling a transaction through an operator-approved caller.
"""
import copy
import hashlib
import importlib
import json
import os
from pathlib import Path
import sys

READ_MASK = 0x120089


def atomic_json(path, value):
    path = Path(path)
    temporary = path.with_name(path.name + '.pending')
    with temporary.open('w', encoding='utf-8') as stream:
        json.dump(value, stream, ensure_ascii=False, indent=2)
        stream.flush()
        os.fsync(stream.fileno())
    os.replace(temporary, path)


class ProvisioningBlocked(RuntimeError):
    def __init__(self, code, message, receipt=None):
        super().__init__(message)
        self.code, self.receipt = code, receipt


class NarrowAclTransaction:
    """Reusable transaction policy. The ACL and journal ports are injected.

    prepare/grant requires a new journal. cleanup can reopen the same durable
    journal after an explicitly authorized recovery; no automatic retry occurs.
    """
    def __init__(self, plan, port, save, journal=None):
        self.plan, self.port, self.save = copy.deepcopy(plan), port, save
        if (plan.get('schemaVersion') != 'operator-studio.acl-transaction/v1'
                or not plan.get('approvalRef') or not plan.get('transactionId')
                or not str(plan.get('packageSid', '')).startswith('S-1-15-2-')):
            raise ProvisioningBlocked('ACL_PLAN_INVALID', 'An approved transaction and package SID are required')
        targets = plan.get('targets', [])
        if not targets or len(targets) > 64 or len({t['path'] for t in targets}) != len(targets):
            raise ProvisioningBlocked('ACL_PLAN_INVALID', 'Exact, distinct file targets are required')
        self.digest = hashlib.sha256(json.dumps(plan, sort_keys=True).encode()).hexdigest()
        if journal and journal.get('planDigest') != self.digest:
            raise ProvisioningBlocked('ACL_JOURNAL_CONFLICT', 'Recovery belongs to another frozen plan')
        self.journal = copy.deepcopy(journal) if journal else {
            'schemaVersion': 'operator-studio.acl-journal/v1', 'planDigest': self.digest,
            'transactionId': plan['transactionId'], 'approvalRef': plan['approvalRef'],
            'packageSid': plan['packageSid'], 'state': 'new', 'consumersPossible': False, 'files': [], 'errors': []}

    def persist(self):
        self.save(copy.deepcopy(self.journal))

    def snapshot(self, target):
        state = self.port.snapshot(target['path'])
        if (state.get('identity') != target.get('identity') or state.get('reparse')
                or state.get('directory') or state.get('nullDacl') or state.get('unparsedTypes')):
            raise ProvisioningBlocked('ACL_RESOURCE_IDENTITY_CONFLICT', target['path'])
        if target.get('ownerSid') and state.get('ownerSid') != target['ownerSid']:
            raise ProvisioningBlocked('ACL_RESOURCE_IDENTITY_CONFLICT', 'Frozen owner changed: '+target['path'])
        return state

    def verify_delta(self, before, current, allow_absent=False):
        if current['identity'] != before['identity'] or current['ownerSid'] != before['ownerSid']:
            raise ProvisioningBlocked('ACL_RESOURCE_IDENTITY_CONFLICT', 'File identity/owner changed')
        own = [a for a in current['aces'] if a['sid'] == self.plan['packageSid']]
        others = [a for a in current['aces'] if a['sid'] != self.plan['packageSid']]
        if others != before['aces']:
            raise ProvisioningBlocked('ACL_DRIFT', 'An unrelated ordered ACE changed')
        if not own and allow_absent and current['fingerprint'] == before['fingerprint']:
            return False
        if len(own) != 1 or own[0]['type'] != 0 or own[0]['mask'] != READ_MASK or own[0]['flags'] != 0:
            raise ProvisioningBlocked('ACL_DELTA_INVALID', 'Only one file-only Allow Read ACE is authorized')
        return True

    def grant(self):
        if self.journal['state'] != 'new':
            raise ProvisioningBlocked('ACL_TRANSACTION_EXISTS', 'Reconcile existing journal; do not replay grant')
        # All checks precede the first mutation, including WRITE_DAC and SID absence.
        for target in self.plan['targets']:
            before = self.snapshot(target)
            if before['fingerprint'] != target['beforeFingerprint']:
                raise ProvisioningBlocked('ACL_DRIFT', target['path'])
            if any(a['sid'] == self.plan['packageSid'] for a in before['aces']):
                raise ProvisioningBlocked('ACL_PREEXISTING_GRANT', target['path'])
            if not self.port.has_write_dac(target['path']):
                raise ProvisioningBlocked('ACL_PROVISIONING_PERMISSION_REQUIRED', target['path'])
            self.journal['files'].append({'target': target, 'before': before, 'state': 'prepared'})
        self.journal['state'] = 'prepared'
        self.persist()
        try:
            for entry in self.journal['files']:
                target, before = entry['target'], entry['before']
                if self.snapshot(target) != before:
                    raise ProvisioningBlocked('ACL_DRIFT', target['path'])
                entry['state'] = 'grant-intent'
                self.persist()  # Intent survives an exception after an ACL write.
                result = self.port.grant_read(target['path'], self.plan['packageSid'])
                current = self.snapshot(target)
                self.verify_delta(before, current)
                if result.get('winerror', 0) != 0:
                    raise ProvisioningBlocked('ACL_GRANT_FAILED', target['path'])
                entry.update(state='granted', afterFingerprint=current['fingerprint'])
                self.persist()
            self.journal['state'] = 'granted'
            self.persist()
        except Exception as error:
            self.journal['errors'].append({'phase': 'grant', 'code': getattr(error, 'code', 'ACL_GRANT_FAILED'), 'message': str(error)})
            # No consumer could have started before the complete grant receipt.
            self.cleanup({'confirmed': True, 'activeProcessCount': 0, 'source': 'not-started'})
            if self.journal['state'] == 'clean':
                self.journal['state'] = 'grant-failed-rolled-back'
                self.persist()
        return copy.deepcopy(self.journal)

    def claim_consumer(self):
        """Durably claim BEFORE starting any consumer; an unknown start stays blocked."""
        if self.journal['state'] != 'granted':
            raise ProvisioningBlocked('ACL_GRANT_NOT_READY', 'Only a completed grant may start a consumer')
        self.journal['consumersPossible'] = True
        self.persist()

    def cleanup(self, release):
        if release.get('confirmed') is not True or release.get('activeProcessCount') != 0:
            raise ProvisioningBlocked('ACL_CONSUMER_RELEASE_UNKNOWN', 'Cleanup requires confirmed consumer release')
        if release.get('source') == 'not-started' and self.journal['consumersPossible']:
            raise ProvisioningBlocked('ACL_CONSUMER_RELEASE_UNKNOWN', 'A completed grant needs the real consumer release proof')
        if self.journal['consumersPossible'] and (release.get('source') != 'windows-job-object'
                or not release.get('jobName') or not isinstance(release.get('pid'), int) or release['pid'] <= 0
                or not release.get('processCreatedAt')):
            raise ProvisioningBlocked('ACL_CONSUMER_RELEASE_UNKNOWN', 'A bound Job/PID/creation receipt is required')
        self.journal['state'] = 'cleanup-required'
        self.persist()
        failures = []
        for entry in reversed(self.journal['files']):
            if entry['state'] == 'prepared':
                continue
            try:
                current = self.snapshot(entry['target'])
                present = self.verify_delta(entry['before'], current, allow_absent=True)
                if present:
                    entry['state'] = 'revoke-intent'
                    self.persist()
                    result = self.port.revoke_read(entry['target']['path'], self.plan['packageSid'])
                    if result.get('winerror', 0) != 0:
                        raise ProvisioningBlocked('ACL_REVOKE_FAILED', entry['target']['path'])
                after = self.snapshot(entry['target'])
                if after != entry['before']:
                    raise ProvisioningBlocked('ACL_REVOKE_UNVERIFIED', entry['target']['path'])
                entry['state'] = 'restored'
                self.persist()
            except Exception as error:
                failures.append({'phase': 'revoke', 'path': entry['target']['path'],
                                 'code': getattr(error, 'code', 'ACL_REVOKE_FAILED'), 'message': str(error)})
        self.journal['errors'].extend(failures)
        if not failures:
            # Untouched prepared targets must still match their original snapshot.
            if all(self.snapshot(e['target']) == e['before'] for e in self.journal['files']):
                self.journal['state'] = 'clean'
        self.persist()
        return copy.deepcopy(self.journal)


def observed_uac_call(runner, observer, source, result_path, argv=(), timeout=60):
    """Reuse the existing UAC launcher with an injected wait/close monitor.

    A timeout/live process keeps its handle open. The monitor writes a receipt
    even when launch/result parsing fails. Only a signaled handle + final exit
    code grants termination; a result file alone never grants it.
    """
    receipt = {'state': 'unknown', 'terminated': False, 'waitResult': None,
               'exitCode': None, 'pid': None, 'processCreatedAt': None}
    original_wait, original_close = runner._kernel32.WaitForSingleObject, runner._kernel32.CloseHandle
    tracked = {}

    def monitored_wait(handle, milliseconds):
        tracked['handle'] = handle
        identity = observer.identity(handle)
        receipt.update(identity)
        result = original_wait(handle, milliseconds)
        receipt['waitResult'] = int(result)
        code = observer.exit_code(handle)
        receipt['exitCode'] = code
        receipt['terminated'] = (result == 0 and isinstance(code, int) and code != 259
                                 and isinstance(receipt['pid'], int) and receipt['pid'] > 0
                                 and bool(receipt['processCreatedAt']))
        receipt['state'] = 'exited' if receipt['terminated'] else 'active' if code == 259 else 'unknown'
        observer.save(receipt)
        return result

    def monitored_close(handle):
        if handle == tracked.get('handle') and not receipt['terminated']:
            observer.retain(handle, copy.deepcopy(receipt))
            tracked['retained'] = True
            return True
        return original_close(handle)

    runner._kernel32.WaitForSingleObject, runner._kernel32.CloseHandle = monitored_wait, monitored_close
    try:
        payload = runner.run_elevated_python(source, result_path=result_path, argv=argv, timeout=timeout)
        if not receipt['terminated']:
            raise ProvisioningBlocked('UAC_PROCESS_RELEASE_UNKNOWN', 'Helper has no verified terminal receipt', receipt)
        if receipt['exitCode'] != 0:
            raise ProvisioningBlocked('UAC_HELPER_FAILED', 'Helper exited unsuccessfully', receipt)
        return {'process': copy.deepcopy(receipt), 'payload': payload}
    except Exception as error:
        if tracked.get('handle') is not None and not receipt['terminated'] and not tracked.get('retained'):
            observer.retain(tracked['handle'], copy.deepcopy(receipt))
        if tracked.get('handle') is None and receipt['pid'] is None and (getattr(error, 'winerror', None) == 1223 or '1223' in str(error)):
            receipt.update(state='cancelled', code='UAC_CANCELLED', launched=False)
        receipt['error'] = {'code': getattr(error, 'code', 'UAC_CALL_FAILED'), 'message': str(error)}
        observer.save(receipt)
        raise ProvisioningBlocked(receipt.get('code') or receipt['error']['code'], str(error), copy.deepcopy(receipt)) from error
    finally:
        runner._kernel32.WaitForSingleObject, runner._kernel32.CloseHandle = original_wait, original_close


def load_pinned_dispatch(source_pins):
    """Load only explicitly pinned external public implementations; never edit them."""
    paths = [Path(p).resolve() for p in source_pins]
    root = next(p.parent.parent for p in paths if p.name == 'storage_toolchain.py')
    for path in paths:
        if hashlib.sha256(path.read_bytes()).hexdigest() != source_pins[str(path)]:
            raise ProvisioningBlocked('ACL_IMPLEMENTATION_DRIFT', str(path))
    if set(p.name for p in paths) != {'__init__.py', 'storage_acl.py', 'storage_boundary.py', 'storage_toolchain.py'}:
        raise ProvisioningBlocked('ACL_IMPLEMENTATION_INVALID', 'Pin the complete external import set')
    if any(p.parent != root / 'dispatch' for p in paths):
        raise ProvisioningBlocked('ACL_IMPLEMENTATION_INVALID', 'External implementations must share the pinned package')
    sys.path.insert(0, str(root))
    try:
        modules = [importlib.import_module('dispatch.' + name) for name in ('storage_acl', 'storage_boundary', 'storage_toolchain')]
        if any(Path(m.__file__).resolve().parent != root / 'dispatch' for m in modules):
            raise ProvisioningBlocked('ACL_IMPLEMENTATION_INVALID', 'A different dispatch package was already loaded')
        return modules
    finally:
        sys.path.remove(str(root))


class NativeAclPort:
    """Existing ACL public APIs plus read-only object/owner identity checks."""
    def __init__(self, acl):
        import ctypes as c
        from ctypes import wintypes as w
        self.acl, self.c, self.w = acl, c, w
        self.a = c.WinDLL('advapi32', use_last_error=True)
        self.a.GetNamedSecurityInfoW.argtypes = [w.LPWSTR, c.c_int, w.DWORD,
            c.POINTER(c.c_void_p), c.c_void_p, c.c_void_p, c.c_void_p, c.POINTER(c.c_void_p)]
        self.a.GetNamedSecurityInfoW.restype = w.DWORD

    def snapshot(self, path):
        c = self.c
        path = Path(path)
        for ancestor in [path, *path.parents]:
            if ancestor.stat(follow_symlinks=False).st_file_attributes & 0x400:
                raise ProvisioningBlocked('ACL_RESOURCE_IDENTITY_CONFLICT', 'Reparse path refused')
        stat = path.stat(follow_symlinks=False)
        owner, sd = c.c_void_p(), c.c_void_p()
        code = self.a.GetNamedSecurityInfoW(str(path), 1, 1, c.byref(owner), None, None, None, c.byref(sd))
        if code:
            raise ProvisioningBlocked('ACL_RESOURCE_UNREADABLE', 'Owner lookup failed: '+str(code))
        try:
            owner_sid = self.acl.as_sid_text(owner)
        finally:
            self.acl._kernel32.LocalFree(sd)
        info = self.acl.read_dacl(path)
        if info['error_code']:
            raise ProvisioningBlocked('ACL_RESOURCE_UNREADABLE', 'DACL lookup failed')
        return {'identity': {'device': stat.st_dev, 'fileId': stat.st_ino}, 'ownerSid': owner_sid,
                'reparse': False, 'directory': bool(stat.st_file_attributes & 0x10),
                'nullDacl': info['null_dacl'], 'unparsedTypes': info['unparsed_types'],
                'fingerprint': self.acl.acl_fingerprint(path), 'aces': info['aces']}

    def has_write_dac(self, path):
        return self.acl.has_write_dac(path)

    def grant_read(self, path, sid):
        return self.acl.grant_read(path, sid, rights='read')

    def revoke_read(self, path, sid):
        return self.acl.revoke_read(path, sid)


class NativeProcessObserver:
    """No PID-only inference or termination. Retains unknown process handles."""
    def __init__(self, receipt_path):
        import ctypes as c
        from ctypes import wintypes as w
        self.c, self.w, self.receipt_path, self.retained = c, w, Path(receipt_path), []
        self.k = c.WinDLL('kernel32', use_last_error=True)
        self.k.GetProcessId.argtypes = [w.HANDLE]; self.k.GetProcessId.restype = w.DWORD
        self.k.GetProcessTimes.argtypes = [w.HANDLE, *([c.POINTER(w.FILETIME)]*4)]
        self.k.GetProcessTimes.restype = w.BOOL
        self.k.GetExitCodeProcess.argtypes = [w.HANDLE, c.POINTER(w.DWORD)]
        self.k.GetExitCodeProcess.restype = w.BOOL
        self.k.WaitForSingleObject.argtypes = [w.HANDLE, w.DWORD]
        self.k.WaitForSingleObject.restype = w.DWORD
        self.k.CloseHandle.argtypes = [w.HANDLE]; self.k.CloseHandle.restype = w.BOOL

    def identity(self, handle):
        times = [self.w.FILETIME() for _ in range(4)]
        pid = self.k.GetProcessId(handle)
        if not pid or not self.k.GetProcessTimes(handle, *[self.c.byref(t) for t in times]):
            raise ProvisioningBlocked('UAC_PROCESS_IDENTITY_UNKNOWN', 'Cannot bind real helper identity')
        created = (times[0].dwHighDateTime << 32) | times[0].dwLowDateTime
        return {'pid': pid, 'processCreatedAt': str(created)}

    def exit_code(self, handle):
        code = self.w.DWORD()
        if not self.k.GetExitCodeProcess(handle, self.c.byref(code)):
            raise ProvisioningBlocked('UAC_PROCESS_EXIT_UNKNOWN', 'Exit-code query failed')
        return code.value

    def save(self, receipt):
        atomic_json(self.receipt_path, receipt)

    def retain(self, handle, receipt):
        if not any(h == handle for h, _ in self.retained):
            self.retained.append((handle, receipt))

    def inspect_retained(self):
        results = []
        for handle, old in list(self.retained):
            if self.identity(handle) != {k: old[k] for k in ('pid', 'processCreatedAt')}:
                raise ProvisioningBlocked('UAC_PROCESS_IDENTITY_CONFLICT', 'Retained process identity changed')
            wait = self.k.WaitForSingleObject(handle, 0)
            code = self.exit_code(handle)
            current = {**old, 'waitResult': wait, 'exitCode': code,
                       'terminated': wait == 0 and code != 259}
            current['state'] = 'exited' if current['terminated'] else 'active' if code == 259 else 'unknown'
            results.append(current)
            self.save(current)
            if current['terminated']:
                self.k.CloseHandle(handle)
                self.retained.remove((handle, old))
        return results
