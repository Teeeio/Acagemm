# 展会交付验收

## 启动

- `npm run build` 成功。
- `npm start` 后 `/api/health` 返回 `status: ok`。
- 双击 `启动展会版.cmd` 可以启动服务并打开浏览器。
- `展会诊断.cmd` 的 Node、Web bundle、Local service 全部为 PASS。
- 断开公网后，页面、Logo、API 和示例数据仍可访问。

## 核心路径

- 应用补丁后，`runtime/mla-kernels/kernels/paged_attention.cu` 内容发生变化。
- 刷新页面后仍显示补丁已应用。
- Benchmark 进度由 API 返回，刷新后可以恢复运行状态。
- Run 完成后出现完整执行日志并进入效果决策。
- 采用候选后可以编辑三条知识草稿。
- 草稿编辑、发布进度和知识资产在刷新后保留。
- 审计中心可以重建上述操作时间线。
- `/api/missions/{id}/events` 返回严格递增的 Runtime 事件序列。

## 现场边界

- C500/CUDA 数值是固定历史样例，不宣称为现场测量。
- 展台操作只修改隔离工作区，不访问讲解人员的真实仓库。
- 现场异常时先检查 `/api/health`，再执行 `npm run demo:reset` 恢复官方样例。
- 顶栏显示“本地参考 Runtime”时，不宣称已连接真实 CLI 或实时硬件。
- 顶栏显示“CLI Agent Runtime”且 `/api/runtime` 返回 `connected: true` 时，才说明已连接真实 CLI 文件投影。
