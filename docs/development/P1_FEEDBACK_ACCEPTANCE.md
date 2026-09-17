# P1 轮次反馈闭环验收（§14.1–§14.5）

本文记录第一阶段（`TEAM_HANDOFF.md` §14 第 1–5 项）的验收范围、两类证据与结果边界，
不声明 GPU 硬件正确性、性能或长期稳定性。

证据分两类，**不能互相冒充**：

1. **确定性验收**（无硬件、无真实 Agent 会话即可重复运行）：第 1–6 节的验收矩阵与测试替身边界，
   对应矩阵 A–Q 的正式测试；这些检查已登记进两道门禁。
2. **单次真实两轮执行**（由上游执行，本仓库只归档原件、不重跑）：一次真实
   Claude Code + 本地共享 GPU 两轮运行及其独立核查。原件与边界见
   [evidence/p1-feedback-20260912/README.md](evidence/p1-feedback-20260912/README.md)；
   门禁记录见 [evidence/p1-feedback-20260912/final-gates.json](evidence/p1-feedback-20260912/final-gates.json)；
   新版观察代码块的只读回放结果见
   [evidence/p1-feedback-20260912/e2e-observer-verification.json](evidence/p1-feedback-20260912/e2e-observer-verification.json)。

**边界**：第一阶段完成**不等于**方案 D 的后续两个阶段（`TEAM_HANDOFF.md` §14 第 6–7 项：
诊断证据三判定拆分 + 发布决策层，以及 KernelWiki 导入器 + 确定性选择器），
也**不构成 N=20 稳定性结论**。

## 1. 被验收的命题

第 2 轮必须知道第 1 轮的真实结果，且这份“知道”必须来自生产路径本身：

1. 第 1 轮的真实执行经验由生产验证器（shared-GPU experience verifier）写入经验库；
2. 第 2 轮启动时由生产 `round-experience-service` 冻结选择，经生产 `agent-runtime`
   渲染进发给 provider 的 prompt；
3. 第 2 轮 prompt 里的轮次事实（`roundFacts`）来自生产归档 `resetMissionRunState`，
   而不是测试手填。

**禁止的证据**：测试直接给 `iterationContext`、`roundFacts`、`resolvedTarget` 赋值，
或从 `items[0]`/baseline/human 记录兜底来“证明”连通性。

## 2. 验收矩阵

| # | 命题 | 用例 | 观测点（真实来源） |
|---|---|---|---|
| A | 第 1 轮候选执行经验被真实验证器采纳 | `round-feedback-integration-test` A/B | 队列投影 + `sharedGpuExperienceVerifier` + 经验库读回 |
| B | 第 2 轮 prompt 携带该经验的 id/version/完整内容 | A/B、E2E 续轮审计 | 生产 `buildCandidateGenerationPrompt` 产出的 prompt |
| C | `roundFacts.previous` 绑定第 1 轮 run/round/candidate/digest/queueRequest | A/B | 归档条目 + prompt 内 `MISSION ITERATION CONTEXT` JSON |
| D | 目标轮 `roundFacts.target` 跟随已准入 Round | A、K | 生产 round budget + 归档 |
| E | 后端标识不得当作硬件维度 | C | `ROUND_EXPERIENCE_TARGET_INVALID` |
| F | 架构必须分维度（sm86 ≠ sm100） | D | 选择清单 excluded reason `scope` + `resolvedTargetMismatch` |
| G | 错误任务快照不得推进 | E | 真实 `applyOperatorTestSnapshot` 的 no-op |
| H | 证据身份冲突必须失败 | E | `ROUND_EXPERIENCE_EVIDENCE_CONFLICT` |
| I | baseline 轮清空 benchmark 但保留 resolvedTarget | F | 生产投影 |
| J | 零经验轮仍保留完整轮次事实 | G | 真实 verifier 跳过 + prompt 内事实 |
| K | 20 条上限与 64 KiB 上限可达且原因可审计 | H1/H2 | `retrieveWithSelection` excluded reason `limit`/`budget` |
| L | 算子测试失败通道进入 failureRecords 与 prompt | I | `OPERATOR_TEST_FAILED` → `benchmark.lastServiceError` |
| M | 基础设施失败不写入算子经验 | J | `facts.classification === 'infrastructure'`，collect 记录 0 条 |
| N | 归档确定性（重复 reset、旧轮无 roundId、JSON 还原） | K | `runHistory` 快照 + 冻结事实 |
| O | Journal capture/replay 不重新读经验库 | L | 冻结 intent + provider 效果重放 |
| P | 发送前审计是 write-before-send 且失败即阻断 | `prompt-audit-test` 2/3 | provider `start` 内部读审计文件；`PROMPT_AUDIT_WRITE_FAILED` 时 `startCalls === 0` |
| Q | 版本冻结、排除项可审计、contextId 不匹配 fail-closed | `prompt-audit-test` 4/5 | `prepare` 复用 contextId 且 `reads()` 不变；`ROUND_EXPERIENCE_SELECTION_CONFLICT` |

## 3. 命令

```bash
node tests/round-feedback-integration-test.mjs
node tests/prompt-audit-test.mjs
node tests/module-boundary-test.mjs
```

两个新测试也已登记进发布门禁：

```bash
npm run verify:local-c500-release
npm run verify:non-hardware-robustness
```

## 4. 证据类型（必须说清楚边界）

- **真实**：文件系统经验仓库、经验/轮次领域服务、shared-GPU 经验验证器、round budget、
  `applyOperatorTestSnapshot`、归档 `resetMissionRunState`、journal capture/replay、
  `agent-runtime` 的 prompt 组装与 `writePromptAudit`、临时工作区。
- **替身（显式注入）**：Agent provider 客户端（避免消耗真实 Agent 会话）、
  execution-package store/adapter、readTask、checkpoint 创建和 rejected-round recovery
  端口。队列快照是按 runner 实际结构手工构造的 fixture；真实临时目录不代表本测试执行了
  真实 Git 回滚。读计数 proxy 包装真实文件系统经验仓库，没有替换底层存储。
- **prepared-before-send**：审计件证明生产边界准备了什么、并把什么交给了 provider 端口。
  它**不证明**真实 provider 进程收到或遵循了什么；`e2e:shared-gpu-agent-iteration`
  的续轮断言同样只读这份审计件，不声称 `audit.prompt === provider start.goal`。
  唯一观察到“交给 provider 端口的字符串”的地方是 `prompt-audit-test`，由 provider
  替身在自身 `start()` 内直接读取审计文件完成。

## 5. 清理与环境隔离

两个测试各自创建唯一的 `mkdtemp` 根目录，在动态导入生产模块之前设置
`OPERATOR_RUNTIME_DIR` / `OPERATOR_DATA_DIR`，并在 `finally` 中只删除该根目录；
不会在允许路径之外留下产物，也不访问父目录或凭据。

## 6. 未决与限制

- 真实 GPU / 真实 Agent 的端到端运行由上游执行，本验收不消耗真实 Agent。
- 本文与两个新测试都不包含 N=20、长期运行或真实硬件稳定性结论。
- `e2e:shared-gpu-agent-iteration` 是可选的真实 GPU + 真实 Agent 验收，默认不进门禁。

## 7. §14.1–§14.5 结果

以下结果只区分两类证据：确定性检查（可重跑）与**一次**真实两轮执行（原件归档，不重跑）。

### 14.1 目标架构正式测试

- 驱动证据解析目标架构的正式回归已登记进两道门禁（对应矩阵 F：架构必须分维度，`sm86 ≠ sm100`）；
  这部分提交为 `fc251a8`。经验查询与轮次事实提交为 `dd95938`，后者也是实机运行时
  [code-manifest.json](evidence/p1-feedback-20260912/code-manifest.json) 记录的 Git 基线；
  当时尚未提交的审计代码由同一文件中的源码 SHA256 单独记录。
- 最终门禁由上游执行：`npm.cmd run verify:non-hardware-robustness`（含 release），
  结束标记 `final-gates.exit` 为 `0`，完整日志见
  [final-gates.log](evidence/p1-feedback-20260912/final-gates.log)，记录见
  [final-gates.json](evidence/p1-feedback-20260912/final-gates.json)。
  日志实际通过行为 `[release-check] PASS: 132 checks completed` 与
  `[non-hardware-check] PASS: 34 checks completed without physical hardware`，无 `FAILED:` 行。
- 本隔离工作区的 worker **未**运行该门禁、GPU 或 Agent，只等待上游结束标记并逐字节复制已完成日志。

### 14.2 查询侧消费同一个实际目标

- 生产投影出的 `resolvedTarget` 由生产 `round-experience-service` 消费，不再恒为 0 条：
  真实运行原件 `affine-state.json` 的 `iterationStats.roundExperience.items[0].evidence` 绑定
  `candidate-01` / `run_13F95DB70766B3CCDFE6F1FF`（patch `1d1a8932…`）。
- 确定性侧由 `round-feedback-integration-test` A/B 与选择重放检查覆盖，对应矩阵 A–K。

### 14.3 冻结轮次事实

- 下一轮 prompt 的 `roundFacts` 来自生产归档 `resetMissionRunState`，不是测试手填。
  第二轮审计（`bridge/prompt-audits/claude_MTY3D3AA_C95A6106.json`，归档原件）记录：
  `previousRunId claude_MTY3AZLZ_D6E64670`、`previousRoundId MIS_MTY3ADFI:round:1`、
  `gateResult reference`、`rollbackPerformed true`、`currentBestCandidateId null`。
- 归档确定性（重复 reset、旧轮无 roundId、JSON 还原）由矩阵 N 的确定性检查覆盖。

### 14.4 发送前 prompt + digest + selection 审计

- 审计件为 `deliveryStage: prepared-before-send`，上游独立验证结果
  `p1-feedback-verification.json` 记 `status: passed`：第一轮 prompt 12045 UTF-8 bytes、
  digest `sha256:0f1930961a240b19c813ceeb5c3be76ae4c5a6c0c4fa264855fbbbd84e6d3f39`；
  第二轮 prompt 21244 UTF-8 bytes、digest
  `sha256:f711c70470511a4067433733eb50fc765328d829619c0ffa486bbe15d33d2996`、
  `roundId MIS_MTY3ADFI:round:2`。
- selection 绑定为 `MIS_MTY3ADFI` / `candidate-01` / patch `1d1a8932…` /
  queueRunId `run_13F95DB70766B3CCDFE6F1FF`，无 baseline / human 兜底。
- 新版 E2E 观察代码块事后对真实原件只读回放通过（`scriptSha256 7bb7cda45eac19b6a177614a38a5e7121bd437fd1221dd7e138377757d5aca0c`），
  4 个篡改负例（prompt 内容、prompt 版本、嵌入 facts、外来候选证据）被拒绝；
  详见 [e2e-observer-verification.json](evidence/p1-feedback-20260912/e2e-observer-verification.json)。

### 14.5 最小两轮生产路径验收

- 一次真实运行：runtime `claude-code`，后端 `local-shared-gpu`，`hardware=nvidia-gpu`，
  设备 `NVIDIA GeForce RTX 3060 Laptop GPU`，架构 `sm86`。
- 两个**不同**候选均 4/4 correctness，且都在 `primary` / `small` 两个 benchmark profile 下运行
  （`candidate-01`、`candidate-02`，绑定见
  [证据 README](evidence/p1-feedback-20260912/README.md)）。
- 序列：round 1 `claude_MTY3AZLZ_D6E64670` 结果 `reference`（性能未达目标）→
  1 次 rollback（checkpoint `cp_59828E28-4B2`，`workspaceClean: true`，
  `restoredAt 2026-09-12T07:56:35.142Z`）→ second run `claude_MTY3D3AA_C95A6106`。
- 原件记录：`workflowWritesAfterStart = 0`、`budgetTerminalAccepted = false`、
  `completedCandidateTasks = 2`、`experienceCount = 2`、`gate: reference`、
  `publishable: false`。

## 8. 结果边界（不可越界声明）

- 14.4 的新版观察是**只读回放**（`liveDriverWasUpdated: false`），
  **不是**重新实机运行整个新版 driver；本次实机用的是原版 driver（fingerprint 见 `code-manifest.json`）。
- 审计件只证明**准备发送的文本**；Provider `start.goal` 与发送前文本一致由双 Provider
  确定性测试另行证明。**不声明模型遵循了提示词**。
- 单次真实两轮运行**不构成 N=20 统计稳定性**；sharedGPU 观察为 `hardware-observation` 且
  `publishable: false`，**不可发布**。
- 第一阶段（§14 第 1–5 项）完成**不覆盖**第 6–7 项（方案 D 第二、第三阶段），
  本记录也不包含第 6–8 项结论。
