import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Codex } from '../src/codex.js';
import { MachineCodex } from '../src/machines.js';
import { ConsoleApp } from '../src/console.js';
import { Store } from '../src/store.js';
import type { CodexPort, ModelSettings, Thread } from '../src/types.js';

function backend(name: string) {
  const threads: Thread[] = [
    { id: 'old', cwd: `F:\\home\\${name}\\projects\\demo`, updatedAt: 100, status: { type: 'idle' }, model: 'model-a', reasoningEffort: 'high' },
    { id: 'duplicate', cwd: `F:\\home\\${name}\\projects\\demo`, updatedAt: 90, status: { type: 'idle' } },
    ...Array.from({ length: 9 }, (_, i) => ({ id: `t${i}`, cwd: `F:\\home\\${name}\\projects\\work ${i}`, updatedAt: 80 - i, status: { type: 'idle' } })),
  ];
  const created: { cwd: string; settings?: ModelSettings }[] = [];
  let offline = false;
  const client: CodexPort = {
    async list() { if (offline) throw new Error('offline'); return structuredClone(threads); },
    async snapshot(id) { if (offline) throw new Error('offline'); return { thread: structuredClone(threads.find(t => t.id === id)!), turns: [] }; },
    async create(_machine, cwd, _requestId, _sourceId, settings) {
      if (offline) throw new Error('offline');
      if (cwd === '/missing') throw new Error('not a directory');
      if (!cwd) throw new Error('missing cwd');
      created.push({ cwd, settings });
      const thread = { id: 'new-' + created.length, cwd, updatedAt: 101, status: { type: 'idle' }, model: settings?.model || 'default-model', reasoningEffort: settings?.effort || 'medium' };
      threads.unshift(thread); return thread;
    },
    async models() { return []; }, async updateSettings() { return threads[0]!; },
    async prepare() {}, async send() { throw new Error('creating must not start a turn'); }, async interrupt() {},
  };
  return { client, created, offline: (value: boolean) => { offline = value; } };
}
function setup(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'qqbot-creation-'));
  const local = backend('workstation'), remote = backend('remote');
  const codex = new MachineCodex({ remote: remote.client, workstation: local.client });
  const store = new Store(directory), replies: { text: string; buttons?: { label: string; command: string }[] }[] = [];
  const sender = { async send(_user: string, text: string, options?: any) { replies.push({ text, buttons: options?.buttons }); return ['r' + replies.length]; } };
  const app = new ConsoleApp(store, codex, sender);
  t.after(async () => { await app.shutdown();  });
  return { directory, local, remote, codex, store, replies, sender, app };
}

test('同目录新建继承源机器模型，不复制上下文，创建成功才切换且消息去重', async t => {
  const h = setup(t);
  await h.app.receive('u', '/选择 remote:old', 'select');
  await h.app.receive('u', '/同目录新建 workstation:old', 'create');
  assert.equal(h.store.chat('u').current, 'workstation:new-1');
  assert.deepEqual(h.local.created, [{ cwd: "F:\\home\\workstation\\projects\\demo", settings: { model: 'model-a', effort: 'high' } }]);
  assert.equal(h.remote.created.length, 0);
  assert.match(h.replies.at(-1)!.text, /空白会话[\s\S]*model-a[\s\S]*high/);
  assert.deepEqual(h.store.chat('u').menu, []);
  await h.app.receive('u', '/同目录新建 workstation:old', 'create');
  assert.equal(h.local.created.length, 1);
});

test('最近目录去重，搜索及翻页只浏览，编号与按钮创建准确路径', async t => {
  const h = setup(t);
  await h.app.receive('u', '/选择 workstation:old', 'select');
  await h.app.receive('u', '/新会话 remote', 'menu');
  assert.equal(h.store.chat('u').current, 'workstation:old');
  assert.equal(h.store.chat('u').creationMenu!.choices.length, 10);
  const oldButton = h.replies.at(-1)!.buttons![0]!.command;
  const next = h.replies.at(-1)!.buttons!.find(b => b.label === '下一页')!.command;
  await h.app.receive('u', next, 'page');
  assert.equal(h.store.chat('u').creationMenu!.page, 1);
  await h.app.receive('u', oldButton, 'stale');
  assert.match(h.replies.at(-1)!.text, /菜单已失效/);
  assert.equal(h.remote.created.length, 0);
  await h.app.receive('u', 'work 8', 'search');
  assert.deepEqual(h.store.chat('u').creationMenu!.choices, ["F:\\home\\remote\\projects\\work 8"]);
  await h.app.receive('u', '1', 'choose');
  assert.equal(h.remote.created[0]!.cwd, "F:\\home\\remote\\projects\\work 8");
  assert.equal(h.store.chat('u').current, 'remote:new-1');
});

test('离线展示持久化目录，失败不切换、不排队；原有命令能退出创建菜单', async t => {
  const h = setup(t);
  await h.app.receive('u', '/选择 workstation:old', 'select');
  await h.app.receive('u', '/新会话 remote', 'menu');
  h.remote.offline(true);
  await h.app.receive('u', '/新会话 remote', 'offline');
  assert.match(h.replies.at(-1)!.text, /缓存目录/);
  await h.app.receive('u', '1', 'choose');
  assert.equal(h.store.chat('u').current, 'workstation:old');
  assert.match(h.replies.at(-1)!.text, /不会自动重试/);
  assert.equal(h.store.state.inputs.length, 0);
  h.remote.offline(false);
  await h.app.tick();
  assert.equal(h.remote.created.length, 0);
  await h.app.receive('u', '/帮助', 'help');
  assert.equal(h.store.chat('u').creationMenu, undefined);
  assert.match(h.replies.at(-1)!.text, /编程助手中控台/);
  const loaded = new Store(h.directory);
  assert.equal(loaded.state.directories?.remote?.length, 10);
  await h.app.receive('u', '/新会话 workstation /missing', 'missing');
  assert.equal(h.store.chat('u').current, 'workstation:old');
});

test('首次先选机器，可手输含空格路径，重启不重放未知创建', async t => {
  const h = setup(t);
  await h.app.receive('u', '/新会话', 'menu');
  assert.equal(h.store.chat('u').creationMenu?.machine, undefined);
  await h.app.receive('u', '2', 'machine');
  assert.equal(h.store.chat('u').creationMenu?.machine, 'workstation');
  await h.app.receive('u', "F:\\home\\workstation\\new project", 'path');
  assert.equal(h.local.created[0]!.cwd, "F:\\home\\workstation\\new project");
  h.store.state.inbox.push({ id: 'u:unknown', user: 'u', text: '/新会话 remote /somewhere', messageId: 'unknown', creation: { machine: 'remote', cwd: '/somewhere' } });
  h.store.save();
  const restarted = new ConsoleApp(new Store(h.directory), h.codex, h.sender);
  await restarted.recover(); await restarted.deliver();
  assert.equal(h.remote.created.length, 0);
  assert.match(h.replies.at(-1)!.text, /未自动重复创建/);
  await restarted.shutdown();
});

test('Codex 创建前验证目录，thread/start 一次传入 cwd、模型和推理强度', async () => {
  class Stub extends Codex {
    requests: { method: string; params: any }[] = [];
    constructor() { super('/unused'); }
    override async request<T = any>(method: string, params: any = {}): Promise<T> {
      this.requests.push({ method, params });
      if (method === 'command/exec') return { exitCode: 0, stdout: "F:\\home\\remote\n" } as T;
      if (method === 'fs/getMetadata') return { isDirectory: params.path !== "F:\\file.txt" } as T;
      if (method === 'thread/start') return { thread: { id: 'new', cwd: params.cwd, status: { type: 'idle' } }, model: params.model || 'default', reasoningEffort: params.config?.model_reasoning_effort || 'medium' } as T;
      throw new Error('unexpected ' + method);
    }
  }
  const codex = new Stub();
  await assert.rejects(codex.create('remote', "F:\\file.txt", 'req'), /不是目录/);
  assert.equal(codex.requests.some(r => r.method === 'thread/start'), false);
  const thread = await codex.create('remote', '~/my project', 'req', undefined, { model: 'chosen', effort: 'high' });
  assert.equal(thread.cwd, "F:\\home\\remote\\my project");
  assert.equal(thread.reasoningEffort, 'high');
  assert.deepEqual(codex.requests.at(-1), { method: 'thread/start', params: { cwd: "F:\\home\\remote\\my project", model: 'chosen', config: { model_reasoning_effort: 'high' } } });
});

test('搜索保留分页条件，新建入口绑定原会话，菜单状态互斥', async t => {
  const h = setup(t);
  await h.app.receive('u', '/选择 workstation:old', 'select');
  await h.app.receive('u', '/搜索会话 remote work', 'search');
  assert.equal(h.store.chat('u').menu.length, 9);
  await h.app.receive('u', '/下一页 remote', 'page');
  assert.equal(h.store.chat('u').menuQuery, 'work');
  assert.equal(h.store.chat('u').page, 1);
  await h.app.receive('u', '/新建会话 remote:old', 'new');
  assert.ok(h.replies.at(-1)!.buttons!.some(b => b.command === '/同目录新建 remote:old'));
  assert.equal(h.store.chat('u').current, 'workstation:old');
  assert.deepEqual(h.store.chat('u').menu, []);
});

test('历史游标及操作菜单始终绑定查看的会话', async t => {
  const h = setup(t); const reads: string[] = [];
  h.remote.client.history = async (id, cursor) => { reads.push(id + ':' + (cursor || '')); return { turns: [], nextCursor: cursor ? null : 'page/2' }; };
  await h.app.receive('u', '/选择 workstation:old', 'select');
  await h.app.receive('u', '/历史 remote:old', 'history');
  const next = h.replies.at(-1)!.buttons!.find(b => b.label === '更早对答')!.command;
  await h.app.receive('u', next, 'next');
  assert.deepEqual(reads, ['old:', 'old:page/2']);
  await h.app.receive('u', '/操作 remote:old', 'ops');
  assert.ok(h.replies.at(-1)!.buttons!.some(b => b.command === '/长期订阅 remote:old'));
  assert.equal(h.store.chat('u').current, 'workstation:old');
});
