# 已知问题与风险

## P0：阻止“真实项目”生产发布

### 1. 真实优化执行链没有接通

- Demo Runtime 的 Agent、Benchmark、C500/CUDA 数值、Accept Gate 证据和知识 change plan 都是固定参考数据。
- `/api/runtime` 正确声明 `liveHardware=false`，但这也意味着当前只能证明产品流程和本地副作用，不能证明真实算子优化能力。
- CLI 文件模式只支持 Mission 请求与 Agent 状态投影；Patch、Benchmark、Decision、Review、Rollback、Reset 都会被拒绝。

### 2. 没有生产服务能力

- 无身份认证、授权执行、租户隔离、数据库、任务队列、Worker 调度、密钥管理、可观测平台或备份恢复。
- 服务只绑定 localhost，适合单机展会，不适合作为多人共享服务。
- `permissions` 字段目前只是展示/元数据，没有服务端鉴权语义。

### 3. 当前业务代码尚未形成可复现提交

- 盘点开始时 `README.md`、服务端、测试、前端等已有多项未提交改动，`server/release-guard-test.mjs` 仍未跟踪。
- 本次文档 commit 将只包含 `for_programmer/`，因此 checkout 该 commit 不能单独复现文档描述的全部当前业务行为。
- 发布前必须审查这些业务差异并单独提交，随后在干净工作树上重新执行 release gate。

## P1：高优先级工程风险

### 4. 前端是超大单文件，且没有前端测试

- `src/App.jsx` 约 204 KB，页面、API、状态和弹窗都在一个文件中。
- `src/styles.css` 约 178 KB。
- 没有 ESLint、TypeScript、单元测试、组件测试、Playwright/Cypress 或截图回归。
- 当前 `npm run build` 只能证明可编译，不能证明按钮、抽屉、响应式布局和错误态可用。

### 5. 单 JSON 状态库没有并发控制

- 临时文件 + rename 可以降低半写文件风险，但没有进程锁或版本比较。
- 两个同时到达的请求都可能基于旧 state 修改并发生最后写入覆盖。
- 所有 Mission 共用一个顶层状态文件，数据增长、查询和迁移能力有限。

### 6. `GET /api/state` 带流程副作用

- Demo 模式在读取时推进 Agent/Benchmark，并可能触发自动采用和知识发布。
- 监控、重复请求或多个浏览器标签页都会驱动状态机；这不符合通常的 GET 语义。
- 接真实后端时应由 Worker/事件循环推进，查询只读。

### 7. 工作区“worktree”不是真正 Git worktree

- 当前实现是目录复制检查点，无法表达 commit、branch、merge、冲突、diff base 和 provenance。
- 大仓库复制会带来时间和磁盘开销。
- Checkpoint path 保存在 JSON 中，移动项目目录后历史检查点可能失效。

### 8. Runtime 和 State Store 边界仍不完整

- `state-store.mjs` 直接生成参考 Agent/Benchmark；Runtime Adapter 只负责部分分派。
- 接真实 CLI 后，需要统一 Action Command、Event、Artifact、Cancellation 和 Error 合约，否则会继续出现 Demo 与 CLI 两套状态机。

## P2：中优先级缺口

### 9. 人工介入分支测试不完整

- Smoke 覆盖了 request-review、阻塞和 redirect。
- adopt、supplement、cancel-review 在各种阶段/异常组合没有完整矩阵测试。
- UI 中的人工介入信息面板和表单没有浏览器自动化验证。

### 10. 状态迁移只做了宽松补字段

- `ensureDomainState()` 通过补默认字段迁移到 schemaVersion 4，没有显式的逐版本 migration 和回滚。
- 旧数据与新默认值合并可能掩盖字段语义变化。
- 未测试多个历史 schema fixture 和损坏 JSON 的恢复行为。

### 11. API 校验与安全边界有限

- 请求体没有大小上限，字段类型校验不完整，错误信息直接来自异常。
- 静态文件目录检查使用字符串 `startsWith(distDir)`，不是严格的父目录比较；虽然当前仅 localhost，仍应在网络化前修正。
- 没有速率限制、Origin/CSRF 策略或安全响应头集合。

### 12. Mission 隔离不是完整领域隔离

- Mission 保存其 stage/agent/benchmark 等快照，但知识资产、候选评估、失败记录、审计等仍为顶层共享数据。
- 切换 Mission 时哪些字段应全局、哪些应按 Mission 隔离，没有独立 schema 文档或测试矩阵。

### 13. 事件是轮询 JSON，不是流式协议

- `/events?after=` 可增量读取，但前端主要仍轮询完整 `/api/state`。
- 没有 SSE/WebSocket、确认机制、断线重放窗口说明或持久事件存储。

### 14. 发布包不包含本目录的工程收口文档

- 当前打包清单复制 `README.md`、`DELIVERY.md`、`EXHIBITION.md`，不复制 `for_programmer/`。
- 这不影响现场运行，但接手工程师仅拿离线包时无法看到本次收口材料。
- 本次遵守“不改业务行为”约束，只记录，不修改打包脚本。

### 15. 发布流程是 Windows 专用且未签名

- `.cmd`、PowerShell、内置 `node.exe` 面向 Windows。
- ZIP 只有 SHA256 manifest，没有代码签名、安装器、SBOM 或恶意软件扫描记录。
- 双击启动/停止的 GUI 行为没有自动化测试。

## P3：文档与体验风险

### 16. 现有交付文档可能与当前未提交代码发生漂移

- 当前自动采用、失败候选和人工介入行为近期发生变化，但 README/DELIVERY/EXHIBITION 也处于未提交状态。
- 在业务改动正式提交前，以代码、测试和本目录的盘点为准，不应单独依据旧 commit 中的 README 判断功能。

### 17. 展会数据过于确定，容易被误解为实测

- 固定的 41.8μs、36.1μs、24/24 和 Level 3 会让演示看起来完整。
- 顶栏 Runtime 真值和 `liveHardware=false` 已提供技术边界，但讲解话术仍必须说明是历史样例/参考 Runtime。

### 18. 缺少性能和长时间稳定性数据

- 未执行多标签页并发、数小时运行、频繁重置、超大事件列表、低磁盘空间、异常断电等测试。
- 当前测试关注功能闭环，不代表现场环境稳定性已充分验证。

## 已观察但不属于应用缺陷的验收事件

第一次尝试用 PowerShell `Start-Process npm.cmd` 创建隔离服务时，被宿主环境中 `Path`/`PATH` 重复键触发的 `ArgumentException` 拦截，应用进程未启动。改用 PowerShell Job 执行同一 `npm start` 后，服务、首页、健康检查和诊断全部通过。该事件应记录为测试启动器兼容性问题，不应计为 Operator Studio 启动失败。
