import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { mkdir, open, writeFile, stat, readFile } from 'node:fs/promises';
import { dirname, join, resolve, isAbsolute } from 'node:path';
import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { query, listSessions, getSessionInfo, getSessionMessages, forkSession, resolveSettings, type Query, type Options, type SDKMessage, type SessionMessage, type SDKUserMessage, type PermissionResult } from '@anthropic-ai/claude-agent-sdk';
import { SubmissionError } from './domain.js';
import { errorText } from './config.js';
import type { CodexPort, Thread, Turn, Snapshot, ModelSettings, ModelOption, PreparedFile, AgentItem } from './types.js';

const sdk = { query, listSessions, getSessionInfo, getSessionMessages, forkSession, resolveSettings };
type Dependencies = typeof sdk;
type Record = { thread: Thread; history: boolean; turns: Turn[]; sourceId?: string; requests: string[]; permissionMode?: 'bypassPermissions'; actualEffort?: string | null };
type Pending = NonNullable<Snapshot['pendingAction']> & { resolve: (result: PermissionResult) => void; input: globalThis.Record<string, unknown>; questions?: any[] };
type Runtime = { query?: Query; turn: Turn; done?: Promise<void>; stopped: boolean; pending?: Pending; permissionQueue?: Promise<PermissionResult> };

export function historyTurns(messages: SessionMessage[], limit = 20): Turn[] {
  const turns: Turn[] = [];
  for (const m of messages) {
    if (m.parent_tool_use_id) continue;
    const message = m.message as any;
    const blocks = typeof message.content === 'string' ? [{ type: 'text', text: message.content }] : message.content || [];
    const text = blocks.filter((b: any) => b.type === 'text').map((b: any) => b.text).join('\n');
    if (m.type === 'user' && text && !blocks.some((b: any) => b.type === 'tool_result')) {
      turns.push({ id: m.uuid, status: 'completed', items: [{ id: m.uuid, type: 'userMessage', text }] });
    } else if (m.type === 'assistant' && turns.length) {
      const turn = turns.at(-1)!;
      if (text) turn.items.push({ id: m.uuid, type: 'agentMessage', text, phase: message.stop_reason === 'end_turn' ? 'final_answer' : 'commentary' });
      for (const block of blocks.filter((b: any) => b.type === 'tool_use')) turn.items.push(toolItem(block));
    }
  }
  return turns.slice(-limit).reverse();
}

function toolItem(block: any): AgentItem {
  return block.name === 'Bash'
    ? { id: block.id, type: 'commandExecution', command: block.input?.command || '', status: 'inProgress' }
    : { id: block.id, type: 'dynamicToolCall', tool: block.name, arguments: block.input, status: 'inProgress' };
}

export class ClaudeBackend extends EventEmitter implements CodexPort {
  private records: globalThis.Record<string, Record> = {};
  private running = new Map<string, Runtime>();
  private file: string;
  private closed = false;
  private catalog?: ModelOption[];
  constructor(private directory: string, private defaultCwd: string, private deps: Dependencies = sdk, recover = false) {
    super();
    this.file = join(directory, 'claude', 'state.json');
    if (existsSync(this.file)) {
      const data = JSON.parse(readFileSync(this.file, 'utf8'));
      if (data.version !== 1 || !data.sessions || Object.values(data.sessions).some((r: any) => !r.thread?.id || !r.thread.cwd || !Array.isArray(r.turns) || !Array.isArray(r.requests))) throw new Error('Claude Bot 状态文件格式不正确');
      this.records = data.sessions;
    }
    if (recover) {
      for (const record of Object.values(this.records)) for (const turn of record.turns) if (turn.status === 'inProgress') {
        turn.status = 'interrupted'; turn.error = { message: 'Bot 重启，上一轮已停止；可发送新要求继续历史。' };
        record.thread.status = { type: 'idle' };
      }
      this.save();
    }
  }
  private save() {
    mkdirSync(dirname(this.file), { recursive: true });
    writeFileSync(this.file + '.tmp', JSON.stringify({ version: 1, sessions: this.records }));
    renameSync(this.file + '.tmp', this.file);
  }
  private managed(id: string) {
    const record = this.records[id];
    if (!record) throw new Error('这是已有 Claude 历史。发送“恢复”创建由 Bot 管理的独立副本，再继续任务。');
    return record;
  }
  private async describe(record: Record): Promise<Thread> {
    const thread = structuredClone(record.thread);
    const config = (await this.deps.resolveSettings?.({ cwd: thread.cwd, settingSources: ['user', 'project', 'local'] }))?.effective;
    const configuredModel = process.env.ANTHROPIC_MODEL || config?.model;
    const selected = thread.model && thread.model !== '默认' ? thread.model : configuredModel;
    const model = this.catalog?.find(m => m.model === selected || m.id === selected) || (!selected ? this.catalog?.find(m => m.id === 'default') : undefined);
    thread.model = model?.model || selected || '默认';
    const perModel = config?.modelSettings?.[thread.model];
    const env = process.env.CLAUDE_CODE_EFFORT_LEVEL;
    const levels = ['low', 'medium', 'high', 'xhigh', 'max'];
    const overridden = !!env && [...levels, 'auto', 'unset'].includes(env);
    const inherited = perModel?.effortLevel || config?.effortLevel;
    thread.reasoningEffort = overridden ? levels.includes(env!) ? env : null : record.thread.reasoningEffort || inherited || null;
    thread.reasoningEffortSource = overridden ? 'environment' : record.thread.reasoningEffort ? 'session' : inherited ? 'settings' : 'default';
    if (record.actualEffort !== undefined) {
      thread.actualReasoningEffort = record.actualEffort;
      thread.actualReasoningEffortCurrent = this.running.has(thread.id);
    }
    return thread;
  }
  async list(): Promise<Thread[]> {
    const history = await this.deps.listSessions({ limit: 100 });
    return [...Object.values(this.records).map(r => structuredClone(r.thread)), ...history.filter(h => !this.records[h.sessionId] && h.cwd).map(h => ({ id: h.sessionId, name: h.customTitle || h.summary, cwd: h.cwd!, updatedAt: h.lastModified / 1000, status: { type: 'notLoaded' } }))]
      .sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 100);
  }
  async create(_machine: string, cwd: string | undefined, requestId: string, sourceId?: string, settings: ModelSettings = {}): Promise<Thread> {
    const existing = Object.values(this.records).find(r => r.requests.includes(requestId));
    if (existing) return structuredClone(existing.thread);
    let id: string = randomUUID(), turns: Turn[] = [], title = '新 Claude 会话';
    if (sourceId) {
      const source = await this.deps.getSessionInfo(sourceId);
      if (!source?.cwd) throw new Error('未找到可恢复的 Claude 历史');
      cwd = source.cwd;
      if (!isAbsolute(cwd) || !(await stat(cwd)).isDirectory()) throw new Error('Claude 原项目目录不存在');
      title = (source.customTitle || source.summary || 'Claude 历史').slice(0, 45) + ' · QQ副本';
      id = (await this.deps.forkSession(sourceId, { dir: cwd, title })).sessionId;
      turns = historyTurns(await this.deps.getSessionMessages(id, { dir: cwd }));
    }
    if (cwd === '~' || cwd && /^~[\\/]/.test(cwd)) cwd = resolve(homedir(), cwd.slice(2));
    const path = cwd || this.defaultCwd;
    if (!isAbsolute(path) || !(await stat(path)).isDirectory()) throw new Error('请提供已存在的项目绝对路径');
    const thread: Thread = { id, managed: true, cwd: resolve(path), name: title, model: '默认', updatedAt: Date.now() / 1000, status: { type: 'idle' } };
    if (settings.model && settings.model !== '默认') thread.model = settings.model;
    if (settings.effort) thread.reasoningEffort = settings.effort;
    this.records[id] = { thread, history: !!sourceId, turns, sourceId, requests: [requestId], ...(process.env.CLAUDE_PERMISSION_MODE === 'bypassPermissions' ? { permissionMode: 'bypassPermissions' as const } : {}) };
    this.save(); return structuredClone(thread);
  }
  async snapshot(id: string): Promise<Snapshot> {
    const managed = this.records[id];
    if (managed) {
      const runtime = this.running.get(id), turn = managed.turns[0];
      return structuredClone({ thread: await this.describe(managed), turns: managed.turns,
        ...(runtime?.pending ? { pendingAction: { id: runtime.pending.id, kind: runtime.pending.kind, text: runtime.pending.text } } : {}),
        ...(runtime && turn ? { activity: { turnId: turn.id, entries: turn.items.slice(-30).reverse().map(item => ({ turnId: turn.id, item })) } } : {}),
      });
    }
    const info = await this.deps.getSessionInfo(id);
    if (!info?.cwd) throw new Error('找不到该 Claude 会话');
    return { thread: { id, name: info.customTitle || info.summary, cwd: info.cwd, updatedAt: info.lastModified / 1000, status: { type: 'notLoaded' } }, turns: historyTurns(await this.deps.getSessionMessages(id, { dir: info.cwd })) };
  }
  async history(id: string, cursor?: string) {
    const offset = Number(cursor || 0);
    if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('历史页码无效');
    const record = this.records[id];
    const info = record ? undefined : await this.deps.getSessionInfo(id);
    const cwd = record?.thread.cwd || info?.cwd;
    if (!cwd) throw new Error('会话不存在');
    const saved = historyTurns(await this.deps.getSessionMessages(id, { dir: cwd }), Number.MAX_SAFE_INTEGER);
    const turns = saved.length ? saved : record?.turns || [];
    return { turns: turns.slice(offset, offset + 2), nextCursor: offset + 2 < turns.length ? String(offset + 2) : null };
  }
  private options(cwd: string): Options {
    return { cwd, settingSources: ['user', 'project', 'local'], systemPrompt: { type: 'preset', preset: 'claude_code' },
      ...(process.env.CLAUDE_EXECUTABLE ? { pathToClaudeCodeExecutable: process.env.CLAUDE_EXECUTABLE } : {}),
      spawnClaudeCodeProcess: ({ command, args, cwd, env, signal }) => spawn(command, args, { cwd, env, signal, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }),
    };
  }
  async models(id: string): Promise<ModelOption[]> {
    if (this.catalog) return this.catalog;
    const record = this.records[id];
    const active = this.running.get(id)?.query;
    let finish!: () => void;
    const wait = new Promise<void>(r => { finish = r; });
    const q = active || this.deps.query({ prompt: (async function* (): AsyncGenerator<SDKUserMessage> { await wait; })(), options: { ...this.options(record?.thread.cwd || this.defaultCwd), persistSession: false } });
    const timer = setTimeout(() => { if (!active) { finish(); q.close(); } }, 20000);
    try {
      const models = await q.supportedModels();
      this.catalog = models.map(m => ({ id: m.value, model: m.resolvedModel || m.value, displayName: m.displayName, defaultReasoningEffort: '', supportedReasoningEfforts: (m.supportedEffortLevels || []).map(e => ({ reasoningEffort: e })) })).filter((m, i, all) => all.findIndex(other => other.model === m.model) === i);
      return this.catalog;
    } finally { clearTimeout(timer); if (!active) { finish(); q.close(); } }
  }
  async updateSettings(id: string, settings: ModelSettings): Promise<Thread> {
    const record = this.managed(id);
    if (this.running.has(id)) throw new Error('请等待当前轮结束后再修改 Claude 模型设置');
    const catalog = await this.models(id);
    const current = await this.describe(record);
    const target = settings.model || current.model;
    const model = catalog.find(m => m.model === target || m.id === target) || (target === '默认' ? catalog.find(m => m.id === 'default') : undefined);
    if (!model) throw new Error('请先从模型菜单选择 Claude 模型');
    if (settings.effort && settings.effort !== 'default' && !model.supportedReasoningEfforts.some(e => e.reasoningEffort === settings.effort)) throw new Error('该模型不支持此推理强度');
    if (settings.effort && settings.effort !== 'default' && current.reasoningEffortSource === 'environment' && settings.effort !== current.reasoningEffort) throw new Error('CLAUDE_CODE_EFFORT_LEVEL 正在覆盖推理强度，请先调整 Bot 的环境变量');
    record.thread.model = model.model;
    record.thread.reasoningEffort = settings.effort === 'default' ? null : settings.effort || (model.supportedReasoningEfforts.some(e => e.reasoningEffort === record.thread.reasoningEffort) ? record.thread.reasoningEffort : null);
    this.save(); return this.describe(record);
  }
  async prepare(id: string) {
    if (this.closed) throw new Error('Claude 后端正在停止');
    const record = this.managed(id);
    if (!(await stat(record.thread.cwd)).isDirectory()) throw new Error('Claude 项目目录不存在');
    if (!record.history && await this.deps.getSessionInfo(id, { dir: record.thread.cwd })) { record.history = true; this.save(); }
  }
  async send(id: string, text: string, inputId: string, files: PreparedFile[] = []): Promise<Turn> {
    const record = this.managed(id);
    const duplicate = record.turns.find(t => t.id === inputId);
    if (duplicate) return structuredClone(duplicate);
    if (this.closed || this.running.has(id)) throw new SubmissionError('Claude 会话正在执行或停止，请稍后再试', 'retryable');
    const content: any[] = [{ type: 'text', text: text + (files.length ? '\n\n用户附件：\n' + files.map(f => `${f.name}: ${f.path}`).join('\n') : '') }];
    for (const file of files.filter(f => ['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(f.mime))) {
      const bytes = await this.readFile(id, file.path, 20 * 1024 * 1024);
      content.push({ type: 'image', source: { type: 'base64', media_type: file.mime, data: bytes.toString('base64') } });
    }
    const turn: Turn = { id: inputId, status: 'inProgress', startedAt: Date.now() / 1000, items: [{ id: inputId, type: 'userMessage', text }] };
    const runtime: Runtime = { turn, stopped: false };
    delete record.actualEffort;
    this.running.set(id, runtime);
    record.turns.unshift(turn); record.turns = record.turns.slice(0, 100);
    record.thread.status = { type: 'active', activeFlags: [] }; record.thread.updatedAt = Date.now() / 1000;
    if (record.thread.name === '新 Claude 会话') record.thread.name = text.replace(/\s+/g, ' ').slice(0, 55);
    this.save();
    try {
      runtime.query = this.deps.query({ prompt: (async function* (): AsyncGenerator<SDKUserMessage> { yield { type: 'user', uuid: inputId as any, session_id: id, message: { role: 'user', content }, parent_tool_use_id: null }; })(), options: {
        ...this.options(record.thread.cwd), ...(record.history ? { resume: id } : { sessionId: id }),
        ...(record.permissionMode === 'bypassPermissions' ? { permissionMode: 'bypassPermissions' as const, allowDangerouslySkipPermissions: true } : {}),
        ...(record.thread.model && record.thread.model !== '默认' ? { model: record.thread.model } : {}),
        ...(record.thread.reasoningEffort ? { effort: record.thread.reasoningEffort as Options['effort'] } : {}),
        hooks: Object.fromEntries(['PreToolUse', 'Stop'].map(event => [event, [{ hooks: [async (input: import('@anthropic-ai/claude-agent-sdk').HookInput) => {
          if (this.running.get(id) === runtime && !input.agent_id && ['low', 'medium', 'high', 'xhigh', 'max'].includes(input.effort?.level || '')) {
            record.actualEffort = input.effort!.level; this.save();
          }
          return {};
        }] }]])),
        canUseTool: (name, input, context) => this.permission(id, runtime, name, input, context.signal),
      } });
    } catch (error) {
      this.running.delete(id); record.turns.shift(); record.thread.status = { type: 'idle' }; this.save();
      throw new SubmissionError(errorText(error), 'retryable');
    }
    runtime.done = this.consume(id, runtime);
    return structuredClone(turn);
  }
  private permission(id: string, runtime: Runtime, name: string, input: globalThis.Record<string, unknown>, signal: AbortSignal): Promise<PermissionResult> {
    const request = () => this.requestPermission(id, runtime, name, input, signal);
    const result = runtime.permissionQueue ? runtime.permissionQueue.then(request, request) : request();
    runtime.permissionQueue = result;
    void result.finally(() => { if (runtime.permissionQueue === result) runtime.permissionQueue = undefined; });
    return result;
  }
  private requestPermission(id: string, runtime: Runtime, name: string, input: globalThis.Record<string, unknown>, signal: AbortSignal): Promise<PermissionResult> {
    if (this.closed || runtime.stopped || signal.aborted) return Promise.resolve({ behavior: 'deny', message: '任务已停止' });
    const requestId = randomUUID();
    const questions = name === 'AskUserQuestion' && Array.isArray(input.questions) ? input.questions : undefined;
    const text = questions ? questions.map((q: any) => `${q.question}\n${(q.options || []).map((o: any) => '- ' + o.label).join('\n')}`).join('\n\n')
      : `Claude 请求执行 ${name}\n${JSON.stringify(input).slice(0, 1800)}\n\n发送“批准”或“拒绝”。`;
    return new Promise(resolve => {
      const done = (result: PermissionResult) => {
        signal.removeEventListener('abort', abort);
        if (runtime.pending?.id !== requestId) return;
        runtime.pending = undefined;
        this.records[id]!.thread.status = { type: runtime.stopped ? 'idle' : 'active', activeFlags: [] };
        this.save(); resolve(result);
      };
      const abort = () => done({ behavior: 'deny', message: '任务已停止' });
      runtime.pending = { id: requestId, kind: questions ? 'input' : 'approval', text: text + (questions ? '\n\n发送“回答 内容”；多题按顺序用 | 分隔。' : ''), input, questions, resolve: done };
      this.records[id]!.thread.status = { type: 'active', activeFlags: [questions ? 'waitingOnUserInput' : 'waitingOnApproval'] };
      signal.addEventListener('abort', abort, { once: true });
      this.save(); this.emit('notification', { method: 'thread/status/changed' });
    });
  }
  async respond(id: string, actionId: string, answer: string) {
    const pending = this.running.get(id)?.pending;
    if (!pending || pending.id !== actionId) throw new Error('该确认或提问已失效，请查看最新状态');
    if (pending.kind === 'approval') {
      if (!['批准', '拒绝'].includes(answer)) throw new Error('请发送“批准”或“拒绝”');
      pending.resolve(answer === '批准' ? { behavior: 'allow', updatedInput: pending.input } : { behavior: 'deny', message: '用户拒绝此操作' });
    } else {
      const answers = answer.split('|').map(s => s.trim());
      if (answers.length !== pending.questions!.length || answers.some(s => !s)) throw new Error('请按题目顺序回答，多题用 | 分隔');
      pending.resolve({ behavior: 'allow', updatedInput: { ...pending.input, answers: Object.fromEntries(pending.questions!.map((q, i) => [q.question, answers[i]])) } });
    }
  }
  private async consume(id: string, runtime: Runtime) {
    const record = this.records[id]!, turn = runtime.turn;
    let resultSeen = false;
    try {
      for await (const message of runtime.query!) {
        if (runtime.stopped || this.closed) break;
        const m = message as any;
        if (m.type === 'system' && m.subtype === 'init' && m.session_id !== id) throw new Error('Claude 返回了不同的会话 ID，已停止该任务');
        if (m.type === 'system' && m.subtype === 'init') {
          record.history = true; if (m.model) record.thread.model = m.model;
          if (m.effort === null || ['low', 'medium', 'high', 'xhigh', 'max'].includes(m.effort)) record.actualEffort = m.effort;
        }
        if (m.type === 'assistant' && !m.parent_tool_use_id) {
          const blocks = m.message?.content || [];
          const text = blocks.filter((b: any) => b.type === 'text').map((b: any) => b.text).join('\n');
          if (text) turn.items.push({ id: m.uuid || randomUUID(), type: 'agentMessage', text, phase: 'commentary' });
          for (const block of blocks.filter((b: any) => b.type === 'tool_use')) turn.items.push(toolItem(block));
        }
        if (m.type === 'user' && Array.isArray(m.message?.content)) for (const b of m.message.content) if (b.type === 'tool_result') {
          const item = turn.items.find(i => i.id === b.tool_use_id); if (item) item.status = b.is_error ? 'failed' : 'completed';
        }
        if (m.type === 'result') {
          resultSeen = true;
          turn.status = m.is_error || m.subtype !== 'success' ? 'failed' : 'completed';
          if (turn.status === 'failed') turn.error = { message: (m.errors || [m.result || m.subtype]).join('\n') };
          if (m.result) turn.items.push({ id: m.uuid || randomUUID(), type: 'agentMessage', text: m.result, phase: 'final_answer' });
          else { const last = turn.items.findLast(i => i.type === 'agentMessage'); if (last && turn.status === 'completed') last.phase = 'final_answer'; }
          if (m.permission_denials?.length) turn.items.push({ id: randomUUID(), type: 'agentMessage', phase: 'final_answer', text: '部分工具被权限配置拒绝：' + m.permission_denials.map((d: any) => d.tool_name).join('、') });
        }
        record.thread.updatedAt = Date.now() / 1000; this.save();
        if (resultSeen) break;
      }
      if (!resultSeen && !runtime.stopped) { turn.status = 'failed'; turn.error = { message: 'Claude 进程结束但未返回结果，请查看状态后重新提交。' }; }
    } catch (error) {
      if (!runtime.stopped) { turn.status = 'failed'; turn.error = { message: errorText(error) }; }
    } finally {
      runtime.pending?.resolve({ behavior: 'deny', message: '本轮已结束' });
      runtime.query?.close();
      if (runtime.stopped) turn.status = 'interrupted';
      turn.completedAt = Date.now() / 1000; record.thread.status = { type: 'idle' }; record.thread.updatedAt = Date.now() / 1000;
      this.running.delete(id); this.save(); this.emit('notification', { method: 'turn/completed' });
    }
  }
  async interrupt(id: string, turnId: string) {
    const runtime = this.running.get(id);
    if (!runtime || runtime.turn.id !== turnId) return;
    runtime.stopped = true;
    runtime.pending?.resolve({ behavior: 'deny', message: '用户停止了任务' });
    try { await Promise.race([runtime.query!.interrupt(), new Promise<void>(r => setTimeout(r, 3000))]); }
    finally { runtime.query?.close(); await runtime.done; }
  }
  async readFile(_id: string, path: string, maxBytes: number): Promise<Buffer> {
    const handle = await open(path, 'r');
    try { const meta = await handle.stat(); if (!meta.isFile() || meta.size > maxBytes) throw new Error('文件不可读或超出 20 MiB'); const data = await handle.readFile(); if (data.length > maxBytes) throw new Error('文件超出 20 MiB'); return data; }
    finally { await handle.close(); }
  }
  async writeFile(_id: string, path: string, data: Buffer) { await mkdir(dirname(path), { recursive: true }); await writeFile(path, data); }
  async close() {
    this.closed = true;
    for (const runtime of this.running.values()) { runtime.stopped = true; runtime.pending?.resolve({ behavior: 'deny', message: 'Bot 正在停止' }); runtime.query?.close(); }
    await Promise.allSettled([...this.running.values()].map(r => r.done));
  }
}
