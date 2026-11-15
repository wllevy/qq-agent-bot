import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

export async function startBackground(root: string, data: string) {
  mkdirSync(data, { recursive: true, mode: 0o700 });
  const child = spawn(process.execPath, [join(root, 'scripts/supervisor.mjs'), '--log-files'], { cwd: root, env: process.env, detached: true, windowsHide: true, stdio: 'ignore' });
  await new Promise<void>((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
  child.unref();
}
