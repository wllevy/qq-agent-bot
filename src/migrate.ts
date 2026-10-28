import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, writeFileSync, rmdirSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parse } from 'dotenv';
import { argumentsFor } from './arguments.js';
import { errorText } from './config.js';
import { runtimePaths } from './paths.js';
import { updateEnv, saveEnvFile } from './setup-config.js';

function stopped(data: string) {
  for (const name of ['bot.pid', 'supervisor.pid']) {
    if (!existsSync(join(data, name))) continue;
    const pid = Number(readFileSync(join(data, name), 'utf8'));
    if (!Number.isSafeInteger(pid) || pid <= 0) continue;
    try { process.kill(pid, 0); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') continue; throw error; }
    throw new Error('迁移前请等待任务完成，停止原 Bot 和监督进程，并取消原登录自启动');
  }
}
function noLinks(path: string) {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink()) throw new Error('迁移源包含符号链接或目录联接，请手动迁移');
  if (stat.isDirectory()) for (const name of readdirSync(path)) noLinks(join(path, name));
}
export function migrate(sourceRoot: string, home: string) {
  sourceRoot = resolve(sourceRoot); home = resolve(home);
  const source = readFileSync(join(sourceRoot, '.env'), 'utf8'), env = parse(source);
  const oldData = resolve(sourceRoot, env.BOT_DATA_DIR || 'data');
  const inside = relative(oldData, home);
  if (!inside || (!isAbsolute(inside) && inside !== '..' && !inside.startsWith('..' + sep))) throw new Error('新安装目录不能位于原数据目录内');
  for (const name of ['config', 'data']) if (existsSync(join(home, name))) throw new Error('目标已有 config 或 data，拒绝覆盖；请使用尚未配置的安装目录');
  stopped(oldData);
  noLinks(join(sourceRoot, '.env'));
  if (existsSync(oldData)) noLinks(oldData);
  const pairing = join(oldData, 'pairing');
  if (existsSync(pairing)) for (const appId of readdirSync(pairing)) stopped(join(pairing, appId));
  const machines = resolve(sourceRoot, env.BOT_MACHINES_FILE || 'machines.json');
  if (existsSync(machines)) noLinks(machines);
  const state = join(oldData, 'state.json');
  if (existsSync(state) && JSON.parse(readFileSync(state, 'utf8')).version !== 4) throw new Error('仅支持 v4 消息订阅数据；旧格式需要单独迁移');
  mkdirSync(home, { recursive: true });
  const stage = mkdtempSync(join(home, 'migration-'));
  const stagedData = join(stage, 'data');
  mkdirSync(stagedData);
  if (existsSync(oldData)) for (const name of readdirSync(oldData)) {
    if (!['bot.pid', 'supervisor.pid', 'stop', 'runtime-status.json', 'runtime-status.json.tmp'].includes(name)) cpSync(join(oldData, name), join(stagedData, name), { recursive: true, errorOnExist: true, force: false });
  }
  if (existsSync(state)) {
    const copied = JSON.parse(readFileSync(state, 'utf8'));
    for (const file of Object.values(copied.files || {}) as { localPath?: string }[]) {
      if (!file.localPath) continue;
      const suffix = relative(oldData, file.localPath);
      if (isAbsolute(suffix) || suffix === '..' || suffix.startsWith('..' + sep)) throw new Error('附件缓存路径不在原数据目录内，请手动迁移');
      file.localPath = join(home, 'data', suffix);
    }
    writeFileSync(join(stagedData, 'state.json'), JSON.stringify(copied), { mode: 0o600 });
  }
  const updates = { BOT_DATA_DIR: './data', BOT_MACHINES_FILE: './machines.json', CLAUDE_DEFAULT_CWD: resolve(sourceRoot, env.CLAUDE_DEFAULT_CWD || '..') };
  saveEnvFile(join(stage, 'config', '.env'), '', updateEnv(source, updates));
  if (existsSync(machines)) cpSync(machines, join(stage, 'config', 'machines.json'));
  // Recheck after copying; the original must remain stopped throughout migration.
  stopped(oldData);
  renameSync(join(stage, 'config'), join(home, 'config'));
  try { renameSync(stagedData, join(home, 'data')); }
  catch (error) { renameSync(join(home, 'config'), join(stage, 'config')); throw error; }
  rmdirSync(stage);
  return { status: 'migrated', configFile: join(home, 'config', '.env'), dataDir: join(home, 'data'), next: 'doctor --json' };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const { options, positional } = argumentsFor(process.argv.slice(2), ['--json', '--help'], ['--from']);
    if (options['--help']) console.log('migrate --from <原源码目录> --json：复制已停止的 v4 部署到尚未配置的 QQ_AGENT_HOME，保留原目录');
    else {
      if (!options['--from'] || positional.length || !runtimePaths().home) throw new Error('需要 QQ_AGENT_HOME 和 --from <原源码目录>');
      console.log(JSON.stringify(migrate(String(options['--from']), runtimePaths().home!)));
    }
  } catch (error) { console.log(JSON.stringify({ status: 'error', message: errorText(error) })); process.exitCode = 1; }
}
