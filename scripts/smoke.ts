import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { configuration } from '../src/config.js';
import { createCodex } from '../src/client.js';
import { completion } from '../src/presentation.js';
import type { Thread } from '../src/types.js';

// Explicit integration check: creates its own small Codex thread and uses the
// configured account once. Never sends a task to an existing user thread.
const codex = createCodex(configuration().socket);
const directory = mkdtempSync(join(tmpdir(), 'qqbot-smoke-'));
let id: string | undefined;
try {
  const thread = await codex.create('local', directory, 'smoke-' + Date.now());
  id = thread.id;
  if ((await codex.snapshot(id)).turns.length) throw new Error('新建会话不是空白会话');
  console.log('已创建独立自检会话');
  await codex.prepare(id);
  await codex.send(id, '这是 QQ 中控台连通性自检。请仅回复 QQBOT_SMOKE_OK，无需操作文件。', 'qqbot-smoke-' + Date.now());
  console.log('续发指令成功，等待本轮完成');
  let passed = false;
  for (let i = 0; i < 60; i++) {
    await delay(1000);
    const snapshot = await codex.snapshot(id);
    const turn = snapshot.turns[0];
    if (turn?.status === 'failed') throw new Error('自检轮次失败：' + turn.error?.message);
    if (turn?.status === 'completed') {
      if (!completion(snapshot, turn).includes('QQBOT_SMOKE_OK')) throw new Error('最终回答与自检预期不符');
      console.log('自检通过：续发 → 历史读取 → 本轮完成 → 最终回答'); passed = true; break;
    }
  }
  if (!passed) throw new Error('自检等待超时');
} finally {
  if (id) {
    try {
      const snapshot = await codex.snapshot(id);
      const active = snapshot.turns.find(turn => turn.status === 'inProgress');
      if (active) { await codex.interrupt(id, active.id); await delay(500); }
      await codex.request('thread/archive', { threadId: id });
      console.log('独立自检会话已归档');
    } catch (error) { console.error('自检会话清理失败', error); }
  }
  codex.close(); rmSync(directory, { recursive: true, force: true });
}
