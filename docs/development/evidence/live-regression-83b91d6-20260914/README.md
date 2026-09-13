# 83b91d6 真实 GPU 回归证据

代码版本固定为 `83b91d658b97fe90d98be8a407e0fb83741103da`。317 个参与源码文件与 Root 已通过的发布检查（143 项）和无硬件稳健性检查（44 项）逐字节一致，冻结目录保持 clean。源码清单见 `../queue-prepared-binding-20260914/live-source-manifest.json`。

独立冒烟已通过：1 次全新 affine 两轮，两个不同候选分别完成两个 profile 的 4 个 correctness case；Claude Code 两次必需调用都从实际响应观测到 `deepseek-v4-flash`。第二轮发送前审计中的经验全文、版本、轮次事实、prompt 摘要和字节数均独立核对，自动回滚与停止释放确认完整。原始 219 文件已标准归档并校验，位置和 SHA-256 见 `status.json`。这次没有失败候选，失败经验支路记为未观测。

正式 N=20 使用同一冻结源码执行 20 个全新 affine 原始尝试，不包括冒烟和旧批次。当前执行状态与启动前故障历史见 `status.json`；严格结论须等完整批次及 Root 原件复核。第一次平台尝试在程序启动前因忽略目录输入缺失而失败，未生成任何 GPU 样本；已将相同字节的报告副本放入本目录并锁定来源映射 `smoke-input-provenance.json`。固定 argv、源码、模型设置和 driver 预算不变。

`smoke-independent.json` 为 Root 只读原件验收结果，`smoke-failed-feedback.json` 为失败回流补充审计。所有数据均为本机共享 GPU 开发证据，不是可发布的独占硬件性能证明。reduction/normalization 将在资源释放后单独覆盖，不计入 affine 的 20 次分母。

