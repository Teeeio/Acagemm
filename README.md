# Operator Studio 展会版

面向异构算子优化流程的可运行展会版本。业务状态由本地服务管理并持久化到磁盘；默认连接“本地参考 Runtime”，C500/CUDA 性能数值为固定历史样例，不代表现场硬件实测。

## 当前可用闭环

1. 审阅 Candidate 02 的文件树与 Diff。
2. 将补丁真实写入隔离工作区 `runtime/mla-kernels`。
3. 由服务端创建 Benchmark Run，页面轮询显示进度和执行日志。
4. 完成正确性、性能与证据门禁后采用或退回候选。
5. 编辑并持久化三条知识草稿，单条或批量发布到知识库。
6. 审计事件、测试矩阵、工作区和通知状态在刷新后保留。

## 开发启动

```powershell
npm install
npm run dev
```

开发模式会同时启动：

- Web：`http://127.0.0.1:5173`
- Mock API：`http://127.0.0.1:4174`

## 展会启动

Windows 展机可以直接双击：

- `启动展会版.cmd`
- `重置演示数据.cmd`
- `展会诊断.cmd`
- `停止展会版.cmd`

命令行启动方式：

```powershell
npm run build
npm start
```

展会模式由一个 Node 进程同时提供静态页面和 API，默认地址：

`http://127.0.0.1:4173`

## Agent Runtime Adapter

服务端 API 不直接依赖某个 Agent 实现。`server/agent-runtime.mjs` 提供统一运行时边界：

- 默认 `demo`：进程内参考 Runtime，适合无网络、无硬件的展台演示。
- `cli-file`：按 CLI 基线读取 Agent status、测试队列和 canonical records，并将 Mission Run 请求写入 Bridge 目录。

连接真实 CLI 文件系统：

```powershell
$env:OPERATOR_RUNTIME_MODE='cli-file'
$env:OPERATOR_CLI_ROOT='D:\path\to\flashinfer_task_package'
npm start
```

可通过 `GET /api/runtime` 查看运行时连接状态，通过 `GET /api/missions/{id}/events` 获取带 `sequence` 的 Adapter 事件。CLI 仍是 status、queue 和 current best 的执行权威，网页不会建立第二套优化记录。

## 后台重置

```powershell
npm run demo:reset
```

该命令会恢复初始任务状态，并重新生成隔离示例工作区。重置入口不显示在产品界面中。

## 闭环检查

```powershell
npm run test:smoke
npm run test:runtime
```

烟雾测试会在隔离目录中验证补丁写入、服务端 Run、候选采用和三条知识资产发布。

## 数据与产物

- 持久化状态：`data/mock-db.json`
- 隔离工作区：`runtime/mla-kernels`
- 示例仓库模板：`demo-assets/mla-kernels`
- 健康检查：`GET /api/health`
- Runtime 状态：`GET /api/runtime`
- Runtime 事件：`GET /api/missions/{id}/events`

`data/` 与 `runtime/` 是运行时目录，不应作为源代码分发内容提交。
离线包运行时会把状态和隔离工作区写入 `%LOCALAPPDATA%\OperatorStudioExhibition`，解压目录可以保持只读。

详细展台流程和故障预案见 `EXHIBITION.md`，交付验收见 `DELIVERY.md`。
