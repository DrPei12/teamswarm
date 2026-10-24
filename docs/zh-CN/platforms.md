# 平台支持

TeamSwarm 0.5.0 提供 Windows x64 桌面安装包。

| 系统与架构 | 桌面格式 | 获取方式 |
|---|---|---|
| Windows x64 | NSIS `.exe` | GitHub Release |
| Linux x64 | AppImage、DEB | 源码构建 |
| macOS Apple Silicon | DMG、ZIP | 源码构建 |

Windows 安装器按用户安装，升级与卸载会保留工作空间数据。安装包未签名，Windows 将发布者显示为未知。安装前将文件 SHA-256 与同版本校验清单比较。

应用内置 Electron、Node.js 和 Codex，还可接入 Claude Code、Grok、Pi、DeepSeek Harness 和 OpenCode。账号与模型配置见 [Harness 指南](harnesses.md)。

源码构建使用 Node.js 24，在目标系统与架构上执行。Linux 桌面凭据使用系统密钥存储，macOS 使用 Keychain。依赖与构建命令见[开发指南](development.md)。

桌面构建架构为 Windows x64、Linux x64 和 macOS arm64。`ci.yml` 在 Windows 执行源码检查；`desktop.yml` 可选择原生构建环境；`windows-installer.yml` 在 Windows 测试安装与升级。
