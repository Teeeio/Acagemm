# P1 Feedback 真实两轮 GPU 证据归档（2026-09-12）

本目录归档上游独立完成并验证的一次真实 Claude Code + 本地共享 GPU 两轮运行的**原件**（逐字节复制，未修改内容）。它只是证据归档，**不包含任何新的模型 / GPU 测试**。

## 来源与完整性

- 真实运行根目录（**本仓库内**被忽略的未跟踪临时目录 `.tmp-real-agent/`，不是仓库外目录；只读引用）：
  `F:\设计\快速项目\acagemm原型\.tmp-real-agent\shared-gpu-W4va7P`
- 归档目标：本目录，保持上游相对目录结构。
- [manifest.json](manifest.json) 记录每个归档原件的目标相对路径、源相对路径、文件 SHA256 与字节数；并记录复制前后字节一致（`byteIdentical: true`）。
- **摘要含义区分**：`manifest.json` 中的 `sha256` 是 JSON **文件**摘要。prompt-audit JSON 内部的 `promptDigest` 只是 **prompt 文本**的摘要，二者不能互相冒充：
  - 第一轮 audit：prompt 12045 UTF-8 bytes，`sha256:0f1930961a240b19c813ceeb5c3be76ae4c5a6c0c4fa264855fbbbd84e6d3f39`
  - 第二轮 audit：prompt 21244 UTF-8 bytes，`sha256:f711c70470511a4067433733eb50fc765328d829619c0ffa486bbe15d33d2996`

## 从原件再核实的事实

运行环境（`affine-state.json` 内的 targetProbe / executionPackage 与 `p1-feedback-verification.json`）：

- 日期 2026-09-12；后端 `local-shared-gpu`，`hardware=nvidia-gpu`，`executionMode=gpu`。
- 设备 `NVIDIA GeForce RTX 3060 Laptop GPU`（driver 551.78，6144 MiB，CUDA 12.4，torch 2.6.0+cu124），架构 `sm86`。
- runtime `claude-code`；mission `MIS_MTY3ADFI`，project `PRJ_463A2FE8AEBEE8AE`。

两个真实候选均 4/4 correctness，且都在 primary / small 两个 benchmark profile 下运行：

- `candidate-01`：patch digest `sha256:1d1a893244cd12c61109c368cf2ffde01e30ba2886b9568adfa7ebe99f4c2f2f`；queueRunId `run_13F95DB70766B3CCDFE6F1FF`；taskId `queue_6529FB2507C349A2`。第二轮 audit 的 `roundFacts.correctness.environments` 显示 `local-shared-gpu` primary 4/4、small 4/4；`p1-feedback-verification.json` 记 `correctness: passed`。
- `candidate-02`：patch digest `sha256:364d419f0c12d3628e238d7fcb333060cb126140cb7bd4ef47fef38b6b08b104`；queueRunId `run_12267033BC4BB1393F3827F5`；taskId `queue_DACD1755A0664988`。`affine-state.json` 的 `candidateEvaluations[].acceptGate` 中 `correctness.complete` actual 为 `local-shared-gpu 4/4 · local-shared-gpu 4/4`，`benchmark.profiles_complete` actual 为 `primary, small`。

轮次序列（`summary.json` + `affine-state.json` + 第二轮 audit `roundFacts`）：

- round 1 结果 `reference`（正确性与证据完整，但 `performance.target` 未达目标）。
- 执行 1 次 rollback：checkpoint `cp_59828E28-4B2`，`workspaceClean: true`，`restoredAt 2026-09-12T07:56:35.142Z`；`roundFacts.rollback`、`decision`、`gate` 与 `p1-feedback-verification.json` 一致（`gate: reference`，`publishable: false`）。
- 随后自动 second run：`claude_MTY3D3AA_C95A6106`，`roundId MIS_MTY3ADFI:round:2`。

汇总与经验（`summary.json`、`runtime/experiences/experiences.json`）：

- `summary.workflowWritesAfterStart = 0`；`summary.budgetTerminalAccepted = false`；两个真实候选 completed；`experienceCount = 2`。
- `experiences.json` revision 2，共 2 条记录；每条 `content` 均为 335 UTF-8 bytes。

第二轮审计的经验选取绑定（第二轮 audit 的 `selection` 与 `experiences.json` 记录）：

- 选中 `exp-36daea48-bfd3-48b0-8bd7-fbb6a3a8fe0b@1`，`useAs: observation`，`reason: scope-match`；`policyVersion` 为 `operator-studio.experience-selection/v1+scope-match+updatedAt-desc-id-asc`。
- 该记录 mission / candidate / patch / queue 绑定为 `MIS_MTY3ADFI` / `candidate-01` / `run_13F95DB70766B3CCDFE6F1FF` / patch `1d1a8932…`，完整 `content` 为 335 bytes、`sha256:bae23768866316b13377b1770fc497a49c65d4d1ffae28277ae182d4b8a989dd`，与 `p1-feedback-verification.json` 的 `experience.contentBytes / contentDigest` 一致。

## 证据边界（精确限制）

- 本次实机运行使用的是**原版** `scripts/e2e-shared-gpu-agent-iteration.mjs`（fingerprint 见 `code-manifest.json`），运行结束后上游用**独立** `verify-live-feedback.mjs` 对原件做强校验。本包只归档该独立验证的**结果 JSON**（`p1-feedback-verification.json`），验证脚本本身不在本包内。
- 新版 E2E 的**审计观察代码块**事后对原版 driver 实机运行保留的原件做了**只读回放**（read-only replay，`liveDriverWasUpdated: false`），结果归档为 [e2e-observer-verification.json](e2e-observer-verification.json)：真实原件通过，4 个篡改负例（prompt 内容、prompt 版本、嵌入 facts、外来候选证据）被拒绝。它**不是**重新实机运行整个新版 driver，本证据不声称跑过新版脚本的实机路径。
- 归档 JSON 内部**保留原始路径值**（例如 `p1-feedback-verification.json` 的 `firstAudit.path` / `continuationAudit.path` 仍为上游绝对路径）；本目录只通过相对链接索引，不改写原件。
- prompt audit 的 `deliveryStage` 为 `prepared-before-send`：它证明**准备发送的文本**。Provider `start.goal` 与发送前文本一致由**双 Provider deterministic tests 另行证明**。本证据**不声称模型遵循了提示词**。
- 单次真实 E2E 运行**不构成 N=20 统计稳定性**；sharedGPU 观察为 `hardware-observation` 且 `publishable: false`，**不可发布**。
- 最终 release / non-hardware 门禁已由**上游根工作区**执行完成：`npm.cmd run verify:non-hardware-robustness`（含 release），结束标记 `final-gates.exit` 内容为 `0`，完整日志逐字节归档为 [final-gates.log](final-gates.log)，摘要见 [final-gates.json](final-gates.json)。日志实际打印 `[release-check] PASS: 132 checks completed` 与 `[non-hardware-check] PASS: 34 checks completed without physical hardware`。本归档 worker **未**运行任何门禁、GPU 或 Agent，只等待结束标记并复制已完成日志。
- 本包不包含 Claude 事件日志、凭据、上游源码或其他目录内容。

## 归档文件

- [manifest.json](manifest.json)
- [summary.json](summary.json)
- [affine-state.json](affine-state.json)
- [p1-feedback-verification.json](p1-feedback-verification.json)
- [code-manifest.json](code-manifest.json)
- [runtime/experiences/experiences.json](runtime/experiences/experiences.json)
- [bridge/prompt-audits/claude_MTY3AZLZ_D6E64670.json](bridge/prompt-audits/claude_MTY3AZLZ_D6E64670.json)
- [bridge/prompt-audits/claude_MTY3D3AA_C95A6106.json](bridge/prompt-audits/claude_MTY3D3AA_C95A6106.json)

`manifest.json` 记录以上 7 个原件的 SHA256/bytes，不包含自身摘要。本批**未修改**这 7 个原件和 manifest。以下 3 个是本批新增的核查/门禁证据，**不在** manifest 的 7 个原件清单内：

- [final-gates.log](final-gates.log)（上游完整门禁日志，逐字节复制）
- [final-gates.json](final-gates.json)（门禁命令、exitCode、PASS 行与 checks 数、日志 SHA256/bytes）
- [e2e-observer-verification.json](e2e-observer-verification.json)（新版观察代码块对真实原件的只读回放结果）
