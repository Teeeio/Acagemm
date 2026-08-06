# 已落地的设计决策

本文件只记录能从当前代码、配置和测试中观察到的决策，不把需求文档中的目标当作已实现事实。状态分为“已落地”“部分落地”“未落地”。

## D-01 本机优先、同源展会部署

- 状态：已落地。
- 决策：生产构建后由一个 Node 进程同时提供 `dist/` 和 `/api`，只绑定 `127.0.0.1`。
- 证据：`server/mock-server.mjs`、`package.json` 的 `start`、启动验收。
- 原因：降低展会机器部署和网络依赖。
- 代价：当前不是网络化、多用户、可水平扩展的服务。

## D-02 开发态拆分 Vite 与 API

- 状态：已落地但未充分验证。
- 决策：`npm run dev` 将 API 放在 4174、Vite 放在 5173，并通过代理维持前端相对 `/api` 调用。
- 证据：`server/dev.mjs`、`vite.config.js`。
- 原因：保留热更新，同时让前端不感知部署端口差异。
- 代价：开发编排和退出信号没有自动化测试。

## D-03 JSON 文件作为当前状态库

- 状态：已落地。
- 决策：完整领域状态保存在单个 `mock-db.json`；保存时写临时文件并重命名。
- 证据：`loadState()`、`saveState()`；Smoke。
- 原因：演示阶段无需外部数据库，状态可重置、可查看、可离线。
- 代价：没有锁、事务、并发写保护、查询能力和生产级迁移机制。

## D-04 工作区与结果状态分离

- 状态：已落地。
- 决策：领域状态在 `data/`，代码工作区和检查点在 `runtime/`，初始模板在 `demo-assets/`。
- 证据：`ensureStorage()`、`.gitignore`、Smoke 文件断言。
- 原因：让补丁和回退具有真实文件副作用，同时避免污染源码。
- 代价：所谓 worktree 是目录复制检查点，不是 Git worktree/branch。

## D-05 默认 Runtime 必须显式声明为参考实现

- 状态：已落地。
- 决策：Demo Runtime 返回 `liveHardware=false`、`authority=operator-studio-reference`，能力名使用 `*.mock`。
- 证据：`agent-runtime.mjs`、诊断脚本、Runtime test。
- 原因：允许完整演示交互，但不能将固定样例包装成实机结果。
- 代价：UI 流程完成不等于真实优化执行完成。

## D-06 外部 CLI 是权威源，未桥接动作必须拒绝

- 状态：部分落地。
- 决策：CLI 模式只接受 Mission request 和 Agent status projection；Patch、Benchmark、Decision 等未实现动作返回 `RUNTIME_ACTION_UNAVAILABLE`，且不得改变状态或生成本地结果。
- 证据：`guardReferenceRuntimeAction()`、`release-guard-test.mjs`。
- 原因：防止连接 CLI 后仍混用 Demo 结果。
- 代价：当前 CLI 连接不能完成从 Patch 到知识维护的端到端闭环。

## D-07 Accept Gate 默认自动采用，人工介入是条件式阻塞

- 状态：已落地。
- 决策：Benchmark 完成且没有 `awaiting_review` 时自动采用 Candidate 02；人工可在 candidate/validation/evidence 阶段提出不同类型的介入。
- 证据：`refreshBenchmark()`、`runAutomaticAdoption()`、review routes、Smoke。
- 原因：避免每次都强制人工审批，同时保留必要时的控制权。
- 代价：Gate 规则和证据目前来自固定 Mock 数据，真实策略引擎尚未接入。

## D-08 失败候选不作为 Candidate 保留，但保留失败记录和负向经验

- 状态：已落地于状态模型和 UI 数据。
- 决策：完全失败项进入 `failureRecords`，`disposition=candidate_removed`，同时产生 `extractedExperience`；候选比较中只保留可采用和弱参考候选。
- 证据：`candidateEvaluations`、`failureRecords`、Smoke 断言。
- 原因：避免失败方案污染候选集，同时保留可复用的失败边界。
- 代价：失败经验仍是 seed 数据，尚未由真实失败运行动态提取。

## D-09 采用前创建检查点，允许阶段回退与采用后回退

- 状态：已落地。
- 决策：应用 Patch 前复制完整工作区；阶段回退恢复该副本，采用后回退恢复 candidate-01 并使关联知识失效。
- 证据：Checkpoint/restore 函数、Smoke。
- 原因：让演示中的撤回可验证，避免只改 UI 状态。
- 代价：目录复制成本随真实仓库变大；没有 Git 对象、分支和冲突模型。

## D-10 知识由决策自动维护，已发布版本不可静默编辑

- 状态：已落地于 Demo 状态机。
- 决策：采用后自动执行预设 change plan，生成固定版本；旧的手工 publish API 返回 410；发布后 Draft patch 返回 `KNOWLEDGE_IMMUTABLE`。
- 证据：`runKnowledgeMaintenance()`、knowledge routes、Smoke/Release Guard。
- 原因：使知识与验证证据、采用决策保持一致并可审计。
- 代价：查重、版本判断、例外审核目前是固定计划，不是算法或服务。

## D-11 使用完整 state 响应驱动前端

- 状态：已落地。
- 决策：大多数变更接口返回完整 state，前端直接覆盖本地领域状态；运行态每 420ms 轮询。
- 证据：`App.jsx` 的 `requestBackend()`、`applyBackendState()` 和定时器。
- 原因：原型阶段实现简单，避免客户端重建状态机。
- 代价：响应体随状态增长；UI 与后端 schema 高耦合；GET 会触发 Demo 推进。

## D-12 知识属性使用受控选项库

- 状态：已落地于前端状态和草稿编辑。
- 决策：dtype、hardware、operator、layout 等使用受控选择组件，不以任意文本作为主要输入。
- 证据：`ControlledSelect`、`ControlledMultiChoice`、`knowledgeOptionLibrary`。
- 原因：提高检索、分类和后续复用的一致性。
- 代价：选项库仍内嵌在应用状态，没有独立维护 API 或组织级治理服务。

## D-13 发布包内置 Node 并生成校验清单

- 状态：已落地并验证。
- 决策：离线包复制当前 Node 可执行文件、应用文件和脚本，生成 `MANIFEST.sha256` 并压缩。
- 证据：`prepare-exhibition-package.ps1`；`npm run demo:package` 通过。
- 原因：降低展会机器安装依赖。
- 代价：当前打包流程是 Windows/PowerShell 专用；未签名，未生成 SBOM。

## D-14 生产后端与真实 Worker 暂不实现

- 状态：未落地。
- 决策边界：仓库中没有认证服务、数据库、任务队列、GPU worker、远程 Artifact Store 或真实 Policy Engine。
- 证据：依赖清单和完整文件扫描。
- 影响：这些能力必须在后续工程化阶段设计，不能把当前 Mock Server 直接定义为生产服务。
