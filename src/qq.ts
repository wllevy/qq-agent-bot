import { QQBot, FileKVStore, kvSessionPersistence, type ReplyTarget } from '@tencent-connect/qqbot-nodejs';
import { setTimeout as delay } from 'node:timers/promises';
import { readFile } from 'node:fs/promises';
import { log } from './config.js';
import { splitText } from './presentation.js';
import type { Button, Sender, TransferFile } from './types.js';

export function makeBot(appId: string, appSecret: string, directory: string) {
  return new QQBot({
    appId, appSecret, accountId: appId,
    // C2C messages/lifecycle plus interaction events; no group subscriptions.
    intents: (1 << 25) | (1 << 26),
    sessionPersistence: kvSessionPersistence({ store: new FileKVStore({ dir: directory + '/gateway' }), accountId: appId }),
    logger: {
      info: (...args: unknown[]) => log(args.map(String).join(' ')),
      warn: (...args: unknown[]) => log(args.map(String).join(' ')),
      error: (...args: unknown[]) => log(args.map(String).join(' ')),
      debug: () => {},
    },
  });
}

function keyboard(buttons: Button[]) {
  const rows = [];
  const visible = buttons.slice(0, 20);
  const columns = Math.max(2, Math.ceil(visible.length / 5));
  for (let i = 0; i < visible.length; i += columns) {
    rows.push({ buttons: visible.slice(i, i + columns).map((button, j) => ({
      id: `console_${i + j}`,
      render_data: { label: button.label.slice(0, 10), visited_label: button.label.slice(0, 10), style: 1 },
      action: { type: 2, permission: { type: 2 }, data: button.command, enter: true },
    })) });
  }
  return { content: { rows } };
}

export class QQSender implements Sender {
  private work = new Map<string, Promise<unknown>>();
  private lastSent = new Map<string, number>();
  private readonly keyboardsEnabled: boolean;
  private closing = new AbortController();
  constructor(private bot: QQBot, keyboards = true) { this.keyboardsEnabled = keyboards; }
  async send(user: string, text: string, options?: { replyTo?: string; thread?: string; buttons?: Button[] }): Promise<string[]> {
    if (this.closing.signal.aborted) throw new Error('QQ 发送器已关闭');
    const prior = this.work.get(user) || Promise.resolve();
    const job = prior.catch(() => {}).then(() => this.perform(user, text, options));
    this.work.set(user, job);
    try { return await job; }
    finally { if (this.work.get(user) === job) this.work.delete(user); }
  }
  async sendFile(user: string, file: TransferFile, uploaded: (upload: { info: string; expiresAt: number }) => void): Promise<string[]> {
    if (this.closing.signal.aborted) throw new Error('QQ 发送器已关闭');
    const prior = this.work.get(user) || Promise.resolve();
    const job = prior.catch(() => {}).then(async () => {
      await delay(Math.max(0, 3100 - (Date.now() - (this.lastSent.get(user) || 0))), undefined, { signal: this.closing.signal });
      const route = '/v2/users/' + encodeURIComponent(user);
      // Keep upload and delivery separate so a failed send reuses the stored upload.
      let upload = file.upload;
      if (!upload || upload.expiresAt <= Date.now() + 60000) {
        const data = await readFile(file.localPath!);
        if (data.length > 20 * 1024 * 1024) throw new Error('文件超出 20 MiB');
        const fileType = file.mime.startsWith('image/') ? 1 : file.mime === 'video/mp4' ? 2 : 4;
        const result = await this.bot.api.post<{ file_info: string; ttl: number }>(route + '/files', {
          file_type: fileType, file_data: data.toString('base64'), srv_send_msg: false,
          ...(fileType === 4 ? { file_name: file.name } : {}),
        });
        if (!result.file_info) throw new Error('QQ 未返回文件上传凭据');
        upload = { info: result.file_info, expiresAt: Date.now() + Math.max(0, result.ttl || 0) * 1000 };
        uploaded(upload);
      }
      if (this.closing.signal.aborted) throw new Error('QQ 发送器已关闭');
      const response = await this.bot.api.post<{ id?: string; ext_info?: { ref_idx?: string } }>(route + '/messages', {
        msg_type: 7, media: { file_info: upload.info }, msg_seq: 1,
      });
      this.lastSent.set(user, Date.now());
      return [response.id, response.ext_info?.ref_idx].filter((id): id is string => Boolean(id));
    });
    this.work.set(user, job);
    try { return await job; }
    finally { if (this.work.get(user) === job) this.work.delete(user); }
  }
  close() { this.closing.abort(); }
  async drain() { await Promise.allSettled([...this.work.values()]); }
  private async perform(user: string, text: string, options?: { replyTo?: string; buttons?: Button[] }): Promise<string[]> {
    const chunks = text.length <= 1800 ? [text] : splitText(text);
    const ids: string[] = [];
    for (let i = 0; i < chunks.length; i++) {
      // Stay below QQ's per-recipient active-message limit, including long replies.
      await delay(Math.max(0, 3100 - (Date.now() - (this.lastSent.get(user) || 0))), undefined, { signal: this.closing.signal });
      const target: ReplyTarget = { scope: 'c2c', targetId: user };
      // A passive message can only receive four replies; subsequent parts are active messages.
      if (options?.replyTo && i < 4) target.msgId = options.replyTo;
      const buttons = i === chunks.length - 1 && this.keyboardsEnabled ? options?.buttons : undefined;
      const response = await this.sendPart(target, chunks[i]!, buttons);
      this.lastSent.set(user, Date.now());
      if (response.id) ids.push(response.id);
      if (response.ext_info?.ref_idx) ids.push(response.ext_info.ref_idx);
    }
    return ids;
  }
  private async sendPart(target: ReplyTarget, text: string, buttons?: Button[]): Promise<{ id?: string; ext_info?: { ref_idx?: string } }> {
    if (this.closing.signal.aborted) throw new Error('QQ 发送器已关闭');
    const explicitRejection = (error: unknown) => {
      const api = error as { httpStatus?: number };
      return !this.closing.signal.aborted && !!api.httpStatus && api.httpStatus >= 400 && api.httpStatus < 500 && api.httpStatus !== 429;
    };
    try {
      return await this.bot.sendMarkdown(target, text, buttons?.length ? { keyboard: keyboard(buttons) } : undefined);
    } catch (error) {
      // A rejected payload says nothing about the next message's capabilities.
      // Never replay ambiguous network failures or globally disable keyboards.
      if (!explicitRejection(error)) throw error;
      if (buttons?.length) {
        log('QQ 按钮发送被拒绝，仅本条消息降级为文字菜单', error);
        try { return await this.bot.sendMarkdown(target, text); }
        catch (fallback) {
          if (!explicitRejection(fallback)) throw fallback;
          log('QQ Markdown 被拒绝，仅本条消息降级为纯文字', fallback);
        }
      } else log('QQ Markdown 被拒绝，仅本条消息降级为纯文字', error);
      return this.bot.sendText(target, text);
    }
  }
}
