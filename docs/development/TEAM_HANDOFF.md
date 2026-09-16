# Operator Studio 开发交接文档（团队版）

> 历史交接日期：2026-09-11（以下页头为当时快照；当前状态见下方 2026-09-15 入口）
> 交接分支：`handoff/codex-job-supervisor-p1`（领先 origin **2 个未推送提交**）
> 稳定基线：`main` = `9b80437`
> 本文档替代口头交接。**第 3 节（文档与代码不一致）必须先读**，否则会照着过时描述做错方向。

> **最新入口（2026-09-16，三条件实机与报告修复）**：冻结源 `13f2014` 的 R5 实机计划
> 保留为 3 完成 / 1 预算终止 / 5 未启动，三种条件各完成一次；14/14 必需模型身份已观测。
> 预算终止报告的只读分支已补齐，原件复核仍保持失败，不能算九次通过或新 N20。
> 当前证据、软件检查和经验收集超时诊断见
> [`evidence/experience-study-20260915/status.json`](evidence/experience-study-20260915/status.json)。
> 本次按用户授权由主代理直接实施，未派发 dispatch 下游。
>
> **此前入口（2026-09-15，Phase 3 软件批次）**：Phase 3（KernelWiki 导入器 + 确定性选择 +
> 现有生产 API/prepare 集成）的**软件实现**已独立验收并集成，生产实现提交
> `bb3ddd5dfbe9285ec982c795ede04595edcf69cf`（其后仅由 Root 补充 review 主题词，生产代码未再改动，
> `status.json` 已锁定）：新增 31 个用例（import 8 / selection 16 / runtime 7）通过，
> `release 147 / non-hardware 44`，exit 0；固定源 KernelWiki `b6b4301f…369e6` 实际 52 页 / 54 单元，
> 幂等导入 54/54（第二次 `unchanged`），两条 sm86 已审查建议进入最终 prompt，其中经验注入区块
> `renderedBytes` 为 6 383 UTF-8 字节（**不是**完整 prompt 长度），
> `publishable=false`。**本批无新的实机模型/GPU 运行**：新生产版本没有新增实机 E2E 或 N20，
> 三条件（无经验 / 仅本地经验 / 本地+已审查 Wiki）收益**仍待验证**（同任务预算与同 Profile，
> 样本量与是否启动由上游决定），本批不宣称性能或发布能力。
> 读者说明与必要 CLI/HTTP 用法见
> [`PHASE3_WIKI_ACCEPTANCE.md`](PHASE3_WIKI_ACCEPTANCE.md)；单一事实源、全部计数与失败细节见
> [`evidence/p3-wiki-20260915/status.json`](evidence/p3-wiki-20260915/status.json)。
>
> **此前的实机验收入口（2026-09-15 UTC，仅对冻结源 `21c6d78` 有效，不适用于当前 HEAD）**：冻结生产源码
> `21c6d7868bd3c5aa74dfcc098f87e3ad4236f948`（git clean）。本批真实回归在本机共享 NVIDIA GPU
> （`sm86`、`publishable=false`）上完成并通过独立验收：affine smoke 1 次运行 / 2 候选 /
> 2 次实际模型观测；**严格 N20 20/20 `full_success`、20/20 独立验证且可比、44/44 实际模型观测
> （`deepseek-v4-flash`）、40 个不同候选**，队列任务全部终态释放、`workflowWritesAfterStart=0`；
> 另做**单独** reduction / normalization 两家族覆盖（每族两轮）4 个不同候选、4/4 实际模型观测，
> 不计入 N20。原件归档 SHA-256：smoke `f519a0cc…ca045`、N20 `ccd79f93…92aca`、
> coverage `fe88c8f0…603d7`（逐项核验；索引见各 `originals-manifest.json`）。
> 权威事实与范围：[`evidence/run-diagnostics-20260914/acceptance.json`](evidence/run-diagnostics-20260914/acceptance.json)、
> [`evidence/closeout-20260915/ACCEPTANCE.md`](evidence/closeout-20260915/ACCEPTANCE.md)；
> 原件 reader/diagnostics 见
> [`n20-recovered-20260915`](evidence/run-diagnostics-20260914/n20-recovered-20260915/reader.json)、
> [`coverage-recovered-20260915`](evidence/run-diagnostics-20260914/coverage-recovered-20260915/reader.json)；
> 交付状态与离线复核结果以
> [`evidence/closeout-20260915/closeout.json`](evidence/closeout-20260915/closeout.json) 为单一事实源，
> 便携交付包的操作说明见
> [`evidence/closeout-20260915/PORTABLE.md`](evidence/closeout-20260915/PORTABLE.md)。
>
> **本文件的时效划分**：§6「专家裁定（方案 D）」仍是当前设计权威，**原文逐字保留、未改动**；
> §8.4「用户已定的边界」与 §9「工程约束与工作规则（不可退让）」是**仍然有效**的既定边界与工程
> 不变量，同样原文保留、继续适用；§0 的阅读约定也仍然有效。被历史化的只有**旧的运行/提交/
> 实施/待办状态**——§3 的过时描述、§4 提交状态、§7 实施状态、§12 未验证假设、§14「立即下一步」
> 第 0–8 项，它们记录的是 2026-09-11/12 的状态，**旧 §14 状态已过期**，不得再当作当前结论或
> 当前下一步引用。历史失败/unknown（旧 `83b91d6` 严格 N20 19 可比 + 1 unknown、无响应与代理
> 重试失败、被拒绝的外发请求等）在原证据中**原样保留**；该实机批次止于上述回归、未涉及 Phase 3，
> Phase 3 的最新状态见上方入口；旧实机结论不能因为工作树 git clean 或后续无生产变更就当成新 HEAD
> 的实机证据。该批无生产代码变更、未推送远端。术语：**「下游」仅指
> dispatch 平台 agent**；被测的 Acagemm 运行 agent 不是下游。

---

## 0. 怎么读这份文档

| 你是 | 先读 |
|---|---|
| 第一次接触这个项目 | 1 → 2 → 3 → 10 |
| 接手继续开发 | 3 → 4 → 5 → 6 → 7 → 8 |
| 只想跑起来验证 | 10 → 11 |
| 要做架构评审 | 2 → 3 → 6 |

本文档记录的是**代码与实测证据**，不是计划或推测。凡是推测，都在第 12 节明确标注。

---

## 1. 一句话现状（2026-09-11 历史快照，已被顶部当前入口替代）

闭环的**逻辑**已经跑通并在真实 GPU 上验证过单次端到端（真实 Claude Agent 改真实工作区 → 真实 GPU 队列 → 4/4 正确性 + 基准 → Gate → 自动回滚续轮），但**「整个迭代流程稳定」目前证不了**，而且**闭环八环里有两环是结构性断的**——其中一环（经验注入）已经定位到根因并开始修，另一环（轮次事实）发现通道建好了但生产端从没接数据。

当前处于「专家已裁定方案、Phase 1 实施到一半」的状态。

---

## 2. 项目是什么

**Operator Studio**：面向异构算子优化的本地 Agent 工作台。

- 当前客户端是 TUI，生产入口 `npm run tester:c500`
- 目标：用户给出优化目标，系统自动完成「生成候选 → 验证 → 采纳/回滚 → 沉淀经验」的连续迭代
- 依赖方向固定：`TUI → HTTP API → application orchestration → domain rules → ports → adapters`。domain 不得依赖 TUI / HTTP / Claude / Codex / 硬件 / 文件系统实现；HTTP route 不得复制 workflow / Gate / 硬件规则

### 2.1 闭环主管线

```
Mission
  → 真实 Agent 在自己的工作区改代码
  → 工作区 Git Diff 是候选准入的唯一权威
  → 串行 Operator Test Queue
  → 正确性 + 基准
  → Accept Gate（采用 / 保留参考 / 拒绝 / 转人工）
  → 未达标：回滚工作区 + 自动开启下一轮
  → 经验沉淀入库
```

### 2.2 验证体系（三层）

| 层 | 命令 | 性质 |
|---|---|---|
| 确定性 E2E | `npm run e2e:cpu-iteration` | 不调真实 Agent，用 Reference Fixture 生成候选；**在门禁内** |
| 总门禁 | `npm run verify:local-c500-release` | 128 checks + build；含全部单测 |
| 总门禁 | `npm run verify:non-hardware-robustness` | 30 checks；第一项就是上面那道 |
| 真实 Agent E2E | `npm run e2e:cpu-agent-iteration` / `npm run e2e:shared-gpu-agent-iteration` | **opt-in**，消耗真实会话配额，需要真实 GPU |

**门禁没有自动发现机制**：新增测试必须同时登记进 `package.json` 的 `scripts` **和**门禁脚本的 `checks` 数组（`scripts/verify-local-c500-release.mjs`、`scripts/verify-non-hardware-robustness.mjs`），否则永远不会被执行。

---

### 2.3 全局开发节点（产品口径）

产品规格书是根目录的 **`原型文档.md`**（标题：*Agent 驱动的异构算子优化云：一步到位原型开发文档*，Prototype Specification v2）。它把产品定义为**四个不可拆分的部分**：

```
1. Operator Studio Client      桌面工作台：代码、Agent 会话、候选、测试、优化状态
2. Agent Control Plane         长期任务编排、上下文管理、角色协作、权限控制、人工审批
3. Knowledge & Capability Cloud 统一存储/版本化/检索/分发 Experience、Skill、Tool、Playbook
4. Heterogeneous Execution Cloud 统一管理异构环境的测试队列、Worker、证据、产物
```

原型要求**必须覆盖 8 项**（`原型文档.md` §3.2）。逐项对照当前代码与实测证据：

| # | 原型必须覆盖 | 现状 | 依据 |
|---|---|---|---|
| 1 | 桌面客户端 | ⚠️ TUI 已接生产 HTTP API（`npm run tester:c500`）；`src/` 有 Web 开发客户端（2 个 .jsx）；**GUI 只有规划**（README：「后续 GUI 将复用同一个 HTTP API」） | README、`src/` |
| 2 | Agent Mission 工作流 | ✅ 闭环：自动迭代、自动续轮、Accept Gate、回滚、人工终态 | 真实 E2E 证据 |
| 3 | 云端 Experience / Skill / Tool 管理与检索 | ⚠️ **本地版闭环**（查询/草稿/沉淀已进生产 workflow）；**云端化与 Skill/Tool 管理未做** | `experience-*` 模块、真实 E2E |
| 4 | 两类以上异构 Worker 的注册、路由和执行 | ⚠️ CPU + 本地共享 GPU 真跑通；C500/C550 后端已过时；**云端队列未做** | `local-shared-gpu-runner.py`、E2E |
| 5 | Correctness / Benchmark / Profile 三类任务 | ⚠️ 前两类真实执行；**Profile 明确是 `unavailable`/mock**（共识禁止用它伪造诊断结论） | 真实结果里 `tracer/profiler: unavailable` |
| 6 | 候选对比、证据分级和 adoption 审批 | ✅ Accept Gate（采用 / 保留参考 / 拒绝 / 人工） | `client-runtime/accept-gate.mjs` |
| 7 | 经验自动草拟 → 人工确认 → 发布 → 再检索 | ⚠️ 前段闭环；**「发布」这一环在当前真实后端下结构性不可达** | 缺陷 5.4 |
| 8 | 组织、项目和用户权限边界 | ❌ **未开始**——仓库里没有任何 user / org / identity / auth 模块 | 全仓文件名检索 |

`原型文档.md` §3.3 还明确列出**暂不覆盖**：公有云商业计费与支付、大规模 Kubernetes 自动扩缩容、完全无人值守地把候选直接合入生产分支、复杂模型训练平台或通用 CI/CD、所有硬件平台的正式适配（原型只需证明 Adapter 机制）。**评审时不要把这些当缺口。**

### 2.4 工程工作包 T1–T7

`GENERIC_OPERATOR_GOAL.md` 把工程拆成 7 个工作包。最新的 P0/P1 checkpoint（2026-09-09）原话：

> Loop status: P0 stability and P1 generic package import complete. Cloud queue, additional native language adapters, stronger OS isolation and Profiler/Tracer remain subsequent goals.

| 包 | 要求 | 状态 |
|---|---|---|
| T1 | 语言中立的包 / 环境 / 准入 / 请求结果 / 测试工具契约 | ✅ 基础完成 |
| T2 | 不可变包装配与有界目标准备 | ✅ 基础完成 |
| T3 | 本地队列 + 严格 CPU 适配器 | ✅ 基础完成（shared-GPU 适配器已接同一队列端口） |
| T4 | 非预置 Mission 的 API/TUI 与自动迭代（≥3 个算子族） | ⚠️ 单族已验证（affine）；三族全量未跑 |
| T5 | 有界 I/O、准备、队列/轮次预算、取消与恢复 | ✅ 基础完成；集成故障注入待补 |
| T6 | 经验库、服务与轮次集成 | ✅ 基础完成 |
| **T7** | **真实 Agent E2E、回归与契约** | ❌ **唯一未结的工作包**——当前所有工作都在 T7 内 |

### 2.5 代码地图

| 目录 | 规模 | 内容 |
|---|---|---|
| `client-runtime/` | 249 文件（**152 .mjs 实现 + 96 .md 模块契约**） | 核心运行时：`application/`（编排）、`server/`（HTTP/SSE）、`agent-runtime/`（provider 注册表）、`candidate-generation/`、以及各 domain 状态模块。**每个 .mjs 通常配一份同名 .md 契约，改代码要同步改契约** |
| `tests/` | 157 文件（155 .mjs） | 测试。`package.json` 里共 **154 个 `test:*` 脚本** |
| `scripts/` | 26 文件 | 两道总门禁、各 E2E 驱动、探针、评测 |
| `tools/` | 30 文件（16 .mjs + 3 .py） | `local-shared-gpu-runner.py`、`local-cpu-runner.py`、`local-c500-runner.py`（基类）、`local-c500-tester/`（生产 TUI） |
| `src/` | 3 文件（2 .jsx） | Web 开发客户端；GUI 可复用它调用的 Production API |
| `package.json` | **182 个脚本** | 入口索引 |

**注意 `client-runtime/` 有 96 份 .md 契约**：这个仓库的约定是「模块文档、边界测试和验证脚本必须同步更新」（`TEMPORARY_CONSTRAINTS.md`）。只改 .mjs 不改同名 .md，会被评审打回。

## 3. 文档与代码不一致（**先读这一节**）

### 3.1 真实执行后端是本地共享 GPU，C500 / C550 后端已过时

仓库里有三处文字与这个事实**相反**，不要照着做：

| 位置 | 过时描述 |
|---|---|
| `README.md` | “目标真机：沐曦 C550” + 一整节「硬件命名约束」 |
| `docs/development/GENERIC_OPERATOR_GOAL.md` | T7 写作 “Real Codex E2E” |
| `docs/development/CURRENT_TASK_HANDOFF.md` | S3 写作“完成真实 Codex 最小探针” |

**代码侧的事实（以代码为准）**：

- 真实后端是 `OPERATOR_TEST_BACKEND=local-shared-gpu`，由 `tools/local-shared-gpu-runner.py` 实现（`nvidia-smi` + CUDA event 计时）
- 它**复用了既有的 `local-c500-service-client` 队列端口，不建第二套调度器**（见 `tools/local-shared-gpu-runner.md`）
- 该 runner 以 `importlib` 加载 `tools/local-c500-runner.py` 作为基类并覆写探测（`runner._probe_c550 = _probe_nvidia`）
- 结果带 `source=local-shared-gpu`、`executionMode=gpu`、`publishable=false`

### 3.2 「真实 Codex E2E」应理解为 provider-neutral 的「真实 Agent E2E」

运行时兼容层（`client-runtime/agent-runtime/definitions.mjs`）已注册三个条目：`claude-code` / `codex-cli` / `opencode-server`，各自声明 `clientKey` / `eventParser` / `failureClassifier` / `usageSemantics` / `capabilities` / `slug` / `unavailableCode` / `managedWorkspace`。上层按 registry 分派，失败码统一用 `` `${slug.toUpperCase()}_...` `` 生成，**准入、结算、Gate、Queue 都不感知 provider**。

**但兼容层统一的是「接口」，不是「事件形状」。** 举例（这是真实缺陷，见 5.6）：Codex 把结构化编辑放在 `item.type: 'file_change'`，Claude Code 把每个 `tool_use` 都规范化成 `item.type: 'command_execution'`、真身份只留在 `item.name`。下游代码一旦假设单一种形状，就只在那个 provider 下是对的。

**结论**：换 provider 跑 E2E 成立；「跑了一个 provider 就等于两个都验过」不成立。

### 3.3 两个 E2E 的默认 provider 不一致（待修）

| 脚本 | 默认 `E2E_AGENT_RUNTIME` |
|---|---|
| `scripts/e2e-cpu-agent-iteration.mjs` | `claude-code` |
| `scripts/e2e-shared-gpu-agent-iteration.mjs` | `codex-cli`（且默认模型写死 `gpt-5.6-sol`） |

要跑 Claude 版 GPU E2E 必须显式 `E2E_AGENT_RUNTIME=claude-code`。

---

## 4. 从上一任同事接手后的进展

### 4.1 上一任交付了什么

交接分支上自稳定基线 `9b80437` 起有 3 个提交：

| 提交 | 内容 |
|---|---|
| `c63b132` | wip: hand off codex job supervisor p1 —— Windows Job Object supervisor、实时 JSONL 采集、release proof、交接文档 |
| `138f9cf` | docs: finalize p1 handoff branch instructions |
| `84386bb` | fix: close out codex job supervisor p1 with verified gates |

**接手时核查发现的问题（已在后续提交中处置）**：

- 门禁曾被中断，不能算 PASS —— 已从头重跑
- `test:local-c500-production-tui` 断言失效（源码断言过时）—— 已修断言，未放宽保护强度
- Job 测试 flake 是真缺陷（负载下 16 路 CPU 时 9 次失败 5 次）—— 诊断为「测试用固定墙钟猜测代替握手证据」，已改为等待 `child.started` 握手；修复后同样负载下 12/12 通过

### 4.2 本会话新增的两个提交（**尚未推送**）

| 提交 | 内容 | 验证 |
|---|---|---|
| `fa87f50` | fix: make candidate generation paths and admission fail closed | 128 / 30 门禁 exit 0；真实 Claude GPU E2E exit 0 |
| `ad73fd8` | docs: record candidate-generation handoff, provider tool identity and E2E run-root limits | 文档改动在门禁之后，已补跑会读取这些 README 的测试，exit 0 |

`fa87f50` 的实质内容：

1. **准入 fail-closed**：Provider 未正常终结时不再预置 `verifiedCandidates = agentResult.candidates`（声明候选会带着 `patchDigest === undefined` 进入候选池且 `candidateValidation` 为 null）。现在一律丢弃并给出 `*_CANDIDATE_INSPECTION_SKIPPED`
2. **空候选七类分类**：新增 `client-runtime/candidate-generation/classification.mjs`（纯函数），固定优先级 1→3→4→6→7→2；第 5 类由 `inspectCandidateDiff` 的工作区观测产出
3. **生成路径降级标记**：`candidateGenerationPath` / `degraded` / `degradationReason` / `editToolStatus` / `patchValidation` / `workspaceAdmission` 透传；只描述生成路径，不参与任何 `passed` 判定
4. **编辑工具身份按 provider 读取**（见 5.6）
5. **`resetMissionRunState` 按 runId 就地替换**（原先无条件前插会产生重复归档条目，污染重复 digest 拒绝的输入）
6. **修复两个 Windows 原子写竞态**（`EPERM` 下 `rename` 失败吞掉操作）
7. **E2E harness**：run root 支持 `E2E_RUN_ROOT` 覆盖，`summary` 自述实际生成路径

### 4.3 工作树里**未提交**的改动（本会话 Phase 1 前半段）

```
 M client-runtime/experience-contract.mjs     (+23 行)  经验契约加 architecture 维度 + 跨维度 AND
 M tools/local-shared-gpu-runner.py           (+50 行)  目标描述从驱动解析，不再硬编码
```

**这两项已完成并验证，但未提交**，详见第 7 节。

### 4.4 工作树里的用户文件（**不得删除 / 不得提交**）

```
?? lastest_demand_for_job.md                       ← 专家意见原文，用户资料
?? pelican-bicycle-svg-animation.html               ← 用户的美术产出
?? penguin-bicycle-svg-animation-generated.html     ← 同上
?? ti-peng-bicycle-2d-animation.html                ← 同上
```

---

## 5. 已实测的缺陷清单

> **贯穿性发现**：下面 5 个缺陷里，前 4 个是**同一个失效模式**——「夹具假设了一种生产里不成立的耦合或存在关系，于是实现与测试互相背书，门禁全绿却掩盖了缺陷」。这不是巧合，是这套测试体系的系统性盲点。**新增任何测试时，先问一句：这个夹具里的字段，生产端真的会写吗？**

### 5.1 【阻塞】经验注入通道恒空

| 项 | 内容 |
|---|---|
| 位置 | `client-runtime/application/round-experience-service.mjs:11` 与 `:109` |
| 现象 | 生产 state 里 `state.iterationStats.roundExperience.items` **恒为 `[]`** |
| 根因 | 同一个文件两处用不同来源的硬件标签：**写入**用 `evidence.hardware`（runner 报的 `nvidia-gpu`），**检索**用 `mission.hardware`（`local-shared-gpu`）。补注：`makeRecord` 对 `source:'execution'` 本就强制 `record.scope.hardware = [evidence.hardware]`，所以写入侧是契约强制的——问题实质是 `mission.hardware` 与 `environment.hardware` 在契约层面就不是同一种东西 |
| 证据 | 用真实运行留下的经验库 + 真实 round-2 入参重放：生产 scope → `items: 0`；**仅把 hardware 换成 `nvidia-gpu`** → `items: 2` |
| 复现 | `node .operator-studio-local/probe/experience-retrieval-probe.mjs` |
| 后果 | 预期：闭环看起来通（每轮都 `recorded`/`existing`），但经验**从未回到下一轮 prompt**。这解释了为什么每轮 Agent 都从头摸索 |
| 测试为何没抓到 | `tests/round-experience-service-test.mjs:8,11` 夹具里 `mission.hardware` 与 `evidence.hardware` **都是 `'cpu'`** |

### 5.2 【阻塞】轮次事实通道是死的

| 项 | 内容 |
|---|---|
| 位置 | `client-runtime/candidate-generation/prompt.mjs:43-56` |
| 现象 | prompt 里从来没有「上一轮改了什么、哪里失败、工作区回到哪个版本」这一段 |
| 根因 | `iterationEvidenceInstruction` 读取四个字段——`mission.iterationContext` / `mission.iterationEvidence` / `baseline.iterationContext` / `baseline.iterationEvidence`——**全仓检索确认这四个字段在生产代码里零写入点**。四者全空则整段返回 `''` |
| 证据 | `grep -rn "iterationEvidence\|iterationContext" --include=*.mjs .` 只命中 `prompt.mjs` 与 `tests/candidate-generation-test.mjs:60,73`（夹具自己填的值） |
| 好消息 | 这一路本来就在经验库预算之外（不受 20 条 / 64 KB 限制），正好符合专家要求的「轮次必需事实」形态——**需要的是接线，不是新建通道** |

### 5.3 `diagnosticEvidenceStructured` 不看 `status`

| 项 | 内容 |
|---|---|
| 位置 | `client-runtime/accept-gate.mjs:127` |
| 现象 | 两个诊断工具都是 `status:"unavailable"`，却算出「结构化诊断证据完整」 |
| 根因 | 判据只看 `format` + `Array.isArray(events)` + `metrics` 是对象；`events: []` 是数组、`metrics` 非空对象是 truthy，**`status` 字段从未被读取** |
| 证据（对真实 GPU 结果复算） | `tracer: {format:'operator-trace/v1', status:'unavailable', events:[]}`、`profiler: {format:'operator-profile/v1', status:'unavailable', metrics:{latencyP50Us:11.264,...}}` → `diagnosticEvidenceStructured = true` |
| 为何未暴露 | 被 `completeEvidence = measurements.length > 0 && (localExecutionEvidence \|\| diagnosticEvidenceStructured)` 的另一条分支掩盖 |
| 为何必须堵 | 一旦接入 mock 诊断，「长得像 trace/v1 + profile/v1」的合成产物就能满足 `evidence.complete`（`required: true`），违反项目不变量 *“mock 不能伪造诊断结论”* |
| 附带问题 | `status:'unavailable'` 的 profiler 里塞着真实 benchmark 数值，字段来源混淆 |

**修法的硬要求（专家裁定）**：必须审查 `completeEvidence` 表达式的**所有分支**，否则只把新检查放进一个分支，仍可能从另一条路径绕过去。

### 5.4 `liveHardware` 与 `publishable` 判定冲突

| 项 | 内容 |
|---|---|
| 位置 | `client-runtime/local-c500-service-client.mjs:445`（`publishable: sharedGpuEnabled ? false : true`）与 `tools/local-shared-gpu-runner.py:128`（`"liveHardware": True, "publishable": False`） |
| 现象 | 当前真实后端同时是「liveHardware 真」+「publishable 假」；knowledge 治理分别用这两个字段做判断，指向相反结果 → 资产恒 `simulation` → 不动点永不成立 → 治理每次 tick 重跑，且 `changes[].outcome='auto_published'` 与 `autoPublished: 0` 自相矛盾 |
| 证据 | `node .operator-studio-local/probe/shared-gpu-knowledge-probe.mjs`（三组对照） |
| 测试为何没抓到 | `tests/knowledge-state-test.mjs:32` 夹具写成 `publishable = liveHardware`（绑死），循环只测 `{local-c500,true}`/`{reference-fixture,false}`/`{cpu-e2e,false}`，**独缺真实组合 `{liveHardware:true, publishable:false}`** |
| 连带事实 | 系统里唯一能产出 `publishable: true` 的是 `local-c500`（`executionMode: 'real-c550'`）——即**唯一可发布的后端已过时** |

**重要澄清（专家裁定）**：「真机执行 = 是」与「可发布 = 否」**本身不矛盾**——前者答「执行发生在哪」，后者答「全部发布条件是否满足」。所以**不得**修成「只要 `realHardware=true` 就 `publishable=true`」。正确方向是：**后端只提供事实和证据；统一的决策层计算采用与发布结果**。

### 5.5 Claude 路径下最终 prompt 不可观测

| 项 | 内容 |
|---|---|
| 位置 | `client-runtime/claude-client.mjs:437`（`child.stdin?.end(\`${goal || ''}\n\`)`） |
| 现象 | `goal`（组装好的完整 prompt）**从不持久化**——run 记录里只有 workspace / status / boundary 等字段，没有 prompt |
| 对比 | codex 路径在 `client-runtime/agent-runtime.mjs:805-815` 会把 `goal` 写进 `bridge/requests/<runId>.json`；Claude 路径没有 |
| 后果 | 「检查最终发给 Agent 的 prompt」这条验收断言**今天写不出来**，而它正是专家指定的 Phase 1 验收方式 |

### 5.6 编辑工具身份在两个 provider 下都恒定返回 `absent`（**已修复**）

保留在这里是因为它是「同一失效模式」最有说服力的样本，也是判断新测试是否可信的参照。

- 专家要求区分 `file_change` 的**失败**与**缺失**；第一版实现成了只认 `apply_patch` 的正则匹配
- 但该形状是**推断的、不是采集的**：78 个真实 Codex run 里 `apply_patch` 作为 `item.type` 出现 **0 次**，真实的是 `item.type: 'file_change'`（64 次）；而 Claude 把每个 `tool_use` 规范化成 `command_execution`，身份只在 `item.name`
- 于是**两个 provider 在生产里都恒定落回 `absent`** → `structuredEditFailed` 恒为 false → 专家分类表**行 4 在生产中不可达**，行 5 被过度上报
- **测试夹具用了同一个错误假设**（也用 `apply_patch`），所以 128 + 30 项门禁全绿却掩盖了它
- 已在 `fa87f50` 修复：工具名优先于事件类型，命令正文永不参与匹配；回归夹具改用**真实采集到的事件形状**（注释里带采集文件路径）

### 5.7 其他已确认但未修的问题

| 问题 | 说明 |
|---|---|
| 两个 E2E 默认 provider 不一致 | 见 3.3 |
| 6 个同类原子写点未加重试 | `command-journal.mjs`、`execution-package-store.mjs`、`state-snapshot-storage.mjs`、`state-workspace.mjs`、`claude-client.mjs`、`codex-client.mjs`。已在两个点踩到 `EPERM` 导致门禁真失败，剩下的是同一模式 |
| `Quote()` argv[0] 转义 | helper 单独传 `lpApplicationName`，不会参数错位，属外观性偏差，低危 |
| `cancel.origin` 枚举缺失 | 需贯通 4 处，当前无测试消费者 |
| 释放证据五项不全 | `rootProcessExited` / `containmentCoverageVerified` / `stdoutCaptureComplete` / `stderrCaptureComplete` 等；现有 `release==='confirmed' && releaseProof.confirmed!==false` 已是 fail-closed，缺的是证据完备性 |
| 五层观测只到第 3 层 | 第 4–5 层与 per-request token 未做；会动已持久化的 `operator-studio.token-usage/v2`，需 v3 迁移 |

---

## 6. 当前设计权威：专家裁定（方案 D）

> 本节是外部专家在看过实测数据后给出的裁定，**是本项目当前的设计权威**。用户已采纳。原文在 `lastest_demand_for_job.md`（用户资料）。

### 6.1 主方案

**D：本地经验优先 + 每轮动态相关性选择 + 少量兜底指导。**

吸收方案 A 的低成本与 B 的动态性，但**不采用**「根据 shape 和耗时判断瓶颈」的强假设；算子映射只作为检索线索，不作为主要组织方式。

**性能症状一律当作「待验证假设」，不是已经查明的瓶颈。**

### 6.2 决策表

| 事项 | 裁定 |
|---|---|
| 主方案 | D |
| 每轮在哪里选择 | 运行时 `prepare` 阶段，由一个**确定性选择器**执行；Mission 提供固定约束，**不固定每轮知识页** |
| 每轮软检索特征 | **0～8 个**；性能症状假设最多 2 个；**不强行凑满** |
| 每轮注入量 | 首版默认 **本地经验 ≤4 条、KernelWiki ≤6 条**；软预算 **24 KB**；仍受既有 20 条 / 64 KB 硬上限与单条 8000 字符约束 |
| 按什么过滤硬件 | **架构 + 经审查的必需能力 + 软件环境要求**；不能只看普通 `tags` |
| 没有 profiler 怎么办 | 可以选择待尝试方法、记录已观察结果；**不能把启发式推断写成已测得的瓶颈** |
| 实施优先级 | ① 经验回流 ② 诊断证据判定 ③ 发布决策 ④ 扩大知识接入 |

> 4 条 / 6 条 / 24 KB 是**建议的首版配置值，不是实验确定的最优值**。既有硬限制继续保留。

### 6.3 三件事必须分开（核心设计原则）

| 问题 | 归属 | 随轮次变化 |
|---|---|---|
| 「能不能用」 | **作用域过滤**（准入约束，不可绕过） | 否 |
| 「这轮值不值得看」 | **相关性选择** | 是 |
| 「它证明了什么」 | **证据与发布判定** | 否 |

> 不要再试图让一个 `scope.tags` 同时承担「安全约束、主题分类、相关性排序」三个职责。

保留现有严格作用域语义，另加**轻量选择器**：

```
确认适用范围 → 找到相关候选 → 排序与去重 → 按预算选取 → 再校验作用域与版本 → 用现有通道渲染
```

**不新建调度器，首版不引入向量库、不再调用一个模型做选择。**

### 6.4 轮次必需事实 vs 可选经验

- **轮次必需事实**：来自运行记录——上一轮候选摘要、正确性结果、失败原因、Gate 决策、回滚状态、当前最好的合法候选及其资产状态。绑定已提交的轮次记录，**新一轮启动前形成快照**，**不因知识页太多而被预算截断**
- **可选经验**：才走经验库检索。**允许零命中**

### 6.5 软检索特征分配（每轮 ≤8）

| 特征 | 上限 | 含义 |
|---|---|---|
| 算子或计算结构 | 2 | 依 Mission 已明确的语义描述，不靠算子名猜实现 |
| 当前失败主题 | 2 | 正确性失败、编译失败等；**基础设施失败与算子失败分开** |
| 性能症状假设 | 2 | 只能是带依据的候选假设，**也允许没有** |
| 本轮拟尝试手法 | 2 | 来自尚未验证的优化方向，不宣称已有效 |

这些是**相关性线索，不是目标硬件声明，也不是 `scope.tags` 的自动扩充来源**。绝不能为了检索某个带 `tcgen05` 标签的页面，就把 `tcgen05` 加进 sm86 任务的能力里——那等于为了命中记录反过来伪造目标条件。

### 6.6 名额与选择顺序

**本地经验 ≤4 条**：优先当前任务最相关的失败记录、最好候选的执行记录、尚未解决的问题。匹配时**保留算子、dtype、shape、环境与测试条件**，不把某 shape 下的结论泛化成整个算子的规律。

> 「这一修改在本次矩阵的某个用例上失败」**不能**压缩成「这种优化方法不可用」。

Provider 网络错误、会话启动失败，**不得**沉淀为「该算子实现失败」的经验。

**KernelWiki ≤6 条**：内部配额 ≤2 症状页 + 3 手法页 + 1 兜底指导页；**没有合适内容时不补齐名额**。选择顺序固定：

```
当前失败直接相关 → 计算结构直接相关 → 症状假设相关 → 其他方法提示
```

症状页的 `candidate_techniques` **展开一跳**后重新做适用性过滤；**不递归 `related`**。

### 6.7 轮次变化对选择的影响

| 轮次情况 | 选择行为 |
|---|---|
| 第一轮，无失败记录 | 用任务语义与已知条件选少量可迁移指导；**不强行赋予瓶颈标签** |
| 上一轮正确性失败 | 优先回注失败用例与修改摘要；正确性线索排在性能手法之前 |
| 正确性通过、性能未达标 | 保留当前假设，**通常只引入一个新手法**，便于解释结果 |
| 同条件下重复尝试同一修改仍无效 | 降低**该具体尝试**优先级，不永久封禁整个方法类别 |
| 证据不足 | **允许 Wiki 为 0 条**，继续依靠轮次事实与本地经验 |

「重复尝试」的判断绑定**修改 + 参数 + 适用条件**，不是只比较「是否都叫 kernel fusion」。

> **不要先用旧检索取出「最近更新的 20 条」再在里面排序**——相关记录可能已在上游被截掉。应先对候选元数据完成选择，再应用最终注入预算。

### 6.8 选择清单（审计信息）

在 `iterationStats.roundExperience` 关联的快照中保留：选中记录的 **ID / 版本 / 来源**、每条的**选择原因与关键排除原因**、**策略版本**、**知识快照版本**、**实际字节数**。

预算按**实际 UTF-8 字节**检查，不是字符数估算。

### 6.9 标签接口决定（最关键的接口约束）

**不要把 KernelWiki 原始标签直接搬进 `scope.tags`。** KernelWiki 的主题标签表达「这页讨论过什么」；`scope.tags` 表达「这条记录要求查询具备哪些条件」。直接复制会改变含义。

分开保存三层：

```
record.scope       继续保存现有的适用范围约束
selection metadata 原始 topics / symptoms / candidate_techniques / 原始 architectures / 适用性审查结果
round selection    本轮最终选中的 recordId + version
```

若现有 schema 不允许加元数据，先把选择元数据放进**与经验 ID、版本绑定的旁路索引**。

`prepare` 新增职责的接口草案：

```
输入: Mission / 已解析的目标硬件 / 上一个已提交轮次 / 当前经验库快照 / 选择策略版本
输出: 软检索特征 / 选中的 recordId + version / 选择与排除原因 / 预算使用情况
```

然后**按 ID 取回记录，并继续验证 `scopeMatches`、记录状态与版本**。

> **按 ID 选择不能绕过作用域；作用域也不再负责决定相关性。**

### 6.10 硬件过滤：跨维度 AND，不是塞进同一个数组

明确区分五个概念：

```
backend / vendor / architecture / device identity / software profile
```

查询使用**本轮已解析的目标**；执行记录保存**实际执行目标**。执行后发现不一致应**报告不一致**，而不是事后把证据改成预期值。历史记录只能确认 `nvidia-gpu` 就保留该粒度；**不能因为现在在这台机器上运行，就给所有历史记录补同一个架构**。

**已复算确认的陷阱**：`scope.hardware` 是"任一匹配"（`some()`），不是"全部满足"。

```
记录 ["nvidia-gpu","sm100"]  vs  查询 ["nvidia-gpu","sm86"]  →  true   ← 假命中（已实测）
记录 ["sm100"]               vs  查询 ["nvidia-gpu","sm86"]  →  false
```

**不能把厂商和架构塞进同一个 OR 数组就以为实现了精确硬件过滤。** 跨维度用 AND（厂商 ∧ 架构 ∧ 必需能力 ∧ 软件要求），同维度内部才允许 OR。

**普通标签是提示，不是必需硬件能力**（例：`kernel-fusion` 页既标 `[sm100, sm90]` 又带 `tmem` 标签，正文同时含通用原理与 Blackwell 专用示例）。两类可注入单元：

- **架构特定原文/代码片段**：按明确支持的架构 + 必需能力 + 软件要求过滤；**信息不足时默认不进入自动实现提示**
- **经审查的可迁移摘要**：只保留原文确实支持的一般原理，移除不适用的具体实现与性能承诺，保留原文引用、原始架构范围、以及「跨架构适用性由本项目审查」标记。仍是 `human-guidance / unverified / publishable:false`

> 「可以作为跨架构建议阅读」≠「已经在该架构上验证」。

**对既有结论的限定**：sm80 与 sm86 同属 Ampere 但资源限制不同，不可视为相同性能条件。「零关键词命中」只说明该检索口径没找到直接对应内容，**不等于零可迁移知识**；「手法名称通用」也不等于整页硬件无关。

### 6.11 没有 profiler：能选方向，不能确诊

命名为「**优化假设选择器**」，不是「性能诊断器」。

| 输入 | 首版可以做什么 | 不应据此宣称 |
|---|---|---|
| shape | 比较规模、识别边界形状、看用例差异 | 实际占用率、调度波次、已发生 tail effect |
| dtype | 识别精度与存储宽度、选数值问题 | 实际用上 Tensor Core、指令吞吐多少 |
| 实测耗时 | 在可比条件下比较候选与基线 | 时间较长所以一定 memory-bound |
| 正确性结果 | 优先处理失败用例与数值问题 | 通过即证明优化原理成立 |
| 失败记录 | 区分编译/运行/正确性/基础设施 | 把普通超时当作流水线停顿或寄存器压力 |

`B_effective = Q_logical / t` 最多是「按逻辑读写量计算的有效带宽」，**不是实际 DRAM 流量测量值**。

**不要给置信度编小数**——没有校准依据时 `confidence: 0.87` 不比「低置信度」更可信。记录 `basis` / `confidence` / `supports` / `missing` / `next_check`。

合适的注入写法：*「当前用例耗时较高。依任务已知计算结构，减少中间数据搬运值得尝试；这是优化假设，尚无 profiler 证据确认 memory-bound。」*

### 6.12 两个治理缺陷的修法

**（a）mock 漏洞**：把三个判断拆开——`schemaValid`（字段格式）／`available`（工具是否真的完成采集）／`evidenceEligible`（是否满足本次规则的证据要求）。`schemaValid=true` 推不出后两项。必需的真实诊断证据至少检查：状态为真实完成、来源不是 mock、与当前候选与运行绑定、**实际内容满足该项诊断规则**（不能又退化成 `Array.isArray(events)` 或 `typeof metrics === "object"`）。

**（b）发布判定**：**后端只提供事实和证据；统一的决策层计算采用与发布结果。**

分开显示：执行是否真实／正确性是否通过／基准是否有效／采用决策／发布决策／不通过原因。TUI、资产状态、运行摘要读取**同一份带版本的决策结果**，不各自根据布尔值重新推导。

发布所需能力不可用时，记录明确阻塞原因并进入类「等待外部验证」的可恢复状态。**不要让 Agent 通过反复改算子去解决「机器没有 profiler」这种无法由代码优化消除的问题。**

旧后端迁移：新后端须在满足**同等证据要求**后接入发布判定，**不能只把名称加入白名单**。

**边界**：KernelWiki 建议始终未经本项目执行验证；据其生成的候选可通过一次新的真实验证形成**独立的**执行证据。**不能因为候选成功一次就把整篇 Wiki 升级为已验证知识。**

### 6.13 最低验收用例（专家给定，逐条落地为测试）

| 用例 | 必须得到的结果 |
|---|---|
| 同一任务写入经验后开启下一轮 | 对应经验进入**最终 prompt**，而不只是数据库 |
| 查询把后端名误当硬件名 | 明确暴露目标描述错误，**不能悄悄退化成正常零命中** |
| sm100 专用内容面对 sm86 | 不因共同拥有 NVIDIA 标签而通过 |
| 标签缺失或架构未声明 | 不自动认定为跨硬件通用 |
| 相关内容排在旧排序的第 20 条之后 | 不因过早截断而永远无法入选 |
| 全部 Wiki 内容都不适用 | 允许零条，轮次必需事实仍完整 |
| 诊断格式合法但状态为 mock / unavailable | 不满足真实诊断必需规则 |
| 经验导入重复执行、来源内容变化 | 不重复灌库；变更走版本推进；旧轮次快照仍可追溯 |

最后做选注效果评估：同一 Mission / Provider / 测试矩阵 / 预算下，对比「只有轮次事实」「加本地经验」「再加 KernelWiki」三种条件。**这是对选择策略的单独评估，不改动原有 oracle 与 Gate。**

---

## 7. 实施状态

### 7.1 已完成并验证（**未提交**，在工作树里）

#### ① 经验契约：`architecture` 成为独立维度，跨维度 AND

**文件**：`client-runtime/experience-contract.mjs`（+23 行）

改动四处：

1. `normalizedScope` 接受 `architecture`，**只在非空时才带该键**
2. `scopeMatches` 跨维度 AND，维度内 OR：`['hardware','architecture','dtype']`
3. `normalizedEvidence` 可选接收 `architecture`
4. execution 记录的 `scope.architecture` 由证据强制盖章（镜像 hardware 的处理）

**关键取舍——为什么是「非空才带键」**：`validateRecord` 末尾有 `if (stable(normalized) !== stable(record)) invalid('stored experience is not canonical')`。**无条件加键会让所有历史记录失效、必须迁移。** 改成条件键之后零迁移。

**验证证据**：

```
用真实运行留下的经验库（.tmp-real-agent/shared-gpu-XqlvN0，2 条记录）
  → validateExperienceStore 通过 → 零迁移                       OK

专家的假命中陷阱（跨维度 AND）
  记录 hw=nvidia-gpu arch=sm100 vs 查询 hw=nvidia-gpu arch=sm86  →  0 条   （修复前会假命中）
  记录 arch=[sm100,sm86]        vs 查询 arch=[sm86]              →  1 条   （同维度 OR 保留）
  记录 hw=[nvidia-gpu,amd]      vs 查询 hw=[nvidia-gpu]          →  1 条
  记录未声明 arch               vs 查询 arch=[sm86]              →  1 条   （未声明维度不构成约束）

execution 记录盖章
  → scope = {"tags":[],"hardware":["nvidia-gpu"],"dtype":[],"shape":{},"architecture":["sm86"]}
```

复现：`node .operator-studio-local/probe/architecture-scope-probe.mjs`

**回归**：7 个受影响的既有测试全部 exit 0 —— `test:experience-service`、`test:round-experience-service`、`test:knowledge-state`、`test:candidate-generation`、`test:agent-runtime-candidate-admission`、`test:state-domain-boundary`、`test:shared-gpu-experience-verifier`。

#### ② runner：目标描述从驱动解析，不再硬编码

**文件**：`tools/local-shared-gpu-runner.py`（+50 行）

**根因**：基类 runner（`tools/local-c500-runner.py:384`）已经探测出 target（`_probe_nvidia` 返回的 dict）并放进 `environment.hardware`，但 `local-shared-gpu-runner.py` 的归一化块用 `"hardware": "nvidia-gpu"` 这个**字面量把它整份覆盖掉了**——权威探测结果被丢弃。这正是专家说的「在任意位置写死字符串替换」。

**改动**：

1. 新增 `_resolve_architecture(executable)`：单独一条**可选**查询读 `nvidia-smi --query-gpu=compute_cap`，返回 `sm86` 形式。**绝不从设备名推断**（那样会声称一个驱动从未确认的架构）
2. `_probe_nvidia` 带上 `architecture`（或 `architectureNote` 说明为何没有）
3. 归一化块不再覆盖探测结果，改为**从它派生**：保留 `targetProbe`，写出 `hardware`（厂商类别，保持 `nvidia-gpu` 不变以向后兼容）、`architecture`、`device`、`driverVersion`
4. `experienceEvidence` 在解析出架构时才带 `architecture` 字段

**真机验证**（直接起真实 runner，与 `tests/shared-gpu-runner-test.mjs` 同法）：

```
hardware        : "nvidia-gpu"
architecture    : "sm86"                                   ← 由 nvidia-smi compute_cap=8.6 解析
device          : "NVIDIA GeForce RTX 3060 Laptop GPU"
driverVersion   : "551.78"
targetProbe     : 完整探测结果（以前被覆盖掉的那份）

回退路径（模拟不支持 compute_cap 的老驱动）
  architecture    : None
  note            : "nvidia-smi did not expose compute_cap; architecture left undeclared"
```

复现：`node .operator-studio-local/probe/runner-target-probe.mjs`

**回归**：5 个 GPU 侧测试全部 exit 0 —— `test:shared-gpu-runtime`、`test:shared-gpu-package-adapter`、`test:shared-gpu-experience-verifier`、`e2e:shared-gpu`（**真的在 GPU 上跑 runner**）、`e2e:shared-gpu-service`。

### 7.2 未完成（Phase 1 剩余三步 + 后续阶段）

#### ③ 查询侧消费同一个目标 【下一步，最高优先】

**现状**：`state.baseline.evidence.environment` 存的是 `"local-shared-gpu"`（**后端/source 字符串**），不含解析出的 hardware / architecture。所以查询侧还没有「同一个目标」的来源，两端仍不一致。

**方案**：任务完成时把 `result.environment` 解析出的目标投影到 state（如 `state.resolvedTarget = { hardware, architecture, device, driverVersion }`），`round-experience-service.mjs` 的 `defaultScope` 消费它、回退到 mission 声明。这样两端同源，符合专家「查询用本轮已解析的目标 / 执行记录存实际执行目标」。

**验收**：`state.iterationStats.roundExperience.items.length > 0`（当前恒为 0）。

#### ④ 接通轮次事实通道

把上一轮的候选摘要、正确性结果、失败原因、Gate 决策、回滚状态、当前最好候选及资产状态，在轮次结算/归档时写入 `mission.iterationContext` / `mission.iterationEvidence` / `baseline.*`，并在新一轮启动前快照。

**注意**：这是**接线**，通道已经存在（`prompt.mjs:43-56`），且已经在预算之外。

#### ⑤ prompt 审计件

在 `client-runtime/agent-runtime.mjs:749`（组装 prompt 处）统一落一份 prompt 审计件 + digest，provider 中立。否则 ⑥ 的验收断言写不出来。

同时满足专家 6.8 的「保存选择清单」要求。

#### ⑥ 最小两轮验收测试

> 第一轮产生一条带真实运行绑定的经验；第二轮准备上下文时**选中它**；**最终发给 Agent 的 prompt 中确实包含该 ID、版本与内容**；且 prompt 里包含上一轮事实。

**不能只验「入库成功」，也不能只验 `retrieve` 非空——必须检查最终发送的 prompt。**

#### 后续阶段（专家给定顺序）

- **第二阶段**：修诊断与发布判定（缺陷 5.3 / 5.4）。用 `unavailable` / `mocked` / 合法真实结果 / 格式合法但绑定错误的结果验证最终 Gate 判定；审查 `completeEvidence` 表达式的**所有分支**。mock 改为 `status: 'mocked'`，单点改 `tools/local-c500-runner.py` 的 `_analysis_tool` 调用方，新增 `OPERATOR_DIAGNOSTICS_MODE=unavailable|mock`（默认 `unavailable`）
- **第三阶段**：接入确定性选择器 + KernelWiki 导入（见第 8 节）

---

## 8. KernelWiki 接入（第三阶段）

### 8.1 它是什么

`https://github.com/mit-han-lab/KernelWiki.git`，mit-han-lab 的结构化 NVIDIA GPU kernel 知识库，以 Claude Code skill 形式打包。**已浅克隆到 `.operator-studio-local/kernel-wiki`（34 MB，gitignore 内，不入库）**。

三层结构：

| 层 | 规模 | 内容 |
|---|---|---|
| `wiki/` | 52 页 | 跨引用综合知识页：`technique` 17、`kernel` 14、`hardware` 8、`pattern` 7、`language` 4、`migration` 2。**对我们有价值的一层** |
| `sources/` | 989 页 | 上游 PR 台账与文档/博客摘要。数量最大，对「注入给 Agent 的知识」基本无用 |
| `queries/` + `data/` | 7 + 21 | 自动生成七维索引 + 页面 schema / 受控词表 / 别名表 |

### 8.2 覆盖实测：与我们的算子零重叠

```
affine / reduction / reduce / normalization / rmsnorm / layernorm
elementwise / softmax / sm86 / ampere / rtx          → 全部 0 命中
sm80（Ampere 邻近）                                   → 2 页
架构分布：sm100(38) sm90(24) sm100a(11) sm120/sm90a/sm80(各2) ...
confidence：source-reported(44) / verified(1)
```

知识库自己的作用域声明写明：*不要用于非 Blackwell / Hopper 特有的通用 CUDA 问答*。而我们的开发卡是 **sm86 / Ampere**。

**因此按「给 affine 找 affine 经验」的思路接入，结果会是库灌满了、检索恒空**——正是已经发生过的失效模式。

### 8.3 它真正拥有的维度：症状 → 手法

`wiki/patterns/` 7 页按**症状**索引：`compute-bound`、`low-sm-utilization`、`memory-bound`、`moe-load-imbalance`、`pipeline-stalls`、`register-pressure`、`tail-effect`。每页结构是「症状 → 可能原因 → 候选手法」，frontmatter 带 `symptoms` 与 `candidate_techniques`。

配套 17 个手法页里有大量**硬件无关方法论**：`vectorized-loads`、`persistent-kernels`、`tile-scheduling`、`register-budgeting`、`kernel-fusion`、`pipeline-stages`、`cache-policy`、`swizzling`、`double-buffering`、`chunk-parallelism`。CLI 也有 `--symptom` 检索轴。

**这些对我们的 affine / reduction / normalization 是真能用的**——可注入的是「这是什么瓶颈、可以试哪些手法」，而不是「affine 的既有实现」。

### 8.4 用户已定的边界

| 项 | 决定 |
|---|---|
| 硬件适用性 | **全量入库，按目标硬件过滤**（不因为本机是 sm86 就把新特性页排除在库外） |
| 源码存放 | **只入库经验快照**；KernelWiki 源码不入库，导入脚本对固定 commit 可重建 |
| 诊断工具 | 本机 profiler / tracer 先用 mock 撑住端到端，之后迁移到工具可用的机器做真实性能分析 |

### 8.5 导入器实现要点

- **仓库无 YAML 依赖**（deps 仅 ink / react）→ 需自写最小 frontmatter 读取器（标量 / 行内列表 / 块列表），带单元测试
- **幂等**：`source:'human'` 来源不做证据去重（`evidenceKey` 为 `null`），重复 id 直接冲突；内容变更要走 `updateExperience(store, id, patch, {projectId, expectedVersion}, {now})` 的版本推进
- **ID 策略**：保持页面或稳定章节身份，commit 作为**来源版本**保存——**不要每换一个 commit 就给同一内容制造一批新身份**
- 映射到 `source:'human'` / `kind:'guidance'` / `verification: {status:'unverified', evidenceClass:'human-guidance', publishable:false}`；检索出来标注 `useAs:'suggestion'`
- `confidence`：`verified → high`、`source-reported → medium`

### 8.6 专家裁定材料的产出物

**`.operator-studio-local/briefs/kernel-wiki-injection-brief.html`**（45 KB，自包含，双击即看）——含闭环八环状态、注入路径与断点、KernelWiki 覆盖实测、三个候选方案对照、最低验收用例。**可直接作为向外部专家/评审同步背景的材料。**

注意：`KernelWiki` id 形如 `technique-vectorized-loads` / `pattern-memory-bound`，**符合经验契约的 `identifier` 正则**（`/^[A-Za-z0-9][A-Za-z0-9_.:@-]*$/`），可直接使用。

---

## 9. 工程约束与工作规则（不可退让）

### 9.1 代码与流程

- **不放宽任何门槛**：候选准入仍是工作区 Git Diff，仍有独立 oracle，仍是固定测试矩阵与观察窗口，Accept Gate 判据不变
- **`simulation` / `cpu-e2e` 证据永远不可变成可发布的 `liveHardware` 证据**
- **mock 诊断不得满足任何必需规则**，不得影响 `publishable`
- **症状是假设，不是结论**；没有 profiler 就不许写「已检测到瓶颈」
- **不为了命中记录而伪造目标条件**（例如把 `tcgen05` 加进 sm86 任务的能力里）
- KernelWiki 内容一律 `human-guidance` / `unverified` / `publishable:false`；**不得**因候选成功一次就升级为已验证知识
- 新增测试必须**同时**登记进 `package.json` 的 `scripts` 与两道门禁的 `checks` 数组
- `OPERATOR_CODEX_JOB_OBJECT=0` 是 Job supervisor 异常时的受控 fallback，但 fail-closed 释放必须保留；**不要把 fallback 误报成「隔离已解决」**

### 9.2 用户文件与回滚（**最容易踩的两条**）

- **不要删除、不要修改、不要提交**这四份用户资料：`lastest_demand_for_job.md`、`pelican-bicycle-svg-animation.html`、`penguin-bicycle-svg-animation-generated.html`、`ti-peng-bicycle-2d-animation.html`
- 需要暂存时**用显式文件列表**，并在提交前复核 `git diff --cached --name-only`
- **回滚**：先把当前 diff 导出为 patch，再逐文件恢复；**禁止无用户确认执行 `git reset --hard`、`git clean -fd` 或删除宽目录**
- **不要凭进程名盲杀用户的 Node 服务**
- **被中断的命令不得记为 PASS**

### 9.3 生成物落盘

诊断工件、探针脚本、日志、E2E 产物一律放**项目内已忽略目录**：`.operator-studio-local/`、`.tmp-real-agent/`、`.local-c500-tester/`、`runtime/`。**不要放 `%TEMP%` 或项目外的自建目录。**

---

## 10. 验证手册

### 10.1 环境准备（Git Bash 下必须）

```bash
cd "F:/设计/快速项目/acagemm原型"
export PATH="/c/Windows/System32:/c/Windows:$PATH"   # 否则 GNU tar 遮蔽 bsdtar
npm.cmd run <script>                                  # 用 npm.cmd，不是 npm
```

### 10.2 两道总门禁

```bash
npm.cmd run verify:local-c500-release         # 期望 [release-check] PASS: 128 checks completed
npm.cmd run verify:non-hardware-robustness    # 期望 [non-hardware-check] PASS: 30 checks completed without physical hardware
```

两者都必须 exit 0。**中断不得记为 PASS，不得沿用历史结论。**

当前已验证结果（提交 `fa87f50` 的同一棵树）：

| 命令 | 结果 | exit |
|---|---|---|
| `verify:local-c500-release` | `PASS: 128 checks completed` | 0 |
| `verify:non-hardware-robustness` | `PASS: 30 checks completed without physical hardware` | 0 |

日志：`%TEMP%\round3-gates.log`、`%TEMP%\round3-units.log`

### 10.3 真实 Agent E2E

```bash
# CPU 版（默认 provider 就是 claude-code）
npm.cmd run e2e:cpu-agent-iteration

# 本地共享 GPU 版（真实算子 + 真实 GPU；默认 provider 是 codex-cli，用 Claude 必须显式覆盖）
E2E_AGENT_RUNTIME=claude-code E2E_GPU_FAMILIES=affine E2E_KEEP_ARTIFACTS=1 npm.cmd run e2e:shared-gpu-agent-iteration
```

相关环境变量：`E2E_GPU_FAMILIES`（默认 `affine,reduction,normalization`）、`E2E_GPU_CANDIDATE_TASKS`（默认 2）、`E2E_GPU_TIMEOUT_MS`（默认 12 分钟/族）、`E2E_RUN_ROOT`、`E2E_AGENT_TIMEOUT_MS`。

**最近一次成功的真实 Claude GPU E2E 证据**（runRoot `.tmp-real-agent/shared-gpu-XqlvN0`，日志 `.operator-studio-local/e2e-runs/gpu-claude-affine.log`）：

```
firstRun          claude_MTWGWMV7_AC325A6A
continuedRun      claude_MTWGYU5T_E729D368      ← 自动续轮
firstRoundOutcome "reference"                   ← 未达标轮次归档
rollbackCount     1                             ← 自动回滚，workspaceClean 已断言
workflowWritesAfterStart 0                      ← 续轮由生产 autopilot 驱动
experienceCount   2
候选 1: queue_BF886994827B4678  primary 11.264 us / small 11.264 us  4/4 正确性
候选 2: queue_AF396B05CD8647D0  primary  9.120 us / small  9.216 us  4/4 正确性
runHistory[0]: { outcome: reference, gen: structured_edit, edit: succeeded, degraded: false }
source=local-shared-gpu / liveHardware=true / publishable=false
```

### 10.4 本机环境事实

| 项 | 值 |
|---|---|
| GPU | NVIDIA GeForce RTX 3060 Laptop GPU，6 GB，驱动 551.78 |
| 计算能力 | **8.6 → sm86**（`nvidia-smi --query-gpu=compute_cap` 与 torch 一致） |
| CUDA 工具链 | **无 nvcc**（Python adapter 走 `requireCudaToolkit=false`，不受影响） |
| GPU Python | `.gpu-venv/Scripts/python.exe`，torch 2.6.0+cu124，`cuda.is_available() == True` |
| Agent CLI | `codex-cli 0.153.4`、`claude 2.1.232`，均在 `/f/Node` |
| 已采集的真实 run 样本 | `.operator-studio-local/runtime/agent-bridge/codex-runs/*.jsonl`（55 个） |

### 10.5 如何复现本文档里的证据

```bash
node .operator-studio-local/probe/experience-retrieval-probe.mjs   # 缺陷 5.1
node .operator-studio-local/probe/shared-gpu-knowledge-probe.mjs   # 缺陷 5.4
node .operator-studio-local/probe/architecture-scope-probe.mjs     # 7.1① 的验证
node .operator-studio-local/probe/runner-target-probe.mjs          # 7.1② 的验证（真实 GPU）
node .operator-studio-local/probe/kernel-wiki-coverage.mjs         # 第 8.2 节的覆盖统计
```

---

## 11. 已知环境陷阱

| 陷阱 | 说明 |
|---|---|
| **Claude Code 拒绝写含 `~` 的路径** | 非 ASCII 用户名下 `os.tmpdir()` 返回 8.3 短名（本机 `C:\Users\棉被暖~3\...`），真实 Agent 因此改不动工作区 → 静默走 patch 兜底而验收照样报绿。**生产工作区在项目目录下不含 `~`，不受影响**。E2E 用 `E2E_RUN_ROOT` 覆盖 |
| **shell 会吞反斜杠** | 通过命令行工具写 Python/JS 时，`\U` / `\r` 会被当转义符吃掉且不报错（如 `%TEMP%\round3` 变成 `%TEMP%<CR>ound3`）。改文件前后都要复核内容 |
| **Git Bash 的 `/tmp`** | 实为 `C:/Users/<短名>/AppData/Local/Temp`；Windows 原生 Python 解析不了 `/tmp/...`，必须传 Windows 路径 |
| **Bash 工具会拦 `sleep`** | 需要等待时用后台任务 + 完成通知，不要写轮询 sleep |
| **Windows 原子写竞态** | `rename` 撞上仍被持有的句柄会返回 `EPERM`/`EBUSY`/`EACCES`。已有两处加了有界重试，**剩 6 处未加**（见 5.7） |
| **Git Bash 里 `find -maxdepth` 等参数会报错** | 用 node 或 python 替代 |
| **`%TEMP%` 下的旧 E2E 工件** | `.tmp-real-agent/` 里的运行目录是历史证据，清理前先确认没有在跑的验证 |

---

## 12. 风险与未验证假设（**不要把什么当成已解决**）

### 12.1 明确未验证

- **稳定性**：保留的 shared-GPU E2E 运行 24 次 → `passed 4 / failed 11 / 无 summary 9`，其中 Claude **仅 1 次**。相当一部分失败来自早期搭建验收脚本的阶段，不能全部算作当前缺陷率；但按项目自己采纳的门槛（「N=20 是回归门槛，不是生产稳定性的充分证明」），**当前数据不足以支撑「稳定」**
- **没有一个真实 Codex 端到端**：本次真实 Agent 验证走的是 Claude Code。Codex 的事件形状（`file_change`）、Job Object / sandbox 路径、TLS 认证失败分类**仍待验**。兼容层让「换 provider 跑」成立，但不让「跑了一个就等于两个都验过」成立
- **没有 C550 / 真机 liveHardware 证据**：全部证据是 `source=local-shared-gpu` / `publishable=false`
- **Profiler / Tracer 不存在**：所有真实结果里都是 `status: "unavailable"`
- **KernelWiki 当时尚未接入任何内容**：只完成了覆盖分析，导入器与选择器未开始（2026-09-11 状态；Phase 3 软件批次现已验收并集成，见顶部 2026-09-15 入口）
- **专家 6.13 的 8 条最低验收用例**：**一条都还没有落地为测试**（2026-09-11 历史状态；当前状态见顶部 2026-09-15 入口与 `evidence/p3-wiki-20260915/status.json`，本节不在此处做覆盖映射）

### 12.2 需要澄清的架构问题

- 「可发布证据」的正式目标是什么？系统里唯一能产出 `publishable: true` 的路径（`local-c500` / `real-c550`）已过时。新产品若要接入发布判定，必须满足**同等证据要求**，不能只把名称加进白名单
- `mission.hardware` 与 `environment.hardware` 的最终语义定型（见 6.10 的五个概念划分）

### 12.3 关于本文档

- 第 3 节的「文档与代码不一致」是**实测结论**，但仓库里的过时文档（README / GOAL / 旧 handoff 的 S3 与 T7）**尚未修改**——需要一次专门的文档订正
- 本文档中所有「已实测」「复算」标注的数字都可用 10.5 节的命令复现；凡未标注的推断均在 12.1 列出
- 设计权威是第 6 节的专家裁定；其中的 4 条 / 6 条 / 24 KB 是**建议首版配置值，不是实验最优值**

---

## 13. 相关文档与代码索引

### 13.1 产品与目标（先读）

| 文档 | 内容 |
|---|---|
| `原型文档.md` | **产品规格书**（Prototype Specification v2）。四个核心部分、8 项必须覆盖、暂不覆盖范围、完整产品闭环 |
| `docs/development/GENERIC_OPERATOR_GOAL.md` | 通用算子目标、共识、不变量、T1–T7 工作包；**注意 T7 的命名已过时** |
| `docs/development/STATE_DOMAIN_GOAL.md` | 状态域目标 |
| `README.md` | 项目入口；**注意「目标真机 C550」与「硬件命名约束」两节已过时** |
| `AGENTS.md` | 仓库级 Agent 协作约定 |

### 13.2 本次交接

| 文档 | 内容 |
|---|---|
| `docs/development/TEAM_HANDOFF.md` | **本文档** |
| `docs/development/CURRENT_TASK_HANDOFF.md` | 上一任同事的交接文档。已追加 §1.2（第二轮收口）、§1.3（第三轮：编辑工具身份修复 + E2E harness），§10.2 补了 `~` 路径边界，§7.2 改为指向最新门禁状态 |
| `lastest_demand_for_job.md` | **外部专家意见原文**（用户资料，**不要提交、不要删除**） |
| `.operator-studio-local/briefs/kernel-wiki-injection-brief.html` | 给外部评审的背景材料，自包含可分享（含闭环八环状态、注入断点、方案对照） |

### 13.3 架构与模块契约

| 文档 | 内容 |
|---|---|
| `docs/development/ARCHITECTURE.md` | 层次、生产路径、允许的依赖方向 |
| `docs/development/MODULE_OWNERSHIP.md` | 模块职责与主责边界（新增 `application/*.mjs` 要登记） |
| `docs/development/MODULE_CONTRACT_TEMPLATE.md` | 模块契约模板 |
| `docs/development/README.md` | 开发文档入口 |
| `client-runtime/README.md` | Client Runtime 模块契约（含本轮新增的 provider 工具身份不变量） |
| `client-runtime/application/README.md` | 应用编排模块契约 |
| `client-runtime/server/README.md` | 传输模块契约 |
| `client-runtime/candidate-generation/README.md` + `CONSTRAINTS.md` | 03 候选生成契约；含两个 provider 的字段通道对照表 |
| `docs/development/MODULE_03_CANDIDATE_GENERATION_HANDOFF.md` | **03 模块与伙伴团队的交接边界**（外部协作面） |
| `tools/local-c500-tester/README.md` | C550 TUI 模块契约 |
| `tests/README.md` | 测试模块契约（含 opt-in 真实 Agent 验收脚本的 `~` 路径陷阱） |

### 13.4 历史与专题

| 文档 | 内容 |
|---|---|
| `docs/development/CODEX_AGENT_DIAGNOSTIC_HANDOFF.md` | 真实 Codex 问题的证据、专家意见与未确认假设 |
| `docs/development/TUI_DECOUPLING_HANDOFF.md` | TUI 拆解过渡面 |
| `docs/development/TEMPORARY_CONSTRAINTS.md` | 临时开发约束（含「模块文档/边界测试/验证脚本必须同步更新」） |
| `docs/development/operator-studio-team-briefing-15min.md` | 15 分钟团队讲稿 |
| `docs/development/operator-studio-*.html` | 架构/模块边界/workflow 可视化（多套，含明暗主题截图与视觉校验） |
| `handoffTUI.md`、`CLI系统对接需求文档.md`、`天数Runner算子测试操作手册.md` | 专题资料 |
| `.operator-studio-local/kernel-wiki/` | KernelWiki 源码克隆（34 MB，**不入库**，可对固定 commit 重建） |

**文档很多且部分过时**：第 3 节列出的三处（README / GOAL / 旧 handoff）与代码相反，第 14 节第 8 项就是订正它们。在订正之前，**以代码和实测证据为准**。

---

## 14. 立即下一步（按依赖排序，2026-09-11 历史；第 0–8 项状态已过期，见顶部 2026-09-15 入口）

| # | 任务 | 验收 |
|---|---|---|
| 0 | **推送** `handoff/codex-job-supervisor-p1`（领先 origin 2 个提交） | 远端可见 `fa87f50`、`ad73fd8` |
| 1 | 提交 7.1 的两项改动（经验契约 + runner 目标解析），并补上对应的**正式测试**（当前只有探针验证） | 新增测试登记进两道门禁；门禁 exit 0 |
| 2 | **③ 查询侧消费同一个目标** | `roundExperience.items.length > 0`（当前恒为 0） |
| 3 | **④ 接通轮次事实通道** | 下一轮 prompt 里出现上一轮候选摘要 / 正确性结果 / 失败原因 / Gate 决策 / 回滚状态 |
| 4 | **⑤ prompt 审计件** | Claude 路径下能读到最终发出的 prompt + digest |
| 5 | **⑥ 最小两轮验收测试** | 第二轮 prompt 含第一轮经验的 ID + 版本 + 内容，且含上一轮事实 |
| 6 | 第二阶段：诊断证据三判定拆分 + 发布决策层 | 6.13 表中相关 3 条；`completeEvidence` 所有分支都审查过 |
| 7 | 第三阶段：KernelWiki 导入器 + 确定性选择器 | 6.13 表全部 8 条 |
| 8 | 文档订正：README / GOAL / 旧 handoff 的过时描述 | 第 3 节的三处不一致被消除 |

**第 2–5 项是当前最高价值的一段**：专家明确指出「当前最该优先解决的，不是导入多少知识，而是确保『上一轮发生的事情，下一轮确实知道』」。
