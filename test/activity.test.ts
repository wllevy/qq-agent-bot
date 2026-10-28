import { test } from 'node:test';
import assert from 'node:assert/strict';
import { latestView, answerView, recentView, completion } from '../src/presentation.js';
import type { Snapshot } from '../src/types.js';

function running(): Snapshot {
  return {
    thread: { id: 'A', cwd: '/project', updatedAt: 1, status: { type: 'active' }, model: 'chosen-model', reasoningEffort: 'high' },
    turns: [
      { id: 'now', status: 'inProgress', items: [{ id: 'request', type: 'userMessage', content: [{ type: 'text', text: '检查训练进度' }] }] },
      { id: 'old', status: 'completed', items: [{ id: 'answer', type: 'agentMessage', phase: 'final_answer', text: '训练已启动' }] },
    ],
    activity: { turnId: 'now', entries: [
      { turnId: 'now', item: { id: 'reason', type: 'reasoning' }, completedAtMs: Date.now() },
      { turnId: 'now', item: { id: 'cmd', type: 'commandExecution', command: 'tail -c 1000 train.log', status: 'completed', exitCode: 0 }, completedAtMs: Date.now() - 1000 },
      { turnId: 'now', item: { id: 'tool', type: 'mcpToolCall', tool: 'exec', server: 'remote', status: 'inProgress', arguments: { cmd: 'python train.py' } }, startedAtMs: Date.now() - 2000 },
    ] },
  };
}

test('运行中展示命令状态、时间、本轮要求和上一轮上下文，回答另有入口', () => {
  const s = running(), view = latestView(s);
  assert.match(view.text, /已完成 · 命令 `tail -c 1000 train.log`/);
  assert.match(view.text, /执行中 · 工具 `remote\/exec` · `python train.py`/);
  assert.match(view.text, /最近记录：.*秒前/);
  assert.match(view.text, /本轮用户要求[\s\S]*检查训练进度/);
  assert.match(view.text, /上一轮对答（上下文）[\s\S]*训练已启动/);
  assert.ok(view.text.indexOf('tail -c') < view.text.indexOf('训练已启动'));
  assert.deepEqual(view.acknowledge, []);
  const answer = answerView(s);
  assert.match(answer.text, /训练已启动/);
  assert.doesNotMatch(answer.text, /tail -c|检查训练进度/);
  assert.deepEqual(answer.acknowledge, ['old']);
});

test('无新操作或读取失败时明确说明，不把上一轮操作显示为本轮进度', () => {
  const s = running();
  s.activity = { turnId: 'old', entries: s.activity!.entries };
  assert.match(latestView(s).text, /尚无可展示的操作记录/);
  assert.doesNotMatch(latestView(s).text, /tail -c/);
  s.activity = { turnId: 'now', entries: [], error: 'unsupported' };
  assert.match(latestView(s).text, /工具动向暂时读取失败/);
});

test('结束后展示完整最终回答及失败信息，长历史上下文只给节选', () => {
  const s = running();
  s.turns[1]!.items[0]!.text = '旧'.repeat(2000);
  assert.match(latestView(s).text, /已截取/);
  assert.equal(answerView(s).text.includes('旧'.repeat(2000)), true);
  s.thread.status.type = 'idle';
  s.turns[0] = { id: 'now', status: 'completed', items: [
    { id: 'progress', type: 'agentMessage', phase: 'commentary', text: '中途说明' },
    { id: 'final1', type: 'agentMessage', phase: 'final_answer', text: '回答一' },
    { id: 'final2', type: 'agentMessage', phase: 'final_answer', text: '回答二' },
  ] };
  const view = latestView(s);
  assert.match(view.text, /回答一\n\n回答二/);
  assert.doesNotMatch(view.text, /中途说明|tail -c|上一轮对答/);
  assert.deepEqual(view.acknowledge, ['now']);
  s.turns[0] = { id: 'now', status: 'failed', error: { message: '模型连接中断' }, items: [] };
  assert.match(latestView(s).text, /本轮暂无模型回答[\s\S]*模型连接中断/);
  assert.deepEqual(latestView(s).acknowledge, []);
});

test('问题与回答按原轮配对，历史按轮计数，完成通知和动向上下文保持同一配对', () => {
  const s = running();
  s.turns[1]!.items.unshift({ id: 'old-question', type: 'userMessage', content: [{ type: 'text', text: '启动训练' }] });
  s.turns[1]!.items.push({ id: 'answer-extra', type: 'agentMessage', phase: 'final_answer', text: '日志保存在 train.log' });
  s.turns.push({ id: 'older', status: 'completed', items: [
    { id: 'older-question', type: 'userMessage', content: [{ type: 'text', text: '准备数据' }] },
    { id: 'older-answer', type: 'agentMessage', phase: 'final_answer', text: '数据就绪' },
  ] });
  for (const text of [answerView(s).text, completion(s, s.turns[1]!)]) {
    assert.match(text, /用户要求[\s\S]*启动训练[\s\S]*模型回答[\s\S]*训练已启动[\s\S]*日志保存在 train.log/);
    assert.doesNotMatch(text, /检查训练进度|准备数据/);
  }
  const recent = recentView(s);
  assert.match(recent.text, /准备数据[\s\S]*数据就绪[\s\S]*启动训练[\s\S]*训练已启动[\s\S]*日志保存在 train.log/);
  assert.doesNotMatch(recent.text, /检查训练进度/);
  assert.deepEqual(recent.acknowledge, ['older', 'old']);
  assert.match(latestView(s).text, /最新动向[\s\S]*tail -c[\s\S]*本轮用户要求[\s\S]*检查训练进度[\s\S]*上一轮对答[\s\S]*启动训练[\s\S]*训练已启动/);
  s.thread.status.type = 'idle';
  s.turns.shift();
  assert.match(latestView(s).text, /用户要求[\s\S]*启动训练[\s\S]*模型回答[\s\S]*训练已启动/);
});
