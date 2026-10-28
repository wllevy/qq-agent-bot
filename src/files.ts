import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { basename, extname, join, posix, win32 } from 'node:path';
import { errorText } from './config.js';
import { Store } from './store.js';
import { forEachConcurrent } from './work.js';
import type { Attachment, Button, CodexPort, PreparedFile, Snapshot, TransferFile, Turn } from './types.js';

export const MAX_FILE_BYTES = 20 * 1024 * 1024;
export const targetPath = (cwd: string) => /^[a-z]:[\\/]|^\\\\/i.test(cwd) ? win32 : posix;
export class FileError extends Error { constructor(message: string, public permanent = false) { super(message); } }
const types: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.mp4': 'video/mp4', '.pdf': 'application/pdf' };
const cacheable = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.mp4', '.pdf', '.docx', '.xlsx', '.pptx', '.csv', '.zip', '.md', '.html', '.txt']);
const safeName = (name: string) => {
  const result = basename(name.replaceAll('\\', '/')).replace(/[\x00-\x1f<>:"|?*]/g, '_').replace(/[. ]+$/, '').slice(0, 180);
  return !result || ['.', '..'].includes(result) ? 'attachment' : result;
};
export function linkedFiles(turn: Turn, cwd: string): { path: string; name: string }[] {
  const all = turn.items.filter(item => item.type === 'agentMessage' && item.text);
  const finals = all.filter(item => item.phase === 'final_answer');
  const text = (finals.length ? finals : all.slice(-1)).map(item => item.text).join('\n');
  const paths = new Map<string, string>();
  for (const match of text.matchAll(/!?\[([^\]]*)\]\((?:<([^>]+)>|([^\n]*?))\)/g)) {
    let path = (match[2] || match[3] || '').trim().replace(/\s+"[^"]*"$/, '');
    if (/^(?:https?:|mailto:|data:|#)/i.test(path)) continue;
    path = path.replace(/^(?:file:\/\/|sandbox:)/, '').replace(/#L\d+(?:C\d+)?(?:-L?\d+)?$/, '').replace(/:\d+(?::\d+)?$/, '');
    try { path = decodeURIComponent(path); } catch {}
    if (/^\/[a-z]:\//i.test(path)) path = path.slice(1);
    if (!path || path.includes('\0') || (/^[a-zA-Z]+:/.test(path) && !/^[a-z]:[\\/]/i.test(path))) continue;
    path = targetPath(cwd).resolve(cwd, path);
    if (!extname(path)) continue;
    paths.set(path, safeName(path));
  }
  return [...paths].map(([path, name]) => ({ path, name }));
}

export class FileTransfers {
  private work?: Promise<void>;
  private stopping = false;
  private closing = new AbortController();
  constructor(private store: Store, private codex: CodexPort, private download: typeof fetch = fetch) {}
  private get records() { return this.store.state.files ??= {}; }
  get(id: string) { return this.records[id]; }
  list(user: string, thread: string) { return Object.values(this.records).filter(file => file.user === user && file.thread === thread); }
  incoming(user: string, thread: string, attachments: Attachment[]): string[] {
    return attachments.map(attachment => {
      const id = randomUUID();
      let fallback = 'attachment';
      try { fallback = new URL(attachment.url.startsWith('//') ? 'https:' + attachment.url : attachment.url).pathname; } catch {}
      const name = safeName(attachment.filename || fallback);
      const oversized = (attachment.size || 0) > MAX_FILE_BYTES;
      this.records[id] = { id, user, thread, name, mime: attachment.content_type || types[extname(name).toLowerCase()] || 'application/octet-stream', direction: 'in',
        url: attachment.url, size: attachment.size, status: oversized ? 'failed' : 'pending', attempts: 0, retryAt: 0,
        ...(oversized ? { error: '文件超出 20 MiB，第一版暂不支持' } : {}) };
      return id;
    });
  }
  candidates(user: string, snapshot: Snapshot, turns: Turn[]): TransferFile[] {
    const files: TransferFile[] = [];
    for (const turn of turns) for (const link of linkedFiles(turn, snapshot.thread.cwd)) {
      let file = this.list(user, snapshot.thread.id).find(file => file.direction === 'out' && file.turn === turn.id && file.sourcePath === link.path);
      if (!file) {
        const id = randomUUID();
        file = { id, user, thread: snapshot.thread.id, turn: turn.id, name: link.name, sourcePath: link.path,
          mime: types[extname(link.name).toLowerCase()] || 'application/octet-stream', direction: 'out',
          status: cacheable.has(extname(link.name).toLowerCase()) ? 'pending' : 'listed', attempts: 0, retryAt: 0 };
        this.records[id] = file;
      }
      files.push(file);
    }
    return files;
  }
  explicit(user: string, thread: string, path: string): TransferFile {
    const id = randomUUID(), name = safeName(path);
    const file: TransferFile = { id, user, thread, name, sourcePath: path, mime: types[extname(name).toLowerCase()] || 'application/octet-stream', direction: 'out', status: 'pending', attempts: 0, retryAt: 0 };
    this.records[id] = file; return file;
  }
  buttons(files: TransferFile[]): Button[] {
    return files.slice(0, 8).map(file => ({ label: '发送 ' + file.name.slice(0, 7), command: '/取文件 ' + file.id }));
  }
  describe(file: TransferFile) {
    const state = file.status === 'ready' ? '已缓存' : file.status === 'listed' ? '按需获取' : file.status === 'failed' ? '不可用' : '等待传输';
    return `${file.name} · ${state}${file.error ? ' · ' + file.error : ''}`;
  }
  pending(user: string, thread: string) { return this.list(user, thread).filter(file => file.direction === 'in' && !file.claimedBy); }
  clearPending(user: string, thread: string) {
    for (const file of this.pending(user, thread)) file.claimedBy = 'discarded';
    this.store.save();
  }
  request(file: TransferFile) {
    if (file.status === 'failed') throw new FileError(file.error || '文件不可用', true);
    if (file.status === 'listed') file.status = 'pending';
    file.retryAt = 0; this.store.save();
  }
  async prepare(ids: string[], cwd: string): Promise<PreparedFile[]> {
    const result: PreparedFile[] = [];
    for (const id of ids) {
      const file = this.get(id);
      if (!file) throw new FileError('附件记录不存在，请重新发送', true);
      if (file.status === 'failed') throw new FileError(file.error || '附件不可用，请重新发送', true);
      if (file.status !== 'ready' || !file.localPath) throw new FileError(`附件 ${file.name} 正在保存${file.error ? '：' + file.error : ''}`);
      if (!file.remotePath) {
        if (!this.codex.writeFile) throw new FileError('当前机器不支持附件传输', true);
        const path = targetPath(cwd).join(cwd, '.qqbot-attachments', file.id, file.name);
        await this.codex.writeFile(file.thread, path, await readFile(file.localPath));
        file.remotePath = path; this.store.save();
      }
      result.push({ path: file.remotePath, name: file.name, mime: file.mime });
    }
    return result;
  }
  tick(): Promise<void> {
    if (this.stopping) return Promise.resolve();
    if (this.work) return this.work;
    const files = Object.values(this.records).filter(file => file.status === 'pending' && file.retryAt <= Date.now());
    const work = forEachConcurrent(files, 2, async file => {
      if (this.stopping) return;
      try {
        const data = file.direction === 'in' ? await this.fetchAttachment(file) : await this.readRemote(file);
        const path = join(this.store.directory, 'files', file.id, file.name);
        await mkdir(join(this.store.directory, 'files', file.id), { recursive: true, mode: 0o700 });
        await writeFile(path + '.part', data, { mode: 0o600 });
        await rename(path + '.part', path);
        file.localPath = path; file.size = data.length; file.status = 'ready'; delete file.error;
      } catch (error) {
        file.error = errorText(error); file.attempts++;
        file.status = error instanceof FileError && error.permanent || /超出 20 MiB|不是普通文件|No such file|not found|ENOENT/i.test(file.error) ? 'failed' : 'pending';
        file.retryAt = Date.now() + Math.min(300000, 5000 * 2 ** Math.min(file.attempts, 6));
      }
      this.store.save();
    });
    this.work = work;
    void work.finally(() => { if (this.work === work) this.work = undefined; }).catch(() => {});
    return work;
  }
  async shutdown() { this.stopping = true; this.closing.abort(); await this.work; }
  private async readRemote(file: TransferFile) {
    if (!this.codex.readFile) throw new FileError('当前机器不支持文件读取', true);
    return this.codex.readFile(file.thread, file.sourcePath!, MAX_FILE_BYTES);
  }
  private async fetchAttachment(file: TransferFile): Promise<Buffer> {
    const url = file.url!.startsWith('//') ? 'https:' + file.url : file.url!;
    if (!/^https?:\/\//i.test(url)) throw new FileError('附件地址无效，请重新发送', true);
    const response = await this.download(url, { signal: AbortSignal.any([AbortSignal.timeout(60000), this.closing.signal]) });
    if (!response.ok) throw new FileError(`下载附件失败（HTTP ${response.status}）${[401, 403, 404, 410].includes(response.status) ? '，请重新发送文件' : ''}`, [401, 403, 404, 410].includes(response.status));
    const reader = response.body?.getReader();
    if (!reader) throw new FileError('附件没有返回文件内容', true);
    const chunks: Buffer[] = []; let size = 0;
    try {
      if (Number(response.headers.get('content-length')) > MAX_FILE_BYTES) throw new FileError('文件超出 20 MiB，第一版暂不支持', true);
      while (true) {
        const next = await reader.read(); if (next.done) break;
        size += next.value.byteLength;
        if (size > MAX_FILE_BYTES) throw new FileError('文件超出 20 MiB，第一版暂不支持', true);
        chunks.push(Buffer.from(next.value));
      }
      return Buffer.concat(chunks);
    } finally { await reader.cancel().catch(() => {}); }
  }
}
