# TeamSwarm

**在本地组织多个 AI 代理，持续协作并交付成果。**

TeamSwarm 面向需要跨成员、会话和多轮修改推进代码与文本项目的 AI builders。通过 Host 讨论目标，让成员在各自独立的 Harness 中执行，并把当前决定、任务与成果保存在同一个工作空间。

[English](README.md) · [安装](#install) · [第一个项目](#first-project) · [Harness 与模型](#harnesses-and-models) · [数据与恢复](#data-and-recovery)

[观看产品宣传片 · 36 秒，4K / 120 fps](https://github.com/DrPei12/teamswarm/releases/download/v0.6.0/TeamSwarm-launch-film-4K120-ZH.mp4)

- **保持项目决定一致。** 维护带来源的当前项目定义。明确决定采用讨论分支后，将内容融入主线，并在历史中查看文档变化。
- **接续同一项工作。** 在原工作线程修改成果，跨会话保留要求、文件归属与历史版本。
- **组织独立代理。** 使用 Codex、Claude Code、Grok、Pi、DeepSeek Harness 或 OpenCode。成员相互交流，重复责任复用已有工作，等待中的成员在新信息到达后继续。
- **查看实际交付。** 打开和下载保存的文件版本，区分进展与完成成果，查看提交所关联的自检或独立审查。
- **通过两张画布了解项目。** 协作画布显示成员与实际通信；历史画布连接讨论、决定、工作、文档变化及交付。

TeamSwarm 面向本地单用户场景。Harness 使用你配置的账号或 API 连接，模型用量由提供方计费。原生工具以当前操作系统账号和你授予的权限运行。

<a id="install"></a>
## 安装

从同一个 [GitHub Release](https://github.com/DrPei12/teamswarm/releases) 下载 Windows x64 安装器和 `SHA256SUMS.txt`。桌面包内置 Electron、Node.js、npm 和 Codex，其他 Harness 单独安装到本机。

| 平台 | 格式 | 可用范围 |
|---|---|---|
| Windows x64 | NSIS `.exe` | Release 下载包，已验证安装与升级 |
| Linux x64 | AppImage、DEB | 源码构建，原生安装与运行待验证 |
| macOS Apple Silicon | DMG、ZIP | 源码构建，原生安装与运行待验证 |

Windows 安装器未签名，系统会显示未知发布者。将文件哈希与同版校验文件比较：

```powershell
Get-FileHash .\TeamSwarm-0.6.0-Windows-x64.exe -Algorithm SHA256
```

运行安装器，从开始菜单打开 **TeamSwarm**。默认按用户安装。升级时先关闭应用、[备份服务数据](#data-and-recovery)，然后在同一系统账号和安装目录运行新版安装器。更新通过手动安装完成，卸载保留服务数据和项目文件。

<a id="first-project"></a>
## 第一个项目

使用合成数据的[任务报告示例](https://github.com/DrPei12/teamswarm/tree/main/examples/task-report)，完成任务、检查输出，再继续同一项工作。

1. 将示例中的 `tasks.json`、`verify.mjs` 和 `verify-followup.mjs` 复制到项目目录。
2. 打开 TeamSwarm，创建团队，在执行设置中选择该项目目录。
3. 连接已有的受支持账号，或配置 [API 连接](#harnesses-and-models)。检查所选 Harness 与资源的可用状态。
4. 向 Host 发送以下任务：

此示例的命令检查需要可用的 Codex 资源。其他 Harness 可以创建和修改文件，由 Codex 成员运行检查。

```text
仅使用 Node.js 标准库创建 report.mjs。
用法：node report.mjs <json-file>。
输入必须是数组，每条记录包含唯一且非空的字符串 id、
非空的字符串 title，以及 open、done、blocked 三者之一的 status。
完整验证每条记录，拒绝非法 JSON、非法记录、重复 ID 和缺少或多余的命令行参数。
成功时仅向 stdout 输出一个 JSON 值，包含 total 和 byStatus，
始终包含三种状态的计数，包括零。空数组返回全部为零的计数。
失败时以非零退出码结束，向 stderr 输出有用的错误，stdout 保持为空。
保持 tasks.json 和两个验证脚本不变。
创建 summary.md，说明用法、所给数据的结果和验证命令。
由 Codex 成员运行 node verify.mjs，处理失败，交付 report.mjs 和 summary.md。
```

打开交付文件和检查结果。所给数据的预期输出为：

```json
{"total":6,"byStatus":{"open":3,"done":2,"blocked":1}}
```

可在项目目录运行 `node verify.mjs`，检查真实进程输出、退出状态和非法输入处理。

在已交付工作上选择“继续修改”，或让 Host 接续该线程：

```text
继续修改同一个 report.mjs，支持：
node report.mjs <json-file> --status open|done|blocked
保留原有不带筛选参数的行为。先完整验证输入，再筛选，
包括不匹配筛选条件的记录。仅统计匹配记录，其他状态的计数保持为零。
未知、缺少或重复参数应以非零退出码失败，stdout 保持为空。
更新 summary.md，保持所给数据和检查脚本不变。
运行 node verify.mjs 和 node verify-followup.mjs。
交付 report.mjs 和 summary.md 的更新版本。
```

打开“成果与想法”，展开文件并选择历史版本和当前版本。关闭并重新打开 TeamSwarm，回到原团队，对该工作提出只读问题。兼容的 Harness 可以恢复原生会话；需要新会话时，从保存的项目事实接续。

“协作”中的“已删除成员”保留成员的历史对话和工作。删除成员后无法再向其发送消息。消息因执行配置冲突而失败时，修正配置后可在原消息上重试；重试保留原消息和工作身份。

## 设备资源与任务排队

Host 在安排工作时读取设备内存、CPU、进程占用、已运行任务和资源配置。运行时在每次启动前重新核算预算；单 Team 和整个服务的并发成员数由设备余量与实测执行开销决定。

可以直接在对话中要求“为其他程序预留 8 GiB 内存”，或“恢复自动预留”。设置保存在本机，作用于该服务中的全部 Team。Windows 同时检查物理内存和提交空间；CPU 使用独立预算。各 Harness 的后续估算会随实际执行数据调整，正在启动的任务也会提前占用预算。

任务因资源不足排队时，对话会显示原因、受影响的任务和默认处理方式。正在执行的工作继续进行；用户可以调整预留或任务安排。用户没有新指示时，任务保持排队，资源恢复后自动接续，并在实际开始执行后再次通知。同一次持续等待合并提示，重启服务后继续保留排队记录和通知状态。Host 保留一个受实际设备余量约束的控制通道，用于调整过高的预留。

Windows 提供逐进程采样和所属进程组统计。其他系统当前使用设备内存与 CPU 采样，以及保守的启动开销估算；逐进程成本学习需要相应平台的采样支持。

<a id="harnesses-and-models"></a>
## Harness 与模型

Harness 执行代理工具与运行循环，模型连接提供模型 API。执行资源将 Harness、模型、连接、权限和受支持的推理设置组合起来。

| Harness | 安装方式 | 原生会话接续 |
|---|---|---|
| Codex | 桌面包内置，也支持已安装 CLI | 配置与上下文兼容时支持 |
| Claude Code | 本机单独安装 | 支持 |
| Grok | 本机单独安装 | 支持 |
| Pi | 本机单独安装 | 支持 |
| DeepSeek Harness | 本机单独安装 | 新原生会话读取保存的 TeamSwarm 工作 |
| OpenCode | 本机单独安装 | 支持 |

集成版本固定在 [config/harnesses.json](config/harnesses.json)。Harness 负责自己的工具、权限与会话，模型来源由独立的连接提供。同一模型连接可以分配给六种 Harness；跨协议组合由本机服务转换 Responses、Chat Completions 和 Anthropic Messages。

在团队能力中分别启用 Harness 和添加模型连接。选择 **ChatGPT → Continue with ChatGPT**，在官方页面授权后加载账号模型目录，再选择提供给 Host 分配的模型。ChatGPT 连接也可用于 Claude Code；Claude Code 自己执行命令、处理工具结果和继续会话。原有 **ChatGPT (Codex)** 入口保留 Codex 原生账号方式。

ChatGPT 连接采用 [Sign in with ChatGPT](https://developers.openai.com/siwc/token-sharing-open-source/sign-in) 的独立账号授权，使用账号目录中的模型和已授权的套餐额度。Windows 使用系统加密存储可续期凭据；刷新、退出和重新登录按账号串行处理。取消未完成的登录后可重新发起。退出会停止本机使用并请求远端撤销；远端未完成时界面提供处理入口。

配置 API 时：

1. 安装任务需要的 Harness。
2. 填写官方 API 地址和账号可用的模型。
3. 选择提供方支持的协议，例如 Responses、Chat Completions 或 Anthropic Messages。
4. 通过桌面凭据存储保存 Key，或填写环境变量引用。
5. 检查可用状态，并运行包含实际工具调用的小任务。

例如，DeepSeek 连接使用 `https://api.deepseek.com` 和 Chat Completions 协议，可由 Pi 原生使用，也可通过协议转换交给 Claude Code。模型以提供方当前账号目录为准。

协议转换支持文本、嵌入式图片、函数工具、工具结果、流式输出与 JSON Schema 输出。每次执行使用独立路由和临时凭据，结束即撤销；一个服务共用一个回环监听器。当前最多同时处理 32 个模型请求，每条执行路由最多 8 个，超限返回繁忙状态。输入上限 8 MiB、响应上限 16 MiB；原生会话的模型元数据达到 16 MiB 时要求新建会话，保留已有记录。供应商托管工具和跨协议精确 token 计数另行支持；不支持的请求会返回具体错误。

使用环境变量时，在启动服务前设置 `DEEPSEEK_API_KEY` 等变量，资源中只填写变量名。`TEAM_CREDENTIAL_FILES` 接受一个 JSON 映射，将环境变量名关联到包含单行密钥的绝对文件路径。

“执行资源与分配”中的任务资源优先于成员默认。每次执行保存实际配置，编辑影响后续工作。资源导入导出携带配置与密钥引用，目标设备需要单独配置对应凭据。

“文件访问”管理只读或项目读写范围；“执行权限”管理原生工具的批准方式。Codex 与 Claude Code 提供“请求批准”“自动判断”“完全访问”，Claude Code 另有“接受编辑”。配置按 Harness 的原生权限结构保存；待批准操作显示在 Host 和对应成员会话中，可允许一次或拒绝。只读任务继续使用其原有边界，已有资源保留原权限，其他 Harness 沿用各自现有的权限策略。

Pi 和 OpenCode 支持“最大输出 token 数”（`maxOutputTokens`，默认 8192）和“上下文 token 数”（`contextWindowTokens`，默认 131072）。采用协议转换的 API 连接也支持输出限制。ChatGPT 套餐连接采用服务自身的输出限制，自定义输出上限会被拒绝；上下文容量覆盖仍限 Pi 和 OpenCode。输入、推理和输出共享上下文容量，输出限制包含推理 tokens。达到长度限制的失败保留供恢复处理。

Pi 的 Chat Completions 支持提供方允许的 `minimal`、`low`、`medium`、`high`、`xhigh` 或 `max` 推理强度。经转换的 Responses 或 Chat Completions 连接按模型支持的取值设置推理强度，独立于 Harness；留空使用提供方默认。Pi 通过原生上下文加载器读取适用的项目指令，该入口不启用扩展代码。

<a id="work-and-results"></a>
## 工作与成果

向 Host 说明目标、相关文件和完成条件。成员负责明确的文件或目录范围，范围互不重叠的有界任务可以并行；文件工具写入前核对当前哈希。修改成果时接续原线程，保留要求、文件范围和尚未发布的候选内容。

Host 和成员先获得项目概况、当前分工与可检索的资料索引，再按任务读取定义、决定和原始消息。派工携带相关资料及其依赖，长文档和来源列表按版本分页读取。项目笔记保留原始来源，相关定义、任务或文件变化后提示重新核对。

上下文取材结合模型配置或实际回报的容量、最近一次原生调用用量和任务关联程度，为回复与工具结果留出空间，保留 Harness 的原生压缩能力，并在需要时从保存的项目资料重建会话。未知容量与用量采用明确标记的估算；原有固定消息条数、字节数和轮数限制不再控制 Host 取材与会话续接。

向成员提问前选择具体工作线程。只读追问查看已有工作，“继续修改”创建保留原验证要求的后续执行。修改相同文件前，先暂停或停止冲突工作，等待实际状态收束。

小范围可逆修改可以由生产者自检。需要独立接受时，明确另一个审查者及其针对提交版本执行的检查。文件审查可以直接比较提交内容；命令类验收当前需要支持原生检查的 Codex 审查者。审查指令变化后，审查者先读取新要求，再重新运行所需命令后验收。

每条验收条件记录所需的语义检查或命令执行证据。执行要求随工作接续和资源切换保留；每条执行条件必须引用当前审查轮次中针对提交版本和当前指令的成功命令事件。未分类条件由 Host 根据原要求确定证据类型后再完成验证，已有验收记录保留为历史。

采用讨论分支时，在该分支向 Host 明确决定和范围。Host 比较来源分支、分支起点与当前主线，更新选定的项目文档。在历史采纳节点中查看决定、来源、想法和文档差异；需要落实到代码时，另行提出实施要求。

进展消息与完成交付分别显示。即使没有完整工作区快照，保存的成果版本仍可下载。恢复文件版本会形成新的当前版本，操作前先解决活动写入、未提交本地修改或当前版本已变化等冲突。从历史创建工作区分支需要已保存的文件快照，外部动作保留各自状态。

右侧文件栏可以浏览项目文件、打开多个标签，预览 Markdown、图片、PDF、Word、Excel 和 PowerPoint，并编辑代码、文本及现代 Office 文件中的文本或单元格。预览支持适应宽度和缩放；未保存内容保留为本机草稿，保存前核对原文件版本。成员正在写入同一工作区时，先完成或停止该工作再保存。

历史中的手动记录点支持右键删除；原始历史和已有分支仍可追溯。成员会话与 Host 使用相同的 Harness、模型和 effort 选择方式，新选择用于后续执行。

可在成员卡片的右键菜单或对话窗口顶部删除空闲成员，也可让 Host 使用 `team_remove_member` 工具删除。已有对话、工作和成果保留在历史中；删除前须完成待处理的任务、验收、协作和消息。已删除成员不再接收新任务或消息。独立 Web 服务与桌面客户端使用同一份当前前端构建。

<a id="data-and-recovery"></a>
## 数据与恢复

团队、对话、工作、成果版本和项目历史保存在本机，项目文件留在你选择的目录。

成员等待消息时保存接续位置并结束当前回合，有新消息或依赖结果后恢复执行。空闲的 Codex 执行器会释放进程，下次任务从保存的原生会话继续。TeamSwarm 的 Codex 会话只加载分配的团队工具与原生能力。Windows 下，执行器及其子进程由独立进程组管理；关闭执行器或服务退出时一起回收。

并发执行同时受团队设置和可用内存约束。内存不足时，新任务排队，活动任务继续执行；资源恢复后自动派发。成员身份、历史和成果保留在本地。

| 平台 | 默认服务数据目录 |
|---|---|
| Windows | `%LOCALAPPDATA%\TeamSwarm\data` |
| macOS | `~/Library/Application Support/TeamSwarm/data` |
| Linux | `${XDG_DATA_HOME:-~/.local/share}/TeamSwarm/data` |

`TEAM_DATA_DIR` 可指定其他服务目录。窗口状态和未提交输入保存在 Electron 的 TeamSwarm 用户数据目录，Windows 上为 `%APPDATA%\TeamSwarm`。项目文件与未提交输入需要单独备份。

所选 Harness 会将提示和相关项目内容发送给配置的提供方，也可能保留自身原生会话记录。本地 API 监听 `127.0.0.1`，使用本机控制凭据；`control.json`、数据库和账号会话记录应保密。

Windows 保存的 Key 使用当前账号的 DPAPI。macOS 桌面版使用 Keychain 加密，Linux 桌面版要求受支持且已解锁的系统密钥环，并拒绝明文回退。macOS/Linux 的源码 Web 服务使用环境变量或启动密钥文件引用。更换设备或系统账号后重新连接凭据。

备份或恢复前关闭应用及服务。从源码目录执行：

```sh
node scripts/data-tools.mjs diagnostics --data-dir "/absolute/data-directory" --output "/absolute/diagnostics.json"
node scripts/data-tools.mjs backup --data-dir "/absolute/data-directory" --output "/absolute/new-backup-directory"
node scripts/data-tools.mjs restore --backup "/absolute/backup-directory" --data-dir "/absolute/new-data-directory"
```

将示例路径换成实际路径，有空格时保留引号。安装包在 `resources/product` 提供 Windows 的 `TeamSwarm-Tools.cmd` 和 macOS/Linux 的 `TeamSwarm-Tools.sh`，Mac 应用内路径为 `Contents/Resources/product`，命令参数相同。

诊断包含构建身份、记录数量、工作状态和 SQLite 完整性，省略对话正文、项目路径与凭据值。备份包含服务数据库、附件及服务所属配置和原生会话文件，应保存在私有位置。恢复校验文件哈希且要求新目录；将 `TEAM_DATA_DIR` 指向该目录，核对恢复后的团队再继续。结果不明的原生执行仍需恢复核对。

<a id="run-from-source"></a>
## 从源码运行

使用 Node.js 24，在仓库根目录运行：

```sh
npm ci
npm run build
npm start
```

启动器在 `http://127.0.0.1:4317` 打开已连接的浏览器工作空间。`TEAM_API_PORT` 指定其他端口，`TEAM_DATA_DIR` 指定独立工作空间，同一数据目录由一个服务管理。`npm run dev` 在 4318 启动 API，在 4317 启动 Vite。

构建后安装、检查指定 Harness：

```sh
npm run harness:install -- pi opencode
npm run harness:check -- pi opencode
```

本机安装需要可用的 Node/npm，且全局 npm 前缀位于项目和应用目录之外。省略 Harness ID 可检查所有登记工具；所选工具不可用时命令以非零退出码结束。

源码检查命令：

```sh
npm run check
npm run build
npm run test:smoke
```

这些检查使用本地夹具，不调用付费模型。在目标系统和架构运行 `npm run desktop:build` 构建桌面安装包，或用 `npm run desktop:unpacked` 生成未打包应用。Windows 安装器验证还需要 Python 3，源码路径宜较短；Linux 需要 Electron 桌面依赖、`tar` 和标准构建工具；macOS arm64 需要 Apple Silicon Mac。

构建覆盖相应的 `release/win32-x64`、`release/linux-x64` 或 `release/darwin-arm64` 输出目录。发布清单和包内清单记录源码与文件哈希。[config/desktop-runtime.json](https://github.com/DrPei12/teamswarm/blob/main/config/desktop-runtime.json) 固定运行时下载来源，内置 npm 归档的来源与完整性见 [vendor/npm-runtime.json](https://github.com/DrPei12/teamswarm/blob/main/vendor/npm-runtime.json)，用 `python -B scripts/rebuild-npm-runtime.py --check` 核对重建结果。

<a id="offline-audit"></a>
## 离线事件审计

可选 CLI 仅使用 Node.js 24 内置模块，无需联网即可分析导出的事件数组：

```sh
node tools/offline-audit/audit.mjs events.json
node tools/offline-audit/audit.mjs events.json --format markdown --team team-id
```

每条事件必须包含 `sequence,id,teamId,runId,workId,attemptId,type,data,createdAt`。sequence 是正整数，ID 和类型为字符串，run/work/attempt ID 允许显式 null；data 为非 null 对象，不能为数组。时间戳需要有效 ISO 日期、含秒时间和时区，额外字段保留。相同事件重放会去重，ID 冲突则失败；先验证并排序整个输入，再按团队筛选。

报告包含事件数、峰值占用工作数、最新终态、交流计数、暂停恢复配对和定义变化。等待与不明恢复状态继续计入占用，交流解决记录成员声明。未知事件类型单独列出。空数组或不存在的团队返回零指标；错误写入 stderr、退出码为 1，stdout 不输出部分结果。文件名以连字符开头时，在前面加 `--`。

<a id="troubleshooting"></a>
## 故障排查与反馈

| 现象 | 处理方式 |
|---|---|
| 未安装 Harness | 安装工具，检查本机 Node/npm 和全局前缀。 |
| 账号或 Key 不可用 | 重新连接账号，或配置资源所引用的确切环境变量。 |
| 模型、协议或提供方限制 | 核对双方支持的组合或账号额度，状态收束后继续。 |
| 需要恢复 | 核对原生执行结果，再重试可能产生文件冲突的工作。 |
| 桌面无法启动 | 查看诊断和端口；Windows 未打包应用可尝试较短路径。 |
| Linux 无法保存 Key | 解锁桌面密钥环，或在源码服务使用环境变量引用。 |
| 桌面提示浏览器服务占用工作空间 | 先停止该服务，再用同一数据目录打开桌面应用。 |

通过 [Issues](https://github.com/DrPei12/teamswarm/issues) 反馈可复现问题，附上版本、系统、Harness/模型、启动方式和脱敏诊断。漏洞使用可用的 **Security → Report a vulnerability** 入口；若未开放，在 issue 中请求私下联系渠道，不公开漏洞细节。反馈中排除凭据、私有对话与个人项目文件。

欢迎提交聚焦的 PR。针对行为变化运行相关检查，保留数据与执行恢复路径，维护两份 README 的一致性；界面变化检查中英文和相关窗口尺寸。提交供项目收录的贡献按 Apache-2.0 提供，并保留第三方署名。

<a id="license"></a>
## 许可

TeamSwarm 使用 [Apache-2.0](LICENSE)，允许商用、修改和再分发。第三方软件保留各自的许可证，详见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
