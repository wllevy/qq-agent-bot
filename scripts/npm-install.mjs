import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, openSync, closeSync, unlinkSync, realpathSync } from 'node:fs';
import { dirname, join, resolve, delimiter } from 'node:path';
import { homedir } from 'node:os';

const options = {};
for (let i = 2; i < process.argv.length; i++) {
  const name = process.argv[i];
  if (['--skip-setup', '--no-path', '--offline'].includes(name)) options[name] = true;
  else if (['--home', '--package', '--version'].includes(name) && process.argv[i + 1]) options[name] = process.argv[++i];
  else throw new Error(`Unknown argument: ${name}`);
}
const home = resolve(options['--home'] || process.env.QQ_AGENT_HOME || (process.platform === 'win32'
  ? join(process.env.LOCALAPPDATA || join(homedir(), 'AppData/Local'), 'QQAgentBot')
  : process.platform === 'darwin' ? join(homedir(), 'Library/Application Support/QQAgentBot') : join(process.env.XDG_DATA_HOME || join(homedir(), '.local/share'), 'qq-agent-bot')));
const version = String(options['--version'] || 'latest').replace(/^v/, '');
if (version !== 'latest' && !/^\d+\.\d+\.\d+$/.test(version)) throw new Error('Version must be latest or X.Y.Z');
if (Number(process.versions.node.split('.')[0]) < 24) throw new Error('Node.js 24+ required');
mkdirSync(home, { recursive: true, mode: 0o700 });
const lock = join(home, 'npm-install.lock'), fd = openSync(lock, 'wx', 0o600);
const env = { ...process.env, QQ_AGENT_HOME: home, PATH: dirname(process.execPath) + delimiter + (process.env.PATH || '') };
function run(executable, args, capture = false) {
  const result = spawnSync(executable, args, { env, encoding: 'utf8', windowsHide: true, stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(capture ? 'Cannot inspect installed CLI; stop the existing bot before updating' : 'Installation command failed; see the output above');
  return result.stdout?.trim();
}
try {
  const pointer = join(home, 'current.json');
  let data = join(home, 'data');
  if (existsSync(pointer)) {
    const active = JSON.parse(readFileSync(pointer, 'utf8'));
    const cli = join(active.root, 'dist/src/cli.js');
    if (existsSync(cli)) data = JSON.parse(run(existsSync(active.node) ? active.node : process.execPath, [cli, 'paths'], true)).dataDir;
  }
  for (const name of ['bot.pid', 'supervisor.pid']) if (existsSync(join(data, name))) {
    const pid = Number(readFileSync(join(data, name), 'utf8'));
    if (!Number.isSafeInteger(pid) || pid <= 0) continue;
    try { process.kill(pid, 0); } catch (error) { if (error.code === 'ESRCH') continue; throw error; }
    throw new Error('Bot is running. Wait for tasks to finish, then run qq-agent-bot service stop before updating.');
  }
  const candidates = [join(dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js'), resolve(dirname(process.execPath), '../lib/node_modules/npm/bin/npm-cli.js')];
  if (process.platform !== 'win32') for (const path of (env.PATH || '').split(delimiter)) {
    const file = join(path, 'npm'); if (existsSync(file)) candidates.push(realpathSync(file));
  }
  const npm = candidates.find(existsSync);
  if (!npm) throw new Error('This Node.js installation does not include npm');
  const prefix = join(home, 'npm');
  const spec = options['--package'] ? resolve(String(options['--package'])) : `qq-agent-bot@${version}`;
  if (options['--offline'] && !options['--package']) throw new Error('--offline requires --package');
  console.log(`Installing ${options['--package'] ? 'local npm package' : spec}...`);
  run(process.execPath, [npm, 'install', '--global', '--prefix', prefix, '--omit=dev', '--no-audit', '--no-fund', ...(options['--offline'] ? ['--offline'] : []), spec]);
  const root = join(prefix, ...(process.platform === 'win32' ? [] : ['lib']), 'node_modules/qq-agent-bot');
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  if (pkg.name !== 'qq-agent-bot' || version !== 'latest' && pkg.version !== version) throw new Error('Installed package/version does not match request');
  const cli = join(root, 'bin/qq-agent-bot.mjs');
  run(process.execPath, [cli, 'install', '--json']);
  const bin = join(home, 'bin');
  if (!options['--no-path']) {
    if (process.platform === 'win32') {
      // Read the path through a file so arbitrary directory names never enter PowerShell code.
      const update = join(home, 'update-path.ps1');
      writeFileSync(update, "$ErrorActionPreference='Stop'\n$BotBin=Join-Path $PSScriptRoot 'bin'\n$UserPath=[Environment]::GetEnvironmentVariable('Path','User')\nif(@($UserPath -split ';') -notcontains $BotBin){[Environment]::SetEnvironmentVariable('Path',(([string]$UserPath).TrimEnd(';')+';'+$BotBin).TrimStart(';'),'User')}\n", { mode: 0o600 });
      run('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', update]);
      unlinkSync(update);
    } else {
      const userBin = join(homedir(), '.local/bin'); mkdirSync(userBin, { recursive: true });
      const { symlinkSync, readlinkSync } = await import('node:fs');
      const link = join(userBin, 'qq-agent-bot'), target = join(bin, 'qq-agent-bot');
      try { symlinkSync(target, link); }
      catch (error) { if (error.code !== 'EEXIST' || readlinkSync(link) !== target) throw new Error('~/.local/bin/qq-agent-bot belongs to another installation; use --no-path'); }
      console.log('Add ~/.local/bin to PATH if needed.');
    }
  }
  console.log(`Installed ${pkg.version}. Command: ${join(bin, process.platform === 'win32' ? 'qq-agent-bot.cmd' : 'qq-agent-bot')}`);
  if (!options['--skip-setup']) run(process.execPath, [cli, 'setup']);
} finally { closeSync(fd); unlinkSync(lock); }
