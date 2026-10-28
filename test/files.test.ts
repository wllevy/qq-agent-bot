import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConsoleApp } from '../src/console.js';
import { FileTransfers, MAX_FILE_BYTES, linkedFiles } from '../src/files.js';
import { Store } from '../src/store.js';
import type { CodexPort, PreparedFile, Sender, Snapshot, TransferFile } from '../src/types.js';

async function setup(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'qqbot-files-'));
  const server = createServer((_req, res) => { res.writeHead(200, { 'content-type': 'image/png' }); res.end('image bytes'); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/image.png`;
  const sent: { id: string; text: string; files: PreparedFile[] }[] = [];
  const writes: { id: string; path: string; data: string }[] = [], reads: string[] = [];
  const snapshots: Record<string, Snapshot> = Object.fromEntries(['A', 'B'].map(id => [id, {
    thread: { id, cwd: '/project/' + id, updatedAt: 1, status: { type: 'idle' } }, turns: [],
  }]));
  let offline = false;
  const codex: CodexPort = {
    async list() { return Object.values(snapshots).map(s => s.thread); },
    async snapshot(id) { if (offline) throw new Error('offline'); return structuredClone(snapshots[id]!); },
    async models() { return []; }, async updateSettings(id) { return snapshots[id]!.thread; },
    async prepare() { if (offline) throw new Error('offline'); }, async interrupt() {},
    async send(id, text, _input, files = []) { sent.push({ id, text, files }); return { id: 'sent', status: 'inProgress', items: [] }; },
    async writeFile(id, path, data) { if (offline) throw new Error('offline'); writes.push({ id, path, data: data.toString() }); },
    async readFile(_id, path) { if (offline) throw new Error('offline'); reads.push(path); return Buffer.from('result file'); },
  };
  const text: string[] = [], media: string[] = [];
  let failMedia = false;
  const sender: Sender = {
    async send(_user, body) { text.push(body); return ['text-' + text.length]; },
    async sendFile(_user, file, uploaded) {
      if (!file.upload) uploaded({ info: 'uploaded', expiresAt: Date.now() + 3600000 });
      if (failMedia) throw new Error('temporary network error');
      media.push(file.id); return ['file-message'];
    },
  };
  const store = new Store(directory), app = new ConsoleApp(store, codex, sender);
  t.after(async () => { await app.shutdown(); await new Promise<void>(resolve => server.close(() => resolve())); rmSync(directory, { recursive: true, force: true }); });
  return { directory, store, app, codex, sender, sent, writes, reads, snapshots, text, media, url, offline: (value: boolean) => { offline = value; }, failMedia: (value: boolean) => { failMedia = value; } };
}

test('纯附件绑定原会话，离线时先下载，重启后随下一条要求提交一次', async t => {
  const h = await setup(t);
  await h.app.receive('u', '/选择 A', 'select');
  h.offline(true);
  await h.app.receive('u', '', 'attachment', undefined, [{ url: h.url, filename: 'image.png', content_type: 'image/png' }]);
  await h.app.files.tick();
  const file = Object.values(h.store.state.files!)[0]!;
  assert.equal(file.status, 'ready');
  assert.equal(readFileSync(file.localPath!, 'utf8'), 'image bytes');
  assert.equal(h.sent.length, 0);
  h.offline(false);
  await h.app.receive('u', '/选择 B', 'switch');
  await h.app.receive('u', 'B task', 'B-task');
  assert.deepEqual(h.sent[0]!.files, []);
  await h.app.receive('u', '/选择 A', 'back');
  h.offline(true);
  await h.app.receive('u', '检查图片', 'task');
  assert.equal(h.store.state.inputs[0]!.thread, 'A');
  assert.deepEqual(h.store.state.inputs[0]!.fileIds, [file.id]);
  await h.app.shutdown();
  const recovered = new Store(h.directory), restarted = new ConsoleApp(recovered, h.codex, h.sender);
  h.offline(false);
  await restarted.tick(); await restarted.tick();
  assert.equal(h.sent.length, 2);
  assert.equal(h.sent[1]!.id, 'A');
  assert.equal(h.sent[1]!.files[0]!.mime, 'image/png');
  assert.match(h.writes[0]!.path, /\/project\/A\/\.qqbot-attachments\/.+\/image.png$/);
  assert.equal(h.writes[0]!.data, 'image bytes');
  await restarted.receive('u', '检查图片', 'task');
  assert.equal(h.sent.length, 2);
  await restarted.shutdown();
});

test('最终回答候选只缓存成果，离线可取缓存；发送失败后重启复用上传结果', async t => {
  const h = await setup(t);
  h.snapshots.A!.turns = [{ id: 'turn', status: 'completed', items: [{ id: 'answer', type: 'agentMessage', phase: 'final_answer', text: '[报告](./report.pdf) [代码](./code.ts:3) [网页](https://example.com/file.pdf)' }] }];
  await h.app.receive('u', '/选择 A', 'select');
  await h.app.files.tick();
  const files = Object.values(h.store.state.files!);
  const report = files.find(file => file.name === 'report.pdf')!;
  assert.equal(files.length, 2);
  assert.deepEqual(h.reads, ['/project/A/report.pdf']);
  assert.equal(files.find(file => file.name === 'code.ts')!.status, 'listed');
  assert.equal(h.media.length, 0);
  h.offline(true); h.failMedia(true);
  await h.app.receive('u', '/取文件 ' + report.id, 'download');
  assert.equal(report.upload?.info, 'uploaded');
  assert.ok(h.store.state.outbox.some(entry => entry.fileId === report.id));
  await h.app.shutdown();
  const recovered = new Store(h.directory), restarted = new ConsoleApp(recovered, h.codex, h.sender);
  h.failMedia(false);
  for (const entry of recovered.state.outbox) entry.retryAt = 0;
  await restarted.deliver();
  assert.deepEqual(h.media, [report.id]);
  assert.equal(recovered.state.refs['file-message']?.thread, 'A');
  assert.equal(h.sent.length, 0);
  await restarted.shutdown();
});

test('超限附件明确失败，普通下载故障可重试；文件名不能改变缓存目录', async t => {
  const h = await setup(t);
  let oversized = true;
  const transfers = new FileTransfers(h.store, h.codex, async () => new Response('data', { headers: { 'content-length': String(oversized ? MAX_FILE_BYTES + 1 : 4) } }));
  const [id] = transfers.incoming('u', 'A', [{ url: h.url, filename: '..', content_type: 'application/octet-stream' }]);
  await transfers.tick();
  assert.equal(transfers.get(id!)!.status, 'failed');
  assert.match(transfers.get(id!)!.error!, /20 MiB/);
  oversized = false;
  const [next] = transfers.incoming('u', 'A', [{ url: h.url, filename: '../report.pdf', content_type: 'application/pdf' }]);
  await transfers.tick();
  assert.equal(transfers.get(next!)!.status, 'ready');
  assert.equal(transfers.get(next!)!.name, 'report.pdf');
  await transfers.shutdown();
});

test('带文字附件作为一个任务，后到的附件不会被前一条文字提前领取', async t => {
  const h = await setup(t);
  await h.app.receive('u', '/选择 A', 'select');
  await Promise.all([
    h.app.receive('u', '原来的要求', 'first'),
    h.app.receive('u', '看这张图', 'second', undefined, [{ url: h.url, filename: 'new.png', content_type: 'image/png' }]),
  ]);
  await h.app.files.tick(); await h.app.tick();
  assert.equal(h.sent.length, 2);
  assert.deepEqual(h.sent[0]!.files, []);
  assert.equal(h.sent[1]!.text, '看这张图');
  assert.equal(h.sent[1]!.files.length, 1);
});

test('只从最终回答收集本机文件链接，排除网页和中途消息', () => {
  const files = linkedFiles({ id: 't', status: 'completed', items: [
    { id: 'p', type: 'agentMessage', phase: 'commentary', text: '[临时](tmp.pdf)' },
    { id: 'a', type: 'agentMessage', phase: 'final_answer', text: '[报告](<./my report.pdf>) [代码](/project/a.ts#L4) [网站](https://example.com/a.pdf) [报告](./my%20report.pdf)' },
  ] }, '/project');
  assert.deepEqual(files.map(file => file.path), ['/project/my report.pdf', '/project/a.ts']);
});
