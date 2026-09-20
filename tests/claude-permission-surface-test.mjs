// Claude 能力强制面推导的纯测试：不 spawn 任何进程、不碰磁盘、不读时钟。
import assert from 'node:assert/strict';
import {
  CLAUDE_WRITE_RULE_NAME,
  buildClaudeSettings,
  claudeRulePath,
  resolveClaudeToolSurface,
  writeDenyRulesFor,
} from '../client-runtime/claude-permission-surface.mjs';

// ---- Windows 路径 → 规则路径 ----
// 实测正确写法是 //c/x：小写盘符、无冒号、双斜杠绝对锚点。写成 //C:/x 不匹配。
assert.equal(claudeRulePath('C:\\work\\sources'), '//c/work/sources');
assert.equal(claudeRulePath('c:/work/sources'), '//c/work/sources');
assert.equal(claudeRulePath('F:\\设计\\快速项目\\acagemm原型\\sources'), '//f/设计/快速项目/acagemm原型/sources');
// 大小写归一：盘符必须小写，否则规则永不匹配。
assert.match(claudeRulePath('D:\\Mixed\\Case'), /^\/\/d\//);
assert.equal(claudeRulePath('D:\\Mixed\\Case').includes('\\'), false, 'rule paths must use forward slashes');

// ---- 写拒绝规则 ----
// 文件权限检查从不匹配名为 Write(...) 的规则（2.1.275 起写规则叫 Edit）。写成 Write(...) 会长久地
// 看起来「配了 deny」，实际一条都不匹配——这正是必须把规则名固定下来的原因。
assert.equal(CLAUDE_WRITE_RULE_NAME, 'Edit');
const rules = writeDenyRulesFor(['C:\\a', 'C:\\a', 'C:\\b']);
assert.deepEqual(rules, ['Edit(//c/a/**)', 'Edit(//c/b/**)'], 'rules must be deduplicated and use the Edit(...) form');
assert.ok(rules.every((rule) => rule.startsWith('Edit(')), 'a Write(...) rule would never match anything');
assert.deepEqual(writeDenyRulesFor([]), []);
assert.deepEqual(writeDenyRulesFor([null, undefined, '']), [], 'empty grants must not produce empty-path rules');

assert.deepEqual(buildClaudeSettings({ denyRules: rules }), { permissions: { deny: rules } });
assert.deepEqual(buildClaudeSettings({ denyRules: [] }), { permissions: { deny: [] } });
assert.deepEqual(buildClaudeSettings(), { permissions: { deny: [] } });

// ---- 工具面由 grant 派生 ----
const writable = ['C:\\workspace'];
const readOnly = ['C:\\sources'];

// 只读根 + 无可写根 → 摘除写工具（联网研究档）。
const readOnlyWeb = resolveClaudeToolSurface({ role: 'research-acquire', writableDirectories: [], readOnlyDirectories: readOnly });
assert.equal(readOnlyWeb.writeToolsWithheld, true);
assert.equal(readOnlyWeb.allowedTools, 'Read,Glob,Grep,WebSearch,WebFetch');
assert.equal(readOnlyWeb.disallowedTools, 'Bash,NotebookEdit,Write,Edit');

// 关键回归：判定键是 grant，不是 role 名字。同一个只读根，换任何 role 都应摘除写工具——
// 此前写死在 role === 'research-acquire' 上，别的 role 传 readOnlyDirectories 会拿到写工具。
for (const role of ['iteration', 'materializer', 'stage', 'research-synthesize']) {
  const surface = resolveClaudeToolSurface({ role, writableDirectories: [], readOnlyDirectories: readOnly });
  assert.equal(surface.writeToolsWithheld, true, `${role} holding only a read-only root must not get write tools`);
  assert.equal(surface.disallowedTools.includes('Write'), true);
  assert.equal(surface.allowedTools.includes('Write'), false, `${role} must not be offered a write tool it cannot use`);
}

// 同时持有可写根与只读根 → 不摘除（同一次运行本就被 CLAUDE_DIRECTORY_GRANT_CONFLICT 拒绝，
// 这里说明的是推导本身不会误摘）。
const mixed = resolveClaudeToolSurface({ role: 'iteration', writableDirectories: writable, readOnlyDirectories: readOnly });
assert.equal(mixed.writeToolsWithheld, false);
assert.equal(mixed.allowedTools, 'Read,Write,Edit');

// 无任何 grant → 保持改动前的本地档位。
const plain = resolveClaudeToolSurface({ role: 'iteration' });
assert.equal(plain.writeToolsWithheld, false);
assert.equal(plain.allowedTools, 'Read,Write,Edit');
assert.equal(plain.disallowedTools, 'Bash,NotebookEdit');

// role 只用来区分联网/非联网这一档读工具集。
const webWritable = resolveClaudeToolSurface({ role: 'research-experience', writableDirectories: writable });
assert.equal(webWritable.allowedTools, 'Read,Glob,Grep,Write,Edit,WebSearch,WebFetch');
assert.equal(webWritable.webResearch, true);
// 可写档的可写面：写工具在场，shell 始终不在。
assert.equal(webWritable.disallowedTools, 'Bash,NotebookEdit');
for (const surface of [readOnlyWeb, mixed, plain, webWritable]) {
  assert.ok(surface.disallowedTools.includes('Bash'), 'shell must never be part of any surface');
  assert.ok(surface.disallowedTools.includes('NotebookEdit'));
}

console.log('[claude-permission-surface] grant-derived tool surface and deny rules passed');
