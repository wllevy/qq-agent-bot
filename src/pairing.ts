import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { allowedUser } from './access.js';
import type { Sender } from './types.js';

type Challenge = { code: string; expiresAt: number };
type Request = Challenge & { senderId: string };
export const PAIRING_TTL = 5 * 60_000;

function read(file: string): unknown {
  try { return JSON.parse(readFileSync(file, 'utf8')); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
}
function write(file: string, value: unknown) {
  const temporary = file + '.' + randomUUID() + '.tmp';
  try { writeFileSync(temporary, JSON.stringify(value), { mode: 0o600 }); renameSync(temporary, file); }
  finally { rmSync(temporary, { force: true }); }
}
function challenge(value: unknown): value is Challenge {
  const v = value as Challenge | undefined;
  return !!v && /^[A-F0-9]{12}$/.test(v.code) && Number.isFinite(v.expiresAt);
}

// Only local CLI writes grants/challenges. The gateway records a single candidate;
// knowing the code alone never grants access. Scope grants to the QQ application.
export class PairingAccess {
  readonly directory: string;
  constructor(dataDir: string, appId: string, private configuredUsers: readonly string[] = [], private now = Date.now) {
    if (!/^[a-zA-Z0-9_-]+$/.test(appId)) throw new Error('QQ AppID 格式错误');
    this.directory = join(dataDir, 'pairing', encodeURIComponent(appId));
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
  }
  users(): string[] {
    const value = read(join(this.directory, 'users.json'));
    if (value === undefined) return [];
    if (!Array.isArray(value) || value.some(id => typeof id !== 'string' || !id)) throw new Error('配对授权文件格式错误，拒绝访问；请在本机检查 users.json');
    return value;
  }
  allowed(senderId: string): boolean { return allowedUser(this.configuredUsers, senderId) || allowedUser(this.users(), senderId); }
  begin(): Challenge {
    const active = read(join(this.directory, 'challenge.json'));
    if (challenge(active) && active.expiresAt > this.now()) throw new Error('已有配对正在等待，请完成或取消后重试');
    const next = { code: randomBytes(6).toString('hex').toUpperCase(), expiresAt: this.now() + PAIRING_TTL };
    rmSync(join(this.directory, 'request.json'), { force: true });
    write(join(this.directory, 'challenge.json'), next);
    return next;
  }
  request(code: string, senderId: string): boolean {
    if (!senderId) return false;
    const active = read(join(this.directory, 'challenge.json'));
    if (!challenge(active) || active.code !== code.toUpperCase() || active.expiresAt <= this.now()) return false;
    const file = join(this.directory, 'request.json');
    // The bot process lock guarantees a single gateway writer. Publish atomically
    // so the local CLI never sees a partially written candidate.
    if (existsSync(file)) return false;
    write(file, { ...active, senderId });
    return true;
  }
  pending(code: string): Request | undefined {
    const active = read(join(this.directory, 'challenge.json'));
    const value = read(join(this.directory, 'request.json')) as Request | undefined;
    if (!challenge(active) || active.code !== code || active.expiresAt <= this.now()) return;
    if (challenge(value) && value.code === code && value.expiresAt === active.expiresAt && typeof value.senderId === 'string' && value.senderId) return value;
  }
  approve(code: string, senderId: string) {
    if (this.pending(code)?.senderId !== senderId) throw new Error('配对请求已失效，请重新运行 npm run pair');
    write(join(this.directory, 'users.json'), [...new Set([...this.users(), senderId])]);
    this.cancel(code);
  }
  cancel(code: string) {
    const active = read(join(this.directory, 'challenge.json'));
    if (challenge(active) && active.code === code) {
      rmSync(join(this.directory, 'challenge.json'), { force: true });
      rmSync(join(this.directory, 'request.json'), { force: true });
    }
  }
  revoke(senderId: string) {
    write(join(this.directory, 'users.json'), this.users().filter(id => id !== senderId));
    return this.configuredUsers.includes(senderId);
  }
}

export async function handlePairing(access: PairingAccess, sender: Sender, message: { senderId: string; content: string; messageId: string }): Promise<boolean> {
  if (!/^\/?配对(?:\s|$)/.test(message.content.trim())) return false;
  const code = /^\/?配对\s+([a-fA-F0-9]{12})$/.exec(message.content.trim())?.[1];
  if (code && access.request(code, message.senderId)) {
    await sender.send(message.senderId, '配对申请已提交，请在运行 setup / pair 的电脑终端确认。确认前无法控制会话。', { replyTo: message.messageId });
  }
  return true;
}
