import { targetPath } from './files.js';
import type { State, Thread } from './types.js';

export function rememberDirectories(state: State, machine: string, threads: Pick<Thread, 'cwd' | 'updatedAt'>[]) {
  const cache = state.directories ??= {};
  const directories = new Map((cache[machine] || []).map(entry => [entry.path, entry.lastUsed]));
  for (const thread of threads) {
    if (!targetPath(thread.cwd).isAbsolute(thread.cwd)) continue;
    const path = targetPath(thread.cwd).normalize(thread.cwd);
    directories.set(path, Math.max(directories.get(path) || 0, thread.updatedAt || 0));
  }
  cache[machine] = [...directories].map(([path, lastUsed]) => ({ path, lastUsed })).sort((a, b) => b.lastUsed - a.lastUsed).slice(0, 200);
}
export function findDirectories(state: State, machine: string, query: string): string[] {
  const words = query.toLocaleLowerCase().trim().split(/\s+/).filter(Boolean);
  return (state.directories?.[machine] || []).filter(entry => words.every(word => entry.path.toLocaleLowerCase().includes(word))).map(entry => entry.path);
}
export const shortDirectory = (path: string) => path.replace(/^\/home\/[^/]+(?=\/|$)|^\/root(?=\/|$)/, '~');
