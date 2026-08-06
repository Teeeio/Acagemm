# 验证与测试计划

## 1. 本次验证环境

- 日期：2026-08-06
- OS/Shell：Windows PowerShell
- Node.js：`v20.11.0`
- 项目：`operator-studio-mvp@0.1.0`
- 默认 Runtime：`demo`
- 启动验收端口：4183（隔离于正在展示的 4175）
- 启动验收数据：`runtime/closure-start-<timestamp>/`，不使用正式 `data/` 和 `runtime/mla-kernels/`

## 2. 本次实际执行结果

| 检查 | 实际命令/方式 | 结果 | 关键输出 |
| --- | --- | --- | --- |
| 生产构建 | `npm run build` | PASS | Vite 5.4.14；1581 modules；JS 313.46 kB，CSS 155.88 kB |
| Runtime contract | `npm run test:runtime` | PASS | `[runtime] adapter contract passed` |
| Demo 主流程 | `npm run test:smoke` | PASS | `[smoke] full mission workflow passed` |
| CLI release guard | `npm run test:release` | PASS | `[release-guard] CLI authority and knowledge governance passed` |
| 展会服务启动 | 隔离环境变量后运行 `npm start`，端口 4183 | PASS | `/` HTTP 200；`/api/health` 为 `operator-studio` / `demo` / `liveHardware=false` |
| 展会诊断 | `powershell -File scripts/diagnose-exhibition.ps1 -Port 4183` | PASS | Node、Bundle、Service、Runtime、State、Event、Knowledge 7 项全部 PASS |
| 离线打包 | `npm run demo:package` | PASS | 再次执行三组测试和 Build；生成 `release/OperatorStudio-Exhibition.zip` |

本次没有自动运行浏览器 UI 测试，因为仓库中不存在 Playwright/Cypress/组件测试配置。

## 3. 各测试实际覆盖

### `npm run test:runtime`

已覆盖：

- Demo descriptor 可用。
- CLI 的 status、queue、canonical record 三个文件探针。
- CLI Mission request JSON 写入。
- Runtime Event sequence 递增。
- CLI Agent 状态投影。
- 非法 status 和空 canonical records 导致连接降级。

未覆盖：真实 CLI 仓库、CLI 长时间写文件、文件写入竞争、动作桥。

### `npm run test:smoke`

已覆盖：

- 重置、Mission 创建和 Run。
- Agent 从 running 推进到 Candidate Plan。
- Mission Events 增量序号。
- Patch 真实写盘。
- Patch 前检查点和阶段回退。
- Benchmark 启动、进度完成、Evidence 状态。
- 人工介入阻塞自动采用。
- redirect 恢复工作区并使 Benchmark 工件失效。
- 无阻塞时 Accept Gate 自动采用。
- Candidate 分类、失败记录和负向经验。
- 3 条知识的更新/创建/版本化/自动发布。
- 已发布知识不可静默编辑，手工 publish API 退役。
- 知识引用。
- 采用后回退、知识 superseded 和幂等处理。

未覆盖：React UI、不同浏览器、人工介入 adopt/supplement/cancel 的完整组合、并发请求、异常 I/O。

### `npm run test:release`

已覆盖：

- CLI 模式 descriptor 的 authority、capabilities 和 `liveHardware=false`。
- Mission Run 只生成 CLI request。
- Patch/Benchmark/Adopt/Reject/Rollback/Revert/Reset 均返回 `RUNTIME_ACTION_UNAVAILABLE`。
- 被拒绝动作不改变领域状态，也不创建 Demo Patch 文件。
- 知识手工发布接口保持 410。

未覆盖：CLI 执行成功后工件回传，因为该合约尚未实现。

## 4. 启动验收步骤

源码展会模式的标准人工验收：

```powershell
npm install
npm run build
npm start
```

另开 PowerShell：

```powershell
Invoke-RestMethod http://127.0.0.1:4173/api/health
npm run demo:diagnose
```

必须确认：

- 浏览器打开 `http://127.0.0.1:4173/`。
- Health 的 `service` 为 `operator-studio`。
- Demo 展示时 `runtime.mode=demo`、`liveHardware=false`。
- CLI 展示时 `runtime.mode=cli-file`、`connected=true`，且三个 probes 全部为 true。
- 旧知识发布 API 诊断为 HTTP 410。

本次为避免占用现有端口，等价地以 4183 和隔离 data/runtime 运行，全部通过。

## 5. 现场核心手工测试矩阵

| 编号 | 场景 | 操作 | 期望 |
| --- | --- | --- | --- |
| M-01 | 初始启动 | 重置后进入首页 | Mission 01 处于 Candidate，Runtime 标识为本地参考 Runtime |
| M-02 | Mission 新建 | 输入目标、仓库、硬件、指标并创建 | 新 Mission 被选中，状态持久化，刷新后仍存在 |
| M-03 | Agent Run | 启动并等待约 7.2 秒 | UI 依次显示上下文、知识、诊断、Candidate Plan |
| M-04 | Diff 审阅 | 打开每个文件 | 文件可切换，行级增删和 rationale 正确 |
| M-05 | Patch | 批准 Candidate 02 | `runtime/mla-kernels/kernels/plan_cache.hpp` 实际存在 |
| M-06 | Benchmark | 运行测试矩阵 | 进度和日志推进，明确是参考 Mock，不宣称实机 |
| M-07 | 自动采用 | 不发起人工介入 | 完成后自动进入 published，current best 为 cnd.02 |
| M-08 | 条件式介入 | Benchmark 期间请求 supplement | 红点/阻塞状态出现，完成测试后不会自动采用 |
| M-09 | 调整方向 | 处理介入为 redirect | 回到 Candidate，Patch 被恢复，旧 Benchmark 失效 |
| M-10 | 阶段回退 | 在 validation/evidence 返回上一步 | 恢复检查点，UI 与真实文件一致 |
| M-11 | 知识维护 | 自动采用后查看知识沉淀/资产 | 3 个版本资产、证据引用和硬件分类可查看 |
| M-12 | 采用后回退 | 回退到上一版本 | current best=cnd.01，工作区恢复，知识 superseded |
| M-13 | 刷新持久化 | 每个关键阶段刷新页面 | 状态不丢失，不重复发布知识 |
| M-14 | 离线运行 | 断网后从离线包启动 | 首页、流程和所有本地资源仍可用 |

## 6. 发布前新增自动化 Gate

以下目前不存在，应在“真实项目发布”前补齐：

1. 前端单元/组件测试：请求错误、状态映射、按钮禁用、介入表单、候选分类。
2. Playwright E2E：从 reset 到 published，再到 revert 的浏览器流程。
3. 多视口截图回归：1920x1080 展会屏、1366x768 笔记本、移动宽度。
4. 并发写测试：两个请求修改 state 时不丢更新。
5. Schema migration fixture：至少覆盖 v1/v2/v3、损坏 JSON、缺字段。
6. I/O 故障：只读目录、磁盘满、Checkpoint 缺失、rename 失败。
7. CLI 真实仓库 Contract/E2E：任务接管、事件、Artifact、Patch、测试和决策闭环。
8. 安全检查：请求体上限、路径穿越、响应头、依赖漏洞、ZIP manifest 验证。
9. 稳定性测试：4 小时运行、重复 reset 100 次、多个标签页轮询。

## 7. 失败处理和取证

测试失败时至少保留：

- 命令、退出码和完整 stdout/stderr。
- `/api/health` 与 `/api/runtime` 响应。
- 失败前后的 `/api/state`，注意脱敏后再外发。
- `data/mock-db.json`、相关 Runtime Event sequence。
- `runtime/mla-kernels` 与最后一个 checkpoint 的 diff。
- Node 版本、端口占用和环境变量清单。

不要在失败调查中直接删除 `data/` 或 `runtime/`。先复制取证，再使用 `npm run demo:reset` 恢复演示状态。

## 8. 本次启动器异常记录

第一次隔离启动尝试使用 `Start-Process npm.cmd`，宿主 PowerShell 因环境字典同时出现 `Path` 和 `PATH` 抛出 `ArgumentException`，应用进程未创建。随后改用 PowerShell Job 执行 `npm start`，应用启动和全部诊断通过。若自动化脚本复用 `Start-Process`，应先规范化环境键；仓库自带的 `启动展会版.cmd` 不走这段测试启动器逻辑。
