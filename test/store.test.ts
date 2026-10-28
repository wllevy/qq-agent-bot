import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { emptyState, Store } from '../src/store.js';

function directory(t: { after: (fn: () => void) => void }) {
  const dir = mkdtempSync(join(tmpdir(), 'qqbot-store-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('消息订阅状态保留引用、队列和分段进度；sending 恢复为 uncertain', t => {
  const dir = directory(t);
  const state = { ...emptyState(), version: 4, inbox: [],
    chats: { u: { current: 'A', menu: ['A'], page: 0, subscriptions: { A: { persistent: true, replies: [], seen: ['old'] } } } },
    refs: { ref: { user: 'u', thread: 'A' } },
    inputs: [{ id: 'input', user: 'u', thread: 'A', text: 'task', state: 'sending' }],
    outbox: [{ kind: 'notification', id: 'out', user: 'u', thread: 'A', turn: 'old', text: 'ab', parts: ['a', 'b'], part: 1, attempts: 1, retryAt: 0 }],
  };
  writeFileSync(join(dir, 'state.json'), JSON.stringify(state));
  const store = new Store(dir);
  assert.equal(store.state.version, 4);
  assert.deepEqual(store.state.inbox, []);
  assert.equal(store.state.chats.u!.current, 'A');
  assert.equal(store.state.refs.ref!.thread, 'A');
  assert.equal(store.state.inputs[0]!.state, 'uncertain');
  assert.equal(store.state.outbox[0]!.kind, 'notification');
  assert.equal(store.state.outbox[0]!.part, 1);
  assert.deepEqual(new Store(dir).state, store.state);
});

test('状态损坏时拒绝加载且不覆盖原文件', t => {
  const dir = directory(t), path = join(dir, 'state.json');
  for (const value of [null, { ...emptyState(), inbox: [{}] }, { ...emptyState(), chats: { u: {} } }]) {
    const text = JSON.stringify(value);
    writeFileSync(path, text);
    assert.throws(() => new Store(dir), /状态文件结构/);
    assert.equal(readFileSync(path, 'utf8'), text);
  }
});

test('状态没有变化时不重写文件', t => {
  const dir = directory(t), store = new Store(dir);
  const path = join(dir, 'state.json');
  const before = statSync(path, { bigint: true });
  store.save(); store.save();
  const after = statSync(path, { bigint: true });
  assert.equal(after.ino, before.ino);
  assert.equal(after.mtimeNs, before.mtimeNs);
});
