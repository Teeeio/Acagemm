# 展会启动方式

Operator Studio 直接调用当前 Windows 用户环境中的 `codex exec --json`。它不管理或注入 Provider、base URL、模型和密钥，Codex 的认证与配置仍由本机 Codex 自己负责。

## 成品模式（展会与交付验收）

在普通 Windows PowerShell 中运行：

```powershell
cd "F:\设计\快速项目\acagemm原型"
npm run build
npm start
```

终端会打印唯一需要打开的地址：

```text
[operator-studio] Open http://127.0.0.1:端口
```

默认页面端口是 `4173`。如果被历史进程占用，启动器会自动选择下一个可用端口，因此必须打开本次终端新打印的地址，不要继续使用旧浏览器标签页。

成品模式同时启动：

- Operator Studio 页面、本地 API 与 Codex Runtime：默认 `4173`，冲突时自动顺延
- Mock Benchmark / Tracer / Profiler 服务：默认 `4180`，冲突时自动顺延

## 开发模式

```powershell
cd "F:\设计\快速项目\acagemm原型"
npm run dev
```

打开 `[operator-studio] Open` 输出的地址，通常是 `http://127.0.0.1:5173/`。开发模式会为页面、本地 API 和 Mock 测试服务分别选择可用端口，并让 Vite 代理到本次启动的 API，不会连接遗留服务。`npm run dev:web` 也会启动同一套完整本地栈，不再允许单独启动一个无法工作的纯前端页面。

## Codex 边界

两个入口都固定使用 `codex-cli` Runtime，并通过 `codex exec --json` 启动 Agent。Operator Studio 不要求用户再次填写 Codex 密钥，也不会读取 CCSwitch 后把密钥写入项目配置。只要用户在自己的终端中可以正常运行 Codex，Operator Studio 就复用同一份本机状态。

如果页面显示 Agent 未连接，先确认浏览器地址与本次启动终端打印的地址完全一致，再运行：

```powershell
codex --version
codex exec --json "只回复 OPERATOR_STUDIO_CODEX_OK"
```

不要从受限沙箱身份启动交付服务，因为该身份可能无法写入当前用户的 Codex 状态目录。
