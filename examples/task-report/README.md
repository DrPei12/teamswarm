# Task report example / 任务报告示例

Copy this directory to a new project folder. Ask TeamSwarm to complete [TASK.md](TASK.md), then continue with [FOLLOWUP.md](FOLLOWUP.md). The starting project contains synthetic input and executable acceptance checks. The agent creates `report.mjs` and `summary.md`.

将本目录复制到新项目目录。先让 TeamSwarm 完成 [TASK.md](TASK.md)，再接续 [FOLLOWUP.md](FOLLOWUP.md)。示例提供合成输入和可执行检查，代理负责创建两个交付文件。

```sh
node verify.mjs
node verify-followup.mjs
```

Run the first check after the initial delivery; run both after the follow-up. The follow-up check is expected to fail until filtering has been implemented.

首次交付后运行第一个检查，后续修改后运行两者；筛选功能实现前，后续检查会失败。

[English tutorial](../../docs/en/getting-started.md) · [中文教程](../../docs/zh-CN/getting-started.md)
