import path from 'node:path';

// Claude Code 的能力强制面推导。纯函数叶子模块：不做 I/O、不 spawn 进程、不读时钟。
//
// 为什么需要它（全部为本机实测结论，见 claude-client.mjs 头部注释）：
//  - `--permission-mode` 在 `-p` 下**不构成写边界**。acceptEdits / dontAsk / bypassPermissions，
//    以及把配置根隔离到运行时自己的目录，四种情形下 workspace 之外的写入都成功。它决定 CLI 的
//    交互行为，不决定能力上限——所以适配器此前那个「拒绝非 acceptEdits」的守卫拦的是一个**名字**，
//    不是一个能力差，它看起来提供的保证大于实际。
//  - 真正有牙齿的是两条通道：①工具面（--tools / --disallowedTools）——能力根本不存在；
//    ②配置根 settings.json 里的 permissions.deny——逐次调用被拒。本模块推导这两者。
//
// 因此能力边界由 **grant** 决定，不由 role 名字决定：持有只读引用根、又不持有任何可写根的运行，
// 就不该在工具面上拥有写工具。role 只用来区分「联网研究」与非联网这两档读工具集。
//
// 这条正是此前的真实缺陷：写工具摘除写死在 `role === 'research-acquire'` 上，于是任何**别的**
// role 只要传 readOnlyDirectories，就会同时拿到读授权与写工具。

// 文件权限检查从不匹配名为 `Write(...)` 的规则（2.1.275 起写规则的名字是 `Edit`）。
// 写成 Write(...) 会长久地看起来「配了 deny」，实际一条都不匹配。
export const CLAUDE_WRITE_RULE_NAME = 'Edit';

// 写工具。摘除写能力时它们必须从工具面消失，而不只是被规则拒绝。
export const CLAUDE_WRITE_TOOLS = Object.freeze(['Write', 'Edit']);
// shell 类工具不属于本研究工作流，在所有档位都摘除。
export const CLAUDE_SHELL_TOOLS = Object.freeze(['Bash', 'NotebookEdit']);

// 工具面档位（保持与改动前逐字一致的字符串，只替换判定键）。
const READ_ONLY_WEB_SURFACE = Object.freeze({
  allowedTools: 'Read,Glob,Grep,WebSearch,WebFetch',
  disallowedTools: 'Bash,NotebookEdit,Write,Edit',
});
const WRITABLE_WEB_SURFACE = Object.freeze({
  allowedTools: 'Read,Glob,Grep,Write,Edit,WebSearch,WebFetch',
  disallowedTools: 'Bash,NotebookEdit',
});
const WRITABLE_LOCAL_SURFACE = Object.freeze({
  allowedTools: 'Read,Write,Edit',
  disallowedTools: 'Bash,NotebookEdit',
});

// Windows 路径 → claude 规则里的路径写法：先归一化成 POSIX，再小写盘符、去掉冒号、加双斜杠锚点。
// 实测正确写法是 `Edit(//c/x/**)`；`Edit(//C:/x/**)`（大写 + 带冒号）不匹配。
export const claudeRulePath = (absolutePath) => {
  const posix = String(path.resolve(absolutePath)).replace(/\\/g, '/');
  const drive = /^([A-Za-z]):\//.exec(posix);
  return drive ? `//${drive[1].toLowerCase()}${posix.slice(2)}` : posix;
};

// 只读根的写拒绝规则。这是纵深防御：主边界是工具面摘除，本规则覆盖「某个工具仍能走到写路径」的残余面。
export const writeDenyRulesFor = (directories = []) => [
  ...new Set((directories || []).filter(Boolean).map((directory) => `${CLAUDE_WRITE_RULE_NAME}(${claudeRulePath(directory)}/**)`)),
];

export const buildClaudeSettings = ({ denyRules = [], experimentIsolation = false } = {}) => ({
  permissions: { deny: [...new Set((denyRules || []).filter(Boolean))],
    ...(experimentIsolation ? { blockReadsOutsideWorkingDirectories: true } : {}) },
  ...(experimentIsolation ? { autoMemoryEnabled: false } : {}),
});

// 工具面由 grant 派生。纯函数、全定义：非法组合（如 acquire 没带只读根）由调用方拒绝，
// 不在这里抛——这里无法判断那是不是一个错误，只能如实描述它的后果。
export const resolveClaudeToolSurface = ({ role, writableDirectories = [], readOnlyDirectories = [] }) => {
  const writable = (writableDirectories || []).filter(Boolean);
  const readOnly = (readOnlyDirectories || []).filter(Boolean);
  const writeToolsWithheld = readOnly.length > 0 && writable.length === 0;
  const webResearch = role === 'research-acquire' || role === 'research-experience';
  const surface = writeToolsWithheld
    ? READ_ONLY_WEB_SURFACE
    : webResearch ? WRITABLE_WEB_SURFACE : WRITABLE_LOCAL_SURFACE;
  return { ...surface, writeToolsWithheld, webResearch };
};
