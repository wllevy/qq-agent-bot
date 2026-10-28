import { spawn, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, openSync, closeSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { runtimePaths } from './paths.js';
import { errorText } from './config.js';

const root = fileURLToPath(new URL('../../', import.meta.url));
const supervisor = join(root, 'scripts/supervisor.mjs');
const paths = runtimePaths(), data = paths.dataDir;
const args = process.argv.slice(3), action = args[0] || 'status';
const unitFile = join(homedir(), '.config/systemd/user/qq-agent-bot.service');
const launcher = paths.home ? join(paths.home, 'bin/launcher.mjs') : join(root, 'dist/src/cli.js');
const systemctl = (...args: string[]) => execFileSync('systemctl', ['--user', ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
function registered() {
  if (!existsSync(unitFile)) return false;
  if (!readFileSync(unitFile, 'utf8').includes(launcher)) throw new Error('qq-agent-bot.service 属于另一个安装目录');
  return true;
}
function pid(name: string) {
  try {
    const value = Number(readFileSync(join(data, name), 'utf8'));
    if (!Number.isSafeInteger(value) || value <= 0) return undefined;
    process.kill(value, 0); return value;
  } catch (error) { if (['ENOENT', 'ESRCH'].includes((error as NodeJS.ErrnoException).code || '')) return undefined; throw error; }
}
function status() {
  const supervisorPid = pid('supervisor.pid'), botPid = pid('bot.pid');
  let state = supervisorPid || botPid ? 'starting' : 'stopped';
  if (botPid) try { const current = JSON.parse(readFileSync(join(data, 'runtime-status.json'), 'utf8')); if (current.pid === botPid) state = current.state; } catch {}
  return { status: state, supervisorPid, botPid, dataDir: data };
}
async function stop() {
  if (pid('supervisor.pid')) {
    writeFileSync(join(data, 'stop'), 'stop');
    for (let i = 0; i < 100 && pid('supervisor.pid'); i++) await delay(500);
    if (pid('supervisor.pid')) throw new Error('Bot 尚未退出，请检查日志');
  } else if (pid('bot.pid')) throw new Error('请先在原终端停止前台 Bot');
}
async function start() {
  if (pid('supervisor.pid')) return;
  if (pid('bot.pid')) throw new Error('Bot 已在前台运行');
  mkdirSync(data, { recursive: true, mode: 0o700 });
  const out = openSync(join(data, 'bot.log'), 'a', 0o600), err = openSync(join(data, 'bot-error.log'), 'a', 0o600);
  try {
    const child = spawn(process.execPath, [supervisor], { cwd: root, env: process.env, detached: true, stdio: ['ignore', out, err] });
    await new Promise<void>((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
    child.unref();
  } finally { closeSync(out); closeSync(err); }
  await delay(1000);
  if (!pid('supervisor.pid')) throw new Error('后台启动失败，请检查 bot-error.log');
}
async function main() {
  if (args.slice(1).some(a => a !== '--json') || !['start', 'stop', 'restart', 'status', 'enable', 'disable', 'run'].includes(action)) throw new Error('service 需要 start/stop/restart/status/enable/disable');
  if (action === 'run') {
    const child = spawn(process.execPath, [supervisor], { cwd: root, stdio: 'inherit' });
    const forward = () => child.kill('SIGTERM');
    process.on('SIGTERM', forward); process.on('SIGINT', forward);
    await new Promise<void>((resolve, reject) => { child.on('error', reject); child.on('exit', code => { process.exitCode = code || 0; resolve(); }); });
    return;
  }
  if (action === 'enable' || action === 'disable') {
    if (process.platform !== 'linux') throw new Error('macOS 当前支持 start/stop/status，暂不提供登录自启动；该平台尚未实机测试');
    registered();
    if (action === 'enable') {
      const quote = (s: string) => '"' + s.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('%', '%%').replaceAll('$', '$$') + '"';
      if ([launcher, process.execPath].some(s => /[\r\n]/.test(s))) throw new Error('服务路径不能含换行');
      await stop();
      mkdirSync(dirname(unitFile), { recursive: true });
      writeFileSync(unitFile, `[Unit]\nDescription=QQ Agent Bot\nAfter=network-online.target\n\n[Service]\nWorkingDirectory=${root.replaceAll('%', '%%')}\nExecStart=${quote(process.execPath)} ${quote(launcher)} service run\nEnvironment=${quote('PATH=' + (process.env.PATH || '/usr/bin:/bin'))}\nUMask=0077\nRestart=on-failure\nRestartSec=10\nTimeoutStopSec=55\n\n[Install]\nWantedBy=default.target\n`);
      systemctl('daemon-reload'); systemctl('enable', '--now', 'qq-agent-bot.service'); await delay(1000);
    } else if (existsSync(unitFile)) systemctl('disable', 'qq-agent-bot.service');
  } else if (action !== 'status') {
    const managed = process.platform === 'linux' && registered();
    if (action === 'stop' || action === 'restart') { if (managed) systemctl('stop', 'qq-agent-bot.service'); await stop(); }
    if (action === 'start' || action === 'restart') { if (managed) { systemctl('start', 'qq-agent-bot.service'); await delay(1000); } else await start(); }
  }
  console.log(JSON.stringify(status()));
}
await main().catch(error => { console.log(JSON.stringify({ status: 'error', message: errorText(error) })); process.exitCode = 1; });
