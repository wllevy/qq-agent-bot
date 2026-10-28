import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { parse } from 'dotenv';
import { configuration, errorText } from './config.js';
import { ask, confirm } from './prompt.js';
import { botRunning, runPairing } from './pair.js';
import { readEnvFile, saveEnvFile, updateEnv, validateSettings } from './setup-config.js';
import { runtimePaths } from './paths.js';
import { argumentsFor } from './arguments.js';
import { diagnose } from './doctor.js';

async function setup() {
  const { options, positional } = argumentsFor(process.argv.slice(2), ['--help', '--non-interactive', '--json'], ['--config-file']);
  if (positional.length) throw new Error('setup 不接受位置参数');
  if (options['--help']) {
    console.log('setup：交互配置；setup --non-interactive --config-file <本地 JSON> --json：校验并保存配置，不启动、不登录、不自动授权。\n已有配置按回车保留，AppSecret 不回显。运行中的 Bot 请先等待任务完成再停止；仅新增授权可使用 pair。'); return;
  }
  if (!options['--non-interactive'] && !process.stdin.isTTY) throw new Error('请在交互终端运行 setup，或使用 --non-interactive --config-file');
  const paths = runtimePaths(), path = paths.configFile, source = readEnvFile(path);
  if (botRunning(paths.dataDir)) throw new Error('Bot 正在运行。请等待任务完成后停止，再运行 setup；仅配对请用 pair');
  if (options['--non-interactive']) {
    if (!options['--config-file']) throw new Error('非交互配置需要 --config-file <本地 JSON>');
    const previous = parse(source);
    const updates = validateSettings(JSON.parse(readFileSync(resolve(String(options['--config-file'])), 'utf8')), previous);
    const template = source || readFileSync(new URL('../../.env.example', import.meta.url), 'utf8');
    saveEnvFile(path, source, updateEnv(template, updates));
    console.log(options['--json'] ? JSON.stringify({ status: 'configured', configFile: path, next: 'doctor --json' }) : '配置已保存；请运行 doctor 检查登录与连接，再启动及配对。');
    return;
  }
  if (options['--json'] || options['--config-file']) throw new Error('--json 和 --config-file 需配合 --non-interactive');
  const previous = { ...parse(source), ...process.env };
  const updates: Record<string, string> = {};
  console.log(`QQ 编程助手配置。回车保留已有值；配置文件：${path}`);
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
  const customMachines = existsSync(paths.machinesFile);
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
  const next = updateEnv(template, validateSettings(updates, parse(source)));
  saveEnvFile(path, source, next);
  // The config module loaded before the wizard. Apply saved settings for this process
  // and its doctor child without changing unrelated inherited authentication variables.
  Object.assign(process.env, parse(next));
  console.log('配置已保存。已有会话、订阅和 Claude 会话权限未变。');
  const report = await diagnose();
  for (const check of report.checks) console.log(`${check.ok ? 'OK' : '待处理'} ${check.name}：${check.message}`);
  if (!['ready', 'needs_pairing'].includes(report.status)) { console.log('配置已保存，但尚不可用。完成上述登录或连接修复后重新运行 setup。'); process.exitCode = 1; return; }
  if (await confirm('现在配对你的 QQ？')) await runPairing(configuration());
  if (process.platform === 'win32' && await confirm('设置当前 Windows 用户登录后自动启动 Bot，并立即启动？')) {
    const script = fileURLToPath(new URL('./cli.js', import.meta.url));
    await new Promise<void>((resolve, reject) => {
      const child = spawn(process.execPath, [script, 'service', 'enable'], { stdio: 'inherit', windowsHide: true });
      child.on('error', reject); child.on('exit', code => code === 0 ? resolve() : reject(new Error('后台服务设置失败')));
    });
  } else console.log(paths.home ? '配置已保存。前台运行：qq-agent-bot start；后台：qq-agent-bot service start。' : '配置已保存。前台运行：npm start；Windows 后台：npm run service -- start。');
}

await setup().catch(error => { if (process.argv.includes('--json')) console.log(JSON.stringify({ status: 'error', message: error instanceof SyntaxError ? '配置文件不是有效的 JSON' : errorText(error) })); else console.error(errorText(error)); process.exitCode = 1; });
