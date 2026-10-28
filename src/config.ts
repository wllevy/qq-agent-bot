import 'dotenv/config';
import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve, join } from 'node:path';

export interface MachineConfig { id: string; endpoint: string }
function machines(): MachineConfig[] {
  const path = resolve(process.env.BOT_MACHINES_FILE || 'machines.json');
  if (!existsSync(path)) {
    const entries = [...(process.env.CODEX_ENABLED === 'false' ? [] : [{ id: 'local', endpoint: defaultEndpoint() }]), ...(process.env.CLAUDE_ENABLED === 'false' ? [] : [{ id: 'claude', endpoint: 'claude' }])];
    if (!entries.length) throw new Error('至少启用 Codex 或 Claude 一个后端');
    return entries;
  }
  const entries: MachineConfig[] = JSON.parse(readFileSync(path, 'utf8'));
  if (!Array.isArray(entries) || !entries.length || entries.some(m => !/^[a-zA-Z0-9_-]+$/.test(m.id) || typeof m.endpoint !== 'string' || !m.endpoint) || new Set(entries.map(m => m.id)).size !== entries.length) {
    throw new Error('machines.json 必须包含不同的机器 id 和连接 endpoint');
  }
  return entries;
}
function defaultEndpoint() { return process.env.CODEX_SOCKET || (process.platform === 'win32' ? 'desktop' : join(homedir(), '.codex/app-server-control/app-server-control.sock')); }
export function configuration() {
  const appId = process.env.QQBOT_APP_ID || process.env.AppID || process.env.APPID;
  const appSecret = process.env.QQBOT_APP_SECRET || process.env.AppSecret || process.env.APPSECRET;
  if (!appId || !appSecret) throw new Error('.env 中缺少 AppID / AppSecret');
  return {
    allowedUsers: (process.env.QQBOT_ALLOWED_USERS || '').split(',').map(s => s.trim()).filter(Boolean),
    appId, appSecret, machines: machines(),
    socket: defaultEndpoint(),
    dataDir: resolve(process.env.BOT_DATA_DIR || 'data'),
    pollMs: Math.max(1000, Number(process.env.BOT_POLL_MS) || 3000),
    keyboards: process.env.QQBOT_KEYBOARDS !== 'false',
  };
}

export function errorText(error: unknown): string {
  let text = error instanceof Error ? error.message : String(error);
  for (const [key, value] of Object.entries(process.env)) {
    if (/secret|api.?key|token/i.test(key) && value && value.length > 5) text = text.replaceAll(value, '[已隐藏]');
  }
  return text;
}

export function log(message: string, error?: unknown) {
  console.log(new Date().toISOString(), errorText(message), error === undefined ? '' : errorText(error));
}
