import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConsoleApp } from '../src/console.js';
import { Store } from '../src/store.js';
import { SubmissionError } from '../src/domain.js';
import { latest, completion, splitText } from '../src/presentation.js';
import type { Button, CodexPort, Sender, Snapshot, Turn } from '../src/types.js';

const done = (id: string, text: string): Turn => ({ id, status: 'completed', items: [{ id: id + '-out', type: 'agentMessage', phase: 'final_answer', text }] });
const snapshot = (id: string): Snapshot => ({ thread: { id, cwd: '/projects/' + id, name: '任务 ' + id, updatedAt: 1, status: { type: 'idle' } }, turns: [done(id + '-old', '旧结果 ' + id)] });
class FakeCodex implements CodexPort {
  snapshots: Record<string, Snapshot> = { A: snapshot('A'), B: snapshot('B') };
  sent: { thread: string; text: string }[] = [];
  failSend = false;
  async list() { return Object.values(this.snapshots).map(s => s.thread); }
  async snapshot(id: string) { return structuredClone(this.snapshots[id]!); }
  async models(_id: string) { return []; }
  async updateSettings(id: string) { return this.snapshots[id]!.thread; }
  async prepare(_id: string) {}
  async send(id: string, text: string) {
    this.sent.push({ thread: id, text });
    if (this.failSend) throw new SubmissionError('test timeout', 'uncertain');
    const turn = { id: id + '-new-' + this.sent.length, status: 'inProgress', items: [] };
    this.snapshots[id]!.turns.unshift(turn);
    this.snapshots[id]!.thread.status = { type: 'active', activeFlags: [] };
    return turn;
  }
  async interrupt(id: string) {
    this.snapshots[id]!.turns[0]!.status = 'interrupted';
    this.snapshots[id]!.thread.status = { type: 'idle' };
  }
  finish(id: string, text: string) {
    const s = this.snapshots[id]!;
    const turnId = s.turns[0]?.status === 'inProgress' ? s.turns.shift()!.id : id + '-done-' + s.turns.length;
    s.turns.unshift(done(turnId, text)); s.thread.status = { type: 'idle' };
  }
}
class FakeSender implements Sender {
  sent: { user: string; text: string; buttons?: Button[] }[] = [];
  fail = false;
  async send(user: string, text: string, options?: { buttons?: Button[] }) {
    if (this.fail) throw new Error('QQ offline');
    this.sent.push({ user, text, buttons: options?.buttons }); return ['reply-' + this.sent.length];
  }
}
function setup(t: { after: (fn: () => void) => void }) {
  const dir = mkdtempSync(join(tmpdir(), 'qqbot-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const store = new Store(dir), codex = new FakeCodex(), sender = new FakeSender();
  return { dir, store, codex, sender, app: new ConsoleApp(store, codex, sender) };
}

test('订阅列表分页保留逐条取消按钮，取消离线会话不切换当前', async t => {
  const { app, sender, store, codex, dir } = setup(t);
  store.chat('u').current = 'A';
  for (let i = 0; i < 13; i++) store.chat('u').subscriptions[`offline${i}`] = { persistent: true, replies: [], seen: [] };
  await app.receive('u', '/订阅', 'list1');
  let buttons = sender.sent.at(-1)!.buttons!;
  assert.equal(buttons.filter(b => b.command.startsWith('/取消订阅 ')).length, 6);
  assert.ok(buttons.some(b => b.command === '/订阅 1'));
  await app.receive('u', '/订阅 2', 'list2');
  buttons = sender.sent.at(-1)!.buttons!;
  assert.ok(buttons.some(b => b.command === '/取消订阅 offline12'));
  await app.receive('u', '/取消订阅 offline12', 'cancel');
  assert.equal(store.chat('u').current, 'A');
  assert.equal(store.chat('u').subscriptions.offline12, undefined);
  assert.equal(new Store(dir).chat('u').subscriptions.offline12, undefined);
  assert.equal(codex.sent.length, 0);
});

test('仅本轮订阅也显示取消入口，点击后任务继续且后续结果不推送', async t => {
  const { app, sender, store, codex } = setup(t);
  await app.receive('u', '/选择 A', 'select');
  await app.receive('u', '继续处理', 'task');
  await app.receive('u', '/操作', 'operations');
  assert.ok(sender.sent.at(-1)!.buttons?.some(b => b.command === '/取消订阅 A'));
  assert.ok(sender.sent.at(-1)!.buttons?.some(b => b.command === '/历史 A'));
  await app.receive('u', '/取消订阅 A', 'cancel');
  assert.equal(codex.snapshots.A!.turns[0]!.status, 'inProgress');
  assert.equal(store.chat('u').current, 'A');
  const count = sender.sent.length;
  codex.finish('A', '不再订阅的回复'); await app.tick(); await app.deliver();
  assert.equal(sender.sent.length, count);
});

test('选择只查看会话，不自动订阅电脑端的后续回复', async t => {
  const { app, sender, codex } = setup(t);
  await app.receive('u', '/选择 A', '1');
  assert.match(sender.sent.at(-1)!.text, /旧结果 A/);
  await app.receive('u', '/选择 B', '2');
  const before = sender.sent.length;
  codex.finish('A', '不应投递'); await app.tick(); await app.deliver();
  assert.equal(sender.sent.length, before);
  codex.finish('B', 'B 新结果'); await app.tick(); await app.deliver(); await app.tick(); await app.deliver();
  assert.equal(sender.sent.filter(m => m.text.includes('B 新结果')).length, 0);
});

test('只接受新订阅命令，旧斜杠命令不会发给模型', async t => {
  const { app, sender, codex, store } = setup(t);
  await app.receive('u', '/选择 A', 'select');
  for (const command of ['/关注', '/固定', '/取消']) {
    await app.receive('u', command, command);
    assert.match(sender.sent.at(-1)!.text, /未知指令/);
  }
  assert.equal(codex.sent.length, 0);
  await app.receive('u', '/长期订阅', 'subscribe');
  assert.equal(store.chat('u').subscriptions.A!.persistent, true);
  await app.receive('u', '/取消订阅', 'unsubscribe');
  assert.equal(store.chat('u').subscriptions.A, undefined);
  assert.equal(store.chat('u').current, 'A');
});

test('QQ任务切换后仍订阅对应回复，送达后不再推送电脑端后续轮次', async t => {
  const { app, sender, codex, store } = setup(t);
  await app.receive('u', '/选择 A', '1');
  await app.receive('u', 'QQ任务', '2');
  await app.receive('u', '/选择 B', '3');
  codex.finish('A', '对应回复'); await app.tick(); await app.deliver();
  assert.equal(sender.sent.filter(m => m.text.includes('对应回复')).length, 1);
  assert.equal(store.chat('u').subscriptions.A?.replies?.length || 0, 0);
  codex.finish('A', '电脑新任务'); await app.tick(); await app.deliver();
  assert.equal(sender.sent.filter(m => m.text.includes('电脑新任务')).length, 0);
  assert.equal(store.chat('u').current, 'B');
});

test('单轮订阅跨重启及投递失败保留，完整送达后结束', async t => {
  const { app, sender, codex, store, dir } = setup(t);
  await app.receive('u', '/选择 A', '1'); await app.receive('u', '任务', '2');
  codex.finish('A', '持久回复'); sender.fail = true;
  await app.tick(); await app.deliver();
  assert.equal(store.chat('u').subscriptions.A!.replies!.length, 1);
  const loaded = new Store(dir);
  for (const entry of loaded.state.outbox) entry.retryAt = 0;
  const restarted = new ConsoleApp(loaded, codex, sender); sender.fail = false;
  await restarted.deliver(); await restarted.tick(); await restarted.deliver();
  assert.equal(sender.sent.filter(m => m.text.includes('持久回复')).length, 1);
  assert.equal(loaded.chat('u').subscriptions.A!.replies!.length, 0);
});

test('排队只订阅QQ提交的轮次，取消订阅不改变当前会话或重新订阅已排队任务', async t => {
  const { app, sender, codex, store } = setup(t);
  await app.receive('u', '/选择 A', '1');
  codex.snapshots.A!.turns.unshift({ id: 'desktop', status: 'inProgress', items: [] });
  codex.snapshots.A!.thread.status.type = 'active';
  await app.receive('u', '排队任务', '2');
  codex.finish('A', '桌面旧任务结束'); await app.tick(); await app.deliver();
  assert.equal(sender.sent.some(m => m.text.includes('桌面旧任务结束')), false);
  await app.receive('u', '第二条', '3');
  await app.receive('u', '/取消订阅', '4');
  assert.equal(store.chat('u').current, 'A');
  codex.finish('A', '第一条结束'); await app.tick(); await app.deliver();
  codex.finish('A', '第二条结束'); await app.tick(); await app.deliver();
  assert.equal(sender.sent.some(m => /第一条结束|第二条结束/.test(m.text)), false);
});

test('引用非当前会话自动订阅，长期订阅在QQ轮次送达后仍继续', async t => {
  const { app, sender, codex, store } = setup(t);
  await app.receive('u', '/选择 A', '1');
  const ref = 'reply-' + sender.sent.length;
  await app.receive('u', '/选择 B', '2');
  await app.receive('u', '引用任务', '3', ref);
  codex.finish('A', '引用回复'); await app.tick(); await app.deliver();
  assert.equal(sender.sent.filter(m => m.text.includes('引用回复')).length, 1);
  await app.receive('u', '/长期订阅 A', '4');
  await app.receive('u', '再次引用', '5', ref);
  codex.finish('A', 'QQ轮结束'); await app.tick(); await app.deliver();
  codex.finish('A', '电脑端第一轮'); await app.tick(); await app.deliver();
  codex.finish('A', '电脑端第二轮'); await app.tick(); await app.deliver();
  assert.equal(sender.sent.filter(m => /电脑端第[一二]轮/.test(m.text)).length, 2);
  assert.equal(store.chat('u').subscriptions.A!.persistent, true);
});

test('长期订阅可后台接收结果，普通消息仍发给当前会话，引用回复发给原会话', async t => {
  const { app, sender, codex, store } = setup(t);
  await app.receive('u', '/选择 A', '1'); await app.receive('u', '/长期订阅', '2');
  await app.receive('u', '/选择 B', '3');
  codex.finish('A', 'A 后台完成'); await app.tick(); await app.deliver();
  assert.equal(store.chat('u').current, 'B');
  const ref = 'reply-' + sender.sent.length;
  await app.receive('u', '继续 B', '4');
  await app.receive('u', '继续 A', '5', ref);
  assert.deepEqual(codex.sent, [{ thread: 'B', text: '继续 B' }, { thread: 'A', text: '继续 A' }]);
  assert.equal(store.chat('u').current, 'B');
});

test('运行中查看进度，自动推送只在本轮结束时发生', async t => {
  const { app, codex, sender } = setup(t);
  await app.receive('u', '/选择 A', '1'); await app.receive('u', '/长期订阅', 'pin');
  const s = codex.snapshots.A!;
  s.turns.unshift({ id: 'running', status: 'inProgress', items: [{ id: 'progress', type: 'agentMessage', phase: 'commentary', text: '正在排查问题' }] });
  s.thread.status = { type: 'active', activeFlags: [] };
  const before = sender.sent.length;
  await app.tick(); await app.deliver(); assert.equal(sender.sent.length, before);
  await app.receive('u', '/最新', '2'); assert.match(sender.sent.at(-1)!.text, /正在排查问题/);
  codex.finish('A', '排查完成'); await app.tick(); await app.deliver();
  assert.match(sender.sent.at(-1)!.text, /排查完成/);
});

test('选择会话和最新消息读取动向，结果入口只展示最近已结束回答', async t => {
  const { app, codex, sender } = setup(t);
  const s = codex.snapshots.A!;
  s.thread.status.type = 'active';
  s.turns.unshift({ id: 'running', status: 'inProgress', items: [{ id: 'u', type: 'userMessage', content: [{ type: 'text', text: '查看日志' }] }] });
  const read = codex.snapshot.bind(codex);
  const requests: boolean[] = [];
  codex.snapshot = async (id: string, options?: { activity?: boolean }) => {
    requests.push(Boolean(options?.activity));
    const snapshot = await read(id);
    if (options?.activity) snapshot.activity = { turnId: 'running', entries: [{ turnId: 'running', item: { id: 'cmd', type: 'commandExecution', command: 'tail -c 100 log', status: 'completed' } }] };
    return snapshot;
  };
  await app.receive('u', '/选择 A', 'activity1');
  assert.match(sender.sent.at(-1)!.text, /tail -c 100 log/);
  await app.receive('u', '/最新消息', 'activity2');
  assert.match(sender.sent.at(-1)!.text, /本轮用户要求[\s\S]*查看日志/);
  await app.receive('u', '/最后回答', 'activity3');
  assert.match(sender.sent.at(-1)!.text, /旧结果 A/);
  assert.doesNotMatch(sender.sent.at(-1)!.text, /tail -c 100 log/);
  assert.deepEqual(requests, [true, true, false]);
});

test('队列绑定接收时的 session，切换后仍发送到原目标', async t => {
  const { app, codex, store } = setup(t);
  await app.receive('u', '/选择 A', '1');
  await app.receive('u', '第一条', '2'); await app.receive('u', '第二条', '3');
  assert.equal(codex.sent.length, 1);
  await app.receive('u', '/选择 B', '4'); codex.finish('A', '第一轮完成');
  await app.tick(); await app.deliver();
  assert.deepEqual(codex.sent.at(-1), { thread: 'A', text: '第二条' });
  assert.equal(store.chat('u').current, 'B'); assert.equal(store.state.inputs.length, 0);
});

test('输入事件去重，发送超时后不重放任务', async t => {
  const { app, codex, store } = setup(t);
  await app.receive('u', '/选择 A', '1'); codex.failSend = true;
  await app.receive('u', '执行一次', '2'); await app.receive('u', '执行一次', '2');
  await app.tick(); await app.deliver(); await app.tick(); await app.deliver();
  assert.equal(codex.sent.length, 1); assert.equal(store.state.inputs[0]?.state, 'uncertain');
});

test('离线通知持久化，取消订阅后不会在恢复时补发', async t => {
  const { app, codex, sender, store, dir } = setup(t);
  await app.receive('u', '/选择 A', '1'); await app.receive('u', '/长期订阅', 'pin'); sender.fail = true;
  codex.finish('A', '待投递结果'); await app.tick(); await app.deliver();
  assert.equal(store.state.outbox.length, 1);
  const reloaded = new Store(dir); assert.equal(reloaded.state.outbox.length, 1);
  sender.fail = false;
  await app.receive('u', '/取消订阅 A', '2'); await app.deliver();
  assert.equal(store.state.outbox.length, 0);
  assert.equal(sender.sent.some(m => m.text.includes('待投递结果')), false);
});

test('重启后已投递轮次不重复，停机期间完成的关注任务会补发', async t => {
  const { app, codex, sender, dir } = setup(t);
  await app.receive('u', '/选择 A', '1'); await app.receive('u', '/长期订阅', 'pin'); codex.finish('A', '已送达'); await app.tick(); await app.deliver();
  const resumed = new ConsoleApp(new Store(dir), codex, sender);
  await resumed.tick(); await resumed.deliver(); assert.equal(sender.sent.filter(m => m.text.includes('已送达')).length, 1);
  codex.finish('A', '停机期间完成');
  const restarted = new ConsoleApp(new Store(dir), codex, sender);
  await restarted.tick(); await restarted.deliver(); assert.equal(sender.sent.filter(m => m.text.includes('停机期间完成')).length, 1);
});

test('最近两轮保持时间顺序，完成通知优先 final_answer，长文本不拆坏 emoji', () => {
  const s = snapshot('A');
  s.turns.unshift({ id: 't', status: 'completed', items: [
    { id: '1', type: 'reasoning', text: '内部推理' },
    { id: '2', type: 'agentMessage', phase: 'commentary', text: '中途进展' },
    { id: '3', type: 'agentMessage', phase: 'final_answer', text: '最终答案' },
  ] });
  const text = latest(s, 2); assert.ok(text.indexOf('旧结果 A') < text.indexOf('最终答案'));
  assert.ok(!text.includes('中途进展'));
  assert.ok(!text.includes('内部推理'));
  assert.ok(!completion(s, s.turns[0]!).includes('中途进展'));
  const chunks = splitText('a'.repeat(1699) + '🐱' + 'b'.repeat(2000));
  for (const chunk of chunks) assert.ok(!/[\uD800-\uDBFF]$/.test(chunk));
});

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

test('查询发送失败保留完成通知；恢复后查询和通知均有持久化记录', async t => {
  const { app, codex, sender, store, dir } = setup(t);
  await app.receive('u', '/选择 A', '1'); await app.receive('u', '/长期订阅', 'pin');
  codex.finish('A', '重要结果'); sender.fail = true;
  await app.tick(); await app.deliver();
  await app.receive('u', '/最新', '2');
  assert.equal(store.state.outbox.filter(e => e.kind === 'notification').length, 1);
  assert.equal(store.state.outbox.filter(e => e.kind === 'reply').length, 1);
  const recovered = new Store(dir);
  for (const entry of recovered.state.outbox) entry.retryAt = 0;
  sender.fail = false;
  const restarted = new ConsoleApp(recovered, codex, sender);
  await restarted.deliver();
  assert.ok(sender.sent.some(m => m.text.includes('重要结果')));
  assert.equal(recovered.state.outbox.length, 0);
});

test('查询最新只确认完整展示的轮次，不清除其他未读结果', async t => {
  const { app, codex, store } = setup(t);
  await app.receive('u', '/选择 A', '1'); await app.receive('u', '/长期订阅', 'pin');
  codex.finish('A', '较早的未读结果'); codex.finish('A', '最新结果');
  await app.tick();
  for (const entry of store.state.outbox) entry.retryAt = Date.now() + 60000;
  await app.receive('u', '/最新', '2');
  assert.equal(store.state.outbox.length, 1);
  assert.match(store.state.outbox[0]!.text, /较早的未读结果/);
});

test('已结束会话展示所有 final_answer，投递后确认整轮通知', async t => {
  const { app, codex, store } = setup(t);
  await app.receive('u', '/选择 A', '1'); await app.receive('u', '/长期订阅', 'pin');
  codex.snapshots.A!.turns.unshift({ id: 'multi', status: 'completed', items: [
    { id: 'part1', type: 'agentMessage', phase: 'final_answer', text: '回答上半部分' },
    { id: 'part2', type: 'agentMessage', phase: 'final_answer', text: '回答下半部分' },
  ] });
  await app.tick();
  store.state.outbox[0]!.retryAt = Date.now() + 60000;
  await app.receive('u', '/最新消息', '2');
  assert.equal(store.state.outbox.length, 0);
});

test('长查询逐段持久化，第二段失败后重启从该段继续并保留引用路由', async t => {
  const { app, codex, sender, store, dir } = setup(t);
  codex.snapshots.A!.turns = [done('long', '长'.repeat(4000))];
  const send = sender.send.bind(sender);
  let attempts = 0;
  sender.send = async (user, text) => {
    if (++attempts === 2) throw new Error('第二段网络失败');
    return send(user, text);
  };
  await app.receive('u', '/选择 A', '1');
  assert.equal(sender.sent.length, 1);
  assert.equal(store.state.outbox[0]!.part, 1);
  assert.equal(store.state.refs['reply-1']?.thread, 'A');
  const recovered = new Store(dir);
  recovered.state.outbox[0]!.retryAt = 0;
  const restarted = new ConsoleApp(recovered, codex, sender);
  await restarted.deliver();
  assert.equal(sender.sent.length, 3);
  assert.equal(sender.sent.filter(m => m.text.startsWith('(1/3)')).length, 1);
  assert.equal(recovered.state.outbox.length, 0);
});

test('提交前读取失败保留 queued，恢复后自动发送一次', async t => {
  const { app, codex, store } = setup(t);
  await app.receive('u', '/选择 A', '1');
  const read = codex.snapshot.bind(codex);
  codex.snapshot = async () => { throw new Error('暂时离线'); };
  await app.receive('u', '需要执行的任务', '2');
  assert.equal(store.state.inputs[0]!.state, 'queued');
  assert.equal(codex.sent.length, 0);
  codex.snapshot = read;
  await app.tick(); await app.tick();
  assert.equal(codex.sent.length, 1);
  assert.equal(store.state.inputs.length, 0);
});

test('prepare 失败不进入 sending，明确拒绝与未知结果分别保留', async t => {
  const { app, codex, store } = setup(t);
  await app.receive('u', '/选择 A', '1');
  codex.prepare = async () => { throw new Error('resume failed'); };
  await app.receive('u', '任务', '2');
  assert.equal(store.state.inputs[0]!.state, 'queued');
  assert.equal(codex.sent.length, 0);
  codex.prepare = async () => {};
  codex.send = async () => { throw new SubmissionError('invalid input', 'rejected'); };
  await app.tick();
  assert.equal(store.state.inputs[0]!.state, 'rejected');
  await app.receive('u', '/清空队列', '3');
  assert.equal(store.state.inputs.length, 0);
});

test('停止等待正在提交的任务，然后中断新轮次并清空后续队列', async t => {
  const { app, codex, store, sender } = setup(t);
  await app.receive('u', '/选择 A', '1');
  store.state.inputs.push({ id: 'q1', user: 'u', thread: 'A', text: '正在发送', state: 'queued' });
  store.state.inputs.push({ id: 'q2', user: 'u', thread: 'A', text: '后续任务', state: 'queued' });
  const entered = deferred(), release = deferred();
  const send = codex.send.bind(codex);
  codex.send = async (id, text) => { entered.resolve(); await release.promise; return send(id, text); };
  const polling = app.tick(); await entered.promise;
  const stopping = app.receive('u', '/停止', '2');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(sender.sent.length, 1);
  release.resolve(); await polling; await stopping;
  assert.equal(codex.snapshots.A!.turns[0]!.status, 'interrupted');
  assert.equal(store.state.inputs.length, 0);
  assert.equal(codex.sent.length, 1);
  assert.match(sender.sent.at(-1)!.text, /已请求中断/);
});

test('退出时尚未处理的入站指令持久化，恢复后只提交一次', async t => {
  const { app, codex, store, sender, dir } = setup(t);
  await app.receive('u', '/选择 A', '1');
  const receiving = app.receive('u', '重启窗口内的任务', '2');
  const shutdown = app.shutdown();
  await receiving; await shutdown;
  assert.equal(store.state.inbox.length, 1);
  assert.equal(store.state.received.includes('u:2'), false);
  const recovered = new Store(dir), restarted = new ConsoleApp(recovered, codex, sender);
  await restarted.recover();
  await restarted.receive('u', '重启窗口内的任务', '2');
  assert.equal(codex.sent.length, 1);
  assert.equal(recovered.state.inbox.length, 0);
});

test('恢复停止请求只中断原轮次，不会误停新轮次', async t => {
  const { app, codex, store, sender, dir } = setup(t);
  await app.receive('u', '/选择 A', '1');
  store.state.inbox.push({ id: 'u:2', user: 'u', text: '/停止', messageId: '2', stopTarget: { thread: 'A', turn: 'old-running' } });
  store.save();
  const interrupted: string[] = [];
  codex.interrupt = async (_id: string, turn?: string) => { interrupted.push(turn!); };
  const restarted = new ConsoleApp(new Store(dir), codex, sender);
  await restarted.recover();
  assert.deepEqual(interrupted, ['old-running']);
});

test('退出等待在途读取结束，之后不准备会话、不提交、不处理新消息', async t => {
  const { app, codex, store } = setup(t);
  await app.receive('u', '/选择 A', '1');
  store.state.inputs.push({ id: 'q', user: 'u', thread: 'A', text: '保留到重启', state: 'queued' });
  const entered = deferred(), release = deferred<Snapshot>();
  codex.snapshot = async () => { entered.resolve(); return release.promise; };
  const tick = app.tick(); await entered.promise;
  let stopped = false;
  const shutdown = app.shutdown().then(() => { stopped = true; });
  await Promise.resolve(); assert.equal(stopped, false);
  release.resolve(snapshot('A')); await tick; await shutdown;
  await app.receive('u', '不能再接收', '3'); await app.tick();
  assert.equal(codex.sent.length, 0);
  assert.equal(store.state.inputs.length, 1);
  assert.equal(store.state.inbox.length, 0);
});

test('QQ 投递阻塞不阻塞轮询和另一个会话的排队任务', async t => {
  const { app, codex, sender, store } = setup(t);
  await app.receive('u', '/选择 A', '1'); await app.receive('u', '/长期订阅', 'pin');
  const entered = deferred(), release = deferred();
  const send = sender.send.bind(sender);
  sender.send = async (user, text) => { entered.resolve(); await release.promise; return send(user, text); };
  codex.finish('A', '长回答'); await app.tick();
  const delivery = app.deliver(); await entered.promise;
  store.state.inputs.push({ id: 'q', user: 'u', thread: 'B', text: '继续 B', state: 'queued' });
  await app.tick();
  assert.equal(codex.sent[0]?.thread, 'B');
  release.resolve(); await delivery;
});

test('一个会话读取缓慢时，其他会话仍能发现结果', async t => {
  const { app, codex, store } = setup(t);
  await app.receive('u', '/选择 A', '1'); await app.receive('u', '/长期订阅', '2');
  await app.receive('u', '/选择 B', '3'); await app.receive('u', '/长期订阅', 'pinB');
  const release = deferred<Snapshot>(); const read = codex.snapshot.bind(codex);
  codex.snapshot = id => id === 'A' ? release.promise : read(id);
  codex.finish('B', 'B 已完成');
  const polling = app.tick(); await new Promise(resolve => setImmediate(resolve));
  assert.ok(store.state.outbox.some(entry => entry.text.includes('B 已完成')));
  release.resolve(snapshot('A')); await polling;
});

test('固定当前会话不把刚完成但尚未轮询的结果当作历史', async t => {
  const { app, codex, sender } = setup(t);
  await app.receive('u', '/选择 A', '1');
  await app.receive('u', 'QQ任务', 'task');
  codex.finish('A', '刚刚完成');
  await app.receive('u', '/长期订阅', '2');
  await app.tick(); await app.deliver();
  assert.equal(sender.sent.filter(m => m.text.includes('刚刚完成')).length, 1);
});

test('空中断快照和运行中会话的冲突状态不推送、不吞掉同轮后续完成', async t => {
  const { app, codex, sender, store } = setup(t);
  await app.receive('u', '/选择 A', 'select'); await app.receive('u', '/长期订阅', 'pin');
  const s = codex.snapshots.A!;
  s.thread.status.type = 'active';
  s.turns.unshift({ id: 'race', status: 'interrupted', items: [] });
  const count = sender.sent.length;
  await app.tick(); await app.deliver();
  assert.equal(sender.sent.length, count);
  assert.ok(!store.chat('u').subscriptions.A!.seen.includes('race'));
  s.turns[0]!.items = [{ id: 'u', type: 'userMessage', content: [{ type: 'text', text: '继续工作' }] }];
  await app.tick(); await app.deliver();
  assert.equal(sender.sent.length, count);
  s.turns[0]!.status = 'inProgress';
  await app.tick(); await app.deliver();
  assert.equal(sender.sent.length, count);
  codex.finish('A', '正常完成');
  await app.tick(); await app.deliver(); await app.tick(); await app.deliver();
  assert.equal(sender.sent.filter(message => message.text.includes('正常完成')).length, 1);
  assert.equal(store.chat('u').subscriptions.A!.terminalStatuses?.race, 'completed');
});

test('真实中断仍通知，重启后同轮状态变为完成会再次通知正确结果', async t => {
  const { app, codex, sender, store, dir } = setup(t);
  await app.receive('u', '/选择 A', 'select'); await app.receive('u', '/长期订阅', 'pin');
  const s = codex.snapshots.A!;
  s.turns.unshift({ id: 'changed', status: 'interrupted', items: [{ id: 'u', type: 'userMessage', content: [{ type: 'text', text: '原始要求' }] }] });
  await app.tick(); await app.deliver();
  assert.match(sender.sent.at(-1)!.text, /该轮已中断[\s\S]*原始要求/);
  assert.equal(store.chat('u').subscriptions.A!.terminalStatuses?.changed, 'interrupted');
  const recovered = new Store(dir), restarted = new ConsoleApp(recovered, codex, sender);
  s.turns[0]!.status = 'completed';
  s.turns[0]!.items.push({ id: 'final', type: 'agentMessage', phase: 'final_answer', text: '实际完成结果' });
  await restarted.tick(); await restarted.deliver(); await restarted.tick(); await restarted.deliver();
  assert.equal(sender.sent.filter(message => message.text.includes('实际完成结果')).length, 1);
  assert.equal(recovered.chat('u').subscriptions.A!.terminalStatuses?.changed, 'completed');
});

test('同轮新结论替换尚未投递的旧通知，真正失败仍保留错误信息', async t => {
  const { app, codex, sender, store } = setup(t);
  await app.receive('u', '/选择 A', 'select'); await app.receive('u', '/长期订阅', 'pin');
  const s = codex.snapshots.A!;
  s.turns.unshift({ id: 'changed', status: 'failed', error: { message: '连接失败' }, items: [] });
  await app.tick();
  assert.match(store.state.outbox[0]!.text, /连接失败/);
  s.turns[0] = done('changed', '恢复后的结果');
  await app.tick();
  assert.equal(store.state.outbox.length, 1);
  assert.match(store.state.outbox[0]!.text, /恢复后的结果/);
  assert.doesNotMatch(store.state.outbox[0]!.text, /连接失败/);
  await app.deliver();
  assert.equal(sender.sent.filter(message => message.text.includes('恢复后的结果')).length, 1);
});

test('逐条移除队列不影响其他指令，引用消息绕过目录搜索', async t => {
  const { app, codex, store, sender } = setup(t);
  await app.receive('u', '/选择 A', 'select');
  const ref = 'reply-' + sender.sent.length;
  await app.receive('u', 'first', 'first');
  await app.receive('u', 'second', 'second');
  await app.receive('u', 'third', 'third');
  const queued = store.state.inputs.find(i => i.text === 'second')!;
  await app.receive('u', '/取消指令 ' + queued.id, 'cancel');
  assert.deepEqual(store.state.inputs.map(i => i.text), ['third']);
  store.chat('u').creationMenu = { token: 'directory', machine: 'local', choices: [], query: '', page: 0 };
  await app.receive('u', '引用任务', 'ref', ref);
  assert.ok(store.state.inputs.some(i => i.text === '引用任务' && i.thread === 'A'));
  assert.equal(store.chat('u').creationMenu, undefined);
});
