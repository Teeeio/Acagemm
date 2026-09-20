# Claude Permission Surface Module Contract

模块归属：`client-runtime/` 根级纯叶子模块。不做 I/O、不 spawn 进程、不读时钟、不 import 运行时实现，
供 `claude-client.mjs` 与测试共用。

## Purpose

推导 Claude Code 一次运行的**能力强制面**：工具面档位与配置根里的写拒绝规则。

背景（本机实测，细节见 `claude-client.md`）：`--permission-mode` 不构成写边界。真正有牙齿的是工具面
与 `settings.json` 的 `permissions.deny`。这两者必须由 **grant** 派生，而不是由 role 名字派生——
否则会出现「声明只读、实际拿得到写工具」的分歧。

## Public API

| 导出 | 说明 |
|---|---|
| `resolveClaudeToolSurface({ role, writableDirectories, readOnlyDirectories })` | `{ allowedTools, disallowedTools, writeToolsWithheld, webResearch }` |
| `writeDenyRulesFor(directories)` | 只读根 → `['Edit(//c/path/**)']`，去重 |
| `claudeRulePath(absolutePath)` | Windows 路径 → 规则路径写法（`C:\x` → `//c/x`） |
| `buildClaudeSettings({ denyRules })` | `{ permissions: { deny: [...] } }` |
| `CLAUDE_WRITE_RULE_NAME` | `'Edit'` |
| `CLAUDE_WRITE_TOOLS` / `CLAUDE_SHELL_TOOLS` | `['Write','Edit']` / `['Bash','NotebookEdit']` |

## Invariants

- **写工具摘除的判定是 grant**：`readOnlyDirectories.length > 0 && writableDirectories.length === 0`。
  role 只用来挑「联网研究」与非联网这两档读工具集，不参与写能力的判定。
- 任何档位的工具面都不含 shell 类工具。
- 写规则名只能是 `Edit(...)`；`Write(...)` 永不被文件权限检查匹配。
- 规则路径必须小写盘符、无冒号、双斜杠锚点；`//C:/x` 形式不匹配。
- 只读根的 deny 规则是**纵深防御**，主边界是工具面摘除。
- 函数是全定义的：非法组合（如 acquire 缺只读根）不在本模块抛错——本模块无法判断那是不是错误，
  只如实描述其后果。拒绝由 `claude-client.mjs` 负责（`CLAUDE_ACQUIRE_GRANT_MISSING`）。

## Non-Responsibilities

- 不决定要不要授予某个根（调用方决定）。
- 不写文件、不读 settings、不校验规则是否真的生效——那是 `claude-client.mjs` 的职责。
- 不覆盖读侧：仓库不声称有任何读边界。
