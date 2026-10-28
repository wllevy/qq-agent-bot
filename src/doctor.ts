import { configuration, errorText } from './config.js';
import { createBackend } from './client.js';
import { makeBot } from './qq.js';
import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import { PairingAccess } from './pairing.js';
import type { CodexPort } from './types.js';

export type Check = { name: string; ok: boolean; message: string; status?: 'needs_login' | 'needs_credentials' | 'needs_pairing' };
export function summarize(checks: Check[]) {
  const failed = checks.filter(c => !c.ok);
  return failed.find(c => c.status === 'needs_credentials') ? 'needs_credentials'
    : failed.find(c => c.status === 'needs_login') ? 'needs_login'
    : failed.some(c => c.status !== 'needs_pairing') ? 'error'
    : failed.length ? 'needs_pairing' : 'ready';
}
export async function diagnose() {
  const checks: Check[] = [];
  let config: ReturnType<typeof configuration>;
  try { config = configuration(); }
  catch (error) {
    checks.push({ name: 'configuration', ok: false, status: 'needs_credentials', message: errorText(error) });
    return { status: summarize(checks), checks };
  }
  for (const machine of config.machines) {
    let backend: CodexPort | undefined;
    try {
      backend = createBackend(machine.endpoint, config.dataDir);
      const threads = await backend.list();
      if (threads[0]) await backend.snapshot(threads[0].id);
      checks.push({ name: machine.id, ok: true, message: '后端历史读取正常（未调用模型）' });
    } catch (error) { checks.push({ name: machine.id, ok: false, message: errorText(error) }); }
    finally { await backend?.close?.(); }
  }
  if (config.machines.some(m => m.endpoint === 'claude')) {
    try {
      const executable = process.env.CLAUDE_EXECUTABLE || (process.platform === 'win32'
        ? createRequire(import.meta.url).resolve(`@anthropic-ai/claude-agent-sdk-win32-${process.arch}/claude.exe`) : 'claude');
      const { stdout } = await promisify(execFile)(executable, ['auth', 'status'], { windowsHide: true, timeout: 15000 });
      if (JSON.parse(stdout).loggedIn !== true) throw new Error('未登录');
      checks.push({ name: 'claude-auth', ok: true, message: 'Claude SDK 已登录（未调用模型）' });
    } catch { checks.push({ name: 'claude-auth', ok: false, status: 'needs_login', message: '请完成 Claude SDK 登录；桌面 App 登录独立' }); }
  }
  const bot = makeBot(config.appId, config.appSecret, config.dataDir);
  try {
    await bot.api.getToken();
    await bot.api.get('/gateway');
    checks.push({ name: 'qq', ok: true, message: 'QQ 鉴权与网关查询正常（未发送聊天）' });
  } catch { checks.push({ name: 'qq', ok: false, message: 'QQ 鉴权或网络连接失败，请检查凭据与网络' }); }
  finally { bot.stop(); }
  try {
    const access = new PairingAccess(config.dataDir, config.appId, config.allowedUsers);
    const authorized = config.allowedUsers.length + access.users().length > 0;
    checks.push({ name: 'access', ok: authorized, ...(authorized ? {} : { status: 'needs_pairing' as const }), message: authorized ? '已有控制授权' : '需要完成 QQ 配对' });
  } catch (error) { checks.push({ name: 'access', ok: false, message: errorText(error) }); }
  return { status: summarize(checks), checks };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const report = await diagnose().catch(error => ({ status: 'error', checks: [{ name: 'doctor', ok: false, message: errorText(error) }] }));
  if (process.argv.includes('--json')) console.log(JSON.stringify(report));
  else { for (const check of report.checks) console.log(`${check.ok ? 'OK' : '待处理'} ${check.name}：${check.message}`); console.log('状态：' + report.status); }
  process.exitCode = report.status === 'ready' ? 0 : report.status === 'needs_pairing' ? 2 : 1;
}
