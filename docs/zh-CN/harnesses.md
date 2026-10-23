# Harness 与模型

[第一个项目](getting-started.md) · [故障排查](troubleshooting.md) · [English](../en/harnesses.md)

Harness 负责代理循环和工具执行，模型提供方负责模型 API。一条执行资源将 Harness、模型、连接、权限与推理设置组合起来。同一个提供方可以通过兼容协议供多个 Harness 使用。

| Harness | 安装方式 | 原生会话接续 |
|---|---|---|
| Codex | 桌面包内置，也支持本机已安装 CLI | 配置与上下文兼容时支持 |
| Claude Code | 单独安装到本机 | 支持 |
| Grok | 单独安装到本机 | 支持 |
| Pi | 单独安装到本机 | 支持 |
| DeepSeek Harness | 单独安装到本机 | 新原生会话读取 TeamSwarm 已保存的工作继续执行 |
| OpenCode | 单独安装到本机 | 支持 |

平台验证范围见[平台说明](platforms.md)，固定集成版本见 [config/harnesses.json](../../config/harnesses.json)。实际组合还取决于工具版本、模型和协议支持。

## 使用已有账号

在团队执行设置选择 Harness，通过对应账号入口连接。官方 Harness 负责登录及账号会话，TeamSwarm 检查安装与访问状态。Codex 账号通过 Codex 自身的账号流程使用，API 连接单独配置。

## 使用官方 API

1. 安装支持相应协议的 Harness。本机具有可用 Node/npm 时，可通过应用管理支持的设备级安装。
2. 打开模型与连接设置，输入官方 API 地址和账号可用的模型名称。
3. 选择提供方与 Harness 都支持的协议，例如 OpenAI 兼容聊天补全或 Anthropic Messages。
4. 在桌面版保存 API Key，或在高级设置填写环境变量引用。
5. 保存后检查状态，运行一个小任务验证真实工具调用。

例如 DeepSeek 使用 `https://api.deepseek.com`，选择账号提供的模型、兼容的聊天补全协议，以及 Pi 或 OpenCode 等支持该组合的 Harness。模型名称与可用性以提供方及配置页面的当前列表为准。

使用环境变量时，在启动服务的环境中设置 `DEEPSEEK_API_KEY` 等变量，在凭据引用中只填写变量名。源码服务还支持 `TEAM_CREDENTIAL_FILES`：使用 JSON 将环境变量名映射到绝对路径的单行密钥文件。

## 从源码安装工具

```sh
npm run build
npm run harness:install -- pi opencode
npm run harness:check -- pi opencode
```

传入 Harness ID 时只检查指定安装；省略 ID 时检查所有已注册 Harness。命令逐项输出结果和错误，所选 Harness 不可用或检查失败时退出码为 1。

安装器检查本机 npm 全局目录，拒绝把项目目录或 TeamSwarm 应用目录作为设备级安装位置。安装后的工具可以独立使用。

## 资源分配与权限

在“执行资源与分配”中创建资源，配置成员默认资源或单项工作资源。任务资源优先于成员默认。每次执行保存实际配置，资源变化在后续工作生效。

只读问题使用只读权限，需要修改时使用工作区写入。更换 Harness、模型、协议或账号时可能建立新原生会话，TeamSwarm 中的责任、对话和成果版本会继续保留。

便携配置导入导出只迁移配置及凭据引用，目标设备上的密钥需要单独配置。

Pi 和 OpenCode 的**最大输出 token 数**用于设置每次模型响应的输出上限，包含推理 token。留空保留默认值 8192。请使用服务商支持的值；此设置不会改变服务商限制或价格。因长度上限结束的响应仍记为失败，不会自动重试。其他 Harness 会拒绝此覆盖设置，而不是静默忽略。
