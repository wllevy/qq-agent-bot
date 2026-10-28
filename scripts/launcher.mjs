import { readFileSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const home = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const active = JSON.parse(readFileSync(join(home, 'current.json'), 'utf8'));
const child = spawn(active.node, [join(active.root, 'dist/src/cli.js'), ...process.argv.slice(2)], {
  cwd: active.root, env: { ...process.env, QQ_AGENT_HOME: home }, stdio: 'inherit', windowsHide: true,
});
child.on('error', error => { console.error(error.message); process.exitCode = 1; });
child.on('exit', code => { process.exitCode = code ?? 1; });
