import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import '../dist/src/config.js';
import { runtimePaths } from '../dist/src/paths.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(root);
if (!existsSync(resolve(root, 'dist/src/main.js'))) throw new Error('缺少构建产物，请先运行 npm run build');
const dataDir = runtimePaths().dataDir;
mkdirSync(dataDir, { recursive: true });
const pidFile = resolve(dataDir, 'supervisor.pid'), stopFile = resolve(dataDir, 'stop');
if (existsSync(pidFile)) {
  const pid = Number(readFileSync(pidFile, 'utf8'));
  try { process.kill(pid, 0); console.error(`监督进程已运行：${pid}`); process.exit(1); }
  catch (error) { if (error.code !== 'ESRCH') throw error; }
  unlinkSync(pidFile);
}
writeFileSync(pidFile, String(process.pid), { flag: 'wx' });
if (existsSync(stopFile)) unlinkSync(stopFile);
let child, stopping = false, restart, force;
function launch() {
  if (stopping) return;
  child = spawn(process.execPath, ['dist/src/main.js'], { cwd: root, windowsHide: true, stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
  console.log(new Date().toISOString(), 'Bot 进程启动', child.pid);
  child.on('error', error => console.error('Bot 启动失败', error.message));
  child.on('exit', code => {
    child = undefined;
    if (stopping) finish();
    else { console.error(new Date().toISOString(), 'Bot 已退出，10 秒后重试', code); restart = setTimeout(launch, 10000); }
  });
}
function finish() {
  clearInterval(timer); clearTimeout(force); clearTimeout(restart);
  if (existsSync(pidFile)) unlinkSync(pidFile);
  if (existsSync(stopFile)) unlinkSync(stopFile);
}
function stop() {
  if (stopping) return;
  stopping = true; clearTimeout(restart);
  if (child?.connected) {
    child.send('shutdown');
    force = setTimeout(() => { child?.kill(); }, 45000);
  } else finish();
}
const timer = setInterval(() => { if (existsSync(stopFile)) stop(); }, 1000);
process.on('SIGINT', stop); process.on('SIGTERM', stop);
launch();
