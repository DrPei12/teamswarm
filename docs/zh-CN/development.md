# 开发与打包

[运行架构](architecture.md) · [发布流程](releasing.md) · [English](../en/development.md)

使用 Node.js 24 和仓库内的 npm 锁文件。Windows 安装器验证还需要 Python 3；Linux 打包需要 Electron 桌面依赖、`tar` 和常规构建工具。macOS arm64 包在 Apple Silicon Mac 上构建。

Windows 原生桌面构建使用较短的源码路径，例如 `C:\src\teamswarm`。固定版本的 electron-builder 通过 `scripts/run-electron-builder.cjs` 保留生成 NSIS 卸载器所需的 Windows 系统路径；升级构建依赖时一并检查该适配。

```sh
npm ci
npm run check
npm run build
npm run test:smoke
npm start
```

`npm run check` 执行文档校验、类型检查、服务测试、离线审计测试、平台与凭据测试、前端格式检查及编译。普通测试使用确定性本地样例，不调用付费模型。

构建后运行 `node test/browser/offline-drafts.mjs`，检查不同浏览器标签页的未发送草稿在断连、关闭和重开后仍被保留。测试使用隔离本地数据库，不调用模型。先安装 Playwright Chromium，或通过 `PLAYWRIGHT_EXECUTABLE_PATH` 指定系统浏览器。

开发运行 `npm run dev`：API 使用 4318，Vite 使用 4317。通过独立 `TEAM_DATA_DIR` 保留日常工作空间。

## 生成桌面包

在目标系统和架构上运行：

```sh
npm run desktop:build
```

`npm run desktop:unpacked` 生成展开的桌面应用。打包会暂存固定 Node 运行时、Codex、服务依赖与许可证，检查文件清单，再生成对应安装格式。输出使用固定平台目录：`release/win32-x64`、`release/linux-x64` 或 `release/darwin-arm64`。两个桌面构建命令再次运行时都会替换对应平台目录，清单记录版本、源码提交与内容哈希。

`config/desktop-runtime.json` 固定 Node 官方归档及 SHA-256，`config/harnesses.json` 固定集成版本。更换内置软件时同步更新许可。

构建清单检查源码与编译产物在构建期间是否变化。编辑源码、配置或文档后重新构建。没有 Git 元数据的源码归档使用 `source-archive` 标识，并保留内容哈希。

## 验证安装包

核对 `release-manifest.json`、`SHA256SUMS.txt` 与包检查结果。在干净工作空间启动应用，创建团队、配置 Harness、完成入门示例、继续修改、关闭重开，再下载两个成果版本。

分别检查安装、保留数据升级、正常退出与恢复。备份命令见[数据与隐私](data-and-privacy.md)。安装器测试使用干净的 Windows 环境。

## 修改 Harness

先阅读 `apps/server/src/runtime/types.ts` 与 `runtime/harness/` 下适配器。保留会话身份、真实观察、权限边界和未确认停止状态。对变更协议加入样例与真实子进程测试；真实提供方检查单独记录具体 Harness、模型和版本。
