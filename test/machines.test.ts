import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MachineCodex } from '../src/machines.js';
import { ConsoleApp } from '../src/console.js';
import { emptyState, Store } from '../src/store.js';
import type { CodexPort, Snapshot, Sender } from '../src/types.js';

function backend(): CodexPort & { offline: boolean; sent: string[] } {
  const snapshot: Snapshot = { thread: { id: 'same-id', name: '项目', cwd: '/project', updatedAt: 1, status: { type: 'idle' } }, turns: [] };
  return {
    offline: false, sent: [],
    async list() { if (this.offline) throw new Error('offline'); return [structuredClone(snapshot.thread)]; },
    async snapshot() { if (this.offline) throw new Error('offline'); return structuredClone(snapshot); },
    async models() { return []; },
    async updateSettings() { return structuredClone(snapshot.thread); },
    async prepare() {},
    async send(id, text) { this.sent.push(id + ':' + text); return { id: 'turn', status: 'inProgress', items: [] }; },
    async interrupt() {},
  };
}

test('机器菜单只改变浏览位置，选择会话、旧按钮和引用按所属机器路由；离线可返回', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'qqbot-machines-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const workstation = backend(), remoteBackend = backend();
  const codex = new MachineCodex({ remote: remoteBackend, workstation });
  const sent: string[] = [];
  const sender: Sender = { async send(_user, text) { sent.push(text); return ['r' + sent.length]; } };
  const store = new Store(dir), app = new ConsoleApp(store, codex, sender);
  await app.receive('u', '/选择 workstation:same-id', '1');
  const reference = 'r' + sent.length;
  await app.receive('u', '/会话', '2');
  assert.deepEqual(store.chat('u').menu, ['remote', 'workstation']);
  await app.receive('u', '1', '3');
  assert.equal(store.chat('u').current, 'workstation:same-id');
  assert.deepEqual(store.chat('u').menu, ['remote:same-id']);
  await app.receive('u', '1', '4');
  await app.receive('u', '服务器任务', '5');
  await app.receive('u', '电脑任务', '6', reference);
  assert.deepEqual(remoteBackend.sent, ['same-id:服务器任务']);
  assert.deepEqual(workstation.sent, ['same-id:电脑任务']);
  assert.equal(store.chat('u').current, 'remote:same-id');
  await app.receive('u', '/选择 workstation:same-id', '7');
  assert.equal(store.chat('u').current, 'workstation:same-id');
  workstation.offline = true;
  await app.receive('u', '/机器 workstation', '8');
  assert.match(sent.at(-1)!, /workstation.*关机/);
  assert.equal(store.chat('u').current, 'workstation:same-id');
  assert.deepEqual(store.chat('u').menu, []);
  await app.receive('u', '/机器 remote', '9');
  assert.match(sent.at(-1)!, /会话 · remote/);
});

test('旧状态版本拒绝加载，不隐式兼容旧关注机制', t => {
  const dir = mkdtempSync(join(tmpdir(), 'qqbot-old-state-'));
  writeFileSync(join(dir, 'state.json'), JSON.stringify({ ...emptyState(), version: 3 }));
  assert.throws(() => new Store(dir), /状态文件结构/);
});
