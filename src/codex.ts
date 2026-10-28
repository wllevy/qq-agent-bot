import { EventEmitter } from 'node:events';
import { targetPath } from './files.js';
import { connect as connectSocket } from 'node:net';
import WebSocket from 'ws';
import { SubmissionError } from './domain.js';
import type { ActivityEntry, CodexPort, ModelOption, ModelSettings, PreparedFile, Snapshot, SnapshotOptions, Thread, Turn } from './types.js';

export class RpcError extends Error {
  constructor(message: string, public code?: number, public uncertain = false) { super(message); }
}
export class Codex extends EventEmitter implements CodexPort {
  private ws?: WebSocket;
  private closed = false;
  private connecting?: Promise<void>;
  private sequence = 0;
  private pending = new Map<number, { resolve: (result: any) => void; reject: (error: Error) => void; timer: NodeJS.Timeout; ws: WebSocket }>();
  constructor(private socket: string, private readTimeout = 5000) { super(); }
  async connect(): Promise<void> {
    if (this.closed) throw new RpcError('Codex 客户端已关闭');
    if (this.connecting) return this.connecting;
    if (this.ws?.readyState === WebSocket.OPEN) return;
    this.connecting = this.open().finally(() => { this.connecting = undefined; });
    return this.connecting;
  }
  private async open() {
    const tcp = /^wss?:\/\//.test(this.socket);
    const ws = new WebSocket(tcp ? this.socket : 'ws://localhost/', {
      ...(!tcp ? { createConnection: () => connectSocket(this.socket) } : {}),
      handshakeTimeout: this.readTimeout,
      maxPayload: 64 * 1024 * 1024,
    });
    this.ws = ws;
    ws.on('message', raw => {
      let message: any;
      try { message = JSON.parse(raw.toString()); } catch { return; }
      if (message.method) {
        if (message.id !== undefined) this.emit('serverRequest', message);
        else this.emit('notification', message);
        return;
      }
      const request = this.pending.get(message.id);
      if (!request) return;
      clearTimeout(request.timer); this.pending.delete(message.id);
      if (message.error) request.reject(new RpcError(message.error.message, message.error.code));
      else request.resolve(message.result);
    });
    ws.on('close', () => {
      this.rejectPending(ws, new RpcError('Codex 连接断开，调用结果未知', undefined, true));
      this.emit('disconnected');
    });
    // Keep an error listener installed after the handshake as well.
    ws.on('error', () => {});
    await new Promise<void>((resolve, reject) => {
      ws.once('open', resolve); ws.once('error', reject);
      ws.once('close', () => reject(new RpcError('Codex 握手期间连接关闭')));
    });
    try {
      await this.call('initialize', {
        clientInfo: { name: 'qq_codex_console', title: 'QQ Codex Console', version: '0.1.0' },
        capabilities: { experimentalApi: true, optOutNotificationMethods: [
          'item/reasoning/summaryTextDelta', 'item/reasoning/textDelta',
          'item/commandExecution/outputDelta', 'item/fileChange/outputDelta',
          'item/agentMessage/delta', 'command/exec/outputDelta',
        ] },
      }, this.readTimeout);
      ws.send(JSON.stringify({ method: 'initialized', params: {} }));
    } catch (error) { ws.close(); throw error; }
  }
  protected call<T>(method: string, params: unknown, timeout = 20000): Promise<T> {
    const ws = this.ws;
    if (this.closed || !ws || ws.readyState !== WebSocket.OPEN) return Promise.reject(new RpcError('Codex 尚未连接'));
    const id = ++this.sequence;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id); reject(new RpcError(`${method} 超时，调用结果未知`, undefined, true));
      }, timeout);
      this.pending.set(id, { resolve, reject, timer, ws });
      ws.send(JSON.stringify({ id, method, params }), error => {
        if (error) { clearTimeout(timer); this.pending.delete(id); reject(new RpcError(error.message, undefined, true)); }
      });
    });
  }
  async request<T = any>(method: string, params: unknown = {}): Promise<T> {
    await this.connect();
    const read = ['thread/list', 'thread/read', 'thread/turns/list', 'thread/items/list', 'model/list'].includes(method);
    return this.call<T>(method, params, read ? this.readTimeout : 20000);
  }
  async list(): Promise<Thread[]> {
    const result = await this.request<{ data: Thread[] }>('thread/list', {
      limit: 100, sortKey: 'updated_at', sortDirection: 'desc', useStateDbOnly: true,
      sourceKinds: ['cli', 'vscode', 'exec', 'appServer'],
    });
    return result.data;
  }
  protected async creationDirectory(cwd: string): Promise<string> {
    if (cwd === '~' || cwd.startsWith('~/')) {
      const result = await this.request('command/exec', { command: ['printenv', 'HOME'], cwd: '/', timeoutMs: 5000, outputBytesCap: 4096 });
      if (result.exitCode !== 0 || !targetPath(result.stdout.trim()).isAbsolute(result.stdout.trim())) throw new Error('无法读取主目录，请输入完整路径。');
      cwd = targetPath(result.stdout.trim()).resolve(result.stdout.trim(), cwd.slice(2));
    }
    if (!targetPath(cwd).isAbsolute(cwd)) throw new Error('请输入项目的绝对目录路径。');
    cwd = targetPath(cwd).normalize(cwd);
    const metadata = await this.request('fs/getMetadata', { path: cwd });
    if (!metadata.isDirectory) throw new Error('所选路径不是目录，请重新选择。');
    return cwd;
  }
  async create(_machine: string, cwd: string | undefined, _requestId: string, sourceId?: string, settings: ModelSettings = {}): Promise<Thread> {
    if (sourceId) throw new Error('Codex 新建会话不支持恢复参数');
    if (!cwd) throw new Error('请选择项目目录');
    cwd = await this.creationDirectory(cwd);
    try {
      const result = await this.request<{ thread: Thread; model: string; reasoningEffort: string | null }>('thread/start', {
        cwd, ...(settings.model ? { model: settings.model } : {}),
        ...(settings.effort ? { config: { model_reasoning_effort: settings.effort } } : {}),
      });
      return { ...result.thread, model: result.model, reasoningEffort: result.reasoningEffort };
    } catch (error) {
      if (error instanceof RpcError && error.uncertain) throw new SubmissionError('创建结果待确认，请查看会话列表；不会自动重复创建。', 'uncertain');
      throw error;
    }
  }
  async snapshot(id: string, options?: SnapshotOptions): Promise<Snapshot> {
    const snapshot = await this.summary(id);
    const turn = snapshot.turns[0];
    if (options?.activity && turn && snapshot.thread.status.type !== 'notLoaded' &&
        (snapshot.thread.status.type === 'active' || turn.status === 'inProgress')) {
      try {
        const page = await this.request<{ data: ActivityEntry[] }>('thread/items/list', {
          threadId: id, turnId: turn.id, limit: 30, sortDirection: 'desc',
        });
        snapshot.activity = { turnId: turn.id, entries: page.data.filter(entry => entry.turnId === turn.id) };
      } catch (error) {
        // An unavailable detail view must not hide the session status or its messages.
        snapshot.activity = { turnId: turn.id, entries: [], error: error instanceof Error ? error.message : String(error) };
      }
    }
    return snapshot;
  }
  private async summary(id: string): Promise<Snapshot> {
    const metadata = await this.request<{ thread: Thread }>('thread/read', { threadId: id });
    try {
      const history = await this.request<{ data: Turn[] }>('thread/turns/list', {
        threadId: id, limit: 20, itemsView: 'summary', sortDirection: 'desc',
      });
      return { thread: metadata.thread, turns: history.data };
    } catch (error) {
      // Older legacy rollouts can lack paginated history; read without resuming.
      if (!(error instanceof RpcError) || error.uncertain) throw error;
      try {
        const history = await this.request<{ thread: Thread & { turns: Turn[] } }>('thread/read', { threadId: id, includeTurns: true });
        return { thread: metadata.thread, turns: history.thread.turns.slice(-20).reverse() };
      } catch (fallback) {
        // A newly-created thread has no persisted rollout before its first turn.
        if (fallback instanceof RpcError && /list_turns is not supported|no rollout found/.test(fallback.message)) return { thread: metadata.thread, turns: [] };
        throw fallback;
      }
    }
  }
  async history(id: string, cursor?: string): Promise<{ turns: Turn[]; nextCursor?: string | null }> {
    try {
      const page = await this.request<{ data: Turn[]; nextCursor?: string | null }>('thread/turns/list', {
        threadId: id, limit: 2, itemsView: 'summary', sortDirection: 'desc', ...(cursor ? { cursor } : {}),
      });
      return { turns: page.data, nextCursor: page.nextCursor };
    } catch (error) {
      if (!(error instanceof RpcError) || error.uncertain) throw error;
      if (cursor && !cursor.startsWith('legacy:')) throw error;
      try {
        const result = await this.request<{ thread: Thread & { turns: Turn[] } }>('thread/read', { threadId: id, includeTurns: true });
        const turns = [...result.thread.turns].reverse(), offset = Number(cursor?.slice(7) || 0);
        return { turns: turns.slice(offset, offset + 2), nextCursor: offset + 2 < turns.length ? `legacy:${offset + 2}` : null };
      } catch (fallback) {
        if (fallback instanceof RpcError && /no rollout found/.test(fallback.message)) return { turns: [] };
        throw fallback;
      }
    }
  }
  async models(_id: string): Promise<ModelOption[]> {
    const models: ModelOption[] = [];
    let cursor: string | null | undefined;
    do {
      const page = await this.request<{ data: ModelOption[]; nextCursor?: string | null }>('model/list', { limit: 100, includeHidden: false, ...(cursor ? { cursor } : {}) });
      models.push(...page.data); cursor = page.nextCursor;
    } while (cursor);
    return models;
  }
  async updateSettings(id: string, settings: ModelSettings): Promise<Thread> {
    const catalog = await this.models(id);
    const before = await this.request<{ thread: Thread }>('thread/read', { threadId: id });
    const chosen = catalog.find(model => model.model === (settings.model || before.thread.model));
    if (!chosen) throw new Error('该模型不在当前机器的可选列表中，请重新打开模型菜单。');
    const supported = chosen.supportedReasoningEfforts.map(option => option.reasoningEffort);
    if (settings.effort && !supported.includes(settings.effort)) throw new Error('当前模型不支持该推理强度，请重新打开推理强度菜单。');
    const patch: ModelSettings = { ...settings };
    // Preserve the current effort across a model change when supported; otherwise
    // use the new model's advertised default, never a hard-coded effort.
    if (settings.model && !settings.effort) {
      const current = before.thread.reasoningEffort;
      patch.effort = current && supported.includes(current) ? current : chosen.defaultReasoningEffort;
    }
    await this.prepare(id);
    await this.request('thread/settings/update', { threadId: id, ...patch });
    return (await this.request<{ thread: Thread }>('thread/read', { threadId: id })).thread;
  }
  async prepare(id: string): Promise<void> {
    const metadata = await this.request<{ thread: Thread }>('thread/read', { threadId: id });
    if (metadata.thread.status.type === 'notLoaded') await this.request('thread/resume', { threadId: id, excludeTurns: true });
  }
  async readFile(_id: string, path: string, maxBytes: number): Promise<Buffer> {
    const meta = await this.request('fs/getMetadata', { path });
    if (!meta.isFile) throw new Error('目标不是普通文件');
    // Check size before loading a whole base64 payload into the control connection.
    const stat = await this.request('command/exec', { command: ['stat', '-L', '--printf=%s', '--', path], cwd: '/', timeoutMs: 5000, outputBytesCap: 1024 });
    if (stat.exitCode !== 0 || !/^\d+$/.test(stat.stdout.trim())) throw new Error('无法读取文件大小：' + stat.stderr);
    if (Number(stat.stdout.trim()) > maxBytes) throw new Error('文件超出 20 MiB，第一版暂不支持');
    const result = await this.request('fs/readFile', { path });
    const data = Buffer.from(result.dataBase64, 'base64');
    if (data.length > maxBytes) throw new Error('文件超出 20 MiB，第一版暂不支持');
    return data;
  }
  async writeFile(_id: string, path: string, data: Buffer): Promise<void> {
    await this.request('fs/createDirectory', { path: targetPath(path).dirname(path), recursive: true });
    await this.request('fs/writeFile', { path, dataBase64: data.toString('base64') });
  }
  async send(id: string, text: string, inputId: string, files: PreparedFile[] = []): Promise<Turn> {
    try { await this.connect(); }
    catch (error) { throw new SubmissionError(error instanceof Error ? error.message : String(error), 'retryable'); }
    try {
      const result = await this.call<{ turn: Turn }>('turn/start', {
        threadId: id, clientUserMessageId: inputId, input: [
          { type: 'text', text: text + (files.length ? '\n\n用户附件（已保存到本机）：\n' + files.map(file => `${file.name}: ${file.path}`).join('\n') : ''), text_elements: [] },
          ...files.filter(file => file.mime.startsWith('image/')).map(file => ({ type: 'localImage', path: file.path })),
        ],
      });
      return result.turn;
    } catch (error) {
      const outcome = error instanceof RpcError
        ? error.uncertain ? 'uncertain' : error.code !== undefined ? 'rejected' : 'retryable'
        : 'uncertain';
      throw new SubmissionError(error instanceof Error ? error.message : String(error), outcome);
    }
  }
  async interrupt(id: string, turnId: string) {
    await this.request('turn/interrupt', { threadId: id, turnId });
  }
  private rejectPending(ws: WebSocket, error: RpcError) {
    for (const [id, request] of this.pending) {
      if (request.ws !== ws) continue;
      clearTimeout(request.timer); this.pending.delete(id); request.reject(error);
    }
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    if (this.ws) {
      this.rejectPending(this.ws, new RpcError('Codex 客户端关闭，调用结果未知', undefined, true));
      this.ws.terminate();
    }
  }
}
