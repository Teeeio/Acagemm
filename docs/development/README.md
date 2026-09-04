# 开发文档入口

本目录是多人开发时的文档入口。开始修改代码前，按以下顺序阅读：

1. [`ARCHITECTURE.md`](ARCHITECTURE.md)：生产链路、依赖方向和不可破坏的边界。
2. [`MODULE_OWNERSHIP.md`](MODULE_OWNERSHIP.md)：模块归属、功能、输入输出和建议主责角色。
3. 待修改目录最近的 `README.md` 或同名模块合同，例如
   `client-runtime/application/foo-service.md`。
4. [`MODULE_CONTRACT_TEMPLATE.md`](MODULE_CONTRACT_TEMPLATE.md)：新增模块文档模板。

## 文档分工

| 文档 | 回答的问题 | 更新时机 |
|---|---|---|
| `ARCHITECTURE.md` | 系统如何分层，依赖可以指向哪里 | 生产链路或模块边界改变 |
| `MODULE_OWNERSHIP.md` | 功能属于哪个模块，应该由谁主责 | 新增、拆分、合并或转移职责 |
| 模块 `README.md` | 目录公开合同是什么 | 输入、输出、API、不变量或副作用改变 |
| `application/*.md` | 单个应用服务如何调用 | 服务参数、返回值、错误或依赖改变 |
| `operator-studio-module-workflow.html` | 模块如何参与完整 workflow | 状态、调用关系或数据流改变 |
| `operator-studio-team-briefing-15min.md` | 如何向团队讲解和分工 | 架构或近期任务发生明显变化 |

历史方案位于 `docs/superpowers/`，用于追溯设计过程，不代表当前生产合同。
