# 开发指南

[返回首页](../README.md)

## 工作方式

```text
QQ 私聊
  └─ Bot：授权、消息路由、任务队列、回复订阅与文件传输
       ├─ Codex：桌面 IPC / 本机 app-server
       └─ Claude Code：官方 Agent SDK 独立进程
```

Codex 与 Claude 的接入和会话执行由各自适配器负责；QQ 侧统一处理选择、订阅与投递。每个任务和结果都绑定会话，引用历史消息可向原会话继续发送要求。

## 开发与验证

源码安装要求 Git 和 Node.js 24+：

```powershell
git clone https://github.com/wllevy/qq-agent-bot.git
cd qq-agent-bot
npm ci
npm run build
npm run setup
```

```powershell
npm run dev          # 通过 tsx 运行源码
npm run check        # 类型检查
npm test             # 不调用模型的行为测试
npm run build        # 输出 dist/src 与 dist/scripts
npm run cli -- --help # 统一命令入口
npm run package:release # 将编译产物和运行文件打包到 release/package
npm run smoke        # 实际 Codex 自检
npm run smoke:claude # 实际 Claude 自检
```

两个模型 smoke 命令会创建独立自检会话并使用账户额度。Windows CI 执行类型检查、测试、构建；发布工作流额外用隔离目录测试生产依赖安装、JSON 配置和保留数据的版本更新，不登录 QQ、不调用模型。推送与 package.json 版本一致的 `vX.Y.Z` 标签后，工作流生成发布 ZIP 和安装脚本。

导出可分享的源码：

```powershell
npm run export:source
```

默认导出到 `release/qqbot-source`，仅包含明确列出的源码、测试、示例配置、构建配置与许可证；不复制凭据、运行数据、配对记录、日志、备份、依赖或构建产物。目的目录存在时拒绝覆盖，可用 `npm run export:source -- release/other-name` 指定新目录。导出不会创建 GitHub 仓库或上传文件。
