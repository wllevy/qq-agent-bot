import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setImmediate as tick } from 'node:timers/promises';
import { ClaudeBackend, historyTurns } from '../src/claude.js';
import { MachineCodex } from '../src/machines.js';
import { ConsoleApp } from '../src/console.js';
import { Store } from '../src/store.js';
import { modelSummary } from '../src/presentation.js';

function setup(t: TestContext) {
  const previous = process.env.CLAUDE_PERMISSION_MODE;
  process.env.CLAUDE_PERMISSION_MODE = 'bypassPermissions';
  t.after(() => { if (previous === undefined) delete process.env.CLAUDE_PERMISSION_MODE; else process.env.CLAUDE_PERMISSION_MODE = previous; });
  const dir = mkdtempSync(join(tmpdir(), 'qqbot-claude-test-'));
  const calls: any[] = [];
  const history = new Map<string, any>();
  const forks: string[] = [];
  const deps = {
    async resolveSettings() { return { effective: {} as any }; },
    async listSessions() { return [...history.values()]; },
    async getSessionInfo(id: string) { return history.get(id); },
    async getSessionMessages() { return [
      { type: 'user', uuid: 'old-u', message: { content: '旧要求' } },
      { type: 'assistant', uuid: 'old-a', message: { content: [{ type: 'text', text: '旧回答' }], stop_reason: 'end_turn' } },
    ]; },
    async forkSession(source: string) { forks.push(source); const sessionId = randomUUID(); history.set(sessionId, { ...history.get(source), sessionId }); return { sessionId }; },
    query(args: any) {
      const queue: any[] = []; let wake: (() => void) | undefined, closed = false;
      const stream = (async function* () { while (!closed) { if (queue.length) yield queue.shift(); else await new Promise<void>(r => { wake = r; }); } })();
      const q = Object.assign(stream, {
        close() { closed = true; wake?.(); },
        async interrupt() { q.close(); },
        async supportedModels() { return [{ value: 'default', resolvedModel: 'claude-test', displayName: 'Default', supportedEffortLevels: ['low', 'high'] }, { value: 'sonnet', resolvedModel: 'claude-test', displayName: 'Test', supportedEffortLevels: ['low', 'high'] }]; },
      });
      calls.push({ args, push(value: any) { queue.push(value); wake?.(); }, q }); return q;
    },
  };
  const backend = new ClaudeBackend(dir, dir, deps as any);
  t.after(async () => { await backend.close(); });
  return { dir, calls, history, forks, deps, backend };
}

test('Claude 默认模型可直接设置强度，默认配置和实际强度分开显示且不固定默认值', async t => {
  const h = setup(t), id = (await h.backend.create('claude', h.dir, 'create')).id;
  const replies: any[] = [];
  const app = new ConsoleApp(new Store(join(h.dir, 'qq')), new MachineCodex({ claude: h.backend }), { async send(_user, text, options) { replies.push({ text, ...options }); return ['r']; } });
  t.after(() => app.shutdown());
  await app.receive('u', `/推理强度 claude:${id}`, 'menu');
  assert.match(replies.at(-1).text, /默认（由 Claude 决定）/);
  assert.ok(replies.at(-1).buttons.some((b: any) => b.command === `/设置强度 claude:${id} high`));
  assert.ok(replies.at(-1).buttons.some((b: any) => b.command === `/设置强度 claude:${id} default`));
  h.deps.resolveSettings = async () => ({ effective: { effortLevel: 'low', modelSettings: { 'claude-test': { effortLevel: 'high' } } } });
  assert.equal((await h.backend.snapshot(id)).thread.reasoningEffort, 'high');
  const saved = JSON.parse(readFileSync(join(h.dir, 'claude/state.json'), 'utf8'));
  assert.equal(saved.sessions[id].thread.reasoningEffort, undefined);
  await app.receive('u', `/设置强度 claude:${id} low`, 'set');
  assert.equal((await h.backend.snapshot(id)).thread.reasoningEffortSource, 'session');
  await assert.rejects(h.backend.updateSettings(id, { effort: 'invalid' }), /不支持/);
  await h.backend.send(id, 'task', randomUUID());
  const run = h.calls.at(-1);
  assert.equal(run.args.options.effort, 'low');
  run.push({ type: 'system', subtype: 'init', session_id: id, model: 'claude-test', effort: 'high' });
  await tick();
  assert.match(modelSummary((await h.backend.snapshot(id)).thread), /low（会话设置）[\s\S]*本轮实际强度：high/);
  const observe = run.args.options.hooks.Stop[0].hooks[0];
  await observe({ agent_id: 'subagent', effort: { level: 'low' } });
  assert.equal((await h.backend.snapshot(id)).thread.actualReasoningEffort, 'high');
  await observe({ effort: { level: 'low' } });
  assert.equal((await h.backend.snapshot(id)).thread.actualReasoningEffort, 'low');
  run.push({ type: 'result', subtype: 'success', result: 'ok', session_id: id }); await tick();
  assert.match(modelSummary((await h.backend.snapshot(id)).thread), /上轮实际强度：low/);
  await h.backend.updateSettings(id, { effort: 'default' });
  assert.equal((await h.backend.snapshot(id)).thread.reasoningEffortSource, 'settings');
  const restored = new ClaudeBackend(h.dir, h.dir, h.deps as any);
  t.after(() => restored.close());
  await restored.send(id, 'next', randomUUID());
  assert.equal(h.calls.at(-1).args.options.effort, undefined);
  assert.equal((await restored.snapshot(id)).thread.reasoningEffort, 'high');
});

test('Claude 显示环境覆盖，不将环境锁定下的强度更改报告为成功', async t => {
  const h = setup(t), id = (await h.backend.create('claude', h.dir, 'create')).id;
  const previous = process.env.CLAUDE_CODE_EFFORT_LEVEL;
  t.after(() => { if (previous === undefined) delete process.env.CLAUDE_CODE_EFFORT_LEVEL; else process.env.CLAUDE_CODE_EFFORT_LEVEL = previous; });
  process.env.CLAUDE_CODE_EFFORT_LEVEL = 'low';
  assert.match(modelSummary((await h.backend.snapshot(id)).thread), /low（环境变量覆盖）/);
  await assert.rejects(h.backend.updateSettings(id, { effort: 'high' }), /环境变量/);
  process.env.CLAUDE_CODE_EFFORT_LEVEL = 'unset';
  assert.match(modelSummary((await h.backend.snapshot(id)).thread), /auto（不指定 effort）/);
});

test('Claude 创建幂等、完成后重启恢复同一历史，不重复提交同一任务', async t => {
  const h = setup(t), id = (await h.backend.create('claude', h.dir, 'create')).id;
  assert.equal((await h.backend.create('claude', h.dir, 'create')).id, id);
  const input = randomUUID();
  await h.backend.send(id, 'hello', input);
  await h.backend.send(id, 'hello', input);
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].args.options.sessionId, id);
  assert.equal(h.calls[0].args.options.permissionMode, 'bypassPermissions');
  assert.equal(h.calls[0].args.options.allowDangerouslySkipPermissions, true);
  h.calls[0].push({ type: 'system', subtype: 'init', session_id: id, model: 'claude-test' });
  h.calls[0].push({ type: 'assistant', uuid: 'a', message: { content: [{ type: 'text', text: 'answer' }] } });
  h.calls[0].push({ type: 'result', subtype: 'success', result: 'answer', session_id: id });
  await tick();
  assert.equal((await h.backend.snapshot(id)).turns[0]!.status, 'completed');
  await h.backend.close();
  const restored = new ClaudeBackend(h.dir, h.dir, h.deps as any, true);
  t.after(() => restored.close());
  await restored.prepare(id); await restored.send(id, 'followup', randomUUID());
  assert.equal(h.calls[1].args.options.resume, id);
  assert.equal(h.calls[1].args.options.sessionId, undefined);
  assert.equal(h.calls[1].args.options.permissionMode, 'bypassPermissions');
});

test('已有历史只读，恢复创建独立副本且保留原会话', async t => {
  const h = setup(t), source = randomUUID();
  h.history.set(source, { sessionId: source, cwd: h.dir, summary: '原会话', lastModified: Date.now() });
  await assert.rejects(h.backend.prepare(source), /独立副本/);
  const created = await h.backend.create('claude', undefined, 'resume', source);
  assert.notEqual(created.id, source);
  assert.deepEqual(h.forks, [source]);
  assert.equal((await h.backend.snapshot(created.id)).turns[0]!.items[1]!.text, '旧回答');
  await h.backend.send(created.id, 'continue', randomUUID());
  assert.equal(h.calls[0].args.options.resume, created.id);
  assert.equal(h.history.has(source), true);
});

test('工具确认、过期按钮、连续确认和多题回答按会话处理', async t => {
  const h = setup(t), id = (await h.backend.create('claude', h.dir, 'create')).id;
  await h.backend.send(id, 'task', randomUUID());
  const callback = h.calls[0].args.options.canUseTool;
  const signal = new AbortController().signal;
  let answered = false;
  const first = callback('Bash', { command: 'echo hello' }, { signal }).then((r: any) => { answered = true; return r; });
  const pending = (await h.backend.snapshot(id)).pendingAction!;
  assert.equal(pending.kind, 'approval'); assert.equal(answered, false);
  await assert.rejects(h.backend.respond(id, 'stale', '批准'), /失效/);
  await h.backend.respond(id, pending.id, '批准');
  assert.deepEqual(await first, { behavior: 'allow', updatedInput: { command: 'echo hello' } });
  const second = callback('Bash', { command: 'echo next' }, { signal });
  const next = (await h.backend.snapshot(id)).pendingAction!;
  assert.notEqual(next.id, pending.id);
  await h.backend.respond(id, next.id, '拒绝'); assert.equal((await second).behavior, 'deny');
  const question = callback('AskUserQuestion', { questions: [{ question: '选哪项？', options: [{ label: 'A' }] }, { question: '叫什么？', options: [] }] }, { signal });
  const ask = (await h.backend.snapshot(id)).pendingAction!;
  await assert.rejects(h.backend.respond(id, ask.id, 'A'), /多题/);
  await h.backend.respond(id, ask.id, 'A | demo');
  assert.deepEqual((await question).updatedInput.answers, { '选哪项？': 'A', '叫什么？': 'demo' });
});

test('停止指定轮次，失败结果和异常退出不伪装为成功', async t => {
  const h = setup(t), id = (await h.backend.create('claude', h.dir, 'create')).id;
  const turn = await h.backend.send(id, 'task', randomUUID());
  await h.backend.interrupt(id, 'old-turn');
  assert.equal((await h.backend.snapshot(id)).turns[0]!.status, 'inProgress');
  await h.backend.interrupt(id, turn.id);
  assert.equal((await h.backend.snapshot(id)).turns[0]!.status, 'interrupted');
  await h.backend.send(id, 'next', randomUUID());
  h.calls[1].push({ type: 'result', subtype: 'error_during_execution', errors: ['authentication failed'], is_error: true });
  await tick();
  assert.equal((await h.backend.snapshot(id)).turns[0]!.status, 'failed');
  assert.match((await h.backend.snapshot(id)).turns[0]!.error!.message!, /authentication/);
});

test('并发工具审批依次展示，停止时拒绝仍在排队的审批', async t => {
  const h = setup(t), id = (await h.backend.create('claude', h.dir, 'create')).id;
  const turn = await h.backend.send(id, 'task', randomUUID());
  const callback = h.calls[0].args.options.canUseTool;
  const context = { signal: new AbortController().signal };
  const first = callback('Bash', { command: 'first' }, context);
  const second = callback('Bash', { command: 'second' }, context);
  const third = callback('Bash', { command: 'third' }, context);
  const pending = (await h.backend.snapshot(id)).pendingAction!;
  assert.match(pending.text, /first/);
  await h.backend.respond(id, pending.id, '批准');
  assert.equal((await first).behavior, 'allow');
  await tick();
  assert.match((await h.backend.snapshot(id)).pendingAction!.text, /second/);
  await h.backend.interrupt(id, turn.id);
  assert.equal((await second).behavior, 'deny');
  assert.equal((await third).behavior, 'deny');
});

test('重启将未完成轮次标为中断，历史 tool_result 不拆成新一轮', async t => {
  const h = setup(t), id = (await h.backend.create('claude', h.dir, 'create')).id;
  const file = join(h.dir, 'claude', 'state.json');
  const data = JSON.parse(readFileSync(file, 'utf8'));
  data.sessions[id].turns = [{ id: 'pending', status: 'inProgress', items: [] }];
  writeFileSync(file, JSON.stringify(data));
  const restored = new ClaudeBackend(h.dir, h.dir, h.deps as any, true);
  assert.equal((await restored.snapshot(id)).turns[0]!.status, 'interrupted'); await restored.close();
  const turns = historyTurns([
    { type: 'user', uuid: 'u', message: { content: 'task' } },
    { type: 'assistant', uuid: 'a', message: { content: [{ type: 'tool_use', id: 'tool', name: 'Bash', input: { command: 'ls' } }] } },
    { type: 'user', uuid: 'tool-result', message: { content: [{ type: 'tool_result', tool_use_id: 'tool', content: 'file' }] } },
    { type: 'assistant', uuid: 'answer', message: { stop_reason: 'end_turn', content: [{ type: 'text', text: 'done' }] } },
  ] as any);
  assert.equal(turns.length, 1); assert.equal(turns[0]!.items.at(-1)!.phase, 'final_answer');
});

test('QQ 后端菜单、新建选中和确认按钮绑定 Claude 会话', async t => {
  const h = setup(t), router = new MachineCodex({ claude: h.backend });
  const sent: any[] = [], store = new Store(join(h.dir, 'bot'));
  const app = new ConsoleApp(store, router, { async send(user, text, options) { sent.push({ text, options }); return [randomUUID()]; } });
  t.after(() => app.shutdown());
  await app.receive('u', 'Claude', 'm1');
  assert.ok(sent.at(-1).options.buttons.some((b: any) => b.command === '/新会话 claude'));
  await app.receive('u', '新建 ' + h.dir, 'm2');
  const qualified = store.chat('u').current!;
  assert.match(qualified, /^claude:/);
  await app.receive('u', 'task', 'm3');
  const permission = h.calls[0].args.options.canUseTool('Bash', { command: 'echo test' }, { signal: new AbortController().signal });
  await app.tick(); await app.deliver();
  const approve = sent.at(-1).options.buttons.find((b: any) => b.label === '批准');
  assert.ok(approve.command.includes(qualified));
  await app.receive('u', approve.command, 'm4');
  assert.equal((await permission).behavior, 'allow');
  const permission2 = h.calls[0].args.options.canUseTool('Bash', { command: 'echo second' }, { signal: new AbortController().signal });
  await app.tick(); await app.deliver();
  assert.match(sent.at(-1).text, /echo second/);
  await app.receive('u', '拒绝', 'm5'); await permission2;
});
