# Operator Studio Development Contract

This repository uses module contracts to support parallel and AI-assisted development.

## Read Before Editing

1. Read `docs/development/ARCHITECTURE.md`.
2. Read the nearest `README.md` in the directory being changed.
3. Keep changes inside that module's responsibilities and public contract.
4. Update the module README when inputs, outputs, invariants, side effects, or public APIs change.

## Dependency Direction

The allowed direction is:

```text
TUI -> HTTP API -> application orchestration -> domain rules -> ports -> adapters
```

- Domain rules must not import TUI, HTTP, Claude, Codex, C550, or filesystem implementations.
- TUI code must not mutate persisted runtime state directly.
- HTTP routes must not duplicate workflow, Gate, Profile, or hardware rules.
- Cross-module imports should target documented public APIs. Do not add a deep import without documenting it.

## Non-Negotiable Invariants

- `client-runtime/fixed-operator-profiles.mjs` is the only source of fixed Profile semantics and test matrices.
- Simulation evidence must never become publishable live-hardware evidence.
- Candidate evidence must match the candidate applied to the Mission Workspace.
- Fixed shapes, dtypes, correctness cases, benchmark profiles, and retry budgets must not be weakened.
- Agent writes are limited to the active Mission Workspace.
- Operator tests remain serialized and persist terminal outcomes atomically.
- Production behavior belongs to the TUI -> Production API -> Client Runtime path. Do not recreate a second workflow.

## Required Verification

Run the nearest module tests while developing. Before merging a cross-module change, run:

```bash
npm run verify:local-c500-release
```

Hardware-free changes should also run `npm run verify:non-hardware-robustness` when time permits.
<!-- dispatch:codex BEGIN {"lead":0,"sha256":"45325cd7c7f931123ab7aed0377b2f837caee48e99048ede0ce9ad30ffd24d24","v":1} -->
### 本项目多模型协作（native-codex-v1.6）

对已经能冻结目标文件、只读测试和固定检查的少量独立编辑，优先从有权访问项目外预算账本的上游宿主调用平台仓库的 `python -m native_codex patch-freeze` 和 `python -m native_codex patch-auto`：前者从精简 brief 计算测试摘要，后者仅用一个只读 Codex CLI 回合制定具体任务卡，随后外层程序派发官网 DeepSeek、独立核对范围并运行冻结检查。必须使用独立 linked Git worktree，命令最终回执的 `passed`、真实检查退出码、请求用量和 `review_diff` 都要检查；尚须上游审查需求语义并自行集成。`patch-auto` 是另一个临时 Codex CLI 规划回合和无工具下游通道，不是当前会话的原生 subagent；不能称为原生委派。若当前宿主无法访问项目外状态目录，报告接入限制，不能自行扩大沙箱或跳过预算门禁。内层 `patch-pack`/`patch-remote` 仅作兼容路线，真实 Acagemm 对照比直接完成更慢，不能默认优先使用。

本项目明确选择 native_codex 的两条受控路线：需要下游自行查阅局部源码、运行工具或诊断的任务使用 Codex 原生 deepseek_worker；已经冻结实现步骤、输入与验收，且每项只改少量现有 UTF-8 文件的独立编辑，可在隔离 Git worktree 中使用 `python -m native_codex patch` 直接请求官方 DeepSeek Responses API。后一条是无工具的结构化编辑通道，不是原生 subagent，必须如实标记。就本项目的任务派发而言，本规则覆盖上级“LLM劳务市场协作”受管块要求的 dispatch_submit、dispatch_wait 及平台验收/集成流程；其它业务要求、用户授权、宿主审批和测试标准继续有效。两条路线都不产生旧平台 task 记录，不伪造该记录。

上游负责确定需求、实现路线、接口、输入、错误行为和验收。关键不确定性先做有界探索；派发语义完整的任务，给出允许修改的精确文件、必要契约与例子、步骤、允许执行的最小检查和停止条件。共同文件仅一个写入者；只有开工确需前置产物时才串行，独立实现和独立测试可并行。原生任务用 deepseek_worker，独立任务优先不继承整段对话；并发不超过本次已配置上限，不为凑并发拆碎任务。无工具编辑路线的任务卡必须绑定精确的可编辑文件、冻结测试摘要、共同验收命令与预算；文件或验收输入不匹配、需要新文件/架构探索/超出上下文大小时改走适合的路线或交回上游决策，不能放宽范围。若任务卡已经冻结路线、输入摘要和验收命令，上游直接按卡派发；除非出现具体矛盾，不在派发前重新读取完整架构文档、长 README 或全量源码。必要的局部阅读交给下游，上游只保留决策所需的契约摘要。先用真实同类任务的耗时数据比较预计直接执行与规划加下游最慢项加验收的开销；没有足以覆盖已观测开销的独立工作量时由上游直接做并记录理由。一个常量加说明与四项同级小模块的原生子代理路线均已实测较慢；同类三项界定完整的编辑批次用无工具路线已测得更快，但不能外推为所有任务。未经同口径证实的其它任务仅作为试点，不宣称提效。

输入摘要、允许文件和检查已在 TaskSpec 冻结的无工具批次，直接从任务要求写卡：**上游不再读这批源文件、契约、测试，也不重复计算 SHA256**；外层本地程序在发请求前会核对真实内容，若不符立即停止。任务卡的步骤要把边界变成可执行条件，尤其是负例：例如“纯空白不是非空白字符串”应写明 `typeof value === 'string' && value.trim().length > 0`，同时说明相等比较仍用未修剪的原始值；不要只写抽象的“非空白”。若已冻结信息不足以定出这种条件，则先停止交上游决定，不能让下游猜。

无工具编辑路线只读取任务卡列出的现有源码、同名契约与冻结测试；本地程序验证 JSON 替换、全部指定文件发生改动、写入范围、实际退出码及工作区差异。模型没有命令或写文件工具。上游在独立 worktree 中准备计划；单独从平台仓库运行时可用 `python -m native_codex patch --profile <明确配置> --project <隔离项目绝对路径> --plan <计划文件>`。在本启动器创建的 Codex CLI 会话内，内层命令沙箱不能可靠读取外部预算账本和 Git 元数据，直接使用同会话外层路由；**不要在内层尝试 git、safe.directory、patch-doctor，也不要为了查询格式读取平台源码或长文档**。启动器已在外层验证 Git 忽略规则并创建 `NATIVE_CODEX_PATCH_AUDIT_DIR`；只在该目录写 `cards.json` 和 `plan.json`，没有此变量则报告接入缺口。卡片结构严格为 `{"items":[{"id":"item-a","editable_paths":["src/a.mjs","src/a.md"],"frozen_test_path":"tests/a-test.mjs","implementation_steps":["准确步骤"],"acceptance":["正反例及结果"],"stop_conditions":["矛盾时停止"]}]}`；每项仅这六个键，测试路径必须在当前冻结任务的 `input_refs` 与 `protected_paths` 中，所有可写路径恰好分配一次。随后只调用 `python $env:NATIVE_CODEX_ENTRY patch-pack --project . --task $env:NATIVE_CODEX_TASK_FILE --cards <卡片文件> --output <计划文件>` 与 `python $env:NATIVE_CODEX_ENTRY patch-remote --project . --plan <计划文件>`。打包器原样带入当前任务的检查及摘要；外层负责官网请求、共享预算、Git 核验和冻结检查。`patch-remote` 成功回执带有有界 `review_diff`、摘要、检查退出码与请求用量；直接据此审查，不再读取 proposals、重复检查或在内层跑 Git，除非回执明确缺少必要证据。`start` 交互会话没有 `NATIVE_CODEX_TASK_FILE` 时，上游须先制定完整 TaskSpec；不能伪造冻结输入。变量缺失时不猜路径、不改全局配置或擅自放宽权限。

取得 run_dir、真实 request/usage 和检查回执后，上游审查差异并自行集成。`passed` 只表示该工作区通过冻结检查，不表示已合入主树。`worker_failed`、`failed`、预算或配置阻断不得静默切换模型、重发有副作用的任务或绕过验收；先按 run_dir 诊断。补丁执行中断后，该隔离工作区可能部分写入，先按记录核对，不能在脏工作区盲重试。只向官方 DeepSeek 发送本任务必需的源文件和测试，禁止密钥与无关文件。

原生路线保留返回的真实 agent 身份。派发后如无独立上游工作，立即使用一次原生等待；已冻结的输入摘要无需在等待前重复查询。宿主 pending 时续接同一等待句柄，不为普通进度生成新的模型解说。若原生等待由 functions.exec 包裹，首次调用可用 `// @exec: {"yield_time_ms": 120000}` 延长外层挂起；外层返回 `Script running with cell ID` 时，仅对该 cell 调用 functions.wait，使用宿主允许的最长合理挂起（优先 120000ms 或更长）。普通进度交宿主界面，不短轮询或重新派发。只有收到最终回执后才处理失败、决策或可验收结果，并只读取必要详情。近邻修正可接续原子代理，不每个小错误重建上下文。无工具编辑路线的 CLI 调用本身会等待该批完成并返回一次最终结果，不需要 dispatch_wait 或额外监看。

上游核查真实差异，并按冻结要求独立验收；如本次运行明确由外层确定性验收器在会话结束后执行同一冻结命令，上游只审查差异和证据身份，不在会话内把这些命令重跑一遍。没有该验收器时，上游自行执行一次。已有可信检查仅在输入仍一致时复用，不重复扩大测试。实现者不能修改验收基准。交付结束、验收通过和代码合入分别报告，不凭模型自述认定成功。用户禁止测试时不运行变相自检。

输入矛盾、需要扩权、改变架构/依赖或无法完成既定路线时由上游决策。原生 sandbox/审批由宿主决定，本规则不授权、不开权限。保留用户已有改动，不自动清理或回滚工作区。旧平台不可用不影响本项目原生流程；模型路由或宿主故障必须如实报告，不静默换模型或双重派发。
<!-- dispatch:codex END {"lead":0,"sha256":"45325cd7c7f931123ab7aed0377b2f837caee48e99048ede0ce9ad30ffd24d24","v":1} -->
