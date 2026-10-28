import { createInterface } from 'node:readline/promises';
import { Writable } from 'node:stream';

export async function ask(prompt: string, options: { secret?: boolean; signal?: AbortSignal } = {}): Promise<string> {
  if (!process.stdin.isTTY) throw new Error('请在交互终端运行此命令；手动配置方法见 README');
  const output = options.secret ? new Writable({ write(_chunk, _encoding, callback) { callback(); } }) : process.stdout;
  const rl = createInterface({ input: process.stdin, output, terminal: true });
  const interrupted = new AbortController();
  rl.on('SIGINT', () => interrupted.abort());
  const signal = options.signal ? AbortSignal.any([options.signal, interrupted.signal]) : interrupted.signal;
  if (options.secret) process.stdout.write(prompt);
  try { return (await rl.question(options.secret ? '' : prompt, { signal })).trim(); }
  finally { rl.close(); if (options.secret) { output.end(); process.stdout.write('\n'); } }
}

export async function confirm(prompt: string, signal?: AbortSignal) {
  return /^(y|yes|是)$/i.test(await ask(prompt + ' [y/N] ', { signal }));
}
