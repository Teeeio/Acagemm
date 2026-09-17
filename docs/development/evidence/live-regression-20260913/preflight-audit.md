# Preflight audit — 真实 affine / N20 证据核验清单（只读静态审计）

日期：2026-09-13。审计对象：既有 e2e driver、ledger 与冻结契约的**实际源码**。

## 声明（边界）

- 这是**只读静态审计 + 精确源码复查**，不是实机结果。没有启动 provider / GPU / Runtime，没有访问凭据，没有改任何契约 / 测试 / 生产文件。
- 本审计**没有 live 访问**，因此**不对 Root 当前的实机样本数或通过状态作任何断言**。派发快照里的 `docs/development/REAL_GPU_REGRESSION.md:17-26` 在快照时仍把最新 affine 两轮 smoke 记为“待运行”（`pending`）；该文档可能落后于 Root 的实机进展，不能据此推断 Root 现在处于 0 样本。Root 的当前事实以 Root 自己的实机证据为准。
- 历史现状以新证据为准（`TEAM_HANDOFF.md` §3）：真实后端是 `local-shared-gpu`，C500/C550 描述过时；"真实 Codex E2E" 应读作 provider-neutral 真实 Agent E2E。

## 1. 真实入口与产物

| 角色 | 真实入口 | 代码 | 产物 |
|---|---|---|---|
| GPU driver（只读观察者） | `npm run e2e:shared-gpu-agent-iteration` | `package.json:193` → `scripts/e2e-shared-gpu-agent-iteration.mjs` | `<repo>/.tmp-real-agent/shared-gpu-<rand>/`（`...mjs:58-64`） |
| ledger（只读，不启动 run） | `node scripts/summarize-gpu-agent-runs.mjs [--json] <runDir>...` | `scripts/summarize-gpu-agent-runs.mjs:519-526` | 控制台 / JSON 汇总，无文件写入 |

默认值（会进指纹，必须显式冻结）：provider `claude-code`（`:26`）、families `affine,reduction,normalization`（`:38`）、`E2E_GPU_CANDIDATE_TASKS=2`（`:39`）。**要跑 affine N20 必须显式 `E2E_GPU_FAMILIES=affine`。**

driver 产物（runRoot 内）：`attempt.json`（running 先写 `:276-303`，terminal 覆盖 `:736-790`）、`summary.json`（`:791-826`）、`runtime.log`、`bridge/prompt-audits/*.json`（`:63`）、每族 `<family>-state.json`（`:513`）。runRoot 位于 `.tmp-real-agent/`，已被根 `.gitignore` 忽略。

**注意**：GPU driver **不读 `E2E_RUN_ROOT`**（`grep E2E_RUN_ROOT` 仅命中 `scripts/e2e-cpu-agent-iteration.mjs:14`）。`TEAM_HANDOFF.md:723` 把 `E2E_RUN_ROOT` 列为 GPU 变量与代码不符；GPU runRoot 固定在被忽略目录下，不能靠该变量搬走。

## 2. 独立核验清单（从原始产物字段验证，不采信契约自述）

| 验收项 | 从哪里读 | 通过判据 | 精确源码 |
|---|---|---|---|
| 两个**不同**候选 | `summary.summaries[].completed[].candidateDigest`、`attempt.familyOutcomes[].completedCandidates` | 每族 ≥2 个 digest 互异 | `shared-gpu-acceptance.mjs:499-504,518-521`；driver `:628` |
| 真 GPU 完成候选 | 任务 `result.environment` | `source==='local-shared-gpu'`、`executionMode==='gpu'`、`liveHardware===true`、`simulated/mock!==true`、`purpose==='candidate'`、payload/result digest 一致 | `shared-gpu-acceptance.mjs:474-485`；driver 断言 `:620-627` |
| correctness 4/4 | 每个 benchmark row 的 `correctness`（`total`/`passedCases`/`caseResults`） | benchmark 恰 2 行；**每行** `correctness.total===4`、`passedCases===4`、`caseResults.length===4` 且 4 项全 `passed===true`；矩阵 `correctnessCases:4`（`:46-49`）。**不是“4 行 benchmark”** | 生产者 `tools/local-c500-runner.py:203-224`（成功分支 `:216-224`，失败分支 `:204-215`）；同一 correctness 对象绑到每个 profile 行 `:641-653`；driver 仅断言每行 `correctness.passed` `:624` |
| primary/small | `task.result.benchmark[].profile` | 序列恰为 `['primary','small']` | driver `:625`；profile 顺序来自 `local-c500-runner.py:274-293` |
| 回滚 + 续轮 | `state.runtimeEvents` 里 `workflow.round_rolled_back`；`state.agent.runId` | ≥1 条且每条 `payload.workspaceClean===true`；续轮 runId ≠ 首候选 sourceRunId | driver `:594-597`；`shared-gpu-acceptance.mjs:523-524` |
| 轮次 prompt audit | `bridge/prompt-audits/*.json` | missionId+`roundId===sourceRound.roundFacts.target.roundId`+`deliveryStage==='prepared-before-send'`，runId ≠ sourceRunId；再跑 `verifyContinuationAudit` 8 条不变量 | driver `:409-423,603-612`；`shared-gpu-acceptance.mjs:235-373`；contract `shared-gpu-acceptance.md:30-70` |
| 经验回流 | `summary.summaries[].experienceCount`、audit 绑定 | >0 且 audit 唯一绑定 missionId+candidateId+patchDigest+queueRequestId | `shared-gpu-acceptance.md:58-66` |
| workflowWritesAfterStart=0 | `summary.summaries[].workflowWritesAfterStart`、`summary.writes` | 每族 `===0`；driver 另有硬断言 | driver `:497,565,647,825` |
| 当前资源释放 | `attempt.cleanup.stopReceipts[]`、`teardownStop.confirmed` | 每族 `confirmed===true`；stop 需 `loopStatus==='stopped'`、`missionPaused===true`、exact activeMissionId、`resourceRelease.confirmed`+resources 全确认、无 `resourceReleaseBarrier`；202 须由后续只读 state 证明 | driver `:330-363,655-665,674-683,728-730`；`shared-gpu-acceptance.mjs:785-862`；contract `shared-gpu-acceptance.md:265-293` |
| 全 run 模型观测 | `attempt/summary.modelObservationSummary`、`modelObservationRequiredRuns`、`modelObservationUnboundRuns`、`modelObservationSweep` | `status==='observed'`、`modelSource==='observed'`、版本 `operator-studio.model-observation/v1`、requiredRuns 覆盖每个已启动 run（含失败/恢复/零候选）、`unboundRuns` 为空 | driver `:701-721,753-760,812-816`；`model-observation.mjs:261-359`；ledger 独立重算 `summarize-gpu-agent-runs.mjs:231-268,344-354` |
| 配置声明与观测分离 | `config.provider` vs `declaredModel/declaredModelSource` | 最终 `provider.model` 由 summary 派生；env/configured 只留 `declared*`，不得升级 | driver `:698-712,763-764`；`shared-gpu-acceptance.mjs:163-184` |

Ledger 侧不信任落盘 summary：对每个 run 用 `modelObservationRequiredRuns + modelObservations` 重新 `summarizeModelObservations`，再与 attempt/summary/config 三方比对（`summarize-gpu-agent-runs.mjs:180-268`）。任一缺失/外来/畸形/矛盾证据 → 该 run `comparable=false`（但不改判 outcome，也不从分母丢弃），见 `:349-373`。

## 3. 配置分组与严格 N20

- 分组键 = 重算 `configFingerprint`（`summarize-gpu-agent-runs.mjs:420`）。组内可比要求**每个** entry 可比（`:449`）；分母保留所有唯一 run，含 failure/timeout/missing_summary（`:452`）。
- 指纹输入：`REQUIRED_FINGERPRINT_PATHS`（`shared-gpu-acceptance.mjs:111-128`）**加上整份归一化 config**（`:191-204`）。逐 run 易变 id（run/mission/session/path/time、observedTargets、sourceRunId）被剥离（`:142-161`），所以**同配置不同 run/session 必须同指纹**。
- 严格口径（`MODEL_OBSERVATION_ACCEPTANCE.md:60`、`REAL_GPU_REGRESSION.md:56-60`）：**≥20 个同指纹独立 attempt，且全部 `full_success`，零 dropped/missing summary，`budget_terminal` 不算成功**。smoke 本身算 1 个样本（`REAL_GPU_REGRESSION.md:167-168`），故 affine smoke + 后续 19 次可组成 N20——前提是 20 次指纹完全一致。

**哪些变更会拆组（或整组不可比）**：

1. `client-runtime`/`tools`/`scripts` 或 package manifest 任何内容变化（含未提交）→ `code.contentDigest` 变（driver `:210-243`）。
2. `git commit` 变化（哪怕只提交文档）→ `code.commit` 变。
3. **仓库内任何未被忽略的 dirty/untracked 文件数量变化** → `code.dirtyFileCount` 变。该字段不在剥离列表（`:142-161`）且被整份哈希（`:191-204`）。已用真实模块静态复算：仅 `dirtyFileCount` 0→1 即令指纹改变（详见 §4 R2 的操作含义）。
4. families 集合（smoke 必须与 19 次同为 `affine`）、`candidateTasks`、`matrix`、`promptPolicy` 版本、`budgets`（`E2E_GPU_TIMEOUT_MS`/`OPERATOR_MAIN_AGENT_BUDGET_MS`）任一变。
5. provider runtime、CLI 版本、model；`hardware/architecture/device/driverVersion`（来自真实 `resolvedTarget`，driver `:692-697`；生产者 `operator-test-evidence.mjs:99-110`）。
6. **CLI 版本与 model 是否可比由“最终来源”决定，不是“设了 env 就整组不可比”**：
   - CLI 版本：`probeCliVersion` 对非空 `E2E_AGENT_CLI_VERSION` 先记 `{source:'declared'}`（driver `:194-196`），但随后**健康 runtime-descriptor 会覆盖** `config.provider.cliVersion/cliVersionSource='runtime-descriptor'`（driver `:431-440`）。所以设了 env 但 Runtime descriptor 给出了真实版本时，最终来源仍是 `runtime-descriptor`（可比）。
   - model：env `E2E_AGENT_MODEL` 只写入 **running** attempt 的 `config.provider.model`（driver `:32-34,254-255`）；**终态 config 的 `provider.model/modelSource/modelObservationStatus/modelObservationVersion` 一律由保留的 per-run 观测 summary 派生**（driver `:701-721`），env 值只留在顶层 `declaredModel/declaredModelSource`（driver `:763-764,817-818`）。
   - 只有当**最终** `provider.modelSource !== 'observed'`（`MODEL_OBSERVED_PROVENANCE`，`shared-gpu-acceptance.mjs:45`）或 CLI 最终来源不在 `observed/probe/runtime-descriptor`（`:40`）时，才由 `fingerprintUnknownFields` 记 unknown 并使整组不可比（`:133-136,163-184`）。**判据是最终来源 + 保留证据，不是 env 是否被设置。**
7. 模型观测未 observed（任一 run unknown/conflict）→ 最终 `provider.model='unknown'`（`missingFingerprintValue` 视 `unknown` 为缺失，`:88-100`）→ 整组不可比。真实 `full_success` 仍算 full_success，但**进不了 N20**。

## 4. 结构风险与误读提醒

- **R1（误读风险，非缺陷）：`n20.eligible` 是“可比性 / 分母资格”标志，不是严格 N20 通过条件。** `summarize-gpu-agent-runs.mjs:459-466` 的判定式只有 `comparable && runs>=20`，**不读 outcome**。这是冻结契约的明确设计（`REAL_GPU_REGRESSION.md:291`：“`n20.eligible` is a comparability/denominator eligibility flag, not a stability conclusion”；`MODEL_OBSERVATION_ACCEPTANCE.md:46`），**不要改此语义**。静态可读出的后果：把 20 条同指纹、comparable、outcome 全 `failure` 的记录喂给 ledger，判定式仍会在 `:460` 给出 `eligible:true`、`:465` 给出 `'comparable group reached 20 retained attempts'`。因此 Root 必须**另行**核对 `group.counts.full_success===group.counts.runs` 且 `failure/timeout/missing_summary/budget_terminal===0`、`duplicates===0`，**不得**把 `eligible` 当作验收通过。
- **R2（操作含义，非阻断）：dirty 文件计数进指纹，但本审计件不在 Root 树内，且按本任务约定批次后集成。** `code.dirtyFileCount` 来自 `git status --porcelain` 行数（driver `:221-241`），既不在剥离列表、又随整份归一化 config 一起哈希（`shared-gpu-acceptance.mjs:142-161,191-204`），所以同代码但 dirty 条目数不同的两次 run 必拆组。但：
  - 本报告位于 **worker 隔离树**，Root 尚未集成它；它**不是** Root 批次树里的文件，因此**不能要求它在第 1 个样本前存在**。本任务按约定在**批次结束后**再集成。
  - Root 侧的实际 `dirtyFileCount` 由其自身工作树在冻结时决定（Root 复核反馈其实机为 2）；本文件既不影响该计数，也不构成冻结前置条件。批次后集成发生在 N20 分组完成之后，不改变已冻结样本的指纹。
  - 对 Root 的操作要求回到常规：在自己的树内冻结工作树，并确保该计数在 20 个样本期间恒定（含未跟踪且未被忽略的文件增删/移动/提交）。
- **R3：同目录重复传入不计 N**：alias（attemptId/runRoot/runDir）去重（`:277-317`），矛盾重复记 `duplicate_record_conflict` 且判 failure（`:294-305,359-365`）。
- **R4：24 条旧/异 provider 记录不可混入**：ledger 只按指纹分组（`:420`），旧记录缺 per-run 模型证据 → `model_observation_attempt_evidence_missing`（`:235`）→ 不可比；且必须只传显式 runDir（`:519-523`），不得把 host/历史目录喂给 ledger。
- **R5：文档与代码不符**：`TEAM_HANDOFF.md:723` 的 GPU `E2E_RUN_ROOT` 不存在（见 §1）。不影响指纹，但会误导定位产物。

## 5. 待实机验证（不得当结论）

以下只能由真实运行证明，本文不预判：真实 Claude 流是否稳定产出 `assistant.message.model` 并让每次 run observed；是否真有两不同候选且每行 correctness 4/4（total/passedCases/caseResults）+ primary/small；回滚与续轮 audit 是否成立；stop receipt 是否 confirmed（含 202 场景）；`resolvedTarget` 是否给出 device/driverVersion（否则 unknown → 不可比）；`workflowWritesAfterStart` 是否恒 0。

本审计**无 live 访问**，也不知道 Root 当前有多少实机样本：派发快照的 `REAL_GPU_REGRESSION.md:17-26` 仍记 pending，该快照可能过时。任何实机通过/失败结论都必须来自 Root 保留的 attempt/summary/raw bridge/GPU 任务，而不是本文。

## 6. 冻结操作顺序（在 Root 的批次树内执行）

1. 冻结 Root 批次树的代码 commit 与工作树，确认 `git status --porcelain` 条目数在 20 个样本期间恒定。**本审计件在 worker 隔离树，不参与该计数，也不是冻结前置条件**（批次后集成）。
2. 显式设定：`E2E_AGENT_RUNTIME=claude-code`、`E2E_GPU_FAMILIES=affine`、`E2E_GPU_CANDIDATE_TASKS=2`、固定 `E2E_GPU_TIMEOUT_MS`/`OPERATOR_MAIN_AGENT_BUDGET_MS`。若设置 `E2E_AGENT_MODEL`/`E2E_AGENT_CLI_VERSION`，必须理解其只作声明、最终可比性由 §3.6 的最终来源判据决定（真实 descriptor / observed model 覆盖声明时仍可比；未覆盖则 unknown → 不可比）。
3. 不移动 `.tmp-real-agent` 下 run 目录，只把显式目录交给 ledger；失败/timeout/missing 原样保留。
4. 按 §2 逐项核验 attempt/summary；再按 §3/§4 核对分组与严格计数。`eligible` 仅作分母资格参考——严格通过需另行满足 `full_success===runs>=20` 且无 failure/timeout/missing/budget_terminal/duplicate。
