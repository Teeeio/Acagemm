# Operator Studio 展会版

面向异构算子优化流程的可运行展会版本。业务状态由本地 Mock API 管理并持久化到磁盘；C500/CUDA 性能数值为固定历史样例，不代表现场硬件实测。

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

```powershell
npm run build
npm start
```

展会模式由一个 Node 进程同时提供静态页面和 API，默认地址：

`http://127.0.0.1:4173`

## 后台重置

```powershell
npm run demo:reset
```

该命令会恢复初始任务状态，并重新生成隔离示例工作区。重置入口不显示在产品界面中。

## 闭环检查

```powershell
npm run test:smoke
```

烟雾测试会在隔离目录中验证补丁写入、服务端 Run、候选采用和三条知识资产发布。

## 数据与产物

- 持久化状态：`data/mock-db.json`
- 隔离工作区：`runtime/mla-kernels`
- 示例仓库模板：`demo-assets/mla-kernels`
- 健康检查：`GET /api/health`

`data/` 与 `runtime/` 是运行时目录，不应作为源代码分发内容提交。
