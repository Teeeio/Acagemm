# Local Server (Composition Root)

## Purpose / Responsibilities

进程组合根与引导入口：import 既有模块、用真实 effect 端口构造 application/domain 服务、组装路由表、持有进程生命周期（监听、PID、单实例、信号关闭、可选 auto-tick）。它不实现 workflow 决策或领域规则，只按 [ARCHITECTURE](../docs/development/ARCHITECTURE.md) 的依赖方向把已有模块接起来。

- 负责：读取部署环境变量、绑定 effect 端口（存储/仓库/队列/Agent runtime/经验服务）、在 State Repository 排他锁内执行变更请求、发布 PID 与 HTTP 监听。
- 不负责：URL 之外的业务规则、Gate/Profile/预算判定、硬件准入、第二套状态存储或第二套调度。

## Public API / Inputs

模块被直接执行（`node client-runtime/local-server.mjs`），由 [start.mjs](start.mjs) / [dev.mjs](dev.mjs) / 各 E2E 包装脚本以子进程方式启动；除进程级环境变量与 `SIGINT`/`SIGTERM` 外没有其他入口。

| 环境变量 | 作用 |
|---|---|
| `API_PORT` / `PORT` | 监听端口，默认 4173；`SERVE_WEB=false` 时只提供本地 API |
| `SERVE_WEB` | 是否为 `dist/` 提供静态资源，默认开启 |
| `OPERATOR_RUNTIME_OWNER_PID` | 分离式运行时的 TUI 宿主进程；owner 消失即自动关闭，`<=0` 表示旧式直接启动 |
| `OPERATOR_EXPERIENCE_CONDITION` | 受控经验条件；见下 |
| `OPERATOR_EXECUTION_PACKAGE_DIR` | 执行包 store/adapter 根目录（默认 runtime 目录下 `execution-packages`） |
| `OPERATOR_GPU_PYTHON` / `OPERATOR_GPU_NVIDIA_SMI` / `OPERATOR_GPU_REQUIRE_NVCC` | 共享 GPU 环境探针 |
| `OPERATOR_PACKAGE_INSPECTION_TIMEOUT_MS` / `OPERATOR_LOCAL_C500_TIMEOUT_SECONDS` | 既有超时预算 |
| `OPERATOR_AUTO_TICK` / `OPERATOR_AUTO_TICK_INTERVAL_MS` | 是否以及多快推进 workflow（默认开启，最小 1000 ms） |

### OPERATOR_EXPERIENCE_CONDITION

只在变量**确实存在**时读取并传给 [轮次经验服务](application/round-experience-service.md) 的 `experienceCondition`；未配置的部署不传该键，构造参数与行为完全不变。取值只能是 [经验契约](experience-contract.md) 冻结的 `EXPERIENCE_CONDITIONS`（`facts-only`/`local-only`/`local-and-wiki`）：唯一开关就是部署环境变量本身，**不是** Mission 设置、全局配置或新 API 路由，且不能被 Agent 写入。

## Outputs / Invariants

- 构造顺序固定在模块作用域：先构造服务与路由，再 `ensureStorage`、写 PID、`listen`。因此非法或空的 `OPERATOR_EXPERIENCE_CONDITION`（以及旧式 retrieve-only 经验端口）会在**监听端口、写 PID、启动 Agent/GPU 之前**同步抛错，进程以非零码退出且不留下监听或 PID 文件。
- 单实例：`EADDRINUSE` 时打印明确原因、清掉 auto-tick 并以退出码 98 结束，绝不覆盖在跑运行时的 PID 文件。PID 只在监听成功后写入。
- `GET/HEAD` 与 SSE 流直接处理；其余 `/api/` 变更请求经 `stateRepository.runExclusive` 串行化。请求体在进入锁之前按既有上限解析一次。
- `SIGINT`/`SIGTERM` 只关闭监听与 auto-tick 定时器一次；owner 进程消失时走同一条关闭路径。
- 条件只影响该进程内轮次经验的选择资格；不改变 rank/配额/预算、不改变采集与轮次必需事实、不写冻结 context。

## Dependencies / Side Effects

组合根本身是唯一允许同时 import server/application/domain/adapter 模块的模块；它不做网络出站、不跑模型/GPU，除既有数据与 runtime 目录（`OPERATOR_DATA_DIR`/`OPERATOR_RUNTIME_DIR`/`OPERATOR_STORAGE_ROOT`）外不写文件。经验条件不引入新的依赖、存储、环境变量读取点或 API。

## Error Contract

非法 `OPERATOR_EXPERIENCE_CONDITION`：构造期 `TypeError` + `EXPERIENCE_INVALID`，进程退出码 1，未监听、未写 PID（已用隔离数据/runtime 目录实测 `bogus` 与空串两种情况）。端口占用为退出码 98。其余启动错误按既有 `server.on('error')`/顶层异常路径非零退出。

## Example / Verification

```bash
OPERATOR_EXPERIENCE_CONDITION=facts-only node client-runtime/local-server.mjs   # 受控运行
node client-runtime/local-server.mjs                                            # 默认部署，行为不变
```

语法检查：`node --check client-runtime/local-server.mjs`。完整链路由既有运行时/E2E 包装（`tests/client-runtime-smoke-test.mjs`、`tests/kernel-wiki-runtime-test.mjs`）以子进程方式覆盖；本文件只描述组合与引导边界，不重复领域契约。

## Change Checklist / Known Limitations

新增/修改此处读取的环境变量必须同步本文件、启动脚本与相邻模块契约，并保持默认值行为不变。受控经验条件属于冻结实验接口：不得在此加入可被 Agent 写入的开关、全局配置或新路由。组合根不做业务校验以外的推断，也不提供第二套存储、调度或恢复。
