import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { runtimePaths } from './paths.js';

export const packageRoot = fileURLToPath(new URL('../../', import.meta.url));

export function assertStopped(dataDir: string) {
  for (const name of ['bot.pid', 'supervisor.pid']) {
    let pid: number;
    try { pid = Number(readFileSync(join(dataDir, name), 'utf8')); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error; }
    if (!Number.isSafeInteger(pid) || pid <= 0) continue;
    try { process.kill(pid, 0); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') continue; throw error; }
    throw new Error('Bot 正在运行，请等待任务完成并执行 service stop，再安装或升级');
  }
}

// current.json is the service target, not a second package/version manager.
// Legacy launchers use the same schema, so existing login tasks keep working.
export function registerInstallation(allowRunning = false) {
  const paths = runtimePaths();
  if (!paths.home) return;
  if (packageRoot.split(/[\\/]/).includes('_npx')) throw new Error('后台运行需要永久安装，请先 npm install -g qq-agent-bot');
  const home = paths.home, bin = join(home, 'bin');
  try { assertStopped(paths.dataDir); }
  catch (error) {
    if (allowRunning && existsSync(join(home, 'current.json'))) {
      const active = JSON.parse(readFileSync(join(home, 'current.json'), 'utf8'));
      if (resolve(active.root) === resolve(packageRoot) && active.node === process.execPath) return;
    }
    throw error;
  }
  mkdirSync(bin, { recursive: true, mode: 0o700 });
  for (const name of ['launcher.mjs', 'launcher.ps1']) copyFileSync(join(packageRoot, 'scripts', name), join(bin, name));
  writeFileSync(join(bin, 'qq-agent-bot.cmd'), '@echo off\r\npowershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0launcher.ps1" %*\r\n', { mode: 0o700 });
  const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
  writeFileSync(join(bin, 'qq-agent-bot'), `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(join(bin, 'launcher.mjs'))} "$@"\n`, { mode: 0o755 });
  const version = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8')).version;
  const pointer = join(home, 'current.json'), temporary = pointer + '.' + randomUUID() + '.tmp';
  if (existsSync(pointer)) copyFileSync(pointer, join(home, 'current.previous.json'));
  writeFileSync(temporary, JSON.stringify({ root: resolve(packageRoot), node: process.execPath, version }), { mode: 0o600 });
  renameSync(temporary, pointer);
  return { status: 'installed', version, home, command: join(bin, process.platform === 'win32' ? 'qq-agent-bot.cmd' : 'qq-agent-bot') };
}
