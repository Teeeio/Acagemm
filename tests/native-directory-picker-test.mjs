import assert from 'node:assert/strict';
import { createNativeDirectoryPicker } from '../client-runtime/native-directory-picker.mjs';

let invocation;
const picker = createNativeDirectoryPicker({
  platform: 'win32',
  env: { SystemRoot: 'C:\\Windows' },
  execFileImpl(command, args, options, callback) {
    invocation = { command, args, options };
    callback(null, '{"cancelled":false,"path":"C:\\\\work\\\\kernels"}', '');
  },
});

const selection = await picker.select('C:\\work');
assert.deepEqual(selection, { cancelled: false, path: 'C:\\work\\kernels' });
assert.match(invocation.command, /WindowsPowerShell[\\/]v1\.0[\\/]powershell\.exe$/i);
assert.deepEqual(invocation.args.slice(0, 2), ['-NoProfile', '-STA']);
assert.equal(invocation.options.env.OPERATOR_DIRECTORY_INITIAL_PATH, 'C:\\work');
assert.equal(invocation.options.windowsHide, true);

const unsupported = createNativeDirectoryPicker({ platform: 'freebsd' });
await assert.rejects(() => unsupported.select(), (error) => error.code === 'NATIVE_DIRECTORY_PICKER_UNAVAILABLE');

console.log('[native-directory-picker] native dialog contract passed');
