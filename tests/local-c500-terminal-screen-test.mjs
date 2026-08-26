import assert from 'node:assert/strict';
import { createTerminalScreenSession, terminalScreenSequences } from '../tools/local-c500-tester/terminal-screen.mjs';

const writes = [];
const tty = { isTTY: true, write: (value) => { writes.push(value); return true; } };
const session = createTerminalScreenSession(tty);

assert.equal(session.active, false);
assert.equal(session.enter(), true);
assert.equal(session.active, true);
assert.equal(session.enter(), false, 'enter must be idempotent');
assert.deepEqual(writes, [terminalScreenSequences.enter]);
assert.match(terminalScreenSequences.enter, /^\u001b\[\?1049h/);
assert.match(terminalScreenSequences.enter, /\u001b\[2J\u001b\[3J\u001b\[H$/);
assert.equal(session.leave(), true);
assert.equal(session.active, false);
assert.equal(session.leave(), false, 'leave must be idempotent');
assert.deepEqual(writes, [terminalScreenSequences.enter, terminalScreenSequences.leave]);

const redirectedWrites = [];
const redirected = createTerminalScreenSession({ isTTY: false, write: (value) => redirectedWrites.push(value) });
assert.equal(redirected.enter(), false, 'redirected output must remain plain text');
assert.equal(redirected.leave(), false);
assert.deepEqual(redirectedWrites, []);

console.log('[local-c500-terminal-screen] alternate screen lifecycle passed');
