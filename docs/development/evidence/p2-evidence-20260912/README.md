# Phase 2 证据治理当前证据索引（2026-09-12）

本目录归档 Phase 2（`TEAM_HANDOFF.md` §6.12 / §14.6，验收基准
[`P2_EVIDENCE_ACCEPTANCE.md`](../../P2_EVIDENCE_ACCEPTANCE.md)）的检查原件与上游核验记录。
19 份 JSON/日志原件逐字节复制，`verification.json` 由上游从最终日志和源码清单计算。
**Phase 2 无硬件验收通过**；本目录不包含任何新的
GPU / 真实 Agent 运行，不构成 N=20 稳定性或真实发布声明。

**最终双门禁：release 136 / non-hardware 38，exit 0。** 上游在最终集成树运行
`npm.cmd run verify:non-hardware-robustness`（内部先执行完整 release 门禁），
UTC 13:11:55 开始、13:21:32 完成。运行前后复算 485 个代码与测试文件 SHA256，无变化。
机器结论见 [verification.json](verification.json)，原始退出记录见
[final-full-gate.json](final-full-gate.json)，完整输出见 [final-full-gate.log](final-full-gate.log)。

## 归档原件、用途与证明范围

| 原件 | 内容 | 证明范围（不证明什么） |
|---|---|---|
| [verification.json](verification.json) / [final-full-gate.json](final-full-gate.json) / [final-full-gate.log](final-full-gate.log) | 最终 136 / 38 项，exit 0，源码无变化 | 证明本阶段无硬件验收；不证明实机稳定或真实发布 |
| [preflight-full-gate.json](preflight-full-gate.json) | 预检 `npm.cmd run verify:non-hardware-robustness`：`exit 1`，含起止时间 | 记录**真实失败**；不证明门禁通过 |
| [final-review-checks.json](final-review-checks.json) | 迁移后聚焦复跑：`test:shared-gpu-acceptance`、`test:smoke`、`e2e:cpu-iteration` 均 `exit 0` | 证明迁移后这三条检查在 CPU 上终止 exit 0；不证明两条总门禁整体通过 |
| [integration-checks.json](integration-checks.json) | 5 组集成/模块检查 `exit 0`：evidence-governance-integration、knowledge-state、workflow-summary、local-c500-tui-logic、round-feedback-integration | 证明这些模块的确定性集成行为；不覆盖真实硬件 |
| [consumer-review-probe.json](consumer-review-probe.json) | 消费侧/决策投影探针：15/15 通过 | 证明 Gate/资产/UI/经验投影一致、幂等与绑定拒绝；无硬件检查 |
| [gate-review-probe.json](gate-review-probe.json) | Gate 域探针：29/29 通过（含 wrong binding、mock 越权、benchmark 非法值、正例） | 证明域决策规则；受控替身，不是实机发布证据 |
| [harness-review-probe.json](harness-review-probe.json) | 验收 harness 探针：25/25 通过（含 P1 原件只读回放、预算/release、N20 分组语义） | 证明账本/资格判定工具本身；**不是** N=20 实测 |
| [final-source-manifest.json](final-source-manifest.json) | `baseCommit 6a5ae54c…`，UTC 13:11:55，485 个参与源码/测试文件的原始字节 SHA256 | 固定被检查内容；与 verification 的运行后核对配合使用 |
| [manifest.json](manifest.json) | 本包 JSON/log 的 SHA256 与字节数，逐文件对应上游原件 | 核对归档保真；不额外产生运行证据 |

这些 JSON 内的 `log` 字段保留原运行路径；对应日志也已以同名文件归档到本目录。
预检失败见 [preflight-full-gate.log](preflight-full-gate.log) 和
[smoke-before-gate.log](smoke-before-gate.log)；修复后聚焦复跑见
[HTTP smoke](test-smoke-final-review.log)、[CPU E2E](e2e-cpu-iteration-final-review.log)、
[观察器与账本](test-shared-gpu-acceptance-final-review.log)。五组集成原始输出保留为本目录
`test-evidence-governance-integration.log`、`test-knowledge-state.log`、`test-workflow-summary.log`、
`test-local-c500-tui-logic.log`、`test-round-feedback-integration.log`。
所有文件角色和摘要以 manifest 为准；包内 Git 属性禁止 JSON/log 换行转换。

## 预检失败的真实根因与处置

1. 预检中 **release 门禁通过（release 135）**，但 **non-hardware 门禁失败**：旧的 CPU
   「all simulation」断言把当前 CPU 运行来源回填给历史无绑定经验，与 Phase 2 的证据归属
   约束冲突；HTTP smoke 出现**同类断言失败**。
2. 迁移内容被**精确限定为历史 3 条无绑定草稿**（`exp.async-plan-cache`、
   `exp.c550-plan-cache-boundary`、`exp.cross-platform-adoption-gate`）：它们没有自己的完整
   `evidenceBinding`，保持 `status=unknown` / `publication=blocked` / `review_required`，
   **不为其伪造或回填当前决策**。CPU 当前候选的生产决策仍为 `cpu` / 采用 allowed / 发布 blocked，
   并在 benchmark、candidate Gate、review、currentBest 中保持同值。
3. 迁移**未**放宽任何门槛：独立 oracle、固定测试矩阵、字节/摘要一致性、回滚与幂等要求全部保留。
4. 迁移后上游聚焦复跑已 `exit 0`；随后最终整套门禁也以 136 / 38 项、exit 0 完成。
   预检失败原件保留，不改写成成功。

## 关键任务/模块简表（不逐条重述过程）

| 任务/模块 | 状态 |
|---|---|
| `task_8825a5839e92468184c69d5d7166ac47` | **已取消**：快照发生变化，`retry_source_unavailable` 且无产物；保留取消历史，**不计入成果** |
| `task_5742dadcd6ff47ab8ef69edef686fc06` | 接续上述取消项，已完成集成并通过独立验证（见上方集成/探针原件） |
| diagnostic predicate + versionedGate + production/adoption/governance/facts/prompt/UI + unknown/binding | 已按劳务任务集成，对应冻结契约；由本目录确定性探针覆盖 |
| 4 个新增正式测试脚本 | 已登记两道门禁：`test:evidence-decision`、`test:diagnostic-runner`、`test:evidence-governance-integration`、`test:shared-gpu-acceptance` |

## 明确非声明与后续实机路线

- **没有任何新的 GPU 或真实 Agent 运行。** 没有新版 driver 的完整实机 smoke、没有 N=20、
  尚未实现真实诊断工具输出 parser、没有 live publication。工具进程 exit 0 只可能证明采集可用，
  当前输出仍不含可授权的 kernel events/metrics。P1 的真实两轮运行属于
  [P1 证据归档](../p1-feedback-20260912/README.md)，不能当作 Phase 2 的实机证据。
- 当前 driver **未观察到 model 值**；`declared` / 环境变量标签不能使 N=20 可比
  （`shared-gpu-acceptance` 的分组规则要求 observed）。
- 后续顺序固定：**先补齐 model 观察**，再在同一配置下做真实两轮 smoke；家族覆盖与 N=20
  是两项**分开**的结论。不能声称「直接跑 20 次就有资格」。
- 真实后端是本地共享 GPU（`local-shared-gpu`，`publishable=false`）；`tester:c500` launcher
  仍硬编码 `local-c500`，真实 GPU 走显式 e2e 命令且默认 Claude。
- **不宣称 C550 可发布**，也不把本目录任何确定性结果升格为真机发布证据。

## 复核入口

在仓库根运行 `npm.cmd run verify:non-hardware-robustness` 可重跑两道门禁。
本阶段新增的四个正式测试均在其中，测试通过不新增硬件样本。
`final-source-manifest.json` 记录验证时的工作树原始字节；源码普通文本可能在后续 Git checkout
时按仓库既有规则转换换行，比较时须区分文本等价与原始字节。证据包内 JSON/log 则保持字节保真。

## 归档文件

- [preflight-full-gate.json](preflight-full-gate.json)
- [final-review-checks.json](final-review-checks.json)
- [integration-checks.json](integration-checks.json)
- [consumer-review-probe.json](consumer-review-probe.json)
- [gate-review-probe.json](gate-review-probe.json)
- [harness-review-probe.json](harness-review-probe.json)
- [final-source-manifest.json](final-source-manifest.json)
