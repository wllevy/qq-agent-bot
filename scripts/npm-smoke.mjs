import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, mkdtempSync, mkdirSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { tmpdir } from 'node:os';

const archive = resolve(process.argv[2]), root = mkdtempSync(join(tmpdir(), 'qq-agent-npm-'));
const windows = process.platform === 'win32', prefix = join(root, 'global npm'), bootstrap = join(root, '安装目录 space');
const globalRoot = join(prefix, ...(windows ? [] : ['lib']), 'node_modules/qq-agent-bot');
const globalBin = join(prefix, windows ? 'qq-agent-bot.cmd' : 'bin/qq-agent-bot');
const npm = process.env.npm_execpath || [join(dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js'), resolve(dirname(process.execPath), '../lib/node_modules/npm/bin/npm-cli.js'), '/usr/share/nodejs/npm/bin/npm-cli.js'].find(existsSync);
if (!npm) throw new Error('Run npm run smoke:install to locate npm');
const env = { ...process.env, LOCALAPPDATA: join(root, 'local'), XDG_DATA_HOME: join(root, 'xdg'), HOME: join(root, 'profile'), USERPROFILE: join(root, 'profile') };
for (const key of ['QQ_AGENT_HOME', 'BOT_DATA_DIR', 'BOT_MACHINES_FILE', 'QQBOT_APP_ID', 'QQBOT_APP_SECRET', 'AppID', 'AppSecret', 'APPID', 'APPSECRET']) delete env[key];
const commandScript = join(root, 'command.ps1');
writeFileSync(commandScript, '[Console]::OutputEncoding=New-Object Text.UTF8Encoding($false)\n$Executable=$args[0]\n$CommandArgs=@($args | Select-Object -Skip 1)\n& $Executable @CommandArgs\nexit $LASTEXITCODE\n');
function run(command, args, expected = 0, cwd = root, overrides = {}) {
  const result = spawnSync(command, args, { env: { ...env, ...overrides }, cwd, encoding: 'utf8', timeout: 180000, windowsHide: true });
  assert.equal(result.status, expected, `${command}: ${result.stdout}\n${result.stderr}\n${result.error || ''}`);
  return result.stdout.trim();
}
function cli(bin, args, expected = 0, overrides = {}, cwd = root) {
  return windows ? run('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', commandScript, bin, ...args], expected, cwd, overrides) : run(bin, args, expected, cwd, overrides);
}
function install(target, pkg, expected = 0) {
  const script = windows ? resolve('scripts/install.ps1') : resolve('scripts/install.sh');
  return windows ? run('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, '-InstallHome', target, '-PackagePath', pkg, '-NodePath', process.execPath, '-SkipSetup', '-NoPath'], expected)
    : run('bash', [script, '--home', target, '--package', pkg, '--node', process.execPath, '--skip-setup', '--no-path'], expected);
}

// Exercise npm's actual global binary wrapper, using a temporary prefix only.
run(process.execPath, [npm, 'install', '-g', '--prefix', prefix, '--no-audit', '--no-fund', archive]);
const version = JSON.parse(readFileSync(join(globalRoot, 'package.json'), 'utf8')).version;
assert.equal(cli(globalBin, ['version']), version);
console.log('npm global command installed');
assert.equal(existsSync(join(globalRoot, 'node_modules/typescript')), false);
assert.equal(existsSync(join(globalRoot, '.env')), false);
assert.equal(existsSync(join(globalRoot, 'src')), false);
const paths = JSON.parse(cli(globalBin, ['paths']));
const elsewhere = join(root, 'unrelated project'); mkdirSync(elsewhere);
assert.deepEqual(JSON.parse(cli(globalBin, ['paths'], 0, {}, elsewhere)), paths);
assert.equal(paths.home, join(windows ? env.LOCALAPPDATA : env.XDG_DATA_HOME, windows ? 'QQAgentBot' : 'qq-agent-bot'));
assert.equal(JSON.parse(cli(globalBin, ['doctor', '--json'], 1)).status, 'needs_credentials');
const input = join(root, 'settings.json');
writeFileSync(input, JSON.stringify({ QQBOT_APP_ID: '123', QQBOT_APP_SECRET: 'npm-fixture-only', CODEX_ENABLED: 'false', CLAUDE_ENABLED: 'true', CLAUDE_PERMISSION_MODE: 'bypassPermissions' }));
assert.equal(JSON.parse(cli(globalBin, ['setup', '--non-interactive', '--config-file', input, '--json'])).status, 'configured');
assert.equal(JSON.parse(cli(globalBin, ['service', 'status', '--json'])).status, 'stopped');
assert.equal(JSON.parse(cli(globalBin, ['pair', 'start', '--json'], 2)).status, 'needs_service');

// Upgrade an existing current.json installation. Config, pairing, subscriptions
// and Claude records already live outside its old version directory.
mkdirSync(join(bootstrap, 'config'), { recursive: true }); mkdirSync(join(bootstrap, 'data/claude'), { recursive: true });
const savedEnv = 'QQBOT_APP_ID=123\nQQBOT_APP_SECRET=bootstrap-fixture\nBOT_DATA_DIR=./data\nCLAUDE_PERMISSION_MODE=bypassPermissions\n';
const savedState = '{"version":4,"chats":{"fixture":{"subscriptions":{"session":{"persistent":true}}}}}';
writeFileSync(join(bootstrap, 'config/.env'), savedEnv);
writeFileSync(join(bootstrap, 'data/state.json'), savedState);
writeFileSync(join(bootstrap, 'data/claude/state.json'), '{"version":1,"sessions":{"fixture":{"permissionMode":"bypassPermissions"}}}');
writeFileSync(join(bootstrap, 'current.json'), JSON.stringify({ root: globalRoot, node: process.execPath, version: 'legacy' }));
install(bootstrap, archive);
console.log('bootstrap installed over legacy service target');
const stable = join(bootstrap, 'bin', windows ? 'qq-agent-bot.cmd' : 'qq-agent-bot');
assert.equal(cli(stable, ['version']), version);
assert.equal(readFileSync(join(bootstrap, 'config/.env'), 'utf8'), savedEnv);
assert.equal(readFileSync(join(bootstrap, 'data/state.json'), 'utf8'), savedState);
assert.equal(readFileSync(join(bootstrap, 'data/claude/state.json'), 'utf8'), '{"version":1,"sessions":{"fixture":{"permissionMode":"bypassPermissions"}}}');

const active = JSON.parse(readFileSync(join(bootstrap, 'current.json'), 'utf8'));
const main = join(active.root, 'dist/src/main.js'), original = readFileSync(main);
writeFileSync(main, `import {mkdirSync,writeFileSync,unlinkSync} from 'node:fs';import {join} from 'node:path';
const data=join(process.env.QQ_AGENT_HOME,'data');mkdirSync(data,{recursive:true});writeFileSync(join(data,'bot.pid'),String(process.pid));writeFileSync(join(data,'runtime-status.json'),JSON.stringify({pid:process.pid,state:'online'}));
const timer=setInterval(()=>{},1000);process.on('message',m=>{if(m==='shutdown'){unlinkSync(join(data,'bot.pid'));clearInterval(timer);process.disconnect();}});`);
try {
  assert.equal(JSON.parse(cli(stable, ['service', 'start', '--json'])).status, 'online');
  assert.equal(JSON.parse(cli(stable, ['service', 'status', '--json'])).status, 'online');
  assert.equal(JSON.parse(cli(stable, ['service', 'start', '--json'])).status, 'online');
  install(bootstrap, archive, 1); // Running-instance guard runs before npm modifies files.
  assert.equal(cli(stable, ['version']), version);
  assert.equal(JSON.parse(cli(stable, ['service', 'restart', '--json'])).status, 'online');
} finally { cli(stable, ['service', 'stop', '--json']); writeFileSync(main, original); }
assert.equal(JSON.parse(cli(stable, ['service', 'status', '--json'])).status, 'stopped');
console.log('background lifecycle and busy upgrade guard passed');

const future = join(root, 'future'); mkdirSync(future);
run(windows ? join(process.env.SystemRoot, 'System32/tar.exe') : 'tar', ['-xzf', archive, '-C', future]);
const metadataFile = join(future, 'package/package.json'), metadata = JSON.parse(readFileSync(metadataFile, 'utf8'));
metadata.version = '99.0.0'; writeFileSync(metadataFile, JSON.stringify(metadata));
run(process.execPath, [npm, 'pack', '--ignore-scripts', '--json', '--pack-destination', future], 0, join(future, 'package'));
const nextPackage = join(future, 'qq-agent-bot-99.0.0.tgz');
install(bootstrap, nextPackage);
console.log('npm package upgrade installed');
assert.equal(cli(stable, ['version']), '99.0.0');
assert.equal(readFileSync(join(bootstrap, 'config/.env'), 'utf8'), savedEnv);
assert.equal(readFileSync(join(bootstrap, 'data/state.json'), 'utf8'), savedState);
// npm's standard upgrade also works, and source commands retain cwd semantics.
run(process.execPath, [npm, 'install', '-g', '--prefix', prefix, '--no-audit', '--no-fund', nextPackage]);
assert.equal(cli(globalBin, ['version']), '99.0.0');
assert.equal(readFileSync(paths.configFile, 'utf8').includes('bypassPermissions'), true);
console.log(JSON.stringify({ status: 'passed', root, checks: 'npm global CLI; fixed home; bootstrap/legacy upgrade; process lifecycle; busy update refusal; config/state preservation' }));
