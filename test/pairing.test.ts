import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PairingAccess, PAIRING_TTL, handlePairing } from '../src/pairing.js';

function fixture(t: { after: (fn: () => void) => void }) {
  const dir = mkdtempSync(join(tmpdir(), 'qqbot-pair-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  let now = Date.now();
  return { dir, access: new PairingAccess(dir, '100', ['static'], () => now), expire: () => { now += PAIRING_TTL + 1; } };
}

test('QQ 配对需要本机批准，授权跨进程读取并按 AppID 隔离', t => {
  const { dir, access } = fixture(t), active = access.begin();
  const gateway = new PairingAccess(dir, '100');
  assert.equal(access.allowed('owner'), false);
  assert.equal(access.allowed('static'), true);
  assert.equal(gateway.request(active.code.toLowerCase(), 'owner'), true);
  assert.equal(access.allowed('owner'), false);
  assert.throws(() => access.approve(active.code, 'other'), /失效/);
  access.approve(active.code, 'owner');
  assert.equal(gateway.allowed('owner'), true);
  assert.equal(new PairingAccess(dir, '200').allowed('owner'), false);
  assert.equal(gateway.request(active.code, 'other'), false);
  assert.equal(access.revoke('owner'), false);
  assert.equal(gateway.allowed('owner'), false);
  assert.equal(access.revoke('static'), true);
  assert.equal(access.allowed('static'), true);
});

test('错误码、空 sender、重复申请、过期和本机拒绝都不能授权', t => {
  const { access, expire } = fixture(t), { code } = access.begin();
  assert.throws(() => access.begin(), /已有配对/);
  assert.equal(access.request('invalid', 'other'), false);
  assert.equal(access.request(code, ''), false);
  assert.equal(access.request(code, 'owner'), true);
  assert.equal(access.request(code, 'other'), false);
  assert.equal(access.pending(code)?.senderId, 'owner');
  expire();
  assert.equal(access.pending(code), undefined);
  assert.throws(() => access.approve(code, 'owner'), /失效/);
  assert.equal(access.request(code, 'owner'), false);
  const next = access.begin();
  access.request(next.code, 'owner'); access.cancel(next.code);
  assert.equal(access.pending(next.code), undefined);
  assert.throws(() => access.approve(next.code, 'owner'), /失效/);
  assert.deepEqual(access.users(), []);
});

test('配对仅消费精确命令，重复或错误申请不反复发消息，不泄露授权码', async t => {
  const { access } = fixture(t), { code } = access.begin();
  const messages: string[] = [];
  const sender = { async send(_user: string, text: string) { messages.push(text); return []; } };
  const message = (content: string) => ({ senderId: 'owner', content, messageId: 'm' });
  assert.equal(await handlePairing(access, sender, message('帮我配对代码')), false);
  assert.equal(await handlePairing(access, sender, message('配对 invalid')), true);
  assert.equal(messages.length, 0);
  assert.equal(await handlePairing(access, sender, message(`/配对 ${code}`)), true);
  assert.equal(await handlePairing(access, sender, message(`/配对 ${code}`)), true);
  assert.equal(messages.length, 1);
  assert.ok(!messages[0]!.includes(code));
  assert.equal(access.allowed('owner'), false);
});

test('损坏的配对授权文件不会开放访问', t => {
  const { access } = fixture(t);
  writeFileSync(join(access.directory, 'users.json'), '{"owner":true}');
  assert.throws(() => access.allowed('owner'), /格式错误/);
});
