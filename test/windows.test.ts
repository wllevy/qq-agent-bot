import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DesktopIPC, DesktopError } from '../src/desktop-ipc.js';
import { desktopTurns, LocalCodex } from '../src/local-codex.js';
import { linkedFiles } from '../src/files.js';
import { SubmissionError } from '../src/domain.js';

test('Windows 盘符、空格及 file URL 链接保留目标路径', () => {
  const files = linkedFiles({ id: 't', status: 'completed', items: [{ id: 'a', type: 'agentMessage', phase: 'final_answer', text: '[报告](<F:/project/output/a b.pdf>) [源码](F:/project/main.ts:12) [图](file:///F:/project/img.png) [相对](output/chart.png) [网页](https://example.com/a.pdf)' }] }, 'F:\\project');
  assert.deepEqual(files.map(f => f.path), ['F:\\project\\output\\a b.pdf', 'F:\\project\\main.ts', 'F:\\project\\img.png', 'F:\\project\\output\\chart.png']);
});

test('桌面 canonical history 按历史顺序转换，保留当前轮状态和时间', () => {
  const state = { turnHistory: { kind: 'canonical', history: { entitiesByKey: {
    a: { turnId: 'old', status: 'completed', items: [], turnStartedAtMs: 1000, durationMs: 2000 },
    b: { turnId: 'new', status: 'inProgress', items: [{ id: 'x', type: 'agentMessage', text: '进行中' }], turnStartedAtMs: 4000 },
  }, islands: [{ entries: [{ value: 'a' }, { value: 'b' }] }] } } };
  const turns = desktopTurns(state);
  assert.deepEqual(turns.map(t => t.id), ['new', 'old']);
  assert.equal(turns[1]!.completedAt, 3);
  assert.equal(turns[0]!.status, 'inProgress');
});

test('桌面 IPC 处理拆包、owner 路由、实时快照及提交中断', async t => {
  const endpoint = process.platform === 'win32' ? `\\\\.\\pipe\\qqbot-ipc-${randomUUID()}` : join(tmpdir(), `qqbot-${randomUUID()}.sock`);
  const seen: any[] = [];
  const server = createServer(socket => {
    let buffer = Buffer.alloc(0);
    const send = (m: unknown) => { const body = Buffer.from(JSON.stringify(m)), head = Buffer.alloc(4); head.writeUInt32LE(body.length); socket.write(head.subarray(0, 2)); socket.write(Buffer.concat([head.subarray(2), body])); };
    socket.on('data', chunk => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 4 && buffer.length >= buffer.readUInt32LE(0) + 4) {
        const size = buffer.readUInt32LE(0), m = JSON.parse(buffer.subarray(4, size + 4).toString()); buffer = buffer.subarray(size + 4); seen.push(m);
        if (m.method === 'thread-stream-following-changed' && m.params.following) send({ type: 'broadcast', method: 'thread-stream-state-changed', sourceClientId: 'desktop', params: { conversationId: 't', hostId: 'local', change: { type: 'snapshot', conversationState: { id: 't', threadRuntimeStatus: { type: 'active' } } } } });
        if (m.type !== 'request') continue;
        if (m.method === 'thread-follower-start-turn') { socket.destroy(); return; }
        send({ type: 'response', requestId: m.requestId, resultType: 'success', handledByClientId: 'desktop', result: m.method === 'initialize' ? { clientId: 'bot' } : {} });
      }
    });
  });
  await new Promise<void>(resolve => server.listen(endpoint, resolve));
  const client = new DesktopIPC(endpoint);
  t.after(async () => { client.close(); await new Promise<void>(resolve => server.close(() => resolve())); });
  assert.equal(await client.owner('t'), 'desktop');
  assert.equal((await client.snapshot('t', 'desktop')).threadRuntimeStatus.type, 'active');
  await assert.rejects(client.request('desktop', 'thread-follower-start-turn', {}, 2), e => e instanceof DesktopError && e.uncertain);
  assert.equal(seen.find(m => m.method === 'thread-follower-start-turn').targetClientId, 'desktop');
  assert.ok(seen.some(m => m.method === 'thread-stream-following-changed' && m.params.following === false));
});

test('桌面任务保留原会话设置，提交结果未知时不回退到第二个 app-server', async () => {
  const client = new LocalCodex('unused');
  let calls = 0;
  const ipc = { async owner() { return 'desktop'; }, async request(_owner: string, method: string, params: any, version: number) {
    calls++; assert.equal(method, 'thread-follower-start-turn'); assert.equal(version, 2);
    assert.equal(params.turnStart.context.inheritThreadSettings, true);
    assert.equal(params.turnStart.request.clientUserMessageId, 'input');
    assert.equal(params.turnStart.request.input[1].type, 'localImage');
    throw new DesktopError('timeout', true);
  }, close() {} };
  (client as any).desktop = ipc;
  try {
    await assert.rejects(client.send('t', '检查图片', 'input', [{ path: 'F:\\x.png', name: 'x.png', mime: 'image/png' }]), e => e instanceof SubmissionError && e.outcome === 'uncertain');
    assert.equal(calls, 1);
  } finally { client.close(); }
});
