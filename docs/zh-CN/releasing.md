# 准备发布

1. 确定版本，统一各工作空间清单、服务锁文件和当前用户文档。
2. 从干净检出运行 `npm ci`、`npm run check`、`npm run release:check`、`npm run build` 与 `npm run test:smoke`。
3. 在本次分发的各目标系统运行 `npm run desktop:build`，保存源码身份、文件清单、安装器验证、发布清单与校验值。
4. 在目标系统完成首次使用、真实任务、接续、退出重开和保留数据升级，记录实际环境与模型组合。
5. 检查准备公开的源码、Git 分支与标签、截图、示例和安装包，处理凭据、私有数据和第三方许可要求。
6. 冻结发布时核对依赖与运行时安全公告，依赖更新后重新构建。
7. 上传前审查准确提交与二进制。安装包和 `SHA256SUMS.txt` 放入 Release 附件，源码提交保持精简。

## CI

`ci.yml` 在 Windows 检查推送与拉取请求。`desktop.yml` 在选定的原生环境构建安装包。`windows-installer.yml` 测试全新安装、应用启动、保留数据升级与卸载。`previous_tag` 指定升级前的版本；`candidate_tag` 留空时构建当前检出并生成通过验收的 `windows-installer-package` 附件，填写已有 Release 标签时验收该安装器。工作流采用只读仓库权限。

## macOS 签名

macOS 源码构建生成未签名的 DMG 和 ZIP 包。面向普通用户分发前，需要 Developer ID、Hardened Runtime、内置可执行文件签名及适当权限声明，再对最终应用或磁盘映像公证并附加票据。在另一台 Mac 检查最终签名包、安装和 Keychain 行为，签名凭据放入 CI 密钥存储，签名后重新核对安装包。

官方参考：[Electron 签名](https://www.electronjs.org/docs/latest/tutorial/code-signing)、[Apple Developer ID](https://developer.apple.com/developer-id/)、[GitHub Releases](https://docs.github.com/en/repositories/releasing-projects-on-github/about-releases)。

## 版本说明

说明用户可见变化、可下载平台与架构、签名状态、已测环境、已知问题、升级及数据操作、固定源码版本，并链接首次使用教程。
