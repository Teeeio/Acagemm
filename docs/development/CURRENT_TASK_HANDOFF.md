# 当前主线开发交接（Codex Agent 运行时与通用算子闭环）

> 交接版本：2026-09-10（Asia/Shanghai）  
> 交接对象：下一位开发者、代码审查者或负责恢复 Goal 的 Agent  
> 当前状态：P0 已提交并推送；P1 的 Windows Job Object/观测改动已完成主要实现，但尚未提交、尚未完成本轮总门禁。

本文件不是历史设计草稿，而是接手当前工作树后可以直接执行的操作清单。若本文件与代码冲突，以代码中的测试、模块合同和最近一次已确认的持久化状态为准；若本文件与用户的新指令冲突，以用户新指令为准。

## 1. 一句话结论

产品主线是“后端/云端测试队列可替换的通用算子迭代闭环”。当前最紧急的运行时问题不是换模型，而是让每个 Agent attempt 有可解释的失败终态、可验证的进程释放证据和正确的候选/测试归属。

P0（失败分类、恢复归属、有限终态）已经在 9b80437 完成并推送。当前工作树正在收尾 P1：Windows 原生 Codex 进程默认进入 Job Object，实时 JSONL 仍被采集，取消/退出后通过 receipt 查询活动进程数并形成 release proof，同时记录 stdout/stderr/解析层观测数据。

接手者的第一目标不是继续扩展功能，而是：

1. 审查未提交的 Job supervisor 差异；
2. 让聚焦测试和完整门禁在干净环境下通过；
3. 解决审查发现的竞态或兼容性问题；
4. 提交、推送并更新验证记录；
5. 再回到 Linux 兼容、真实 Codex 对照和通用算子长期能力。

## 2. 项目与产品背景

### 2.1 产品目标

产品希望把算子工程师从反复手工试错中解放出来：用户在不同平台提交算子及其完整依赖包，Agent 在 Mission Workspace 中生成或修改候选，测试后端以工具/端口形式抽象，未来可以从本地 GPU 测试队列平滑替换为云端 GPU 队列，并自动沉淀经过验证的经验。

当前优先级是跑通一般算子的通用迭代流程，而不是仅支持两个 demo 算子。Profiler、tracer 等性能工具可以暂时 mock 或延后；正确性、候选准入、测试提交、证据归属和失败收尾不能延后。

### 2.2 已对齐的运行约束

- 暂无云端服务；测试队列必须通过工具/端口抽象，本地实现是当前后端，云端实现以后接入。
- 本机没有隔离的 CPU/GPU 测试资源；当前主线优先使用本机 GPU，MVP 可放宽由竞争造成的性能阈值，但不能放宽固定 correctness、shape、dtype 和候选准入契约。
- 算子文件和依赖必须作为执行包整体导入、验证、打包后再提交；运行期间只能引用包内文件。后续必须支持 Python 之外的语言，因此执行包合同不能绑定单一解释器。
- Agent 只能写 active Mission Workspace；真实 Workspace Diff 是候选事实来源。
- 候选证据、Queue 请求、benchmark 结果必须绑定同一候选 digest；simulation 证据永远不能发布为 live-hardware 证据。
- 测试保持串行，终态必须原子持久化；丢失响应时查询/重发同一稳定请求，不创建第二个权威测试任务。
- 真实 Codex 对照优先使用 gpt-5.5 或 gpt-5.6-sol；不要把 gpt-6 作为默认稳定性实验模型。

## 3. 必读入口和依赖边界

接手后按下面顺序阅读，不要先从某个深层实现文件开始猜测合同：

1. ARCHITECTURE.md：层次、生产路径、允许的依赖方向。
2. MODULE_OWNERSHIP.md：模块职责与主责边界。
3. 要修改目录最近的 README；本轮重点是 client-runtime/README.md。
4. CODEX_AGENT_DIAGNOSTIC_HANDOFF.md：真实 Codex 问题的证据、专家意见和未确认假设。
5. GENERIC_OPERATOR_GOAL.md：通用算子目标和历史验证记录；其中旧门禁数字是历史快照，不能替代本轮新门禁。
6. MODULE_03_CANDIDATE_GENERATION_HANDOFF.md：03 候选生成模块的输入输出和同事交接边界。
7. client-runtime/codex-client.md、client-runtime/cancellation-contract.md 及相关 application 服务合同。

允许的依赖方向：

    TUI -> HTTP API -> application orchestration -> domain rules -> ports -> adapters

不要让 domain 依赖 TUI、HTTP、Codex、Claude、C550 或文件系统实现；不要在 HTTP route 中复制 workflow/Gate/hardware 规则；生产行为必须继续走 TUI -> Production API -> Client Runtime，不要创建第二套 workflow。

## 4. Git、远端和工作树事实

### 4.1 当前分支与远端

    工作目录：F:\设计\快速项目\acagemm原型
    分支：main
    HEAD：9b80437 fix: close agent failure and release attribution contracts
    origin：https://github.com/Teeeio/Acagemm.git
    origin/main：当前已包含 9b80437
    运行环境：Windows；Node v22.23.2（Node 可执行文件位于 F:\Node\node.exe）

用户已经明确授权将验证后的改动推送到远端；接手者不需要再次等待授权，但仍不得把未审查的实验产物或用户文件提交。

### 4.2 当前未提交的受控改动

以下 7 个 tracked 文件是本轮 P1 差异，尚未提交：

    client-runtime/README.md
    client-runtime/codex-client.mjs
    client-runtime/windows-job-object-helper.ps1
    client-runtime/windows-job-object.mjs
    tests/codex-runtime-test.mjs
    tests/release-guard-test.mjs
    tests/windows-job-object-test.mjs

当前差异规模约为 644 行新增、69 行删除（以接手时 git diff --stat 为准）。必须先读 diff 和测试再决定是否拆 commit；不要直接 git add -A。

### 4.3 必须保留的未跟踪文件

工作树中有若干动画 HTML 文件（例如 ti-peng-bicycle-2d-animation.html、penguin-bicycle-svg-animation-generated.html、pelican-bicycle-svg-animation.html，具体以接手时 git status --short 为准）。这些是用户既有产物，与本任务无关：

- 不要删除；
- 不要为了清理工作树而 reset/checkout；
- 不要把它们加入本轮 commit；
- 若必须使用全量暂存，先改用显式文件列表并复核 git diff --cached --name-only。

## 5. 已完成的 P0（不要重复重做）

提交 9b80437 已把专家指出的三类控制契约落到主线，主要内容如下。

### 5.1 失败原因与资源释放分离

Agent 运行记录同时保留：

    primaryFailure       # TLS、capacity、工具、候选契约等业务/上游原因
    resourceRelease      # 进程树是否已经可证明释放
    workspace            # 可复用、隔离、需人工处理等后续动作

UnknownIssuer 不能被后续 CODEX_CANCEL_UNCONFIRMED 覆盖；取消请求也不能被误报成释放成功。资源不确定时必须 fail-closed，Workspace 隔离，禁止自动恢复写入。

### 5.2 Round/Attempt/Candidate/Queue 归属

概念关系已经按下面的模型修正：

    Mission
      └─ Round R
          ├─ Attempt A1：capacity/TLS 等失败
          └─ Attempt A2：恢复后完成
              └─ Candidate C（sourceRunId = A2）
                  └─ 稳定 Queue 请求 Q
                      └─ Evidence E

E2E 不能永远查询初始 firstRunId；必须等待 Round 的持久化终态，再读取实际候选的 sourceRunId、Queue 请求和 evidence。重试不能产生第二个权威测试身份。

### 5.3 有限终态

cancel_requested 不能无限停留。正常成功、已释放的正常失败、以及“时间用尽但释放未确认”的 blocked/needs_human/quarantined 必须区别记录。迟到的 turn.completed 只能作为证据，不能重新打开已经结算的 Round。

### 5.4 P0 验收边界

P0 仍需通过原有 test:codex-cancellation、test:agent-cancellation-liveness、Round/Queue/候选归属测试；不要为了让测试“更容易通过”而放宽 Gate、固定测试矩阵或错误重试预算。

## 6. 当前 P1 实现清单（未提交）

### 6.1 client-runtime/codex-client.mjs

本文件仍是 Codex adapter，不是 domain workflow。当前增量包括：

- 通过 platform、spawnImpl、spawnJobObjectProcessImpl 注入可测试实现；真实 Windows native command 默认启用 Job Object。
- OPERATOR_CODEX_JOB_OBJECT=0 可以显式关闭 Job Object；.cmd shim 不适合直接传给 CreateProcessW，会回退为 child-process，并在 preflight() 中给出 processSupervisorReason。
- Agent 记录增加 observability：transport、stdout/stderr 字节数、chunk 数、首末活动时间、解析事件数、解析错误数、terminal event 类型。
- Job 路径为 prompt 建立外部 bridge 文件，避免把桥接文件写入 Mission Workspace；通过 stdin file、ready sidecar 和 receipt sidecar 交换启动与收尾证据。
- 接收到 started handshake 后才写入目标 PID；记录 helper PID、Job name、stdout/stderr/ready/receipt 路径。
- stdout/stderr 由 Job supervisor 增量 tail，实时传给 adapter；JSONL 仍写入原有 run event log，不靠进程退出后一次性读取。
- result receipt 中 release === confirmed 且 releaseProof.confirmed !== false 才能成为可复用释放证据。
- Job result 拒绝或释放未确认时，记录 CODEX_JOB_RELEASE_UNCONFIRMED/启动失败信息，状态保持 fail-closed，禁止 recovery。
- 旧的注入 child-process 路径保留，供 Linux、.cmd shim 和单元测试使用。

### 6.2 client-runtime/windows-job-object.mjs

- 创建临时 config，启动 powershell.exe helper；配置值采用 base64，避免路径和换行破坏配置。
- started 只有在 CreateProcessW(CREATE_SUSPENDED)、AssignProcessToJobObject、ResumeThread 成功后才 resolve。
- 持续 tail stdout/stderr 文件，使用 StringDecoder 处理跨 chunk UTF-8；helper 关闭后再做一次 drain。
- result 读取 receipt sidecar，并校验 Job name、exit code、release 状态；不满足条件则 reject。
- 启动超时有界；超时会 best-effort 请求终止，但最终是否释放仍由 receipt 决定。
- terminate() 通过 Job name 调 helper 的 terminate 动作；调用方不可只依据“发出了终止请求”就标记释放成功。
- 保留原有 local C500 使用的调用形状，避免把硬件 runner 的 Job helper 误改成 Codex 专用接口。

### 6.3 client-runtime/windows-job-object-helper.ps1

helper 内嵌 C# Win32 调用，当前目标是：

1. 用 suspended target 避免进程在纳入 Job 前产生后代；
2. 设置 JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE；
3. target 与 descendants 都进入同一 Job；
4. parent owner 消失时通过 owner watchdog 终止 Job；
5. target 退出后查询 JobObjectBasicAccountingInformation.ActiveProcesses；
6. 如果仍有后代，先终止 Job，再有界重查；
7. 写入包含 activeProcessCount、confirmed、ownerLost、时间戳的 receipt proof。

### 6.4 测试和文档改动

- tests/windows-job-object-test.mjs：保留原有两个进程树测试，新增 stdin bridge、started handshake、实时 JSONL tail、receipt release proof 测试，目前共 3 个子测例。
- tests/codex-runtime-test.mjs：增加 observability 断言和注入式 Job supervisor 测试，验证 prompt、PID、Job 元数据、terminal/release proof、JSON 参数。
- tests/release-guard-test.mjs：增加 Windows 文件句柄释放后的有限重试；启动健康检查尝试次数从 30 增加到 100，解决测试本身的短暂启动/EBUSY 噪声。
- client-runtime/README.md：补充 Job supervisor、stdin、实时 tail、release proof 和环境开关说明。

## 7. 测试状态（必须按“当前”与“历史”区分）

### 7.1 已确认通过的聚焦测试

在本轮差异下已单独执行并通过：

    node tests/codex-runtime-test.mjs
    node tests/windows-job-object-test.mjs       # 3/3
    node tests/codex-cancellation-test.mjs
    node tests/module-boundary-test.mjs
    node tests/release-guard-test.mjs            # 在清理旧 server/增加重试后通过
    git diff --check

这些结果证明主要路径和确定性 fixture 可用，但不能证明真实 provider 网络稳定，也不能替代完整发布门禁。

### 7.2 最近一次总门禁的真实状态

最近启动的是：

    npm run verify:non-hardware-robustness

它包含 verify:local-c500-release。该轮在用户中断时已经打印并通过大量前置检查，包括 execution package、experience、Queue liveness、local C500 recovery、Windows Job Object 3/3、generic iteration fault injection、candidate generation、module boundary 等；中断点在：

    test:state-storage-adapters

因此当前 handoff 不能写“本轮 verify:non-hardware-robustness 全部通过”。接手者必须从头重新运行，并记录最终 exit code。中断的 node 进程/服务也要先确认没有占用测试端口；不要凭进程名盲杀用户的 Node 服务。

### 7.3 历史验证材料的使用规则

GENERIC_OPERATOR_VERIFICATION.json 和 .log.txt 是以前一轮的机器可读摘要/日志，里面的“PASS 数量”不一定覆盖当前未提交差异。可以用于了解命令顺序，不能作为本轮 P1 的验收证明。

## 8. 接手后的立即执行顺序（短期任务）

### T0：建立安全快照

    Set-Location 'F:\设计\快速项目\acagemm原型'
    git status --short
    git diff --stat
    git diff --check
    git branch --show-current
    git log -1 --oneline
    git remote -v

把 git diff > $env:TEMP\acagemm-p1-job-supervisor.patch 保存为可回滚证据；不要用 git reset --hard 或 git checkout -- 清理工作树。

### T1：阅读并审查差异

重点审查下面几个危险点：

1. Job helper 启动失败后，children、receipt、临时目录和 fail-closed 状态是否都能收敛；
2. stdout/stderr tail 与 append chain 是否会因 helper close 顺序丢最后一行；
3. target 退出但 descendant 仍在时，active-process query 是否真的覆盖所有 Job 成员；
4. owner watchdog 的父 PID 打开失败时，是否明确记录“未启用 watchdog”而不是宣称已保护；
5. .cmd、Node shim、非 Windows 平台、注入 spawn 的 fallback 是否仍兼容原有测试；
6. Job receipt reject 与业务 primaryFailure 是否保持两条独立故障轴；
7. 外部 bridge 文件是否绝不混入 Workspace Diff；
8. 无论 helper 是否已输出 receipt，都不会自动启动下一 attempt。

### T2：重新跑聚焦测试

    node tests/codex-runtime-test.mjs
    node tests/windows-job-object-test.mjs
    node tests/codex-cancellation-test.mjs
    node tests/agent-cancellation-liveness-test.mjs
    node tests/module-boundary-test.mjs
    node tests/release-guard-test.mjs

若某个测试因旧 server/端口失败，先读取测试进程和端口归属；不要把网络、模型或业务代码改动作为第一反应。测试代码已经有有限清理重试，持续失败才进入代码排查。

### T3：完成完整门禁

    npm run verify:local-c500-release
    npm run verify:non-hardware-robustness

verify:non-hardware-robustness 会再次包含 local release gate；如果时间有限，至少先完成 local gate，并在交接记录中明确第二个命令未完成。禁止把被中断的命令写成 PASS。

### T4：提交与推送

测试通过后只显式暂存受控文件：

    git add client-runtime/README.md client-runtime/codex-client.mjs client-runtime/windows-job-object-helper.ps1 client-runtime/windows-job-object.mjs tests/codex-runtime-test.mjs tests/release-guard-test.mjs tests/windows-job-object-test.mjs docs/development/CURRENT_TASK_HANDOFF.md docs/development/README.md
    git diff --cached --name-only
    git commit -m "feat: contain codex runs with observable job supervisor"
    git push origin main

如果代码审查要求拆分 commit，可拆为“实现/测试/文档”，但必须保持每个 commit 不破坏门禁。推送后记录新的 commit hash 和远端 URL。

## 9. P1 完成验收标准

只有同时满足下列条件，才能说当前 P1 完成：

- 原生 Windows Codex executable 默认走 Job Object；.cmd fallback 的原因可观察且不冒充 Job 收容。
- target 启动前已加入 Job；启动 handshake 能证明 target PID、Job name 与时间。
- stdout/stderr 在运行期间持续可观测，事件文件保留 JSONL，最后一段无换行内容也不会丢失。
- target 退出不等于资源释放；只有 receipt 的 release proof 确认 active process count 为 0，才可复用 Workspace。
- owner 消失、helper 异常、receipt 缺失、查询失败都会有限结束为 blocked/quarantined/fail-closed，不会无限 cancel_requested，也不会自动恢复。
- P0 的 primaryFailure（例如 TLS trust failure、capacity、候选契约失败）仍然可追踪，不被释放错误覆盖。
- 恢复 attempt 产生的 candidate、Queue request、evidence 都指向实际生成该 candidate 的 sourceRunId；不会回查最初失败的 run。
- 测试请求在超时、调用方丢响应、Queue 重启时使用同一稳定身份，不重复执行权威任务。
- 聚焦测试和两项 release gate 通过，并记录运行日期、Node/CLI 版本、是否真实 provider。

## 10. 已知限制与风险（不要误报为已解决）

### 10.1 真实 Codex/provider 仍未被此 fixture 证明

Job tests 使用确定性本地进程和注入 supervisor；它们证明的是本地收容、流采集和状态转换，不证明模型服务容量、TLS 信任链、服务端排队或 Code Mode host 的行为。真实 Codex 需要在预检通过后用同一 CLI/模型/认证/配置做单独探针。

尤其不能把：

- UnknownIssuer 归因成模型生成能力；
- turn.started 后无 turn.completed 归因成模型静默；
- 浏览器能联网归因成 Codex provider 路径正常；
- 20 次本地 fixture 成功归因成生产稳定率。

### 10.2 Windows 兼容边界

- Job Object 只对 native Windows executable 直接适用；.cmd/某些 shim 会走 legacy child-process。
- Job supervisor 能证明它实际收容的进程；如果存在外部 broker、提权服务或 sandbox helper，不应假设它们自动在同一 Job 中。
- unelevated sandbox 不是完整隔离承诺；sandbox 决定访问边界，Job supervisor 决定生命周期，两者不能互相替代。
- helper 目前依赖 Windows PowerShell、Win32 API 和本地临时文件；真实部署还应验证路径 ACL、杀毒软件句柄、长路径和非 ASCII 路径。

### 10.3 尚未覆盖的测试

- owner parent 在 target 运行中突然退出的真实 fixture；
- receipt 写入失败、Job 查询 API 返回 UInt32.MaxValue、helper 被杀死后的恢复；
- 大量 stderr、分块多字节 UTF-8、迟到 terminal event 的组合回放；
- .cmd shim 的实际 Codex 版本解析和 preflight 展示；
- Linux process group/supervisor 与 Windows Job Object 对等性；
- 云端 GPU Queue 的稳定请求、服务端 trace ID 和跨进程证据关联。

### 10.4 当前环境诊断噪声

本机对 Get-CimInstance Win32_Process 和 tasklist /V 曾返回“拒绝访问”。这不是代码已修复或 WMI 已可用的证明；需要调查进程时优先使用测试自身输出、受控 PID、端口探针和 Job receipt，不要依赖未授权的 WMI 快照。

## 11. 错误分类与恢复策略速查

| 情况 | primaryFailure | release | 自动动作 |
|---|---|---|---|
| 明确 capacity 终态 | CODEX_CAPACITY...（以现有分类器实际值为准） | confirmed | 释放确认后有限恢复，仍受 Round 总预算约束 |
| 临时连接重置/超时 | transport 类 | confirmed | 有限恢复；记录 attempt 次数与退避 |
| 持续 UnknownIssuer | CODEX_TLS_TRUST_FAILED | 可独立为 confirmed/unconfirmed | 同配置不继续外层重试，要求环境修复和预检 |
| 工具失败但 patch 可验证 | 工具失败分类 | confirmed | 标记 candidateGenerationPath=patch_fallback，不降低 correctness/Gate |
| 正常完成但候选为空 | candidate contract | confirmed | 不伪装成网络重试，进入候选失败分类 |
| helper/Job 释放证据缺失 | 原始上游原因另存 | unconfirmed | blocked/quarantined，禁止恢复和 Workspace 复用 |
| Queue 已接受但调用方没收到 | 不应新建 provider failure | 按 Queue 证据 | 查询或用同一稳定请求重发，不创建新任务 |

推荐状态关系：

    running
      ├─ completed/failed/cancelled + release confirmed
      └─ cancel_requested
            ├─ released -> terminal business status
            └─ deadline/release unknown -> blocked/needs_human + quarantined

不要用一个布尔 success 覆盖业务结果、资源释放、候选准入和 Queue 终态。

## 12. 短期任务（完成 P1 后的 1～3 个迭代）

### S1：补齐确定性运行时 fixture

- 首次 attempt capacity，第二次 attempt 生成候选；故意延迟结算 projection，确认 E2E 不查 firstRunId。
- 本地取消与迟到 turn.completed 交错；断言 Round 只结算一次。
- Queue 已接受但响应丢失；断言重启后同一稳定请求被查询，不产生并发 runner。
- helper 退出但 receipt 缺失、owner 退出、descendant 残留；断言 blocked/quarantine 和禁止 recovery。

### S2：完善 Job supervisor 的审计字段

把 provider 请求、stdout 原始流、JSONL parser、adapter、Runtime 持久化五层的最后活动时间和计数分开记录。不要只记录一个“最后活动时间”，否则无法区分服务端无响应、CLI 不吐 stdout、解析器阻塞和状态投影落后。

### S3：完成真实 Codex 最小探针

在同一生产路径下记录 CLI binary digest、模型请求标识、sandbox、认证模式、provider、网络/证书指纹、thread/turn/request ID。只返回 OK 的只读任务先跑通，再进入候选生成。证书问题不得通过关闭校验规避。

### S4：更新机器可读验证摘要

门禁完全通过后再更新 GENERIC_OPERATOR_VERIFICATION.json/.log.txt 或新增本轮记录；保留历史记录，不覆盖失败证据。记录样本数、平台、是否真实模型、是否使用 fixture、失败分类和耗时分位数。

### S5：Linux 兼容收口

Linux 继续采用 process group/等价 supervisor，但把通用接口抽象为“启动、实时流、取消、释放证明、失败原因”。不要把 Windows Job API 细节泄漏到 domain/application；新增 Linux 实现时补对应集成测试和平台 preflight。

## 13. 长期任务路线图

### L1：跨平台/云端测试后端

- 以测试工具/port 为唯一上层入口，保留 local GPU adapter。
- 新增 cloud GPU queue adapter、提交/查询/取消/幂等协议和服务端 trace 关联。
- 明确 simulation、local shared GPU、cloud live GPU 的 evidence provenance，禁止跨环境冒充。
- 处理断线、重复提交、服务端接受但客户端未收到响应、远端 worker 释放证明。

### L2：通用执行包与多语言算子

- Python、C++/CUDA、Rust 等语言共享 manifest、依赖闭包、入口、平台、编译/运行命令和 digest 合同。
- import 前完整有效性验证；危险路径、符号链接、越界引用、外部绝对路径和未声明依赖 fail-closed。
- 运行时只允许包内引用，测试证据绑定 execution bundle digest。

### L3：03 候选生成工作区内部优化

03 输入输出合同已经解耦，伙伴可以在不改变外部 I/O 的前提下把自由发散生成改成可量化 workflow。长期要接入：上一轮经验、已验证经验、失败摘要、token/time/correctness/benchmark 评估；经验必须带 provenance、版本和证据，不得把未验证建议当知识。

03 不负责：启动进程、文件 I/O、Queue、Gate、硬件判定或跨模块持久化。相关 orchestration 仍由 application/client runtime 负责。

### L4：稳定性与性能观测

- 固定 CLI 构建、模型版本/别名、工具 schema、Prompt/semantic/testSpec digest。
- 比较 gpt-5.5 与 gpt-5.6-sol 时交错执行，不把模型切换伪装成重试。
- 分别统计生成、释放、Queue、correctness、benchmark 延迟；超时样本不能从总体 p95/p99 中偷偷剔除。
- Profiler/tracer 在基础闭环稳定后再接入，不能改变候选准入和证据完整性。

### L5：生产级恢复与审计

- 原子 Round settlement snapshot；迟到事件只能追加证据，不能重开终态。
- 统一 attempt/candidate/evidence/queue ID 关联查询。
- 支持人工处理 blocked/quarantined workspace，并可安全恢复而不复用未知仍在写入的进程。
- 为支持团队生成脱敏诊断包，不上传 token、cookie、认证头或未审查 Prompt。

## 14. 交接时的提交/回滚规则

### 提交规则

- 先通过 nearest module tests，再跑 npm run verify:local-c500-release；硬件无关改动尽量补 npm run verify:non-hardware-robustness。
- commit message 要说明是 Job supervisor、observability 或状态修复，不把真实 provider 尚未验证写成“稳定性完成”。
- 只提交受控 tracked 文件和本 handoff/README 更新；动画 HTML 等用户文件留在工作树。
- push 后把 commit hash、门禁命令、exit code 和未完成项写回本文件或后续交接记录。

### 回滚规则

- 先把当前 diff 导出为 patch，再逐文件恢复；禁止无用户确认执行 git reset --hard、git clean -fd 或删除宽目录。
- 如果 Job supervisor 在生产验证中出现异常，优先使用 OPERATOR_CODEX_JOB_OBJECT=0 作为受控 fallback，但仍保留 fail-closed 释放要求；不要把 fallback 误报成隔离已解决。
- 回滚不能放宽候选 Gate、固定 test matrix、资源释放屏障或证据 provenance。

## 15. 交给下一位同事的最短消息模板

可以直接转发以下内容：

> 请先拉取 https://github.com/Teeeio/Acagemm.git 的 main，阅读 docs/development/CURRENT_TASK_HANDOFF.md、docs/development/ARCHITECTURE.md 和 client-runtime/README.md。远端已包含 P0 提交 9b80437；当前本地还有一组尚未提交的 Windows Job Object/实时 JSONL/release proof 改动，交接文档列出了具体文件。先检查工作树，不要删除未跟踪的动画 HTML；先跑 node tests/codex-runtime-test.mjs、node tests/windows-job-object-test.mjs、node tests/codex-cancellation-test.mjs，再跑两个 release gate。只有在确认释放证据、候选 sourceRunId 和 Queue 幂等都没有回归后，才提交并推送。真实 Codex/provider 稳定性仍需单独探针验证，不能用本地 fixture 代替。

## 16. 完成定义

当且仅当下一位接手者完成以下事项，本次交接才算闭环：

1. 知道哪些改动已在远端、哪些仍在本地；
2. 能在不误删用户文件的情况下重现聚焦测试；
3. 解释 primaryFailure、resourceRelease、sourceRunId、stable Queue ID 的关系；
4. 证明 Job supervisor 的实时流和 release proof，而不只证明 helper 进程退出；
5. 完成或明确记录总门禁的最终结果；
6. 提交/推送后留下新的 commit hash 和后续未决任务；
7. 不把 TLS、模型容量、外部 broker 或真实云端稳定性尚未验证的部分写成已解决。

