# C500 Tester 环境包

该分支包含可迁移的非硬件运行环境入口。目标机只需要提供 Claude Code 登录态、Python/C500 软件栈和本机 C500 runner。

## 已封装

- Linux x64 Node.js 24.19.0 及 SHA-256 校验
- 锁定的 `package-lock.json` 依赖安装入口
- Claude Code 默认运行时配置
- 当前 checkout 派生的 Tester Home、data、runtime 和日志路径
- 启动前识别并停止目标端口上的旧 Operator Studio runtime
- 非硬件 release 回归、Mock 闭环和真机 Doctor 入口

## 未封装

- Claude Code CLI 本体、账号认证、模型网关和配额
- Python、PyTorch、Triton、MACA/C500 驱动及 `mx-smi`
- 目标机上的 `mctracer`、`mcProfiler`（两者为可选诊断工具）
- 真实 C500 runner 的硬件执行结果

## 目标机入口

```bash
bash scripts/c500-test.sh verify
bash scripts/c500-test.sh doctor
bash scripts/c500-test.sh start
```

如果目标设备是 C550：

```bash
export OPERATOR_MUXI_DEVICE=C550
bash scripts/c500-test.sh doctor
bash scripts/c500-test.sh start
```

`verify` 不访问 C500，验证代码、Node、工作流、TUI 和 Mock 闭环；`doctor` 验证 Claude 和 C500 环境；`start` 启动 Claude Code + C500 真机 TUI。

## 运行边界

脚本只会终止 `/api/health` 明确标识为 `operator-studio-client-runtime` 且 PID/端口匹配的旧进程。普通端口占用或其他服务不会被自动终止，而是要求更换端口或人工处理。

因此可以把“非硬件软件链路”收敛为可重复部署，但 Claude 外部服务和 C500 驱动仍属于目标机依赖，必须由 Doctor 在启动前确认。
