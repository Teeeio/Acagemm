# 真实 E2E 接续与准备摘要缺失证据

2026-09-13，冻结源码 `f3a54460c795cd6a64ceea01e0c2e0e3bcdf6d29`。
真实 affine 两轮任务 `task_baf9fc222be74e38afb3fbd67eb545c6` 已独立验收并集成。
这是一次新 smoke，**新 N=20 为 0 次，尚未通过**。

- 原命令退出 0；1 次 `full_success` 且 comparable。
- 1 个 baseline、3 个真实候选任务：2 个不同候选通过，1 个 correctness 失败。
- 两个通过候选满足既定 4 个 correctness case 与 2 个 benchmark profile。
- 3 次必需模型调用全部实际观测为 `deepseek-v4-flash`；运行器为 Claude Code 2.1.232。
- 回滚、下一轮 prompt/audit 中成功执行经验与轮次事实核对通过；停止与资源释放确认。
- `workflowWritesAfterStart=0`，共享本地 GPU 开发证据 `publishable=false`。

上述结论由 Root 只读执行原件验证器独立重算，见
[smoke-independent.json](smoke-independent.json)、[batch.json](batch.json)、
[ledger.json](ledger.json)。它们不证明以下失败经验路径已经修好。

## 新发现

失败候选 `candidate-01` 的 minimal case 真实误差为 0.125，执行 1/4 用例后停止。
typed `OPERATOR_CORRECTNESS_MISMATCH`、真实 metrics、GPU 环境及释放证据均已保留。
但生产队列请求没有 `preparedArtifactDigest`，后端包解析后的请求及结果有该摘要。
`local-server.mjs` 的准备回调返回值漏传了 `admission.preparedArtifactDigest`。
严格失败经验校验因此正确拒绝，实际经验记录被跳过。

[real-failed-queue.json](real-failed-queue.json) 是真实队列单条原件快照，
[discovery.json](discovery.json) 记录来源、原始身份和 SHA。
[queue-binding-differential.json](queue-binding-differential.json) 为明确使用 admission/artifact
端口替身的只读诊断：原件拒绝；仅内存副本补这一字段后通过；原件未改。
该差分只定位接线缺陷，不是新 GPU 验收或生产修复。

## 保留与下一步

250 份原件已按平台标准 archive/verify 归档并校验通过，解压后 5,189,447 bytes。
归档保留在本机 `.operator-studio-local/live-regression-f3a5446-20260913/smoke-originals.zip`，
SHA-256 `624d824e74f594d65d773b7d5279f10e414a70b2172e09a5df09a566c8dbde27`。
完整绝对路径、manifest SHA 及状态见 [resume-status.json](resume-status.json)。

Root 已冻结[修复接口与验收矩阵](../../QUEUE_PREPARED_BINDING_ACCEPTANCE.md)，以及
[两任务派发请求](repair-dispatch-request.json)：实现抽出原准备回调并补可信摘要，
独立测试穿过真实准备端口、Benchmark command 和持久化 Queue；二者并行开发，
精确 candidate_inputs 组合 command 验证后集成。然后运行既有门禁、冻结新版本，
执行 smoke → 新的 20 个原始 affine 样本 → 单独 reduction/normalization 覆盖。
旧批次和这次 smoke 不补入新 20，不回填 unknown，不替换失败样本。

此前 E2E 外发审批阻断已由用户明确授权解决；本次命令确已实际运行。
新的开发派发被自动审批拒绝，理由为此前授权限定于 E2E 验收外发、未明确覆盖
向 DeepSeek 发送生产源码、失败队列证据和修复细节以完成实现/测试任务。
平台连接与容量正常，修复任务未创建，生产源码尚未修改；需用户对已保存请求明确授权。
