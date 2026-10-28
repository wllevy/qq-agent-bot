import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { parse } from 'dotenv';
import { configuration, errorText } from './config.js';
import { ask, confirm } from './prompt.js';
import { botRunning, runPairing } from './pair.js';
import { readEnvFile, saveEnvFile, updateEnv } from './setup-config.js';

async function runNode(relative: string) {
  const path = fileURLToPath(new URL(relative, import.meta.url));
  return new Promise<boolean>((resolve, reject) => {
    const child = spawn(process.execPath, [path], { stdio: 'inherit', windowsHide: true });
    child.on('error', reject); child.on('exit', code => resolve(code === 0));
  });
}

async function setup() {
  if (process.argv.includes('--help')) {
    console.log('npm run setup：在本机交互配置 QQ 凭据和后端、检查连接、配对 QQ，并可设置登录启动。\n已有配置按回车保留，AppSecret 不回显。运行中的 Bot 请先等待任务完成再停止；仅新增授权可使用 npm run pair。'); return;
  }
  if (!process.stdin.isTTY) throw new Error('请在 PowerShell 等交互终端中运行 npm run setup');
  const path = resolve('.env'), source = readEnvFile(path);
  if (botRunning(resolve(process.env.BOT_DATA_DIR || 'data'))) throw new Error('Bot 正在运行。请等待任务完成后 npm run service -- stop，再运行 setup；仅配对请用 npm run pair');
  const previous = { ...parse(source), ...process.env };
  const updates: Record<string, string> = {};
  console.log('QQ 编程助手配置。回车保留已有值；配置保存在当前目录 .env。');
  console.log('在 QQ 开放平台 https://q.qq.com/ 创建支持私聊的机器人，准备 AppID 和 AppSecret。');
  const currentAppId = previous.QQBOT_APP_ID || previous.AppID || previous.APPID;
  const appId = await ask(`QQ AppID${currentAppId ? '（回车保留）' : ''}：`) || currentAppId;
  if (!appId || !/^\d+$/.test(appId)) throw new Error('AppID 应为数字');
  const currentSecret = !currentAppId || currentAppId === appId ? previous.QQBOT_APP_SECRET || previous.AppSecret || previous.APPSECRET : undefined;
  const appSecret = await ask(`QQ AppSecret（输入不回显${currentSecret ? '，回车保留' : ''}）：`, { secret: true }) || currentSecret;
  if (!appSecret) throw new Error('AppSecret 不能为空');
  updates.QQBOT_APP_ID = appId; updates.QQBOT_APP_SECRET = appSecret;
  // A different QQ application has different sender IDs; do not reuse its static grants.
  if (currentAppId && appId !== currentAppId) updates.QQBOT_ALLOWED_USERS = '';
  const customMachines = existsSync(resolve(previous.BOT_MACHINES_FILE || 'machines.json'));
  if (customMachines) console.log('检测到 machines.json，将保留其中的后端配置。');
  else {
    const current = previous.CODEX_ENABLED === 'false' ? '3' : previous.CLAUDE_ENABLED === 'false' ? '2' : '1';
    const choice = await ask(`启用后端：1 Codex + Claude，2 仅 Codex，3 仅 Claude [${current}]：`) || current;
    if (!['1', '2', '3'].includes(choice)) throw new Error('请选择 1、2 或 3');
    updates.CODEX_ENABLED = String(choice !== '3'); updates.CLAUDE_ENABLED = String(choice !== '2');
  }
  if ((updates.CLAUDE_ENABLED || previous.CLAUDE_ENABLED) !== 'false') {
    const mode = previous.CLAUDE_PERMISSION_MODE || 'default';
    const selected = await ask(`Claude 新会话权限：default（QQ 确认）或 bypassPermissions（YOLO，免工具确认）[${mode}]：`) || mode;
    if (!['default', 'bypassPermissions'].includes(selected)) throw new Error('请选择 default 或 bypassPermissions');
    updates.CLAUDE_PERMISSION_MODE = selected;
    console.log('Claude SDK 使用 Bot 所在系统用户的登录。桌面 App 登录独立，登录命令见 README。');
    if (previous.ANTHROPIC_BASE_URL || previous.ANTHROPIC_AUTH_TOKEN || previous.ANTHROPIC_API_KEY) console.log('检测到 ANTHROPIC_* 认证或地址配置，请确认是预期账户来源；不会显示或修改凭据。');
  }
  const template = source || readFileSync(new URL('../../.env.example', import.meta.url), 'utf8');
  const next = updateEnv(template, updates);
  saveEnvFile(path, source, next);
  // The config module loaded before the wizard. Apply saved settings for this process
  // and its doctor child without changing unrelated inherited authentication variables.
  Object.assign(process.env, parse(next));
  console.log('配置已保存。已有会话、订阅和 Claude 会话权限未变。');
  if (await confirm('现在运行 doctor 检查后端读取及 QQ 鉴权？')) await runNode('./doctor.js');
  if (await confirm('现在配对你的 QQ？')) await runPairing(configuration());
  if (process.platform === 'win32' && await confirm('设置当前 Windows 用户登录后自动启动 Bot，并立即启动？')) {
    const script = fileURLToPath(new URL('../../scripts/windows-service.ps1', import.meta.url));
    await new Promise<void>((resolve, reject) => {
      const child = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, 'enable'], { stdio: 'inherit', windowsHide: true });
      child.on('error', reject); child.on('exit', code => code === 0 ? resolve() : reject(new Error('后台服务设置失败')));
    });
  } else console.log('配置完成。前台运行：npm start；Windows 后台：npm run service -- start。');
}

await setup().catch(error => { console.error(errorText(error)); process.exitCode = 1; });
