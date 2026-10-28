# QQ Agent Bot · QQ 编程助手

[![Check](https://github.com/wllevy/qq-agent-bot/actions/workflows/check.yml/badge.svg)](https://github.com/wllevy/qq-agent-bot/actions/workflows/check.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
![Node.js 24+](https://img.shields.io/badge/Node.js-24%2B-339933)
![Windows](https://img.shields.io/badge/platform-Windows-0078D4)

**在 QQ 私聊中继续电脑上的编程任务，完成后接收回复和文件。**

QQ Agent Bot 将本机 Codex 和 Claude Code 接入 QQ：浏览与创建会话、提交任务、处理 Claude 确认，并把模型的最终回答推送到手机。适合在离开电脑后继续跟进任务。

[快速开始](#快速开始) · [使用示例](#使用示例) · [能力表](#能力表) · [配置](#配置) · [QQ 命令](#qq-命令) · [开发](#开发与验证)

## 主要功能

- **会话管理**：按标题或目录搜索历史，切换会话，在同一项目创建新任务。
- **回复订阅**：QQ 提交的任务自动订阅本轮回复；长期订阅持续接收该会话后续结果。
- **手机端操作**：查看进度、停止任务、管理队列、收发文件；Claude 确认和提问可在 QQ 中处理。
- **本机部署**：运行数据保存在自己的电脑，提供配对向导和 Windows 登录启动，无需自行部署中转服务器。

目前支持 **Windows、Node.js 24+、QQ 官方机器人私聊**。电脑需要保持开机联网；聊天消息经过 QQ 平台，模型请求使用相应后端的账户与服务。

## 快速开始

### 1. 准备账户与环境

- 安装 Node.js 24+ 和 Git。
- 在 [QQ 开放平台](https://q.qq.com/) 创建支持私聊的机器人，准备 AppID / AppSecret。菜单、Markdown 和文件能力取决于平台授予的权限。
- 按需准备 Codex 或 Claude，至少启用一个后端。Codex 使用已登录的桌面应用；Claude 需要在安装依赖后完成 [SDK 登录](#claude-登录与权限)。

### 2. 安装并配置

```powershell
git clone https://github.com/wllevy/qq-agent-bot.git
cd qq-agent-bot
npm ci
npm run build
npm run setup
```

向导会引导填写 QQ 凭据、选择后端和 Claude 权限模式，并提供诊断、QQ 配对及后台启动选项。AppSecret 不回显；已有配置可以按回车保留。

配对时，在 QQ 私聊中发送终端显示的配对码，再回到电脑确认申请。完整流程见 [QQ 配对](#qq-配对)。

### 3. 启动并发送第一条消息

如果没有在向导中启用后台启动，运行：

```powershell
npm start
```

在 QQ 私聊中发送 **会话**，选择一个会话后即可发任务。需要底部菜单和指令面板时，运行一次 `npm run menus`。

遇到连接问题，运行 `npm run doctor`。它检查后端读取、Claude 登录状态和 QQ 鉴权，不调用模型、不发送聊天。

## 使用示例

下面是一条典型操作路径，省略了 Bot 的菜单和回复：

```text
会话                     → 选择后端和已有会话
检查刚才的改动并运行测试   → 提交任务，自动订阅本轮回复
当前                     → 查看进度
文件                     → 查看可取回的成果文件
长期订阅                 → 持续接收该会话之后的结果
订阅                     → 查看订阅列表，按条取消
```

也可以发送 `新会话 local C:/Projects/demo`，在已有目录创建 Codex 空白会话。从 QQ 提交任务后，即使切换到其他会话，原任务的结果仍会送达。

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

配置保存在项目目录 `.env`，运行数据默认在 `data/`。运行命令时请位于项目根目录；更新程序时保留这两处。

重跑 `npm run setup` 会保留已有值，不修改会话、订阅和已保存的 Claude 会话权限。Bot 正在运行时，先等任务结束再停止；单独新增配对无需停机。

### QQ 配对

setup 内可以直接配对，也可单独运行：

```powershell
npm run pair
```

1. 本机终端显示一个有效期 5 分钟的配对码。
2. 用要授权的 QQ 私聊 Bot，发送 `配对 配对码`。
3. 回到本机终端，确认刚才的申请，输入 `y` 才会授权。

没有运行中的 Bot 时，pair 会临时连接 QQ，仅处理配对；已有 Bot 时由它接收申请。配对记录按 AppID 保存在 `data/pairing/`，运行中的 Bot 即时读取，无需重启。错误、过期或已使用的配对码不能授权；退出终端或拒绝申请不会添加授权。

```powershell
npm run pair -- list
npm run pair -- revoke <senderId>
```

也可在 `.env` 的 `QQBOT_ALLOWED_USERS` 中配置静态 senderId，逗号分隔。该 ID 是 Bot 收到的用户标识，不是 QQ 号码。静态授权和配对授权取并集；两者都为空时拒绝所有控制消息。撤销配对不会移除静态授权，也不会停止已提交任务或取消结果订阅。

### Claude 登录与权限

使用 Bot 所在 Windows 用户完成 SDK 登录。Windows x64 默认命令：

```powershell
& ".\node_modules\@anthropic-ai\claude-agent-sdk-win32-x64\claude.exe" auth login --claudeai
```

打开命令给出的浏览器链接授权；远程终端可使用浏览器返回的授权码。其他架构使用匹配的 CLI。已有 `ANTHROPIC_BASE_URL`、`ANTHROPIC_AUTH_TOKEN` 或 API key 会影响认证来源，需与预期账户一致。

`CLAUDE_PERMISSION_MODE=default` 使用权限确认；`bypassPermissions` 为 YOLO，允许免确认执行工具。此配置用于新会话及恢复副本，已有 Bot 会话续聊保留保存时的权限模式；问题澄清仍通过 QQ 回答。

### 启动与诊断

```powershell
npm run doctor
npm start
```

`doctor` 检查后端历史读取、Claude CLI 登录状态和 QQ 鉴权，不调用模型、不发送聊天。`npm start` 运行构建后的 JavaScript，不需要 tsx 或 TypeScript 开发依赖。`npm run menus` 可设置此机器人的全局私聊菜单与指令面板。

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
npm run service -- start
npm run service -- status
npm run service -- stop
npm run service -- restart
npm run service -- enable
npm run service -- disable
```

`enable` 设置当前用户登录启动并立即启动，`disable` 仅取消登录启动。后台运行编译后的程序，日志在 `data/bot.log` 和 `data/bot-error.log`。

更新源码后，先等待 Bot 管理的任务结束，再停止、安装依赖、构建并启动：

```powershell
npm run service -- stop
npm ci
npm run build
npm run service -- start
```

重启会中断 Bot 运行的 Claude 和辅助 app-server 任务。代码更新需要重新构建；配置和运行数据不要覆盖。

## 工作方式

```text
QQ 私聊
  └─ Bot：授权、消息路由、任务队列、回复订阅与文件传输
       ├─ Codex：桌面 IPC / 本机 app-server
       └─ Claude Code：官方 Agent SDK 独立进程
```

Codex 与 Claude 的接入和会话执行由各自适配器负责；QQ 侧统一处理选择、订阅与投递。每个任务和结果都绑定会话，引用历史消息可向原会话继续发送要求。

## 开发与验证

```powershell
npm run dev          # 通过 tsx 运行源码
npm run check        # 类型检查
npm test             # 不调用模型的行为测试
npm run build        # 输出 dist/src 与 dist/scripts
npm run smoke        # 实际 Codex 自检
npm run smoke:claude # 实际 Claude 自检
```

两个 smoke 命令会创建独立自检会话并使用账户额度。Windows CI 执行类型检查、测试、构建及配置命令帮助入口检查。

导出可分享的源码：

```powershell
npm run export:source
```

默认导出到 `release/qqbot-source`，仅包含明确列出的源码、测试、示例配置、构建配置与许可证；不复制凭据、运行数据、配对记录、日志、备份、依赖或构建产物。目的目录存在时拒绝覆盖，可用 `npm run export:source -- release/other-name` 指定新目录。导出不会创建 GitHub 仓库或上传文件。

## 当前边界

- Windows 以外的平台尚未验证。
- 轮询最近 20 轮检测完成，停机过久可能漏过更早结果；QQ 确认丢失后重试可能重复送达。
- 状态格式为 v4，仅使用消息订阅机制；历史 v1–v3 部署需单独迁移，本版不隐式兼容。
- 进阶多机可用 `machines.json` 配置 `[{"id":"server","endpoint":"ws://127.0.0.1:PORT"}]`。存在该文件时，它决定后端列表，setup 保留配置；连接由部署者维护，不要把未认证的 app-server 暴露到公网。

## 许可证

本项目使用 [MIT License](LICENSE)。第三方依赖遵循各自许可证及服务条款。部署权限和凭据说明见 [SECURITY.md](SECURITY.md)。

