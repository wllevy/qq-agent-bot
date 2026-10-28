import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { configuration, errorText, log } from './config.js';
import { PairingAccess, handlePairing } from './pairing.js';
import { confirm } from './prompt.js';
import { makeBot, QQSender } from './qq.js';
import { Store } from './store.js';
import { argumentsFor } from './arguments.js';

export function botRunning(dataDir: string): boolean {
  try {
    const pid = Number(readFileSync(join(dataDir, 'bot.pid'), 'utf8'));
    if (!Number.isSafeInteger(pid) || pid <= 0) return false;
    process.kill(pid, 0); return true;
  } catch (error) {
    if (['ENOENT', 'ESRCH'].includes((error as NodeJS.ErrnoException).code || '')) return false;
    throw error;
  }
}

export async function runPairing(config = configuration()) {
  const access = new PairingAccess(config.dataDir, config.appId, config.allowedUsers);
  const unlockPairing = Store.lock(access.directory);
  let unlockBot: (() => void) | undefined, bot: ReturnType<typeof makeBot> | undefined, sender: QQSender | undefined;
  let running: Promise<void> | undefined, code: string | undefined;
  const abort = new AbortController();
  const stop = () => abort.abort();
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
  try {
    if (!botRunning(config.dataDir)) {
      unlockBot = Store.lock(config.dataDir);
      bot = makeBot(config.appId, config.appSecret, config.dataDir);
      sender = new QQSender(bot, false);
      bot.on('message', async (_ctx, message) => {
        if (message.kind !== 'c2c' || abort.signal.aborted) return;
        try { await handlePairing(access, sender!, message); }
        catch (error) { log('配对响应失败', error); }
      });
      bot.on('error', error => log('配对连接错误', error));
      bot.on('ready', () => console.log('配对连接已就绪。'));
      running = bot.start().then(() => { if (!abort.signal.aborted) abort.abort(new Error('QQ 配对连接已关闭')); }, error => abort.abort(error));
      console.log('已启动临时配对连接；此连接只处理配对，不运行模型。');
    } else console.log('使用正在运行的 Bot 接收配对请求。');
    const active = access.begin(); code = active.code;
    console.log(`请用要授权的 QQ 私聊 Bot，发送：配对 ${code}\n配对码 5 分钟内有效；随后需要在本终端确认。`);
    const signal = AbortSignal.any([abort.signal, AbortSignal.timeout(Math.max(1, active.expiresAt - Date.now()))]);
    let request;
    while (!(request = access.pending(code))) await delay(250, undefined, { signal });
    console.log(`收到申请，senderId：${request.senderId}`);
    if (await confirm('确认这是你刚才使用的 QQ，并授权它控制本机编程会话？', signal)) {
      access.approve(code, request.senderId);
      console.log('已授权，运行中的 Bot 无需重启。若 Bot 尚未启动，请运行 npm start。');
    } else console.log('已拒绝配对，未添加授权。');
  } finally {
    abort.abort();
    if (code) access.cancel(code);
    sender?.close(); bot?.stop();
    await running; await sender?.drain();
    unlockBot?.(); unlockPairing();
    process.off('SIGINT', stop); process.off('SIGTERM', stop);
  }
}

async function main() {
  const { positional, options } = argumentsFor(process.argv.slice(2), ['--help', '--json'], ['--user']);
  const [command, user] = positional;
  if (positional.length > (['approve', 'cancel', 'revoke'].includes(command || '') ? 2 : 1)) throw new Error('多余的位置参数，运行 pair --help');
  if (options['--user'] && command !== 'approve') throw new Error('--user 仅用于 approve');
  const emit = (value: object) => console.log(JSON.stringify(value));
  if (options['--help']) {
    console.log('pair：交互配对\npair start --json：Bot 运行时开始配对\npair status --json：查看待确认申请\npair approve <requestId> --user <senderId> --json：本机批准已确认的身份\npair cancel <requestId> --json：取消配对\npair list / revoke <senderId>：查看或撤销授权'); return;
  }
  if (command && !['list', 'revoke', 'start', 'status', 'approve', 'cancel'].includes(command)) throw new Error('未知命令，运行 pair --help');
  if (!command) { if (options['--json']) throw new Error('请选择 start/status/approve 等非交互子命令'); await runPairing(); return; }
  const config = configuration(), access = new PairingAccess(config.dataDir, config.appId, config.allowedUsers);
  if (command === 'status') {
    const active = access.current(), pending = active && access.pending(active.code);
    emit({ status: pending ? 'needs_confirmation' : active ? 'waiting_for_qq' : 'inactive', ...(active ? { requestId: active.code, expiresAt: active.expiresAt } : {}), ...(pending ? { senderId: pending.senderId } : {}) }); return;
  }
  if (command === 'list') {
    if (options['--json']) { emit({ status: 'ok', users: access.users(), configuredUsers: config.allowedUsers }); return; }
    console.log('配对授权：\n' + (access.users().join('\n') || '无'));
    console.log(`静态授权：${config.allowedUsers.length} 个（在 .env 中管理）`); return;
  }
  const unlock = Store.lock(access.directory);
  try {
    if (command === 'start') {
      if (!botRunning(config.dataDir)) { emit({ status: 'needs_service', next: 'service start' }); process.exitCode = 2; return; }
      const active = access.begin(); emit({ status: 'waiting_for_qq', requestId: active.code, code: active.code, expiresAt: active.expiresAt }); return;
    }
    if (!user) throw new Error('需要指定 requestId 或 senderId');
    if (command === 'approve') {
      if (!options['--user']) throw new Error('批准时必须用 --user 指定已确认的 senderId');
      access.approve(user, String(options['--user'])); emit({ status: 'authorized' }); return;
    }
    if (command === 'cancel') { access.cancel(user); emit({ status: 'cancelled' }); return; }
    const stillConfigured = access.revoke(user);
    if (options['--json']) { emit({ status: 'revoked', stillConfigured }); return; }
    console.log('已撤销配对授权。' + (stillConfigured ? '该用户仍在 QQBOT_ALLOWED_USERS 中，请从 .env 移除并重启以完全撤销。' : '后续控制消息将被拒绝；已提交任务与通知订阅保持不变。'));
  } finally { unlock(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main().catch(error => { if (process.argv.includes('--json')) console.log(JSON.stringify({ status: 'error', message: errorText(error) })); else console.error(errorText(error)); process.exitCode = 1; });
}
