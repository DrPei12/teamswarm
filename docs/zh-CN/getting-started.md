# 第一个项目

[安装](installation.md) · [Harness 配置](harnesses.md) · [English](../en/getting-started.md)

本教程制作一个任务报告命令行工具，检查真实输出，再通过第二轮工作添加筛选功能。示例使用合成数据，只需要先接通一个 Harness。

## 1. 准备项目

将 [examples/task-report](../../examples/task-report/README.md) 的内容复制到一个新目录，保留 `tasks.json`、`verify.mjs` 和 `verify-followup.mjs`。代理会创建 `report.mjs` 与 `summary.md`。

打开 TeamSwarm，选择“创建团队”，命名为“任务报告”，并在团队执行设置中选择这个目录。

## 2. 接通 Harness

使用已有 Codex 账号时，在执行设置选择 Codex，通过账号入口连接或检查本机登录，并选择账号可用的模型。确认安装与执行配置可用后再发送任务。

使用 API 时，按 [Harness 与模型](harnesses.md) 添加连接。先配置一条可运行的资源，成员数量由团队按任务需要安排。

## 3. 发送第一个任务

在 Host 对话中发送：

```text
按照项目目录中 TASK.md 的要求制作任务报告。
创建 report.mjs 和 summary.md，读取 tasks.json，并保持原始数据不变。
运行 node verify.mjs，修复发现的问题。交付这两个文件并报告命令结果。
在当前项目目录工作，保持提供的验证脚本不变。
```

通过团队对话或协作视图查看工作。有待查看交付时，打开对话顶部的“成果”并选择相应结果。完成后打开交付文件，命令行工具的输出应为：

```json
{"total":6,"byStatus":{"open":3,"done":2,"blocked":1}}
```

验证脚本检查真实进程输出、退出码和非法输入处理。也可以在项目目录重新执行：

```sh
node verify.mjs
```

## 4. 继续修改

在已交付工作上选择“继续修改”，或要求 Host 接续这条工作线程：

```text
继续这个任务报告，按照 FOLLOWUP.md 添加 --status open|done|blocked 筛选。
先完整验证输入，再进行筛选。保留无筛选时的行为，更新 summary.md，
运行 node verify.mjs 和 node verify-followup.mjs，交付更新后的文件版本。
```

打开最新成果，再查看旧版本。原始交付会保留，当前版本反映本轮修改。

打开“成果与想法”，展开文件，通过“版本”选择之前的成果。下图展示了本教程实际交付的两个版本：

![已保存成果与版本历史](../assets/results.png)

## 5. 关闭后重新进入

关闭并重新打开 TeamSwarm，回到团队和工作线程，查看对话与成果，并发起一个只读问题。支持且配置兼容的 Harness 可以恢复原生会话；需要新会话时，系统从已保存的项目事实继续工作。

任务中断时，先按[故障排查](troubleshooting.md)处理恢复。独立审查流程见[团队使用](usage.md)。
