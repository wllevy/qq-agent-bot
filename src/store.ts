import { mkdirSync, readFileSync, writeFileSync, renameSync, openSync, closeSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import type { State, Chat } from './types.js';

export function emptyState(): State {
  return { version: 4, inbox: [], chats: {}, outbox: [], inputs: [], received: [], refs: {} };
}
export class Store {
  state: State;
  private file: string;
  private persisted?: State;
  constructor(public readonly directory: string) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.file = join(directory, 'state.json');
    try { this.state = JSON.parse(readFileSync(this.file, 'utf8')); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      this.state = emptyState();
    }
    validateState(this.state);
    // A send interrupted by process exit has an unknown result; never replay it.
    for (const input of this.state.inputs) if (input.state === 'sending') input.state = 'uncertain';
    this.save();
  }
  chat(user: string): Chat {
    return this.state.chats[user] ??= { menu: [], page: 0, subscriptions: {} };
  }
  save() {
    if (this.persisted && isDeepStrictEqual(this.state, this.persisted)) return;
    const temporary = this.file + '.tmp';
    writeFileSync(temporary, JSON.stringify(this.state), { mode: 0o600 });
    renameSync(temporary, this.file);
    this.persisted = structuredClone(this.state);
  }
  completeIncoming(id: string) {
    this.state.inbox = this.state.inbox.filter(entry => entry.id !== id);
    if (!this.state.received.includes(id)) this.state.received.push(id);
    this.state.received = this.state.received.slice(-2000);
  }
  remember(user: string, ids: string[], thread?: string, save = true) {
    if (!thread) return;
    for (const id of ids) if (id) this.state.refs[id] = { user, thread };
    const keys = Object.keys(this.state.refs);
    for (const key of keys.slice(0, Math.max(0, keys.length - 2000))) delete this.state.refs[key];
    if (save) this.save();
  }
  static lock(directory: string): () => void {
    const file = join(directory, 'bot.pid');
    try {
      const pid = Number(readFileSync(file, 'utf8'));
      if (pid > 0) {
        try { process.kill(pid, 0); throw new Error(`Bot 已运行（PID ${pid}）`); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
      }
      unlinkSync(file);
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    const fd = openSync(file, 'wx', 0o600);
    writeFileSync(fd, String(process.pid)); closeSync(fd);
    return () => { try { unlinkSync(file); } catch {} };
  }
}

function validateState(value: unknown): asserts value is State {
  const object = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v);
  const strings = (v: unknown): v is string[] => Array.isArray(v) && v.every(item => typeof item === 'string');
  const optionalString = (v: unknown) => v === undefined || typeof v === 'string';
  const natural = (v: unknown) => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
  const records = (v: unknown, check: (entry: any) => boolean) => object(v) && Object.values(v).every(entry => object(entry) && check(entry));
  const array = (v: unknown, check: (entry: any) => boolean) => Array.isArray(v) && v.every(entry => object(entry) && check(entry));
  const valid = object(value) && value.version === 4 && strings(value.received)
    && (value.directories === undefined || object(value.directories) && Object.values(value.directories).every(entries => array(entries, d => typeof d.path === 'string' && typeof d.lastUsed === 'number' && Number.isFinite(d.lastUsed))))
    && (value.files === undefined || records(value.files, f => typeof f.id === 'string' && typeof f.user === 'string'
      && typeof f.thread === 'string' && typeof f.name === 'string' && typeof f.mime === 'string'
      && ['in', 'out'].includes(f.direction) && ['pending', 'ready', 'listed', 'failed'].includes(f.status)
      && natural(f.attempts) && natural(f.retryAt)
      && ['url', 'sourcePath', 'localPath', 'remotePath', 'turn', 'claimedBy', 'error'].every(key => optionalString(f[key]))
      && (f.size === undefined || natural(f.size))
      && (f.upload === undefined || object(f.upload) && typeof f.upload.info === 'string' && natural(f.upload.expiresAt))))
    && records(value.chats, c => optionalString(c.current) && strings(c.menu) && optionalString(c.menuMachine) && natural(c.page)
      && (c.creationMenu === undefined || object(c.creationMenu) && typeof c.creationMenu.token === 'string' && optionalString(c.creationMenu.machine)
        && strings(c.creationMenu.choices) && typeof c.creationMenu.query === 'string' && natural(c.creationMenu.page))
      && records(c.subscriptions, w => typeof w.persistent === 'boolean' && strings(w.seen) && optionalString(w.attention)
        && (array(w.replies, r => typeof r.inputId === 'string' && optionalString(r.turnId)))
        && (w.terminalStatuses === undefined || object(w.terminalStatuses) && Object.values(w.terminalStatuses).every(s => ['completed', 'failed', 'interrupted'].includes(String(s)))))
      && (c.settingsMenu === undefined || object(c.settingsMenu) && typeof c.settingsMenu.thread === 'string'
        && ['model', 'effort'].includes(c.settingsMenu.kind) && strings(c.settingsMenu.values)))
    && records(value.refs, r => typeof r.user === 'string' && typeof r.thread === 'string')
    && array(value.inbox, i => typeof i.id === 'string' && typeof i.user === 'string' && typeof i.text === 'string'
      && typeof i.messageId === 'string' && optionalString(i.reference)
      && optionalString(i.attachmentThread) && (i.fileIds === undefined || strings(i.fileIds))
      && (i.creation === undefined || object(i.creation) && typeof i.creation.machine === 'string' && typeof i.creation.cwd === 'string'
        && (i.creation.thread === undefined || object(i.creation.thread) && typeof i.creation.thread.id === 'string' && typeof i.creation.thread.cwd === 'string' && object(i.creation.thread.status) && typeof i.creation.thread.status.type === 'string'))
      && (i.stopTarget === undefined || object(i.stopTarget) && typeof i.stopTarget.thread === 'string' && optionalString(i.stopTarget.turn)))
    && array(value.inputs, i => typeof i.id === 'string' && typeof i.user === 'string' && typeof i.thread === 'string'
      && typeof i.text === 'string' && ['queued', 'sending', 'uncertain', 'rejected'].includes(i.state) && optionalString(i.error) && optionalString(i.threadLabel)
      && (i.fileIds === undefined || strings(i.fileIds)))
    && array(value.outbox, o => typeof o.id === 'string' && typeof o.user === 'string' && typeof o.text === 'string'
      && ['reply', 'notification'].includes(o.kind) && optionalString(o.thread) && (o.kind !== 'notification' || typeof o.thread === 'string')
      && strings(o.parts) && natural(o.part) && o.part <= o.parts.length && natural(o.attempts) && natural(o.retryAt)
      && optionalString(o.turn) && optionalString(o.replyTo) && (o.acknowledge === undefined || strings(o.acknowledge))
      && optionalString(o.fileId)
      && (o.buttons === undefined || array(o.buttons, b => typeof b.label === 'string' && typeof b.command === 'string')));
  if (!valid) throw new Error('中控台状态文件结构不完整或版本不受支持，请保留原文件后检查');
}
