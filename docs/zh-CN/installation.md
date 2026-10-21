# 安装 TeamSwarm

[第一个项目](getting-started.md) · [平台支持](platforms.md) · [English](../en/installation.md)

从同一个 [GitHub Release](https://github.com/DrPei12/teamswarm/releases) 下载安装包与 `SHA256SUMS.txt`。文件名包含版本、系统和架构。桌面包内置 Node.js 与 Codex；源码开发，以及在本机安装其他基于 npm 的 Harness，需要单独安装 Node.js。

## Windows x64

下载并运行 `TeamSwarm-0.4.0-Windows-x64.exe`，按需选择安装目录，随后从开始菜单打开 **TeamSwarm**。默认安装到当前用户。

Windows 安装包未签名，Windows 会显示未知发布者。核对下载来源和校验值后再选择运行。

在 PowerShell 中计算校验值：

```powershell
Get-FileHash .\TeamSwarm-0.4.0-Windows-x64.exe -Algorithm SHA256
```

将结果与 `SHA256SUMS.txt` 中相应文件的记录比较。

## 其他平台

Linux x64 和 macOS Apple Silicon 桌面目标可从源码构建，依赖与命令见[开发指南](development.md)。本版提供 Windows x64 安装包。

## 升级与卸载

升级前关闭 TeamSwarm 并备份数据。运行新版 Windows 安装器，使用原安装目录。保持原系统账号和数据目录，即可重新打开已有团队。

卸载应用后，用户数据目录中的记录会保留。项目文件仍在你选择的项目目录。具体路径及备份命令见[数据与隐私](data-and-privacy.md)。

## 源码 Web 运行

安装 Node.js 24，在仓库根目录执行：

```sh
npm ci
npm run build
npm start
```

启动器通过本地连接凭据打开浏览器，默认使用 4317 端口。为独立工作空间设置 `TEAM_DATA_DIR`，为其他端口设置 `TEAM_API_PORT`。同一数据目录只由一个服务管理。
