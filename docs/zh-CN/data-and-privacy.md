# 数据、凭据与恢复

[故障排查](troubleshooting.md) · [English](../en/data-and-privacy.md)

## 存储位置

团队记录、消息、工作、成果版本与项目历史保存在本地服务目录，项目工作文件保存在你选择的项目目录。

| 平台 | 默认服务数据目录 |
|---|---|
| Windows | `%LOCALAPPDATA%\TeamSwarm\data` |
| macOS | `~/Library/Application Support/TeamSwarm/data` |
| Linux | `${XDG_DATA_HOME:-~/.local/share}/TeamSwarm/data` |

`TEAM_DATA_DIR` 可以指定服务目录。窗口状态与待发送输入保存在 Electron 的 TeamSwarm 用户目录；Windows 路径为 `%APPDATA%\TeamSwarm`。需要保留尚未提交的输入时，单独备份这部分数据。

## 模型请求

所选 Harness 将提示和相关项目内容发送到配置的提供方，并维护自己的原生会话和账号状态。数据保留与使用方式以该提供方及 Harness 的设置为准。TeamSwarm 不运营模型中转服务。

本地 API 监听 `127.0.0.1` 并使用本地控制凭据。保护 `control.json`、数据库和原生会话记录。诊断导出会省略对话正文与密钥值。

## 凭据

Windows 保存的密钥使用当前系统账号的 DPAPI。macOS 桌面版通过 Keychain 加密，Linux 桌面版使用可用的系统密钥存储，并拒绝明文后备存储。保存和读取密钥时需要解锁系统密钥环。

macOS/Linux 源码 Web 服务使用环境变量或启动时的密钥文件引用。配置导出只携带引用。更换系统账号或设备后，在目标设备重新连接账号、填写所需密钥。

## 备份与恢复

先关闭 TeamSwarm，再执行服务数据备份或恢复。源码目录中可使用：

```sh
node scripts/data-tools.mjs diagnostics --data-dir /absolute/data-directory --output /absolute/diagnostics.json
node scripts/data-tools.mjs backup --data-dir /absolute/data-directory --output /absolute/new-backup-directory
node scripts/data-tools.mjs restore --backup /absolute/backup-directory --data-dir /absolute/new-data-directory
```

将示例路径替换为实际绝对路径，有空格时加引号。备份包括服务数据库、附件及服务管理的配置、会话文件；项目目录与桌面待发送输入单独备份。恢复写入新目录，随后设置 `TEAM_DATA_DIR` 并打开应用。

安装包的 `resources/product` 下提供 `TeamSwarm-Tools.cmd` 或 `TeamSwarm-Tools.sh`；Mac 应用内位于 `Contents/Resources/product`。这两个入口接受命令名之后的相同参数。

备份含项目记录及可能的原生账号、会话资料，应保存在私有位置。卸载应用会保留用户数据，确定不再需要后再单独删除。
