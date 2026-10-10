// Run the PowerShell Job owner in a detached native Node supervisor. Windows
// PowerShell can silently exit when directly spawned with DETACHED_PROCESS;
// Node supports that mode. Strict supervision additionally uses a native
// bootstrap to verify escape from inherited Jobs before resuming this Node;
// detachment alone survives owner exit, not enclosing tool-Job termination.
// The helper's held original-owner handle cancels only the bound target Job,
// while the helper's held owner handle still cancels only the bound Job tree.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';
const configPath = process.argv[2];
if (!configPath) throw new TypeError('Job configuration path is required.');
process.stdout.on('error', () => {});
process.stderr.on('error', () => {});
const helperScript = fileURLToPath(new URL('./windows-job-object-helper.ps1', import.meta.url));
const values = Object.fromEntries((await readFile(configPath, 'utf8')).split('\n').filter(Boolean).map(line => {
  const split = line.indexOf('=');
  return [line.slice(0, split), Buffer.from(line.slice(split + 1), 'base64').toString('utf8')];
}));
const boundary = values.appcontainerPlan ? JSON.parse(values.appcontainerPlan) : null;
const executable = boundary ? boundary.pythonExecutable : 'powershell.exe';
const arguments_ = boundary ? ['-B', '-u', fileURLToPath(new URL('./appcontainer-job-helper.py', import.meta.url)), configPath]
  : ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', helperScript, '-Action', 'start', '-Config', configPath];
const helper = spawn(executable, arguments_, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
helper.stdout.on('data', value => { try { process.stdout.write(value); } catch { /* Lost observer is not the execution owner. */ } });
helper.stderr.on('data', value => { try { process.stderr.write(value); } catch { /* Keep supervision after owner loss. */ } });
helper.once('error', () => { process.exitCode = 1; });
helper.once('close', code => { process.exitCode = Number.isInteger(code) ? code : 1; });
