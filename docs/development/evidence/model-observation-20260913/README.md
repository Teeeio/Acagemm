# 模型观测与无硬件验收证据包（2026-09-13）

本目录归档 Root 已完成验证的模型观测实现与**无硬件（non-hardware）验收**原件。
27 份 JSON/日志从 Root 只读原件目录逐字节复制，文件名与内容不变；机器索引见
[manifest.json](manifest.json)。
本轮结论边界是：**响应模型观测链与无硬件门禁 139 / 41 exit 0 已通过；真实 GPU / 真实
Agent 尚未开始，N20 未完成，最新两轮真实 smoke 与 reduction/normalization 覆盖均 pending。**
本目录不含任何新的实机运行，也不构成稳定性或发布声明。

设计/验收基准为
[`MODEL_OBSERVATION_ACCEPTANCE.md`](../../MODEL_OBSERVATION_ACCEPTANCE.md) 与
[`REAL_GPU_REGRESSION.md`](../../REAL_GPU_REGRESSION.md)（本轮已更新顶部状态段）。代码已提交
`b85c2f709811b00bde547ff1fc256ad0bfffb66b`。

## 本轮已通过的验收

- **最终无硬件门禁：release 139 / non-hardware 41，exit 0。** 上游在最终集成树运行
  `npm.cmd run verify:non-hardware-robustness`（内部先执行完整 release 门禁），
  UTC `19:18:55.9829552Z` 开始、`19:29:01.2567892Z` 结束，完整输出 85,182 字节，
  SHA256 `c4205aa44917708dff15aaa3d2d2996d95b9f9e5fd4a6aa83a12d7ba7a0b3c46`。
  机器结论见 [verification.json](verification.json)，退出记录见
  [final-nonhardware-gate-result.json](final-nonhardware-gate-result.json)，完整输出见
  [final-nonhardware-gate.log](final-nonhardware-gate.log)。
- **响应模型观测链完成。** producer 侧以 `assistant.message.model`（provider-reported）为响应
  身份，`system.init.model` / `result.modelUsage` / env/`declared` 仅作诊断标签，绝不升级为
  观测；[producer 模型观测测试](producer-final-model-observation-test.mjs.log) pure / adapter /
  projection / archive 共 **34 passed, 0 failed**，明确无真实 Claude CLI、Python、网络或 GPU
  进程。producer 最终（A34）三项检查 exit 0（[checks](producer-final-checks.json)、
  [files](producer-final-files.json)），其中[Claude 生命周期](producer-final-claude-runtime-test.mjs.log)与
  [超时恢复](producer-final-agent-runtime-timeout-recovery-test.mjs.log)测试同样 exit 0。
- **consumer 最终记录 / 全 requiredRuns / 台账 / stop 语义完成。** 独立 collector 测试
  **65/65 通过、0 expected-red**（[日志](consumer-third-shared-gpu-model-collector-test.mjs.log)），
  [模型观测验收](consumer-third-model-observation-acceptance-test.mjs.log)与
  [shared-gpu 验收](consumer-third-shared-gpu-acceptance-test.mjs.log)契约通过，
  汇总于 [consumer-third-checks.json](consumer-third-checks.json) 与
  [consumer-third-files.json](consumer-third-files.json)。
- **实际 driver 在 VM fixture 下五种场景全部通过**（[consumer-third-driver-vm.json](consumer-third-driver-vm.json)）：
  `confirmed`、`pending_then_confirmed`、`stop_transport_failure`、`final_file_missing`、
  `final_directory_failure`。该文件显式标注 `fixtureOnly: true`、`realRuntimeGpuOrNetwork: false`。
- **门禁前后关键源文件一致。** [gate-source-before.json](gate-source-before.json) 与
  [gate-source-after.json](gate-source-after.json) 记录**同一批 8 个**关键源文件的 SHA256，
  逐项相同。**该核对只覆盖这 8 个列名文件，不能扩大为整棵源码树。**

## 归档原件与证明范围

| 原件 | 内容 | 证明范围（不证明什么） |
|---|---|---|
| [verification.json](verification.json) | Root 机器核验总表：commit、门禁 139/41 exit 0、8 文件前后一致、producer/consumer 三测试 exit 0、五种 VM 场景、本轮实机 0 次、N20 未合格、审批待决 | 证明本轮无硬件验收结果；不证明实机稳定、不证明 N20 |
| [final-nonhardware-gate-result.json](final-nonhardware-gate-result.json) / [final-nonhardware-gate.log](final-nonhardware-gate.log) | 最终 139 / 41，exit 0，含起止时间与日志 SHA256 | 证明无硬件门禁通过；不含硬件样本 |
| [gate-source-before.json](gate-source-before.json) / [gate-source-after.json](gate-source-after.json) | 8 个关键源文件门禁前后 SHA256 | 只证明这 8 个文件未变；**不代表整棵源代码树** |
| [producer-final-checks.json](producer-final-checks.json) / [producer-final-files.json](producer-final-files.json) | producer 三测试 exit 0、9 个交付文件 SHA256 | 证明 producer 侧实现与测试；无硬件执行 |
| [producer-final-model-observation-test.mjs.log](producer-final-model-observation-test.mjs.log) | 34 passed / 0 failed，无真实 CLI/Python/网络/GPU | 证明观测/绑定/投影/归档的确定性行为；不是实机模型观测 |
| [producer-final-claude-runtime-test.mjs.log](producer-final-claude-runtime-test.mjs.log) / [producer-final-agent-runtime-timeout-recovery-test.mjs.log](producer-final-agent-runtime-timeout-recovery-test.mjs.log) | CLI 生命周期契约、超时取消收敛为可重试终态 | 证明生命周期/恢复契约；无真实 provider |
| [consumer-third-checks.json](consumer-third-checks.json) / [consumer-third-files.json](consumer-third-files.json) | consumer 第三版三测试 exit 0、5 个交付文件 SHA256 | 证明第三版实现；不证明实机 |
| [consumer-third-shared-gpu-model-collector-test.mjs.log](consumer-third-shared-gpu-model-collector-test.mjs.log) | 65/65 独立 case 通过，0 expected-red | 证明冻结 helper 边界；无 GPU/Agent |
| [consumer-third-driver-vm.json](consumer-third-driver-vm.json) | 实际 driver 五种 VM fixture 场景全过，`fixtureOnly: true` | 证明 cleanup/stop/final 读取逻辑；**不是实机运行** |
| [consumer-third-model-observation-acceptance-test.mjs.log](consumer-third-model-observation-acceptance-test.mjs.log) / [consumer-third-shared-gpu-acceptance-test.mjs.log](consumer-third-shared-gpu-acceptance-test.mjs.log) | required-run 覆盖、指纹、台账可比性、预算终态、家族结果、run 台账契约 | 证明验收工具本身；不产生硬件样本 |
| [consumer-first-b.log](consumer-first-b.log) / [consumer-first-shared.log](consumer-first-shared.log) | 第一版 consumer 测试绿 | **历史保留**：随后被 Root 复现问题并退回 |
| [consumer-second-shared-gpu-model-collector-test.mjs.log](consumer-second-shared-gpu-model-collector-test.mjs.log) / [consumer-second-model-observation-acceptance-test.mjs.log](consumer-second-model-observation-acceptance-test.mjs.log) / [consumer-second-shared-gpu-acceptance-test.mjs.log](consumer-second-shared-gpu-acceptance-test.mjs.log) | 第二版 48/48 等测试绿 | **历史保留**：该版未集成 |
| [consumer-second-root-probes.log](consumer-second-root-probes.log) | Root 用第二版实际 helper 复现的误判（冲突 duplicate、空 parsed、foreign provider 已知 Mission、known-start 冲突；non-Agent barrier 被忽略） | 记录**真实失败**；不证明通过 |
| [consumer-second-driver-failure-vm.json](consumer-second-driver-failure-vm.json) | Root 实际 driver fixture：`stopMissionNow` 作用域不可达，`stopCalls: 0`、killRuntime、保留 `originalFailure`、cleanup 未确认 | 记录**真实失败与 fixture 复现**；不是实机 |
| [collector-baseline-red.log](collector-baseline-red.log) | 冻结 helper 实现前：1/48 通过、47 expected-red | 记录**真实基线红**；历史保留 |
| [collector-edge65-baseline-red.log](collector-edge65-baseline-red.log) | 第二版复核：53/65 通过、12 expected-red（冲突顺序/空记录/foreign provider/stop receipt 边界） | 记录**返工前的真实红**；历史保留 |
| [live-approval-status.json](live-approval-status.json) | 实机命令在 automatic approval review 中被拒：`approval-required`、`processCreated: false`、未开始真实 GPU/Agent | 记录**审批待决**；不是 GPU 失败样本、也不是成功样本 |
| [live-run-request.json](live-run-request.json) | 待审批运行请求**输入**（affine 两轮、reduction/normalization、预算、payload 范围） | 只是输入准备；不是实机结果，不含 attempt/summary |

## 失败历史可追溯（不隐藏、不改写成成功）

1. **旧 consumer 版本测试全绿仍有 Root 复现问题。** 第一版 B/shared 绿，但 Root 在实际
   helper 中复现 earlier-observed 压 later-unknown、DTO 自供 session、unreadable 漏分母；
   第二版 48/48 绿，Root 实际 driver 又复现 duplicate 顺序 first/last-wins、空 parsed 与
   foreign-provider 漏分母、known-start 冲突被吞、non-Agent barrier 被忽略，并证实
   `try` 内 `const stopMissionNow` 在 `finally` 不可见导致 `stopCalls: 0`。
2. **先独立基准再返工。** 冻结 helper 实现前 collector 基线为 1/48（47 expected-red）；
   补强后 65 边界复核为 53/65（12 expected-red）；第三版实现后才达到 65/65、0 expected-red。
3. **VM 注入全部为 fixture-only**，无 Runtime / GPU / provider 真实执行；`originalFailure`
   保留，初始回执（HTTP 202）保留且不被后续 poll 覆盖，`final_file_missing` /
   `final_directory_failure` 降级为 `unknown` 而非伪装成 observed。

## 实机审批待决（不是已执行）

真实命令被 `exec_command` 的 automatic approval review 在 **CreateProcess 之前**拒绝，原因与
具体 payload / 目的模型服务的授权不足有关：**进程没有启动**，本批次新增 GPU/Agent 样本为
**0**，没有生成新的 `attempt.json` / `summary.json`。记录见
[live-approval-status.json](live-approval-status.json) 与 [live-run-request.json](live-run-request.json)。
配置的前端代理为 `http://127.0.0.1:15721/`，但**外部上游目的未被独立确认**。Root 已向用户提交
明确的授权问题，**等待答复**。

因此：

- 本目录**不得**被解读为实机 GPU 失败或成功；被拒绝的 live 执行**不能**用本地 dispatch 替代。
- 只读 GPU 预检即使可用，也只是工具可用性，**不是 E2E 样本**。
- 本任务只做已授权的本地证据文档归档，**未启动任何 Runtime / GPU / Agent**。

## 明确非声明

- **没有任何新的 GPU 或真实 Agent 运行**；N20 未完成，`n20.eligible` 只是样本资格，不等于稳定结论。
- 无最新真实两轮 smoke、无 reduction/normalization 真实覆盖，二者仍 pending。
- 8 个关键源文件的 hash 一致**不能**扩大为整棵 source 树未变。
- 模型观测是 provider-reported 元数据，不是远端服务的独立认证；历史 P1 原件 init 标签为
  Claude 但响应为 `deepseek-v4-flash`，不能混为 Claude 模型。
- 本目录不宣称任何 provider 等价、发布资格或长期稳定性。

## 复核入口

- 逐文件核对：以 [manifest.json](manifest.json) 的 `bytes` / `sha256` 对照 Root 只读原件目录。
- 门禁重跑：在仓库根运行 `npm.cmd run verify:non-hardware-robustness`（测试通过不新增硬件样本）。
- 本目录 JSON / 日志由 [.gitattributes](.gitattributes) 禁止换行转换，保持字节保真。

## 归档文件（27 份原件 + 索引）

原件：[verification.json](verification.json)、
[final-nonhardware-gate-result.json](final-nonhardware-gate-result.json)、
[final-nonhardware-gate.log](final-nonhardware-gate.log)、
[gate-source-before.json](gate-source-before.json)、[gate-source-after.json](gate-source-after.json)、
[producer-final-checks.json](producer-final-checks.json)、[producer-final-files.json](producer-final-files.json)、
[producer-final-model-observation-test.mjs.log](producer-final-model-observation-test.mjs.log)、
[producer-final-claude-runtime-test.mjs.log](producer-final-claude-runtime-test.mjs.log)、
[producer-final-agent-runtime-timeout-recovery-test.mjs.log](producer-final-agent-runtime-timeout-recovery-test.mjs.log)、
[consumer-third-checks.json](consumer-third-checks.json)、[consumer-third-files.json](consumer-third-files.json)、
[consumer-third-driver-vm.json](consumer-third-driver-vm.json)、
[consumer-third-shared-gpu-model-collector-test.mjs.log](consumer-third-shared-gpu-model-collector-test.mjs.log)、
[consumer-third-model-observation-acceptance-test.mjs.log](consumer-third-model-observation-acceptance-test.mjs.log)、
[consumer-third-shared-gpu-acceptance-test.mjs.log](consumer-third-shared-gpu-acceptance-test.mjs.log)、
[consumer-first-b.log](consumer-first-b.log)、[consumer-first-shared.log](consumer-first-shared.log)、
[consumer-second-shared-gpu-model-collector-test.mjs.log](consumer-second-shared-gpu-model-collector-test.mjs.log)、
[consumer-second-model-observation-acceptance-test.mjs.log](consumer-second-model-observation-acceptance-test.mjs.log)、
[consumer-second-shared-gpu-acceptance-test.mjs.log](consumer-second-shared-gpu-acceptance-test.mjs.log)、
[consumer-second-root-probes.log](consumer-second-root-probes.log)、
[consumer-second-driver-failure-vm.json](consumer-second-driver-failure-vm.json)、
[collector-baseline-red.log](collector-baseline-red.log)、
[collector-edge65-baseline-red.log](collector-edge65-baseline-red.log)、
[live-approval-status.json](live-approval-status.json)、[live-run-request.json](live-run-request.json)。

索引：[manifest.json](manifest.json)、[README.md](README.md)。
