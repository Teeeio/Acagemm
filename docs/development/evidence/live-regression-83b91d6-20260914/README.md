# 83b91d6 真实 GPU 回归证据

代码版本固定为 `83b91d658b97fe90d98be8a407e0fb83741103da`。317 个参与源码文件与 Root 已通过的发布检查（143 项）和无硬件稳健性检查（44 项）逐字节一致，冻结目录保持 clean。源码清单见 `../queue-prepared-binding-20260914/live-source-manifest.json`。

独立冒烟已通过：1 次全新 affine 两轮，两个不同候选分别完成两个 profile 的 4 个 correctness case；Claude Code 两次必需调用都从实际响应观测到 `deepseek-v4-flash`。第二轮发送前审计中的经验全文、版本、轮次事实、prompt 摘要和字节数均独立核对，自动回滚与停止释放确认完整。原始 219 文件已标准归档并校验，位置和 SHA-256 见 `status.json`。这次没有失败候选，失败经验支路记为未观测。

正式 N=20 已完整执行并独立核验：**20/20 次 affine E2E full_success、20/20 原件核验通过，但严格 N=20 不通过**。主命令真实退出码为 1，耗时 5711.235 秒。19 次属于同一个完整配置指纹；第 13 次虽最终完成两个通过候选，但一个被取消的模型运行没有有效响应元数据，`provider.model` 如实为 `unknown`。本批 46 个必须统计的模型运行中，45 个观测到 `deepseek-v4-flash`，1 个未知；不能用配置、相邻运行或追加第 21 次替代它。`n20-independent.json` 的退出码 0 表示原件一致性核验通过，其 `strictN20.eligible=false` 才是严格门槛结论。

这 20 次包含 40 个不同的通过候选（每次两个），各自保留两个 profile 的 4/4 correctness。64 个队列任务均已终止并确认释放资源，全部停止回执、自动回滚、成功经验及轮次事实的发送前审计独立核验通过，`workflowWritesAfterStart=0`。`n20-resource-release.json` 只证明资源释放，不授予 N20 通过。

另有 4 个真实正确性失败候选：准备摘要绑定有效，失败经验全部落库，失败事实全部进入恢复 prompt。`n20-failed-feedback.json` 额外要求“立即把失败经验正文注入恢复 prompt”，因此 4 条均未通过，原始退出码 1 保留。既有 `round-experience-service.md` 明确要求同轮恢复复用冻结快照；`n20-freeze-reconciliation.json` 分别验证 4 次快照原文未变，并在有后续新逻辑轮的 2 次运行中验证了失败经验 ID、版本及完整正文进入新轮的发送前 prompt。另 2 次没有后续新逻辑轮，记为未观测。这个补充结果不覆盖或改写即时注入检查的失败，也不把发送前原件当成对上游模型内部行为的观测。

4,546 个原始文件（未压缩 88,428,865 字节）已标准归档并校验，位置及 SHA-256 见 `n20-archive-index.json`。本批不包括独立冒烟或旧批次。第一次平台尝试在程序启动前因忽略目录输入缺失而失败，未生成任何 GPU 样本；修正为同字节、可进入快照的报告副本后再启动固定 20 次。启动前失败、真实候选失败、取消运行及未知模型全部保留；固定 argv、源码、模型设置和 driver 预算未变。

reduction/normalization 独立覆盖已通过：命令退出码 0，耗时 433.969 秒；两个家族各完成两轮，共 4 个不同通过候选、4/4 个实际模型运行观测到 `deepseek-v4-flash`。经验正文、轮次事实、发送前 prompt、回滚与停止释放原件均通过 Root 核验。此覆盖无失败候选，失败支路记为未观测；不计入 affine 的 20 次分母。391 个原始文件（未压缩 9,128,094 字节）已标准归档并校验，见 `coverage-archive-index.json`。

coverage 命令已在平台验收并集成执行记录。平台产物清单未收录实际生成的两个报告，受支持的修订导入又因控制目录规则被拒绝；原执行版本未改变，未绕过限制或重跑 GPU。本目录保留 Root 从原 command workspace 复制的同摘要报告及真实来源，不能将它们称为平台交付的 payload。原程序回执与索引分别保存在 `coverage-platform-result.json` 和 `coverage-archive-index.json`。

`smoke-independent.json` 为 Root 冒烟原件验收结果，`smoke-failed-feedback.json` 为冒烟失败回流补充审计。所有数据均为本机共享 GPU 开发证据，不是可发布的独占硬件性能证明。三组证据独立统计，最终状态见 `status.json`。

下一步应先诊断模型无响应和取消恢复的时序，保留未知值语义；只有形成明确、验证过的变更后，才考虑新冻结批次。当前证据不能用于宣布“严格 N20 已通过”或“整个迭代流程稳定”。
