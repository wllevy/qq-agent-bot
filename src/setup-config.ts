import { parse } from 'dotenv';
import { randomUUID } from 'node:crypto';
import { readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';

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
  const temporary = path + '.' + randomUUID() + '.tmp';
  try { writeFileSync(temporary, next, { mode: 0o600 }); renameSync(temporary, path); }
  finally { rmSync(temporary, { force: true }); }
}
