import { spawnSync } from 'node:child_process';
import { readFileSync, existsSync, mkdirSync, openSync, closeSync, unlinkSync, cpSync, writeFileSync, renameSync, symlinkSync, readlinkSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

const [home, requested, skipSetup, noPath, offline] = process.argv.slice(2);
if (!home || !home.startsWith('/')) throw new Error('Absolute install home required');
const stage = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pointer = join(home, 'current.json'), lock = join(home, 'install.lock');
const fd = openSync(lock, 'wx', 0o600);
const env = { ...process.env, QQ_AGENT_HOME: home };
function run(args, cwd = stage, expected = 0) {
  const result = spawnSync(process.execPath, args, { cwd, env, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== expected) throw new Error('Installation command failed; inspect the output above');
}
try {
  const previous = existsSync(pointer) ? JSON.parse(readFileSync(pointer, 'utf8')) : undefined;
  let data = join(home, 'data');
  if (previous) {
    const result = spawnSync(previous.node, [join(previous.root, 'dist/src/cli.js'), 'paths'], { cwd: previous.root, env, encoding: 'utf8' });
    if (result.status !== 0) throw new Error('Cannot inspect existing installation');
    data = JSON.parse(result.stdout).dataDir;
  }
  for (const name of ['bot.pid', 'supervisor.pid']) if (existsSync(join(data, name))) {
    const pid = Number(readFileSync(join(data, name), 'utf8'));
    if (!Number.isSafeInteger(pid) || pid <= 0) continue;
    try { process.kill(pid, 0); } catch (error) { if (error.code === 'ESRCH') continue; throw error; }
    throw new Error('Bot is running. Wait for tasks to finish, then run service stop before updating.');
  }
  const pkg = JSON.parse(readFileSync(join(stage, 'package.json'), 'utf8'));
  if (pkg.name !== 'qq-codex-console' || !/^\d+\.\d+\.\d+$/.test(pkg.version) || requested !== 'latest' && requested.replace(/^v/, '') !== pkg.version) throw new Error('Invalid package/version');
  const destination = join(home, 'versions', pkg.version);
  if (existsSync(destination)) {
    if (previous?.root !== destination) throw new Error('Version directory already exists but is not active');
    console.log(`Already installed: ${pkg.version}`);
  } else {
    // Resolve npm from the same Node installation, including private runtimes.
    const npm = resolve(dirname(process.execPath), '../lib/node_modules/npm/bin/npm-cli.js');
    if (existsSync(npm)) run([npm, 'ci', '--omit=dev', '--no-audit', '--no-fund', ...(offline === '1' ? ['--offline'] : [])]);
    else {
      const result = spawnSync('npm', ['ci', '--omit=dev', '--no-audit', '--no-fund', ...(offline === '1' ? ['--offline'] : [])], { cwd: stage, env, stdio: 'inherit' });
      if (result.error || result.status !== 0) throw new Error('npm ci failed');
    }
    run(['dist/src/cli.js', 'version']);
    mkdirSync(dirname(destination), { recursive: true });
    renameSync(stage, destination);
    const bin = join(home, 'bin'); mkdirSync(bin, { recursive: true });
    cpSync(join(destination, 'scripts/launcher.mjs'), join(bin, 'launcher.mjs'));
    const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
    writeFileSync(join(bin, 'qq-agent-bot'), `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(join(bin, 'launcher.mjs'))} "$@"\n`, { mode: 0o755 });
    writeFileSync(pointer + '.tmp', JSON.stringify({ version: pkg.version, root: destination, node: process.execPath }), { mode: 0o600 });
    renameSync(pointer + '.tmp', pointer);
  }
  const command = join(home, 'bin/qq-agent-bot');
  if (noPath !== '1') {
    const bin = join(homedir(), '.local/bin'), link = join(bin, 'qq-agent-bot');
    mkdirSync(bin, { recursive: true });
    try { symlinkSync(command, link); }
    catch (error) { if (error.code !== 'EEXIST' || readlinkSync(link) !== command) throw new Error('~/.local/bin/qq-agent-bot belongs to another installation; use --no-path'); }
    console.log('Command linked in ~/.local/bin; add that directory to PATH if needed.');
  }
  console.log(`Installed ${pkg.version}: ${command}`);
  if (skipSetup !== '1') run([join(home, 'bin/launcher.mjs'), 'setup'], home);
} finally { closeSync(fd); unlinkSync(lock); }
