import { existsSync, readdirSync, statSync } from 'node:fs';
import { mkdir, open, writeFile, stat } from 'node:fs/promises';
import { dirname, join, isAbsolute, resolve } from 'node:path';
import { homedir } from 'node:os';
import { Codex } from './codex.js';
import { DesktopIPC, DesktopError } from './desktop-ipc.js';
import { StdioRPC } from './stdio-rpc.js';
import { SubmissionError } from './domain.js';
import type { ModelSettings, PreparedFile, Snapshot, SnapshotOptions, Thread, Turn } from './types.js';

export function codexExecutable(): string {
  if (process.env.CODEX_EXECUTABLE) return process.env.CODEX_EXECUTABLE;
  if (process.platform !== 'win32') return 'codex';
  const root = join(process.env.LOCALAPPDATA || '', 'OpenAI', 'Codex', 'bin');
  const candidates = existsSync(root) ? readdirSync(root).map(dir => join(root, dir, 'codex.exe')).filter(existsSync) : [];
  // Installed runtime directories are immutable; the newest runtime is preferred.
  if (candidates.length) {
    return candidates.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0]!;
  }
  throw new Error('找不到 Codex 桌面运行时，请配置 CODEX_EXECUTABLE');
}

export function desktopTurns(state: any): Turn[] {
  const history = state.turnHistory?.kind === 'canonical' ? state.turnHistory.history : undefined;
  const turns: any[] = history
    ? history.islands.flatMap((island: any) => island.entries.map((entry: any) => history.entitiesByKey[entry.value]))
    : state.turns || [];
  return turns.filter(t => t?.turnId).slice(-20).reverse().map(t => ({
    id: t.turnId, status: t.status, error: t.error,
    startedAt: t.turnStartedAtMs == null ? null : t.turnStartedAtMs / 1000,
    completedAt: t.turnStartedAtMs == null || t.durationMs == null ? null : (t.turnStartedAtMs + t.durationMs) / 1000,
    items: Array.isArray(t.items) ? t.items : [],
  }));
}

export class LocalCodex extends Codex {
  private rpc: StdioRPC;
  private desktop: Pick<DesktopIPC, 'owner' | 'snapshot' | 'request' | 'close'>;
  private snapshots = new Map<string, Promise<any>>();
  constructor(executable: string | (() => string) = codexExecutable, desktopEnabled = true) {
    super('desktop');
    this.desktop = desktopEnabled ? new DesktopIPC() : { owner: async () => undefined, snapshot: async () => { throw new Error('桌面 IPC 未启用'); }, request: async () => { throw new Error('桌面 IPC 未启用'); }, close() {} };
    this.rpc = new StdioRPC(executable);
    for (const event of ['notification', 'serverRequest']) this.rpc.on(event, m => this.emit(event, m));
  }
  override connect() { return this.rpc.connect(); }
  protected override async creationDirectory(cwd: string) {
    if (cwd === '~' || /^~[\\/]/.test(cwd)) cwd = resolve(homedir(), cwd.slice(2));
    if (!isAbsolute(cwd)) throw new Error('请输入项目的绝对目录路径');
    if (!(await stat(cwd)).isDirectory()) throw new Error('所选路径不是目录');
    return resolve(cwd);
  }
  protected override call<T>(method: string, params: unknown, timeout = 20000): Promise<T> { return this.rpc.call(method, params, timeout); }
  private state(id: string, owner: string) {
    const existing = this.snapshots.get(id);
    if (existing) return existing;
    const work = this.desktop.snapshot(id, owner).finally(() => { this.snapshots.delete(id); });
    this.snapshots.set(id, work);
    return work;
  }
  override async snapshot(id: string, options?: SnapshotOptions): Promise<Snapshot> {
    const owner = await this.desktop.owner(id);
    const snapshot = await super.snapshot(id, owner ? undefined : options);
    if (!owner) return snapshot;
    const state = await this.state(id, owner);
    snapshot.thread = {
      ...snapshot.thread, name: state.title || snapshot.thread.name,
      model: state.latestModel ?? snapshot.thread.model,
      reasoningEffort: state.latestReasoningEffort ?? state.latestCollaborationMode?.settings?.reasoning_effort ?? snapshot.thread.reasoningEffort,
      status: state.threadRuntimeStatus || { type: desktopTurns(state)[0]?.status === 'inProgress' ? 'active' : 'idle' },
    };
    const live = desktopTurns(state);
    // Completed history is read from app-server; the desktop adds current live
    // turns which are not necessarily persisted yet. Prefer complete stored items.
    const persisted = new Map(snapshot.turns.map(t => [t.id, t]));
    snapshot.turns = [...live.map(t => t.status === 'inProgress' || !persisted.has(t.id) ? t : { ...persisted.get(t.id)!, status: t.status, error: t.error }), ...snapshot.turns.filter(t => !live.some(l => l.id === t.id))].slice(0, 20);
    if (options?.activity && live[0]?.status === 'inProgress') snapshot.activity = { turnId: live[0].id, entries: live[0].items.slice(-30).reverse().map(item => ({ turnId: live[0]!.id, item })) };
    return snapshot;
  }
  override async prepare(id: string) {
    if (await this.desktop.owner(id)) return;
    await super.prepare(id);
  }
  override async send(id: string, text: string, inputId: string, files: PreparedFile[] = []): Promise<Turn> {
    let owner: string | undefined;
    try { owner = await this.desktop.owner(id); }
    catch (error) { throw new SubmissionError(String(error), 'retryable'); }
    if (!owner) return super.send(id, text, inputId, files);
    const input = [
      { type: 'text', text: text + (files.length ? '\n\n用户附件（已保存到本机）：\n' + files.map(f => `${f.name}: ${f.path}`).join('\n') : ''), text_elements: [] },
      ...files.filter(f => f.mime.startsWith('image/')).map(f => ({ type: 'localImage', path: f.path })),
    ];
    try {
      const response = await this.desktop.request(owner, 'thread-follower-start-turn', {
        conversationId: id,
        turnStart: { request: { threadId: id, input, clientUserMessageId: inputId }, context: { inheritThreadSettings: true } },
      }, 2);
      if (!response.result?.turn?.id) throw new DesktopError('桌面未返回已提交轮次，需核对本机会话', true);
      return response.result.turn;
    } catch (error) {
      throw new SubmissionError(error instanceof Error ? error.message : String(error), error instanceof DesktopError && !error.uncertain ? 'rejected' : 'uncertain');
    }
  }
  override async updateSettings(id: string, settings: ModelSettings): Promise<Thread> {
    const owner = await this.desktop.owner(id);
    if (!owner) return super.updateSettings(id, settings);
    const before = await this.snapshot(id);
    const models = await this.models(id);
    const chosen = models.find(m => m.model === (settings.model || before.thread.model));
    if (!chosen) throw new Error('该模型不在当前机器的可选列表中');
    const efforts = chosen.supportedReasoningEfforts.map(e => e.reasoningEffort);
    if (settings.effort && !efforts.includes(settings.effort)) throw new Error('当前模型不支持该推理强度');
    const patch = { ...settings };
    if (settings.model && !settings.effort) patch.effort = before.thread.reasoningEffort && efforts.includes(before.thread.reasoningEffort) ? before.thread.reasoningEffort : chosen.defaultReasoningEffort;
    const response = await this.desktop.request(owner, 'thread-follower-update-thread-settings', { conversationId: id, threadSettings: patch }, 2);
    if (!response.applied) throw new Error('桌面会话设置未应用，请重试');
    return (await this.snapshot(id)).thread;
  }
  override async interrupt(id: string, turnId: string) {
    const owner = await this.desktop.owner(id);
    if (!owner) return super.interrupt(id, turnId);
    await this.desktop.request(owner, 'thread-follower-interrupt-turn', { conversationId: id, mode: 'user-stop', expectedTurnId: turnId }, 4);
  }
  override async readFile(_id: string, path: string, maxBytes: number): Promise<Buffer> {
    const file = await open(path, 'r');
    try {
      const stat = await file.stat();
      if (!stat.isFile()) throw new Error('目标不是普通文件');
      if (stat.size > maxBytes) throw new Error('文件超出 20 MiB');
      const buffer = Buffer.alloc(Math.min(maxBytes + 1, stat.size + 1));
      const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
      if (bytesRead > maxBytes) throw new Error('文件超出 20 MiB');
      return buffer.subarray(0, bytesRead);
    } finally { await file.close(); }
  }
  override async writeFile(_id: string, path: string, data: Buffer) {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, data);
  }
  override close() { this.desktop.close(); this.rpc.close(); }
}
