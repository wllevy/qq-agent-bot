# 使用指南

[返回首页](../README.md)

## 能力表

| 能力 | Codex | Claude Code |
| --- | --- | --- |
| 查看、搜索会话与历史 | 支持本机桌面会话及历史 | 支持 SDK 可读取的本机历史与 Bot 管理会话 |
| 新建空白会话 | 支持选择目录、同目录新建 | 支持，使用官方 Agent SDK |
| 继续已有会话 | 桌面拥有的会话经 IPC 提交；其他会话经辅助 app-server | Bot 管理会话直接续聊；其他历史先“恢复”为独立副本 |
| 控制桌面 App 中正在运行的会话 | 支持桌面 IPC 接入 | 不接管桌面 App 进程；独立 SDK 进程执行 |
| 权限确认与提问 | 审批仍需在 Codex 桌面处理 | 支持 QQ 批准、拒绝、回答；新会话可配置 YOLO |
| 本轮回复自动订阅 | QQ 发送任务后自动启用，送达后结束 | 同左 |
| 长期订阅 | 持续推送该会话后续结果，包括电脑端交互 | 持续推送可读取的该会话后续结果；原历史和恢复副本是不同会话 |
| 停止、队列、附件与成果文件 | 支持 | Bot 管理会话支持 |
| 模型与推理强度 | 按后端提供的选项设置 | 按后端提供的选项设置 |

Codex 桌面接入使用内部 IPC，最初验证版本为 **26.1021.3705.0**；桌面升级后可能需要适配。Claude 使用官方 Agent SDK，登录与 Claude 桌面 App 独立。恢复出的副本保留原历史，但与原会话共用项目文件。

## 配置

安装版默认目录如下，可用 `qq-agent-bot paths` 查看实际位置。`QQ_AGENT_HOME` 决定安装版配置和数据根目录，稳定启动命令会自动设置它。

```text
%LOCALAPPDATA%\QQAgentBot\
  bin\                  稳定命令入口
  versions\0.4.0\       程序与生产依赖
  config\.env           QQ 凭据与后端配置
  data\                 会话、订阅、附件、配对和日志
  current.json          当前程序版本
```

源码运行时不设置 `QQ_AGENT_HOME`，沿用项目目录 `.env` 和 `data/`，命令在项目根目录执行。两种运行方式使用相同后端与消息订阅逻辑。

重跑 `qq-agent-bot setup` 会保留已有值，不修改会话、订阅和已保存的 Claude 会话权限。Bot 正在运行时，先等任务结束再停止；单独新增配对无需停机。源码部署对应命令为 `npm run setup`。

### QQ 配对

setup 内可以直接配对，也可单独运行：

```powershell
qq-agent-bot pair
```

1. 本机终端显示一个有效期 5 分钟的配对码。
2. 用要授权的 QQ 私聊 Bot，发送 `配对 配对码`。
3. 回到本机终端，确认刚才的申请，输入 `y` 才会授权。

没有运行中的 Bot 时，pair 会临时连接 QQ，仅处理配对；已有 Bot 时由它接收申请。配对记录按 AppID 保存在 `data/pairing/`，运行中的 Bot 即时读取，无需重启。错误、过期或已使用的配对码不能授权；退出终端或拒绝申请不会添加授权。

```powershell
qq-agent-bot pair list
qq-agent-bot pair revoke <senderId>
```

也可在 `.env` 的 `QQBOT_ALLOWED_USERS` 中配置静态 senderId，逗号分隔。该 ID 是 Bot 收到的用户标识，不是 QQ 号码。静态授权和配对授权取并集；两者都为空时拒绝所有控制消息。撤销配对不会移除静态授权，也不会停止已提交任务或取消结果订阅。

### Claude 登录与权限

使用 Bot 所在 Windows 用户完成 SDK 登录，安装版运行：

```powershell
qq-agent-bot claude-login
```

此命令调用 SDK 依赖自带的 CLI，无需额外全局安装 Claude CLI。打开命令给出的浏览器链接授权；远程终端可使用浏览器返回的授权码。源码部署可运行 `npm run cli -- claude-login`。已有 `ANTHROPIC_BASE_URL`、`ANTHROPIC_AUTH_TOKEN` 或 API key 会影响认证来源，需与预期账户一致。

`CLAUDE_PERMISSION_MODE=default` 使用权限确认；`bypassPermissions` 为 YOLO，允许免确认执行工具。此配置用于新会话及恢复副本，已有 Bot 会话续聊保留保存时的权限模式；问题澄清仍通过 QQ 回答。

### 启动与诊断

```powershell
qq-agent-bot doctor
qq-agent-bot start
```

`doctor` 检查后端历史读取、Claude CLI 登录状态和 QQ 鉴权，不调用模型、不发送聊天。`doctor --json` 返回机器可读状态；`service status --json` 的 `online` 才表示后台 QQ 连接已就绪。启动运行构建后的 JavaScript，不需要 tsx 或 TypeScript 开发依赖。

手动配置可从 `.env.example` 复制为 `.env`。`CODEX_ENABLED=false` 或 `CLAUDE_ENABLED=false` 可关闭对应后端；至少启用一个。

## QQ 命令

| 命令 | 功能 |
| --- | --- |
| 会话 / Codex / Claude | 选择后端和会话 |
| 搜索会话 [后端] 关键词 | 筛选最近 100 个会话的标题、目录，翻页保留条件 |
| 当前 / 最新 | 查看进度和最近对答 |
| 操作 / 设置 | 文件、订阅、队列、停止，以及模型和推理强度 |
| 历史 | 每页两轮，点击更早对答继续翻阅 |
| 新会话 | 在当前会话的同目录或其他目录创建 |
| 新会话 local C:/Projects/demo | 在已有目录直接创建 Codex 空白会话 |
| 同目录新建 | 沿用项目目录、模型和推理强度，不复制上下文 |
| 恢复 | 将选中的 Claude 历史复制为 Bot 管理的新会话 |
| 订阅 | 分页查看本轮与长期订阅，逐条取消 |
| 长期订阅 / 取消订阅 | 持续推送 / 取消该会话的所有消息订阅 |
| 队列 | 查看等待原因，按条移除待发或待确认记录 |
| 停止 / 清空队列 | 中断当前轮并清空队列 / 仅清空队列 |
| 文件 / 文件 路径 | 查看成果附件，或获取指定路径的文件 |
| 批准 / 拒绝 / 回答 内容 | 处理 Claude 确认和提问，多题用竖线分隔 |

普通文字发往当前会话；引用 Bot 的会话消息则发往对应会话。历史消息按钮绑定其原会话。`发送 内容` 可发送与命令同名的文字。

### 消息订阅规则

- 选择会话只改变发送目标，不产生订阅。
- 从 QQ 提交的每项任务自动订阅对应回复，完整送达后结束。切换会话、投递重试和重启均保留待收回复。
- 长期订阅持续接收该会话后续结果，包括电脑端交互产生的结果。
- 订阅列表每页 6 条，每条都有取消按钮；操作页也可取消仅本轮的订阅。
- 取消订阅保留当前选择和执行、排队中的任务，移除待推送通知；已经交给 QQ 的消息无法撤回。之后再次从 QQ 发送任务，会创建新的本轮订阅。

附件上限 20 MiB，绑定接收时的会话；单独附件等待下一条任务，带文字附件作为同一项任务。最终回答中的文件可通过按钮取回。历史、附件和缓存保存在本机，不自动清理。

## Windows 后台运行与更新

```powershell
qq-agent-bot service start
qq-agent-bot service status
qq-agent-bot service stop
qq-agent-bot service restart
qq-agent-bot service enable
qq-agent-bot service disable
```

`enable` 设置当前用户登录启动并立即启动，`disable` 仅取消登录启动。后台运行编译后的程序，日志在 `data/bot.log` 和 `data/bot-error.log`。

安装版更新：先等待 Bot 管理的任务结束，再停止、下载并运行安装器。`-SkipSetup` 保留现有配置，安装完成后诊断并启动：

```powershell
qq-agent-bot service stop
$Installer = Join-Path $env:TEMP 'qq-agent-bot-install.ps1'
Invoke-WebRequest -UseBasicParsing https://github.com/wllevy/qq-agent-bot/releases/latest/download/install.ps1 -OutFile $Installer
& $Installer -SkipSetup
qq-agent-bot doctor
qq-agent-bot service start
```

下载和依赖安装成功后才切换程序版本。配置与数据独立保存，旧版本保留；已启用的登录启动任务通过稳定入口读取新版本。`-Version vX.Y.Z` 可选择版本，其他安装参数见 [Agent 安装指南](agent-install.md)。

重启会中断 Bot 运行的 Claude 和辅助 app-server 任务。源码更新使用 `npm run service -- stop`、`npm ci`、`npm run build`、`npm run service -- start`。

### 从源码部署迁移

安装器用 `-SkipSetup` 安装程序。等待旧 Bot 任务完成，在旧项目目录执行 `npm run service -- disable` 和 `npm run service -- stop`，然后在新终端执行：

```powershell
qq-agent-bot migrate --from 'C:\path\to\old-bot' --json
qq-agent-bot doctor
qq-agent-bot service enable
```

迁移复制 v4 会话、订阅、Claude 权限、附件和配对记录，保留原目录。新安装必须尚未配置：已有 `config` 或 `data` 时拒绝覆盖，所以迁移要在首次 setup、doctor 或 pair **之前**执行。同一 QQ AppID 的旧实例应保持停止；不要同时启动新旧部署。

## 当前边界

- Windows 以外的平台尚未验证。
- 轮询最近 20 轮检测完成，停机过久可能漏过更早结果；QQ 确认丢失后重试可能重复送达。
- 状态格式为 v4，仅使用消息订阅机制；历史 v1–v3 部署需单独迁移，本版不隐式兼容。
- 进阶多机可用 `machines.json` 配置 `[{"id":"server","endpoint":"ws://127.0.0.1:PORT"}]`。存在该文件时，它决定后端列表，setup 保留配置；连接由部署者维护，不要把未认证的 app-server 暴露到公网。
