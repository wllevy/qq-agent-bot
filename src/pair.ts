import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { configuration, errorText, log } from './config.js';
import { PairingAccess, handlePairing } from './pairing.js';
import { confirm } from './prompt.js';
import { makeBot, QQSender } from './qq.js';
import { Store } from './store.js';

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
  const [command, user] = process.argv.slice(2);
  if (command === '--help') {
    console.log('npm run pair：生成短时配对码，在 QQ 提交后本机确认\nnpm run pair -- list：查看配对授权\nnpm run pair -- revoke <senderId>：撤销配对授权（不取消 QQBOT_ALLOWED_USERS 静态授权）'); return;
  }
  if (command && command !== 'list' && command !== 'revoke') throw new Error('未知命令，运行 npm run pair -- --help');
  if (!command) { await runPairing(); return; }
  const config = configuration(), access = new PairingAccess(config.dataDir, config.appId, config.allowedUsers);
  if (command === 'list') {
    console.log('配对授权：\n' + (access.users().join('\n') || '无'));
    console.log(`静态授权：${config.allowedUsers.length} 个（在 .env 中管理）`); return;
  }
  if (!user) throw new Error('请指定要撤销的 senderId');
  const unlock = Store.lock(access.directory);
  try {
    const stillConfigured = access.revoke(user);
    console.log('已撤销配对授权。' + (stillConfigured ? '该用户仍在 QQBOT_ALLOWED_USERS 中，请从 .env 移除并重启以完全撤销。' : '后续控制消息将被拒绝；已提交任务与通知订阅保持不变。'));
  } finally { unlock(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main().catch(error => { console.error(errorText(error)); process.exitCode = 1; });
}
