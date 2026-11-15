# Agent 安装与配置

目标：在当前系统用户下安装 QQ Agent Bot，配置 QQ 凭据及至少一个本机后端，确认 QQ 上线并完成用户配对。不要把安装完成报告为已经可用。

## 安装

先判断平台和 Node.js 版本。已有 Node.js 24+ 时，三个平台优先使用 npm：

```bash
npm install -g qq-agent-bot
qq-agent-bot version
qq-agent-bot paths
```

npm 包提供 `qq-agent-bot` 命令并自动选择固定用户数据目录，可以从任意工作目录调用。`npx qq-agent-bot ...` 适合临时查看帮助、路径或诊断；后台服务使用永久 npm 安装，不能绑定 npx 缓存目录。

没有 Node.js 24+ 或全局 npm 目录没有写权限时，使用一键安装器：它准备私有 Node.js，并用 `<QQ_AGENT_HOME>/npm` 作为 npm prefix 安装同一个包，不需要管理员权限。下文 PowerShell 示例用于 Windows。Linux/macOS 使用 Bash 安装器，参数见[平台说明](usage.md#平台支持)；macOS 尚未实机测试，报告中保留这一状态。

```bash
curl -fL https://github.com/wllevy/qq-agent-bot/releases/latest/download/install.sh -o /tmp/qq-agent-bot-install.sh
bash /tmp/qq-agent-bot-install.sh --skip-setup
```

Unix 默认命令为 `~/.local/bin/qq-agent-bot`，或 `<安装目录>/bin/qq-agent-bot`。下文 `& $Bot ...` 在 Bash 中替换为 `"$bot" ...`；配置 JSON 字段、诊断状态、配对步骤不变。Unix 的 Codex 使用已登录 CLI 或已有 app-server，未实现 Windows 桌面 IPC。Linux 可用 `service enable` 设置 systemd 用户服务；macOS 暂不支持登录自启动，使用 `service start`。

Windows 一键安装需要 PowerShell 5.1+，以及能访问 GitHub、npm 和 QQ。它复用 Node.js 24+；没有时下载私有 Node.js。

```powershell
$Installer = Join-Path $env:TEMP 'qq-agent-bot-install.ps1'
Invoke-WebRequest -UseBasicParsing https://github.com/wllevy/qq-agent-bot/releases/latest/download/install.ps1 -OutFile $Installer
& $Installer -SkipSetup
```

Windows 默认用户目录 `%LOCALAPPDATA%\QQAgentBot`。可用 `-InstallHome <绝对路径>` 改位置；`-Version vX.Y.Z` 固定 npm 版本；`-NoPath` 不修改用户 PATH；`-PackagePath <本地 npm .tgz>` 使用本地包。`-Offline` 还要求已存在 Node.js 24+ 和完整 npm 缓存。`install.ps1` 与 `npm-install.mjs` 应放在同一目录，在线运行时会自动下载辅助脚本。

直接 npm 安装使用 npm 的全局命令；一键安装后当前终端尚未刷新 PATH 时，使用完整路径调用：

```powershell
$Bot = Join-Path $env:LOCALAPPDATA 'QQAgentBot/bin/qq-agent-bot.cmd'
& $Bot version
& $Bot paths
```

## 已有部署

先确认是否已有 Bot 使用同一 QQ AppID，确定本次是新部署还是迁移。相同 AppID 的旧实例应在切换前停止。不要自动关闭用户正在执行的任务。

迁移必须在新安装首次 setup、doctor、pair 之前执行；目标中已有 `config` 或 `data` 时拒绝覆盖。等待旧任务完成，在旧源码目录执行 `npm run service -- disable`、`npm run service -- stop`，随后：

```powershell
& $Bot migrate --from 'C:\path\to\old-bot' --json
```

只支持当前 v4 消息订阅格式。复制配置、配对、会话、Claude 权限和订阅，转换附件缓存路径，保留原目录。迁移不复制系统用户的 Codex/Claude 登录；应使用同一系统账户。失败时停止后续步骤，报告具体原因，不能通过覆盖目标绕过检查。

## 配置与登录

QQ AppID/AppSecret 由用户在 QQ 开放平台取得。优先让用户在本机运行 `setup` 隐藏输入 AppSecret；不要要求用户把秘密粘贴进聊天，也不要通过命令行参数传秘密。用户已提供本地配置文件时可使用：

```powershell
& $Bot setup --non-interactive --config-file 'C:\private\qq-settings.json' --json
```

JSON 对象各值均为字符串，最小示例（占位内容不能直接使用）：

```json
{
  "QQBOT_APP_ID": "<数字 AppID>",
  "QQBOT_APP_SECRET": "<本地填写的 AppSecret>",
  "CODEX_ENABLED": "true",
  "CLAUDE_ENABLED": "true",
  "CLAUDE_PERMISSION_MODE": "default"
}
```

允许的其他字段：`QQBOT_ALLOWED_USERS`、`CODEX_SOCKET`、`CODEX_EXECUTABLE`、`CLAUDE_DEFAULT_CWD`、`CLAUDE_EXECUTABLE`、`BOT_POLL_MS`、`QQBOT_KEYBOARDS`。未提供的字段保留原值；不能经此接口移动数据目录。返回 `configured` 只表示配置保存成功；不会登录、启动或授权。不要输出文件内容，完成后提醒用户妥善处理配置输入文件。

Codex 使用已登录的本机桌面应用。Claude 使用 Bot 依赖自带的 CLI，在同一系统用户下运行 `qq-agent-bot claude-login`，由用户完成浏览器授权。登录与 Claude 桌面 App 独立。不要替用户选择第三方 API 服务、改写全局认证或获取 OAuth 凭据。已有 YOLO 设置应保留；新安装使用 `default`，只有用户明确要求免确认时才设为 `bypassPermissions`。

## 诊断、启动与配对

```powershell
& $Bot doctor --json
```

`doctor` 不调用模型或发送聊天。stdout 是 JSON；stderr 可含脱敏诊断日志。

| status | 下一步 |
| --- | --- |
| `needs_credentials` | 补全 QQ 配置 |
| `needs_login` | 用户完成 Claude SDK 登录后重试 |
| `needs_pairing` | 后端及 QQ 检查通过，但尚无控制授权；继续启动及配对 |
| `error` | 根据 checks 修复后端或网络；不要宣称成功 |
| `ready` | 诊断通过；仍需检查实际后台连接 |

退出码：`ready` 为 0，`needs_pairing` 为 2，其余为 1。检查每个 check，可能同时存在多个问题。

```powershell
& $Bot service start --json
& $Bot service status --json
& $Bot pair start --json
```

service 状态为 `starting` 时隔几秒再次查询，最多等 30 秒；`online` 才表示 QQ 已连接。`disconnected`、`stopped` 或长期 `starting` 需查看 `paths` 返回的数据目录内 `bot-error.log`，向用户仅报告脱敏摘要。不要无限重启。

`pair start` 返回 `requestId`、`code` 和过期时间，要求用户私聊自己的 Bot 发送 `配对 <code>`。返回 `needs_service` 时先处理启动。接着调用：

```powershell
& $Bot pair status --json
```

出现 `needs_confirmation` 时展示 `senderId`，让用户确认是自己刚才使用的 QQ。只有收到确认后才执行：

```powershell
& $Bot pair approve '<requestId>' --user '<已确认的 senderId>' --json
```

用户拒绝或要求取消时执行 `pair cancel <requestId> --json`；过期后重新开始。不要自动批准第一个申请。已有明确静态授权或配对授权时无需重复配对。

最后用 `doctor --json` 确认 `ready`，`service status --json` 确认 `online`，请用户发送“会话”验证 QQ 交互。需要登录后自动运行时使用 `service enable`；其含义是当前用户登录启动，不是未登录系统服务。未经用户要求，不调用模型测试、修改全局 QQ 菜单或启动示例任务。

## 更新

等任务完成后先运行 `service stop`。直接 npm 安装使用 `npm install -g qq-agent-bot@latest` 更新同一全局目录；一键安装继续执行安装器 `-SkipSetup`，更新其独立 npm prefix。配置在 `config`，运行数据在 `data`，不放进 npm 包目录。直接运行 npm 升级前应先停止 Bot；一键安装器还会检查运行状态并拒绝带任务更新。

更新后执行诊断，再 `service start`。切换 npm prefix 或 Node.js 安装时，用新命令执行 `service enable` 更新稳定启动目标。稳定入口读取 `current.json`，npm 管理程序版本；既有 Release 安装原地升级时会接续原配置和数据，旧程序目录保留。`service disable` 取消登录启动，`service stop` 停止后台，两者独立。
