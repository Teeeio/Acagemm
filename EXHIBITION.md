# Operator Studio 展会手册

## 展前准备

1. 在联网开发机执行 `npm ci`、`npm run build`、`npm run test:runtime`、`npm run test:smoke`。
2. 执行 `npm run demo:package` 生成 `release/OperatorStudio-Exhibition.zip`；包内自带经过验证的 Node 运行时。
3. 将压缩包解压到展机本地磁盘，不从 U 盘直接运行。
4. 断开公网后双击 `启动展会版.cmd`，再运行 `展会诊断.cmd`。
5. 展示前双击 `重置演示数据.cmd`，刷新页面。

离线包的状态、日志和隔离工作区保存在 `%LOCALAPPDATA%\OperatorStudioExhibition`，不会修改分发包本身。

## 五分钟主线

| 时间 | 操作 | 讲解重点 |
| --- | --- | --- |
| 0:00–0:40 | 打开 Mission 工作台 | 目标、硬件、指标、当前最佳和审批状态在一个任务上下文中。 |
| 0:40–1:30 | 查看 Agent Run、Profile 和 Tool Calls | Agent 的每一步、使用的 Skill/Tool、版本和权限均可追溯。 |
| 1:30–2:20 | 审阅 Candidate Plan 与文件 Diff | 人在写入工作区前决策；补丁范围和代码依据可检查。 |
| 2:20–3:20 | 应用 Patch 并运行测试矩阵 | Patch 真实写入隔离工作区；进度和日志由本地服务持久化。 |
| 3:20–4:15 | 查看效果决策 | Correctness、固定环境和性能证据共同决定是否采用。 |
| 4:15–5:00 | 发布知识资产 | 将结论、约束、硬件范围和证据形成可检索经验。 |

## 现场口径

- 可以说：这是可运行的产品闭环，页面交互、状态持久化、Patch 写入、审批、事件和知识发布均真实执行。
- 可以说：系统已有与 CLI 对接的 Runtime Adapter 边界，CLI 保持执行和 current best 权威。
- 不应说：默认演示中的 C500/CUDA 数值是现场实时测量。
- 不应说：顶栏显示“本地参考 Runtime”时已经连接真实 CLI 或 GPU Worker。

## 故障恢复

1. 页面打不开：运行 `展会诊断.cmd`，检查 Local service。
2. 服务未启动：运行 `停止展会版.cmd`，再运行 `启动展会版.cmd`。
3. 数据状态不适合演示：运行 `重置演示数据.cmd` 后刷新。
4. 页面仍异常：检查 `runtime/logs/operator-studio.err.log`。
5. 展机环境不可恢复：展示预先准备的产品录屏，并说明当前使用离线演示预案。

## CLI 文件投影模式

第一版真实接入使用文件型 Adapter：

```powershell
$env:OPERATOR_RUNTIME_MODE='cli-file'
$env:OPERATOR_CLI_ROOT='D:\flashinfer_task_package'
./启动展会版.cmd
```

默认探测：

- `results/agent_status_cli_integration.json`
- `results/test_queue.jsonl`
- `docs/optimization_records.json`

Mission Run 请求写入 `runtime/agent-bridge/requests/`。CLI 侧需要消费该请求并更新 status/queue/canonical records；Adapter 只做投影与事件排序，不越权修改 current best。
