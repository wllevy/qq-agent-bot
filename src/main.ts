import { mkdirSync, writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { PairingAccess, handlePairing } from './pairing.js';
import { configuration, errorText, log } from './config.js';
import { createBackend } from './client.js';
import { MachineCodex } from './machines.js';
import { ConsoleApp } from './console.js';
import { makeBot, QQSender } from './qq.js';
import { Store } from './store.js';

const config = configuration();
mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
const unlock = Store.lock(config.dataDir);
function status(state: string) {
  const file = join(config.dataDir, 'runtime-status.json');
  writeFileSync(`${file}.tmp`, JSON.stringify({ pid: process.pid, state, updatedAt: new Date().toISOString() }));
  renameSync(`${file}.tmp`, file);
}
status('starting');
const access = new PairingAccess(config.dataDir, config.appId, config.allowedUsers);
const store = new Store(config.dataDir);
const codex = new MachineCodex(Object.fromEntries(config.machines.map(machine => [machine.id, createBackend(machine.endpoint, config.dataDir, true)])));
const bot = makeBot(config.appId, config.appSecret, config.dataDir);
const sender = new QQSender(bot, config.keyboards);
const app = new ConsoleApp(store, codex, sender);
let ready = false;
let stopping = false;
let shutdownWork: Promise<void> | undefined;

function refresh() {
  if (!ready || stopping) return;
  // Each worker coalesces its own overlapping calls. Slow QQ delivery cannot
  // block polling or the next Codex task.
  void app.files.tick().catch(error => log('文件传输失败', error));
  void app.tick().catch(error => log('刷新失败', error)).then(() => {
    if (!stopping && ready) void app.deliver().catch(error => log('投递失败', error));
  });
  void app.deliver().catch(error => log('投递失败', error));
}
async function online(message: string) {
  if (stopping) return;
  log(message);
  try { await app.recover(); }
  catch (error) { log('恢复入站消息失败', error); }
  if (stopping) return;
  ready = true;
  status('online');
  refresh();
}
bot.on('ready', () => online('QQ 私聊 Bot 已上线'));
bot.on('resumed', () => online('QQ 连接已恢复'));
bot.on('disconnected', () => { ready = false; status(stopping ? 'stopping' : 'disconnected'); log('QQ 已断线，等待自动重连'); });
bot.on('error', error => log('QQ 连接错误', error));
bot.on('message', async (_ctx, message) => {
  if (stopping || message.kind !== 'c2c') return;
  try {
    if (await handlePairing(access, sender, message)) return;
    if (!access.allowed(message.senderId)) return;
    log('收到私聊消息');
    await app.receive(message.senderId, message.content, message.messageId, message.refMsgIdx, message.attachments);
  }
  catch (error) { log('私聊响应失败', error); }
});
bot.on('rawEvent', async context => {
  if (stopping || context.eventType !== 'FRIEND_ADD') return;
  const data = context.data as { openid?: string };
  try {
    if (data.openid && access.allowed(data.openid)) await sender.send(data.openid, '编程助手已连接。发送“会话”选择 Codex 或 Claude Code，之后直接发文字即可继续任务。', { buttons: [{ label: '打开会话', command: '/会话' }] });
  } catch (error) { if (!stopping) log('欢迎消息发送失败', error); }
});
codex.on('notification', event => {
  if (['turn/completed', 'thread/status/changed'].includes(event.method)) refresh();
});
codex.on('serverRequest', event => {
  log(`Codex 等待交互：${event.method}`);
  refresh();
});
const timer = setInterval(refresh, config.pollMs);
function shutdown(): Promise<void> {
  if (shutdownWork) return shutdownWork;
  stopping = true; ready = false; clearInterval(timer);
  status('stopping');
  // Stop admitting work before aborting I/O. Keep the process lock until all
  // callbacks have settled and their final state has been saved.
  const draining = app.shutdown();
  sender.close(); const closingBackend = codex.close(); bot.stop();
  shutdownWork = (async () => {
    await draining;
    await closingBackend;
    await sender.drain();
    store.save();
    status('stopped'); unlock();
    log('Bot 已停止');
  })();
  return shutdownWork;
}
const onSignal = () => { void shutdown().catch(error => { log('停止失败', error); process.exitCode = 1; }); };
process.on('SIGINT', onSignal);
process.on('SIGTERM', onSignal);
process.on('message', message => { if (message === 'shutdown') void shutdown().finally(() => process.disconnect?.()); });
try {
  log(`已配置机器：${codex.machines.join('、')}`);
  if (!stopping) await bot.start();
} catch (error) {
  if (!stopping) { console.error(errorText(error)); process.exitCode = 1; }
} finally { await shutdown(); }
