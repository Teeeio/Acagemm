# Claude Code Adapter Module Contract

模块归属：`client-runtime/` 下的 provider 适配器，实现 `agent-runtime` 使用的最小 agent 运行契约。
CLI 探测、参数拼装、事件归一化、运行记录与取消传播都在这里；策略与编排不在。

## Purpose

把本机的 Claude Code CLI 包成 `agent-runtime` 能用的运行体。关键约束是**能力边界必须由适配器自己
拥有**：宿主的 `~/.claude/settings.json`、宿主的工作目录默认值，都不得悄悄参与本次运行的授权。

## Public API

| 导出 | 说明 |
|---|---|
| `createClaudeClient(options)` | 构造客户端。options：`command`、`bridgeDir`、`permissionMode`、`spawnImpl`、`execFileImpl`、`terminateProcessTreeImpl`、`descriptorTtlMs` |
| `client.describe()` | CLI 是否安装、是否登录、版本（带 TTL 缓存） |
| `client.preflight({ workspace })` | `{ ready, code, workspace, command, version, configurationAuthority, permissionMode, permissionModeIsBoundary }` |
| `client.start({ runId, missionId, goal, workspace, additionalDirectories, readOnlyDirectories, resumeThreadId, environment })` | 起一次运行并写运行记录 |
| `client.readRun` / `readEvents` / `cancel` | 运行记录、事件流、取消 |
| `normalizeClaudeEvents` / `claudeActivityFromEvent` / `classifyClaudeFailure` / `isClaudeTelemetryEvent` | 事件归一化与故障分类（纯） |

## 能力强制面（本模块的核心语义）

`--permission-mode` **不是**安全边界。本机实测：`acceptEdits` / `dontAsk` /
`bypassPermissions`，以及把配置根隔离到运行时自己的目录，四种情形下 workspace 之外的写入**都成功**。
它决定 CLI 的交互行为，不决定能力上限。

因此 preflight 不再因 mode 而拒绝启动，运行记录里用 `permissionModeIsBoundary: false` 显式标注这一点。

真正有牙齿的两条通道，都由 **grant** 派生（推导见 `claude-permission-surface.mjs`）：

1. **工具面**（主边界）：`--tools` / `--disallowedTools`。持有只读引用根且没有任何可写根的运行，
   写工具从工具面整个摘除——写入不是「被规则拒绝」，而是**不存在该工具**。
2. **配置根 deny 规则**（纵深防御）：`<configRoot>/settings.json` 的 `permissions.deny`，形如
   `Edit(//c/path/**)`。实测配置根里的 deny 规则在显式 `--permission-mode` 下仍然生效。

运行记录登记实际生效的面：

```
enforcedSurface: {
  authority: 'tool-surface',
  toolSurface: { allowedTools, disallowedTools, writeToolsWithheld },
  denyRules: [...],
  permissionModeIsBoundary: false,
}
boundary.enforcement: 'claude-tool-surface-and-config-deny'
```

### 判定键是 grant，不是 role 名字

写工具摘除的判定是 `readOnlyDirectories.length > 0 && writableDirectories.length === 0`。
此前它写死在 `role === 'research-acquire'` 上，于是任何**别的** role 只要传 `readOnlyDirectories`，
就会同时拿到读授权与写工具——声明的只读与实际的只读不一致。

role 现在只用来挑「联网研究」与非联网这两档读工具集。

### 配置根每次运行独立

`CLAUDE_CONFIG_DIR` 指向 `<bridgeDir>/claude-config/<runId>`（打包目录只读时回退到
`<tmp>/operator-studio-claude-config/<runId>`）。**按运行隔离是必须的**：deny 规则写在配置根里，
共用目录会让并发的两次运行互相覆盖 settings.json，把其中一次的 deny 悄悄抹掉，而那条运行记录里
登记的却是它写过。

隔离的是配置目录，不是进程环境：`PATH` 等照常传递，否则 CLI 起不来。凭证走进程环境变量
（`ANTHROPIC_AUTH_TOKEN` / `ANTHROPIC_BASE_URL` / `ANTHROPIC_MODEL`），不属于配置文件，隔离后照常可用。

## Invariants

- 工具面永远不含 shell 类工具（`Bash` / `NotebookEdit`），任何档位都不含。
- 同一次运行不得把同一目录同时授予可写与只读（`CLAUDE_DIRECTORY_GRANT_CONFLICT`）。
- `role === 'research-acquire'` 却不带任何只读根时**显式失败**（`CLAUDE_ACQUIRE_GRANT_MISSING`）：
  缺根会让它落到「联网 + 有写工具」那一档，比收紧前更宽，绝不能静默通过。
- 写规则名只能是 `Edit(...)`。文件权限检查从不匹配 `Write(...)`；写成 `Write(...)` 会长久地看起来
  「配了 deny」，实际一条都不匹配（2.1.275 起的坑）。
- 路径规则必须归一化成小写盘符、无冒号的双斜杠锚点（`C:\x` → `//c/x`）；`//C:/x` 不匹配。
- 不声称 `--add-dir` 是写权限开关：它只是把目录列为工作目录。只读根的只读性由工具面摘除保证。
- 路径 deny 规则是纵深防御，不是主边界；主边界是工具面摘除。

## 错误码

| 码 | 含义 |
|---|---|
| `CLAUDE_NOT_INSTALLED` | 未检测到 CLI |
| `CLAUDE_WORKSPACE_UNAVAILABLE` | workspace 不存在或不是目录 |
| `CLAUDE_DIRECTORY_GRANT_CONFLICT` | 同目录既授可写又授只读 |
| `CLAUDE_ACQUIRE_GRANT_MISSING` | acquire 角色未携带只读引用根 |
| `CLAUDE_AUTH_REQUIRED` / `CLAUDE_BILLING_UNAVAILABLE` 等 | 运行期故障分类，见 `classifyClaudeFailure` |

`CLAUDE_PERMISSION_MODE_UNSAFE` **已删除**：它拦的是一个名字，不是一个能力差。

## Non-Responsibilities

- 不决定要不要研究、研究哪个阶段、预算多少（`research-policy.mjs`）。
- 不决定给哪个角色授予哪些根（`agent-runtime.mjs` 的调用点）。
- 不做读侧硬限制：实测两侧都没有读边界，仓库不声称有。
