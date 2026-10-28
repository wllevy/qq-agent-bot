import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { claudeExecutable } from './claude-executable.js';
import './config.js';
import { runtimePaths } from './paths.js';

const [command, ...args] = process.argv.slice(2);
const entrypoints: Record<string, string> = { start: './main.js', setup: './setup.js', doctor: './doctor.js', pair: './pair.js', migrate: './migrate.js', menus: '../scripts/menus.js' };
if (!command || ['help', '--help'].includes(command)) {
  console.log('qq-agent-bot <setup|start|doctor|pair|service|migrate|menus|paths|version|claude-login>\n配置向导：setup；Agent 配置：setup --non-interactive --config-file <JSON> --json\n诊断：doctor --json；后台状态：service status --json；配对：pair --help');
} else if (command === 'version') {
  console.log(JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version);
} else if (command === 'paths') {
  console.log(JSON.stringify(runtimePaths()));
} else if (entrypoints[command] || command === 'service' || command === 'claude-login') {
  let executable = process.execPath, childArgs = [fileURLToPath(new URL(entrypoints[command] || './main.js', import.meta.url)), ...args];
  if (command === 'claude-login') {
    if (args.length) throw new Error('claude-login 不接受参数');
    executable = claudeExecutable();
    childArgs = ['auth', 'login', '--claudeai'];
  }
  if (command === 'service') {
    if (process.platform !== 'win32') {
      await import('./unix-service.js');
      process.exit(process.exitCode || 0);
    }
    executable = 'powershell.exe';
    childArgs = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', fileURLToPath(new URL('../../scripts/windows-service.ps1', import.meta.url)), '-Action', args[0] || 'status', '-NodePath', process.execPath];
    if (runtimePaths().home) childArgs.push('-BotHome', runtimePaths().home!);
    if (args.includes('--json')) childArgs.push('-Json');
    if (args.slice(1).some(arg => arg !== '--json')) throw new Error('service 仅接受操作名和 --json');
  }
  const child = spawn(executable, childArgs, { stdio: 'inherit', windowsHide: true });
  child.on('error', error => { console.error(error.message); process.exitCode = 1; });
  child.on('exit', code => { process.exitCode = code ?? 1; });
} else { console.error(`未知命令：${command}`); process.exitCode = 1; }
