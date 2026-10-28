import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parse } from 'dotenv';
import { readEnvFile, saveEnvFile, updateEnv } from '../src/setup-config.js';

test('setup 保留订阅目录、静态授权与 Claude YOLO，特殊字符不损坏凭据和 Windows 路径', () => {
  const source = '# personal config\r\nQQBOT_APP_SECRET=old\r\nCLAUDE_PERMISSION_MODE=bypassPermissions\r\nQQBOT_ALLOWED_USERS=owner\r\nBOT_DATA_DIR=./data\r\n';
  const updates = { QQBOT_APP_SECRET: 'sample#$`"\\secret', CLAUDE_DEFAULT_CWD: 'C:\\new project\\code', CODEX_ENABLED: 'true' };
  const next = updateEnv(source, updates), result = parse(next);
  for (const [key, value] of Object.entries(updates)) assert.equal(result[key], value);
  assert.equal(result.CLAUDE_PERMISSION_MODE, 'bypassPermissions');
  assert.equal(result.QQBOT_ALLOWED_USERS, 'owner');
  assert.equal(result.BOT_DATA_DIR, './data');
  assert.ok(next.startsWith('# personal config\r\n'));
  assert.equal(next.match(/QQBOT_APP_SECRET=/g)?.length, 1);
});

test('setup 拒绝换行注入和并发覆盖，原文件仍可读取', t => {
  assert.throws(() => updateEnv('', { QQBOT_APP_SECRET: 'x\nQQBOT_ALLOWED_USERS=attacker' }), /多行/);
  const dir = mkdtempSync(join(tmpdir(), 'qqbot-setup-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, '.env');
  saveEnvFile(file, '', 'A=one\n');
  writeFileSync(file, 'A=changed\n');
  assert.throws(() => saveEnvFile(file, 'A=one\n', 'A=two\n'), /发生变化/);
  assert.equal(readEnvFile(file), 'A=changed\n');
});
