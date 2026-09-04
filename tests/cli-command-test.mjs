import assert from 'node:assert/strict';
import path from 'node:path';
import { resolveCliInvocation } from '../client-runtime/cli-command.mjs';

const npmRoot = path.resolve('C:/agent-cli');
const whereImpl = (_command, args) => ({ status: 0, stdout: `${path.join(npmRoot, args[0])}\r\n` });
const available = new Set([
  path.join(npmRoot, 'node.exe'),
  path.join(npmRoot, 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe'),
  path.join(npmRoot, 'node_modules', '@openai', 'codex', 'bin', 'codex.js'),
]);
const existsImpl = (candidate) => available.has(candidate);

const claude = resolveCliInvocation({ provider: 'claude', configuredCommand: 'claude', platform: 'win32', whereImpl, existsImpl });
assert.equal(claude.command, path.join(npmRoot, 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe'));
assert.deepEqual(claude.prefixArgs, []);

const codex = resolveCliInvocation({ provider: 'codex', configuredCommand: 'codex', platform: 'win32', whereImpl, existsImpl });
assert.equal(codex.command, path.join(npmRoot, 'node.exe'));
assert.deepEqual(codex.prefixArgs, [path.join(npmRoot, 'node_modules', '@openai', 'codex', 'bin', 'codex.js')]);

const explicit = resolveCliInvocation({ provider: 'codex', configuredCommand: 'custom-codex.exe', platform: 'win32', whereImpl, existsImpl });
assert.equal(explicit.command, 'custom-codex.exe');
assert.deepEqual(explicit.prefixArgs, []);

const unix = resolveCliInvocation({ provider: 'claude', configuredCommand: 'claude', platform: 'linux', whereImpl, existsImpl });
assert.deepEqual(unix, { command: 'claude', prefixArgs: [], requested: 'claude' });

console.log('[cli-command] Windows npm shims and direct commands resolve to executable invocations');
