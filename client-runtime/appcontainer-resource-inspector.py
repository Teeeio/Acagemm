"""Read-only Windows resource observations. Never provisions or starts a target."""
import importlib.util
import json
from pathlib import Path
import sys
import winreg

sys.dont_write_bytecode = True
source = Path(__file__).with_name('appcontainer-provisioning.py')
spec = importlib.util.spec_from_file_location('operator_provisioning', source)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
request = json.loads(sys.stdin.buffer.read(131073))
receipt, plan = request['receipt'], request['plan']
acl, _, _ = module.load_pinned_dispatch(receipt['sourcePins'])
port = module.NativeAclPort(acl)
mapping = r'Software\Classes\Local Settings\Software\Microsoft\Windows\CurrentVersion\AppContainer\Mappings' + '\\' + plan['packageSid']
matches = False
try:
    with winreg.OpenKey(winreg.HKEY_CURRENT_USER, mapping) as entry:
        matches = winreg.QueryValueEx(entry, 'Moniker')[0] == plan['profileName']
except FileNotFoundError:
    pass
observations = []
for resource in receipt['resources']:
    row = {'resourceId': resource['resourceId']}
    try:
        row.update(port.snapshot(resource['path']), hasWriteDac=port.has_write_dac(resource['path']))
    except Exception as error:
        row['error'] = getattr(error, 'code', 'APPCONTAINER_RESOURCE_UNREADABLE')
    observations.append(row)
print(json.dumps({'profileMatches': matches, 'resources': observations}))
