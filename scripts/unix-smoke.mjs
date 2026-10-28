import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, existsSync, unlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir, homedir } from 'node:os';
import assert from 'node:assert/strict';
const root = mkdtempSync(join(tmpdir(), 'qq-agent-unix-test-')), home = join(root, '安装目录 space');
function run(command, args, expected = 0) {
  const result = spawnSync(command, args, { encoding: 'utf8', timeout: 180000 });
  assert.equal(result.status, expected, result.stdout + result.stderr); return result.stdout.trim();
}
const archive = resolve(process.argv[2]);
const unit = join(homedir(), '.config/systemd/user/qq-agent-bot.service');
const testSystemd = process.env.QQ_AGENT_TEST_SYSTEMD === '1';
if (testSystemd && existsSync(unit)) throw new Error('Refusing to replace an existing user service during testing');
const install = ['scripts/install.sh', '--home', home, '--package', archive, '--node', process.execPath, '--skip-setup', '--no-path'];
run('bash', install);
const bot = join(home, 'bin/qq-agent-bot');
assert.equal(JSON.parse(run(bot, ['doctor', '--json'], 1)).status, 'needs_credentials');
assert.equal(JSON.parse(run(bot, ['service', 'status', '--json'])).status, 'stopped');
const config = join(root, 'settings.json');
writeFileSync(config, JSON.stringify({ QQBOT_APP_ID: '123', QQBOT_APP_SECRET: 'unix-fixture', CODEX_ENABLED: 'false', CLAUDE_ENABLED: 'true' }));
assert.equal(JSON.parse(run(bot, ['setup', '--non-interactive', '--config-file', config, '--json'])).status, 'configured');
// A local main-process fixture exercises supervisor lifecycle without opening a QQ connection.
const active = JSON.parse(readFileSync(join(home, 'current.json'), 'utf8'));
const main = join(active.root, 'dist/src/main.js'), original = readFileSync(main);
writeFileSync(main, `import {mkdirSync,writeFileSync,unlinkSync} from 'node:fs'; import {join} from 'node:path';
const data=join(process.env.QQ_AGENT_HOME,'data'); mkdirSync(data,{recursive:true}); writeFileSync(join(data,'bot.pid'),String(process.pid)); writeFileSync(join(data,'runtime-status.json'),JSON.stringify({pid:process.pid,state:'online'}));
const timer=setInterval(()=>{},1000); process.on('message',m=>{if(m==='shutdown'){unlinkSync(join(data,'bot.pid'));clearInterval(timer);process.disconnect();}});`);
try {
  assert.equal(JSON.parse(run(bot, ['service', 'start', '--json'])).status, 'online');
  assert.equal(JSON.parse(run(bot, ['service', 'status', '--json'])).status, 'online');
  assert.equal(JSON.parse(run(bot, ['service', 'restart', '--json'])).status, 'online');
  if (testSystemd) {
    assert.equal(JSON.parse(run(bot, ['service', 'enable', '--json'])).status, 'online');
    run('systemctl', ['--user', 'is-enabled', 'qq-agent-bot.service']);
    run(bot, ['service', 'disable', '--json']);
  }
} finally {
  run(bot, ['service', 'stop', '--json']); writeFileSync(main, original);
  if (testSystemd && existsSync(unit) && readFileSync(unit, 'utf8').includes(join(home, 'bin/launcher.mjs'))) { unlinkSync(unit); run('systemctl', ['--user', 'daemon-reload']); }
}
assert.equal(JSON.parse(run(bot, ['service', 'status', '--json'])).status, 'stopped');
const envFile = join(home, 'config/.env'), before = readFileSync(envFile, 'utf8');
run('bash', install);
assert.equal(readFileSync(envFile, 'utf8'), before);
// Exercise an actual version switch while preserving existing state.
const future = join(root, 'future'); mkdirSync(future);
run('tar', ['-xzf', archive, '-C', future]);
for (const name of ['package.json', 'package-lock.json']) {
  const file = join(future, name), value = JSON.parse(readFileSync(file, 'utf8'));
  value.version = '99.0.0'; if (name === 'package-lock.json') value.packages[''].version = '99.0.0';
  writeFileSync(file, JSON.stringify(value));
}
const stateFile = join(home, 'data/state.json');
writeFileSync(stateFile, '{"version":4,"fixture":"subscription"}');
const futureArchive = join(root, 'future.tar.gz'); run('tar', ['-czf', futureArchive, '-C', future, '.']);
run('bash', ['scripts/install.sh', '--home', home, '--package', futureArchive, '--node', process.execPath, '--skip-setup', '--no-path']);
assert.equal(run(bot, ['version']), '99.0.0');
assert.equal(readFileSync(envFile, 'utf8'), before);
assert.equal(readFileSync(stateFile, 'utf8'), '{"version":4,"fixture":"subscription"}');
console.log(JSON.stringify({ status: 'passed', home, checks: 'install/configure/lifecycle/reinstall/upgrade; no QQ or model calls' }));
