import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import { Codex } from '../src/codex.js';
import { SubmissionError } from '../src/domain.js';
import { MachineCodex } from '../src/machines.js';

type Request = { id: number; method: string; params: Record<string, unknown> };
async function server(t: TestContext, handle: (request: Request, ws: WebSocket) => void) {
  const dir = mkdtempSync(join(tmpdir(), 'qqbot-rpc-test-'));
  const socket = process.platform === 'win32' ? `\\\\.\\pipe\\qqbot-test-${process.pid}-${Math.random().toString(36).slice(2)}` : join(dir, 'rpc.sock');
  const http = createServer(), wss = new WebSocketServer({ server: http });
  let connections = 0;
  const requests: Request[] = [];
  wss.on('connection', ws => {
    connections++;
    ws.on('message', raw => {
      const request = JSON.parse(raw.toString()) as Request;
      if (request.id === undefined) return;
      requests.push(request);
      if (request.method === 'initialize') ws.send(JSON.stringify({ id: request.id, result: {} }));
      else handle(request, ws);
    });
  });
  await new Promise<void>(resolve => http.listen(socket, resolve));
  const codex = new Codex(socket);
  t.after(async () => {
    codex.close();
    for (const ws of wss.clients) ws.terminate();
    await new Promise<void>(resolve => wss.close(() => resolve()));
    await new Promise<void>(resolve => http.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  });
  return { codex, requests, connections: () => connections };
}

test('按需跨机器读取当前轮工具详情，轮询不读详情，详情失败保留摘要', async t => {
  let failDetails = false;
  const { codex, requests } = await server(t, (req, ws) => {
    if (req.method === 'thread/items/list' && failDetails) {
      ws.send(JSON.stringify({ id: req.id, error: { code: -32601, message: 'unsupported' } })); return;
    }
    const result = req.method === 'thread/read' ? { thread: { id: 'A', status: { type: 'active' } } }
      : req.method === 'thread/turns/list' ? { data: [{ id: 'running', status: 'inProgress', items: [{ type: 'userMessage', id: 'u', content: [{ type: 'text', text: '检查日志' }] }] }] }
      : { data: [{ turnId: 'running', item: { type: 'commandExecution', id: 'cmd', command: 'tail -c 100 log', status: 'completed' } }] };
    ws.send(JSON.stringify({ id: req.id, result }));
  });
  const machines = new MachineCodex({ workstation: codex });
  await machines.snapshot('workstation:A');
  assert.equal(requests.some(r => r.method === 'thread/items/list'), false);
  const s = await machines.snapshot('workstation:A', { activity: true });
  assert.equal(s.thread.id, 'workstation:A');
  assert.equal(s.activity?.entries[0]?.item.command, 'tail -c 100 log');
  assert.equal(s.turns[0]?.items[0]?.type, 'userMessage');
  assert.deepEqual(requests.at(-1)?.params, { threadId: 'A', turnId: 'running', limit: 30, sortDirection: 'desc' });
  failDetails = true;
  const degraded = await machines.snapshot('workstation:A', { activity: true });
  assert.equal(degraded.activity?.error, 'unsupported');
  assert.equal(degraded.turns[0]?.status, 'inProgress');
});

test('附件路径和文字在同一轮提交，图片另外使用 localImage 输入', async t => {
  const { codex, requests } = await server(t, (req, ws) => ws.send(JSON.stringify({ id: req.id, result: { turn: { id: 'turn', status: 'inProgress', items: [] } } })));
  const machines = new MachineCodex({ workstation: codex });
  await machines.send('workstation:A', '查看附件', 'input', [
    { path: '/project/figure.png', name: 'figure.png', mime: 'image/png' },
    { path: '/project/report.pdf', name: 'report.pdf', mime: 'application/pdf' },
  ]);
  const params = requests.at(-1)!.params;
  assert.equal(params.threadId, 'A');
  const input = params.input as any[];
  assert.equal(input.length, 2);
  assert.match(input[0].text, /查看附件[\s\S]*figure.png: \/project\/figure.png[\s\S]*report.pdf: \/project\/report.pdf/);
  assert.deepEqual(input[1], { type: 'localImage', path: '/project/figure.png' });
});

test('关闭客户端会拒绝在途请求，后续调用不再重连', async t => {
  let entered!: () => void;
  const pending = new Promise<void>(resolve => { entered = resolve; });
  const { codex, connections } = await server(t, () => entered());
  const request = codex.request('thread/read', { threadId: 'A' });
  const rejected = assert.rejects(request, /客户端关闭/);
  await pending; codex.close(); await rejected;
  await assert.rejects(codex.request('thread/read', { threadId: 'B' }), /已关闭/);
  assert.equal(connections(), 1);
});

test('意外断线后可重连，初始化在业务请求之前完成', async t => {
  let first = true;
  const { codex, connections, requests } = await server(t, (req, ws) => {
    if (first) { first = false; ws.terminate(); }
    else ws.send(JSON.stringify({ id: req.id, result: { data: [] } }));
  });
  await assert.rejects(codex.list(), /连接断开/);
  assert.deepEqual(await codex.list(), []);
  assert.equal(connections(), 2);
  assert.deepEqual(requests.map(r => r.method), ['initialize', 'thread/list', 'initialize', 'thread/list']);
});

test('prepare 恢复原 session，send 只提交 turn/start；保留明确拒绝语义', async t => {
  const { codex, requests } = await server(t, (req, ws) => {
    if (req.method === 'turn/start') ws.send(JSON.stringify({ id: req.id, error: { code: -32602, message: 'invalid input' } }));
    else ws.send(JSON.stringify({ id: req.id, result: req.method === 'thread/read' ? { thread: { status: { type: 'notLoaded' } } } : {} }));
  });
  await codex.prepare('A');
  await assert.rejects(codex.send('A', 'task', 'input'), error => error instanceof SubmissionError && error.outcome === 'rejected');
  assert.deepEqual(requests.map(r => r.method), ['initialize', 'thread/read', 'thread/resume', 'turn/start']);
  assert.deepEqual(requests[2]!.params, { threadId: 'A', excludeTurns: true });
});

test('提交后连接断开视为 uncertain；关闭后未提交的调用可重试', async t => {
  const { codex } = await server(t, (_req, ws) => ws.terminate());
  await assert.rejects(codex.send('A', 'task', 'input'), error => error instanceof SubmissionError && error.outcome === 'uncertain');
  codex.close();
  await assert.rejects(codex.send('A', 'task', 'input'), error => error instanceof SubmissionError && error.outcome === 'retryable');
});

test('握手未完成前连接失败属于尚未提交，可以重试', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'qqbot-init-test-'));
  const http = createServer(), wss = new WebSocketServer({ server: http });
  const methods: string[] = [];
  wss.on('connection', ws => ws.on('message', raw => {
    methods.push(JSON.parse(raw.toString()).method); ws.terminate();
  }));
  const socket = process.platform === 'win32' ? `\\\\.\\pipe\\qqbot-init-${process.pid}-${Math.random().toString(36).slice(2)}` : join(dir, 'rpc.sock');
  await new Promise<void>(resolve => http.listen(socket, resolve));
  const codex = new Codex(socket);
  t.after(async () => {
    codex.close(); for (const ws of wss.clients) ws.terminate();
    await new Promise<void>(resolve => wss.close(() => resolve()));
    await new Promise<void>(resolve => http.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  });
  await assert.rejects(codex.send('A', 'task', 'id'), error => error instanceof SubmissionError && error.outcome === 'retryable');
  assert.deepEqual(methods, ['initialize']);
});
