import { configuration, errorText } from './config.js';
import { createBackend } from './client.js';
import { MachineCodex } from './machines.js';
import { makeBot } from './qq.js';
import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import { promisify } from 'node:util';

const config = configuration();
const codex = new MachineCodex(Object.fromEntries(config.machines.map(m => [m.id, createBackend(m.endpoint, config.dataDir)])));
try {
  for (const machine of codex.machines) {
    try {
      const threads = await codex.list(machine);
      console.log(`${machine}：已连接，读取到 ${threads.length} 个最近会话`);
      if (threads[0]) {
        const snapshot = await codex.snapshot(threads[0].id);
        console.log(`${machine} 历史读取：${snapshot.turns.length} 轮（内容未输出）`);
      }
    } catch (error) { console.log(errorText(error)); process.exitCode = 1; }
  }
  if (config.machines.some(m => m.endpoint === 'claude')) {
    try {
      const executable = process.env.CLAUDE_EXECUTABLE || (process.platform === 'win32'
        ? createRequire(import.meta.url).resolve(`@anthropic-ai/claude-agent-sdk-win32-${process.arch}/claude.exe`) : 'claude');
      const { stdout } = await promisify(execFile)(executable, ['auth', 'status'], { windowsHide: true, timeout: 15000 });
      const auth = JSON.parse(stdout);
      if (auth.loggedIn !== true) throw new Error('未登录');
      console.log(`Claude SDK：已登录（${auth.authMethod === 'claude.ai' ? 'Claude 账户' : '其他认证方式'}，未调用模型）`);
    } catch {
      console.log('Claude SDK：未能确认登录，请按 README 的 Claude 登录步骤操作；桌面 App 登录独立。'); process.exitCode = 1;
    }
  }
  const bot = makeBot(config.appId, config.appSecret, config.dataDir);
  await bot.api.getToken();
  console.log('QQ：AppID / AppSecret 鉴权成功（凭据未输出）');
  const gateway = await bot.api.get<{ url: string }>('/gateway');
  console.log(`QQ 网关：${new URL(gateway.url).hostname}`);
} catch (error) { console.error(errorText(error)); process.exitCode = 1; }
finally { await codex.close(); }
