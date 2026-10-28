import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { parse } from 'dotenv';
import { runtimePaths } from '../src/paths.js';
import { validateSettings } from '../src/setup-config.js';
import { migrate } from '../src/migrate.js';
import { summarize } from '../src/doctor.js';
import { PairingAccess } from '../src/pairing.js';

function fixture(t: { after: (fn: () => void) => void }) {
  const root = mkdtempSync(join(tmpdir(), 'qq-agent-install-'));
  t.after(() => { assert.ok(resolve(root).startsWith(resolve(tmpdir()) + requireSeparator())); rmSync(root, { recursive: true, force: true }); });
  return root;
}
function requireSeparator() { return process.platform === 'win32' ? '\\' : '/'; }

test('安装目录与工作目录无关，源码路径保持原语义', () => {
  const cwd = resolve('source'), home = resolve('installed');
  assert.equal(runtimePaths({}, cwd).configFile, join(cwd, '.env'));
  assert.equal(runtimePaths({ QQ_AGENT_HOME: home }, cwd).dataDir, join(home, 'data'));
  assert.equal(runtimePaths({ QQ_AGENT_HOME: home, BOT_MACHINES_FILE: 'custom.json' }, cwd).machinesFile, join(home, 'config/custom.json'));
  assert.throws(() => runtimePaths({ QQ_AGENT_HOME: 'relative' }, cwd), /绝对路径/);
});

test('机器配置拒绝未知字段和注入，更换 AppID 必须更新凭据并清除旧静态授权', () => {
  const previous = { QQBOT_APP_ID: '123', QQBOT_APP_SECRET: 'fixture-secret', QQBOT_ALLOWED_USERS: 'old', CLAUDE_PERMISSION_MODE: 'bypassPermissions' };
  assert.deepEqual(validateSettings({ CODEX_ENABLED: 'false' }, previous), { CODEX_ENABLED: 'false' });
  assert.throws(() => validateSettings({ BOT_DATA_DIR: 'elsewhere' }, previous), /未知字段/);
  assert.throws(() => validateSettings({ CODEX_ENABLED: false }, previous), /配置字段或值/);
  assert.throws(() => validateSettings({ QQBOT_APP_SECRET: 'a\nb' }, previous), /配置字段或值/);
  assert.throws(() => validateSettings({ QQBOT_APP_ID: '456' }, previous), /AppSecret/);
  assert.equal(validateSettings({ QQBOT_APP_ID: '456', QQBOT_APP_SECRET: 'new-fixture' }, previous).QQBOT_ALLOWED_USERS, '');
});

test('迁移保存订阅、Claude 权限和配对，修正缓存路径，原数据不变且拒绝覆盖', t => {
  const root = fixture(t), source = join(root, 'source'), home = join(root, 'installed');
  mkdirSync(join(source, 'data/claude'), { recursive: true });
  writeFileSync(join(source, '.env'), 'QQBOT_APP_ID=123\nQQBOT_APP_SECRET=fixture\nCLAUDE_PERMISSION_MODE=bypassPermissions\n');
  const state = { version: 4, chats: { owner: { selected: 'claude:test', subscriptions: { 'claude:test': { persistent: true, replies: [{ input: 'pending' }] } } } }, files: { test: { localPath: join(source, 'data/files/test.txt') } } };
  const original = JSON.stringify(state);
  writeFileSync(join(source, 'data/state.json'), original);
  writeFileSync(join(source, 'data/claude/state.json'), '{"version":1,"sessions":{"test":{"permissionMode":"bypassPermissions"}}}');
  const access = new PairingAccess(join(source, 'data'), '123', []), code = access.begin().code;
  access.request(code, 'fixture-owner'); access.approve(code, 'fixture-owner');
  migrate(source, home);
  const copied = JSON.parse(readFileSync(join(home, 'data/state.json'), 'utf8'));
  assert.deepEqual(copied.chats, state.chats);
  assert.equal(copied.files.test.localPath, join(home, 'data/files/test.txt'));
  assert.equal(readFileSync(join(source, 'data/state.json'), 'utf8'), original);
  assert.equal(readFileSync(join(home, 'data/claude/state.json'), 'utf8'), readFileSync(join(source, 'data/claude/state.json'), 'utf8'));
  assert.deepEqual(new PairingAccess(join(home, 'data'), '123', []).users(), ['fixture-owner']);
  assert.equal(parse(readFileSync(join(home, 'config/.env'), 'utf8')).CLAUDE_PERMISSION_MODE, 'bypassPermissions');
  assert.throws(() => migrate(source, home), /拒绝覆盖/);
});

test('迁移拒绝运行中的源及 v3 数据，不写入目标', t => {
  const root = fixture(t), source = join(root, 'source'), home = join(root, 'installed');
  mkdirSync(join(source, 'data'), { recursive: true });
  writeFileSync(join(source, '.env'), 'QQBOT_APP_ID=123');
  writeFileSync(join(source, 'data/bot.pid'), String(process.pid));
  assert.throws(() => migrate(source, home), /停止原 Bot/);
  assert.equal(existsSync(home), false);
  rmSync(join(source, 'data/bot.pid'));
  writeFileSync(join(source, 'data/state.json'), '{"version":3}');
  assert.throws(() => migrate(source, home), /仅支持 v4/);
  assert.equal(existsSync(home), false);
});

test('Agent 分阶段配对需要准确 requestId 和 senderId，只有明确批准才能授权', t => {
  const home = fixture(t);
  mkdirSync(join(home, 'config')); mkdirSync(join(home, 'data'));
  writeFileSync(join(home, 'config/.env'), 'QQBOT_APP_ID=123\nQQBOT_APP_SECRET=fixture\n');
  writeFileSync(join(home, 'data/bot.pid'), String(process.pid));
  const env = { ...process.env, QQ_AGENT_HOME: home, QQBOT_APP_ID: '123', QQBOT_APP_SECRET: 'fixture', BOT_DATA_DIR: join(home, 'data') };
  const call = (...args: string[]) => {
    const result = spawnSync(process.execPath, ['--import', 'tsx', 'src/pair.ts', ...args, '--json'], { env, encoding: 'utf8' });
    assert.ok(result.stdout, result.stderr); return { code: result.status, ...JSON.parse(result.stdout) };
  };
  const started = call('start');
  assert.equal(started.status, 'waiting_for_qq');
  const access = new PairingAccess(join(home, 'data'), '123', []);
  access.request(started.requestId, 'fixture-owner');
  assert.equal(call('status').status, 'needs_confirmation');
  assert.deepEqual(access.users(), []);
  assert.equal(call('approve', started.requestId, '--user', 'wrong').status, 'error');
  assert.deepEqual(access.users(), []);
  assert.equal(call('approve', started.requestId, '--user', 'fixture-owner').status, 'authorized');
  assert.deepEqual(access.users(), ['fixture-owner']);
  assert.equal(call('status').status, 'inactive');
});

test('诊断状态不会把缺少登录、配对或网络失败标记为 ready', () => {
  assert.equal(summarize([{ name: 'qq', ok: false, message: 'network' }, { name: 'access', ok: false, message: '', status: 'needs_pairing' }]), 'error');
  assert.equal(summarize([{ name: 'auth', ok: false, message: '', status: 'needs_login' }]), 'needs_login');
  assert.equal(summarize([{ name: 'access', ok: false, message: '', status: 'needs_pairing' }]), 'needs_pairing');
  assert.equal(summarize([{ name: 'qq', ok: true, message: '' }]), 'ready');
});
