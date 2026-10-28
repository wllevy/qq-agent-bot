import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { QQBot } from '@tencent-connect/qqbot-nodejs';
import { QQSender } from '../src/qq.js';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TransferFile } from '../src/types.js';

test('文件先上传并保存凭据，消息失败重试时不重复上传', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'qqbot-upload-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, 'report.txt'); writeFileSync(path, 'report');
  const calls: { path: string; body: any }[] = [];
  let fail = true;
  const bot = { api: { async post(path: string, body: any) {
    calls.push({ path, body });
    if (path.endsWith('/files')) return { file_info: 'uploaded', ttl: 3600 };
    if (fail) { fail = false; throw new Error('network error'); }
    return { id: 'message', ext_info: { ref_idx: 'quote' } };
  } } } as unknown as QQBot;
  const sender = new QQSender(bot);
  const file: TransferFile = { id: 'file', user: 'u', thread: 'A', name: 'report.txt', mime: 'text/plain', direction: 'out', status: 'ready', localPath: path, attempts: 0, retryAt: 0 };
  const uploaded = (upload: { info: string; expiresAt: number }) => { file.upload = upload; };
  await assert.rejects(sender.sendFile('u', file, uploaded), /network error/);
  assert.deepEqual(await sender.sendFile('u', file, uploaded), ['message', 'quote']);
  assert.equal(calls.filter(call => call.path.endsWith('/files')).length, 1);
  assert.equal(calls[0]!.body.srv_send_msg, false);
  assert.equal(calls[0]!.body.file_type, 4);
  assert.equal(Buffer.from(calls[0]!.body.file_data, 'base64').toString(), 'report');
  assert.equal(calls[2]!.body.media.file_info, 'uploaded');
  sender.close();
});

test('关闭发送器后等待在途请求完成，并取消尚未开始的消息', async () => {
  let enter!: () => void, release!: () => void;
  const started = new Promise<void>(resolve => { enter = resolve; });
  const pending = new Promise<void>(resolve => { release = resolve; });
  let calls = 0;
  const bot = { async sendMarkdown() { calls++; enter(); await pending; return { id: 'sent' }; } } as unknown as QQBot;
  const sender = new QQSender(bot);
  const first = sender.send('u', 'first');
  const second = sender.send('u', 'second');
  const canceled = assert.rejects(second);
  await started; sender.close();
  let drained = false;
  const draining = sender.drain().then(() => { drained = true; });
  await Promise.resolve(); assert.equal(drained, false);
  release(); await first; await canceled; await draining;
  await assert.rejects(sender.send('u', 'third'), /已关闭/);
  assert.equal(calls, 1);
});

test('会话和导航按钮保持在五行以内，不丢失会话操作', async () => {
  const layouts: { buttons: { action: { data: string } }[] }[][] = [];
  const bot = { async sendMarkdown(_target: unknown, _text: string, options: any) {
    layouts.push(options.keyboard.content.rows); return { id: 'sent' };
  } } as unknown as QQBot;
  const sender = new QQSender(bot);
  const buttons = Array.from({ length: 12 }, (_, i) => ({ label: `选择 ${i}`, command: `/选择 workstation:session-${i}` }));
  await sender.send('u', '会话列表', { buttons });
  assert.ok(layouts[0]!.length <= 5);
  assert.ok(layouts[0]!.every(row => row.buttons.length <= 5));
  assert.deepEqual(layouts[0]!.flatMap(row => row.buttons.map(button => button.action.data)), buttons.map(button => button.command));
});

test('一次按钮拒绝只降级当前消息，下次机器菜单仍发送按钮', async () => {
  const keyboards: boolean[] = [];
  const bot = { async sendMarkdown(_target: unknown, _text: string, options?: unknown) {
    keyboards.push(!!options);
    if (keyboards.length === 1) throw Object.assign(new Error('invalid keyboard'), { httpStatus: 400, bizCode: 400 });
    return { id: 'sent' };
  } } as unknown as QQBot;
  const sender = new QQSender(bot);
  const buttons = [{ label: 'remote', command: '/机器 remote' }];
  await sender.send('first', '会话', { buttons });
  await sender.send('next', '机器', { buttons });
  assert.deepEqual(keyboards, [true, false, true]);
});
