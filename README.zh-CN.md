# TeamSwarm

**在本地组织多个 AI 编程代理，持续协作并交付成果。**

向团队提出目标，查看执行过程，并把讨论、任务与交付文件保存在同一个工作空间。TeamSwarm 连接各自独立运行的 Harness，在多轮工作中保留项目上下文，记录每次交付对应的文件和检查结果。

[English](README.md) · [安装](docs/zh-CN/installation.md) · [第一个项目](docs/zh-CN/getting-started.md) · [Harness 配置](docs/zh-CN/harnesses.md) · [参与贡献](CONTRIBUTING.md)

![TeamSwarm 工作空间](docs/assets/workspace.png)

## 主要能力

- **持续的项目对话。** 通过 Host 讨论目标，成员在各自的责任范围内执行工作。
- **独立的原生 Harness。** 接入 Codex、Claude Code、Grok、Pi、DeepSeek Harness 和 OpenCode，保留各自的工具与执行循环。
- **跨回合继续工作。** 追问过程、提出修改，并在同一工作线程查看之前的交付。
- **可查看的成果。** 打开和下载文件、比较历史版本，核对自检或独立审查结果。
- **持久的项目历史。** 保存项目决定、讨论、任务和可恢复的本地文件快照。

TeamSwarm 面向本地单用户的代码与文本项目。所选 Harness 使用你配置的模型服务。你需要准备相应账号或 API 凭据，模型用量由提供方计费。

## 安装

从 [Releases](https://github.com/DrPei12/teamswarm/releases) 选择安装包，并阅读[安装指南](docs/zh-CN/installation.md)。桌面包包含 Electron、Node.js 和 Codex；其他 Harness 在选择使用时安装到本机。

| 平台 | 安装形式 | 支持状态 |
|---|---|---|
| Windows x64 | `.exe` | 0.5.0 下载包 |
| Linux x64 | `.deb`、`.AppImage` | 从源码构建 |
| macOS Apple Silicon | `.dmg`、`.zip` | 从源码构建 |

架构与构建格式见[平台说明](docs/zh-CN/platforms.md)。当前通过下载安装新版本进行升级。迁移设备前请阅读[数据与恢复](docs/zh-CN/data-and-privacy.md)。

## 第一个项目

1. 打开 TeamSwarm，创建团队，并选择一个空项目目录。
2. 打开团队的执行设置，选择 Codex 并连接账号，或配置使用官方 API 的 Harness。
3. 把[任务报告示例](examples/task-report/README.md)复制到项目目录。
4. 将示例中的任务发送给 Host，查看交付文件与验证结果。
5. 提出后续修改，比较新旧版本。

[完整教程](docs/zh-CN/getting-started.md)提供了准确的任务文本、预期结果和检查方法。

## 从源码运行

安装 Node.js 24，下载或克隆仓库，在根目录运行：

```sh
npm ci
npm run build
npm start
```

启动器会打开已连接的浏览器工作空间，默认地址为 `http://127.0.0.1:4317`。桌面打包方法见[开发指南](docs/zh-CN/development.md)。macOS/Linux 的源码 Web 服务使用环境变量凭据；桌面版接入系统密钥存储。

## 文档

[团队使用](docs/zh-CN/usage.md) · [故障排查](docs/zh-CN/troubleshooting.md) · [数据与隐私](docs/zh-CN/data-and-privacy.md) · [运行架构](docs/zh-CN/architecture.md) · [版本变化](CHANGELOG.md)

## 贡献与许可

欢迎提交问题、文档改进和聚焦的代码变更。参与方法见 [CONTRIBUTING.md](CONTRIBUTING.md)，漏洞报告方法见 [SECURITY.md](SECURITY.md)。

TeamSwarm 使用 [Apache-2.0](LICENSE)，允许商用、修改和再分发。第三方软件保留各自的许可证，详见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
