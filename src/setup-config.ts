import { parse } from 'dotenv';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export function updateEnv(source: string, updates: Record<string, string>): string {
  let result = source;
  const original = parse(source);
  for (const [key, value] of Object.entries(updates)) {
    if (!/^[A-Z][A-Z0-9_]*$/.test(key) || /[\r\n\0]/.test(value) || /[\r\n]/.test(original[key] || '')) throw new Error(`请手动配置 ${key}：不支持多行值`);
    const quote = ["'", '`', '"'].find(q => !value.includes(q));
    if (!quote) throw new Error(`请手动配置 ${key}：值包含多种引号`);
    const line = `${key}=${quote}${value}${quote}`;
    if (parse(line)[key] !== value) throw new Error(`无法无损保存 ${key}，请手动配置`);
    const pattern = new RegExp(`^(?:export\\s+)?${key}\\s*=.*$`, 'gm');
    if (pattern.test(result)) result = result.replace(pattern, () => line);
    else result += (result.endsWith('\n') || !result ? '' : '\n') + line + '\n';
  }
  return result;
}

export function readEnvFile(path: string): string {
  try { return readFileSync(path, 'utf8'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return ''; throw error; }
}

export function saveEnvFile(path: string, expected: string, next: string) {
  if (readEnvFile(path) !== expected) throw new Error('.env 在配置期间发生变化，未覆盖；请重新运行 setup');
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = path + '.' + randomUUID() + '.tmp';
  try { writeFileSync(temporary, next, { mode: 0o600 }); renameSync(temporary, path); }
  finally { rmSync(temporary, { force: true }); }
}

export function validateSettings(value: unknown, previous: Record<string, string>): Record<string, string> {
  const allowed = new Set(['QQBOT_APP_ID', 'QQBOT_APP_SECRET', 'QQBOT_ALLOWED_USERS', 'CODEX_ENABLED', 'CODEX_SOCKET', 'CODEX_EXECUTABLE', 'CLAUDE_ENABLED', 'CLAUDE_PERMISSION_MODE', 'CLAUDE_DEFAULT_CWD', 'CLAUDE_EXECUTABLE', 'BOT_POLL_MS', 'QQBOT_KEYBOARDS']);
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('配置文件必须是 JSON 对象');
  const updates = value as Record<string, string>;
  for (const [key, item] of Object.entries(updates)) {
    if (!allowed.has(key) || typeof item !== 'string' || /[\r\n\0]/.test(item)) throw new Error(`不支持的配置字段或值：${allowed.has(key) ? key : '(未知字段)'}`);
  }
  const next = { ...previous, ...updates };
  if (!/^\d+$/.test(next.QQBOT_APP_ID || '') || !next.QQBOT_APP_SECRET) throw new Error('需要有效的 QQBOT_APP_ID 和 QQBOT_APP_SECRET');
  for (const key of ['CODEX_ENABLED', 'CLAUDE_ENABLED', 'QQBOT_KEYBOARDS']) if (next[key] !== undefined && !['true', 'false'].includes(next[key]!)) throw new Error(`${key} 必须是字符串 true 或 false`);
  if (next.CODEX_ENABLED === 'false' && next.CLAUDE_ENABLED === 'false') throw new Error('至少启用一个后端');
  if (next.CLAUDE_PERMISSION_MODE && !['default', 'bypassPermissions'].includes(next.CLAUDE_PERMISSION_MODE)) throw new Error('无效的 CLAUDE_PERMISSION_MODE');
  if (next.BOT_POLL_MS && (!Number.isFinite(Number(next.BOT_POLL_MS)) || Number(next.BOT_POLL_MS) < 1000)) throw new Error('BOT_POLL_MS 至少为 1000');
  if (previous.QQBOT_APP_ID && next.QQBOT_APP_ID !== previous.QQBOT_APP_ID) {
    if (!updates.QQBOT_APP_SECRET) throw new Error('更换 AppID 时必须提供新的 AppSecret');
    return { ...updates, QQBOT_ALLOWED_USERS: updates.QQBOT_ALLOWED_USERS || '' };
  }
  return updates;
}
