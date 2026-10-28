import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Codex } from '../src/codex.js';
import { MachineCodex } from '../src/machines.js';
import { ConsoleApp } from '../src/console.js';
import { Store } from '../src/store.js';
import type { ModelOption, Thread } from '../src/types.js';

const catalog: ModelOption[] = [
  { id: 'a', model: 'model-a', displayName: 'A', defaultReasoningEffort: 'low', supportedReasoningEfforts: [{ reasoningEffort: 'low' }, { reasoningEffort: 'high' }] },
  { id: 'b', model: 'model-b', displayName: 'B', defaultReasoningEffort: 'medium', supportedReasoningEfforts: [{ reasoningEffort: 'medium' }, { reasoningEffort: 'high' }] },
];
class SettingsCodex extends Codex {
  thread: Thread = { id: 'session', name: '测试会话', cwd: '/test', updatedAt: 1, status: { type: 'active' }, model: 'model-a', reasoningEffort: 'low' };
  updates: Record<string, unknown>[] = [];
  constructor() { super('/unused'); }
  override async request<T = any>(method: string, params: any = {}): Promise<T> {
    if (method === 'model/list') return { data: catalog, nextCursor: null } as T;
    if (method === 'thread/list') return { data: [structuredClone(this.thread)] } as T;
    if (method === 'thread/read') return { thread: structuredClone(this.thread) } as T;
    if (method === 'thread/turns/list') return { data: [] } as T;
    if (method === 'thread/settings/update') {
      this.updates.push(params);
      if (params.model) this.thread.model = params.model;
      if (params.effort) this.thread.reasoningEffort = params.effort;
      return {} as T;
    }
    throw new Error(`Unexpected RPC ${method}`);
  }
}

test('修改原会话模型与强度，保留兼容强度、不兼容时采用默认，并拒绝无效强度', async () => {
  const codex = new SettingsCodex();
  let updated = await codex.updateSettings('session', { model: 'model-b' });
  assert.equal(updated.reasoningEffort, 'medium');
  assert.deepEqual(codex.updates[0], { threadId: 'session', model: 'model-b', effort: 'medium' });
  await codex.updateSettings('session', { effort: 'high' });
  updated = await codex.updateSettings('session', { model: 'model-a' });
  assert.equal(updated.reasoningEffort, 'high');
  const count = codex.updates.length;
  await assert.rejects(codex.updateSettings('session', { effort: 'ultra' }), /不支持/);
  assert.equal(codex.updates.length, count);
  assert.equal(updated.status.type, 'active');
});

test('选择会话展示模型和强度；菜单编号与旧消息按钮保持原机器、原会话路由', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'qqbot-settings-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const local = new SettingsCodex(), remote = new SettingsCodex();
  const store = new Store(dir);
  const replies: { text: string; options?: any }[] = [];
  const app = new ConsoleApp(store, new MachineCodex({ remote: remote, workstation: local }), {
    async send(_user, text, options) { replies.push({ text, options }); return ['r' + replies.length]; },
  });
  await app.receive('u', '/选择 remote:session', '1');
  assert.match(replies.at(-1)!.text, /模型：model-a\n推理强度：low/);
  await app.receive('u', '/设置 remote:session', 'settings-page');
  assert.ok(replies.at(-1)!.options.buttons.some((b: any) => b.command === '/模型 remote:session'));
  await app.receive('u', '/模型', '2');
  await app.receive('u', '2', '3');
  assert.equal(remote.thread.model, 'model-b');
  assert.equal(remote.thread.reasoningEffort, 'medium');
  await app.receive('u', '/推理强度', '4');
  await app.receive('u', '2', '5');
  assert.equal(remote.thread.reasoningEffort, 'high');
  await app.receive('u', '/选择 workstation:session', '6');
  await app.receive('u', '/设置模型 remote:session model-a', '7');
  assert.equal(remote.thread.model, 'model-a');
  assert.equal(remote.thread.reasoningEffort, 'high');
  assert.equal(local.thread.reasoningEffort, 'low');
  assert.equal(store.chat('u').current, 'workstation:session');
  await app.receive('u', '/模型 remote:session', '8');
  await app.receive('u', '/设置模型 model-b', '9');
  assert.equal(remote.thread.model, 'model-b');
  assert.equal(local.thread.model, 'model-a');
});
