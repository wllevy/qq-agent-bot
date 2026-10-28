import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { ClaudeBackend } from '../src/claude.js';

const directory = mkdtempSync(join(tmpdir(), 'qqbot-claude-smoke-'));
const backend = new ClaudeBackend(directory, directory);
const marker = 'QQBOT_' + randomUUID().slice(0, 8);
let id: string | undefined;
async function waitForResult(turnId: string) {
  for (let n = 0; n < 120; n++) {
    await delay(1000);
    const snapshot = await backend.snapshot(id!);
    if (snapshot.pendingAction) throw new Error('纯文字自检意外请求工具确认');
    const turn = snapshot.turns.find(t => t.id === turnId)!;
    if (turn.status === 'failed') throw new Error(turn.error?.message || 'Claude 自检失败');
    if (turn.status === 'completed') {
      const text = turn.items.filter(i => i.type === 'agentMessage' && i.phase === 'final_answer').map(i => i.text).join('\n');
      if (!text.includes(marker)) throw new Error('自检上下文标记不匹配');
      return;
    }
  }
  throw new Error('Claude 自检超时');
}
try {
  const thread = await backend.create('claude', directory, randomUUID()); id = thread.id;
  console.log('已创建独立 Claude 自检会话');
  let turnId = randomUUID();
  await backend.send(id, `连通性自检，请记住标记 ${marker} 并仅原样回复此标记，不使用工具。`, turnId);
  await waitForResult(turnId);
  console.log('第一轮通过');
  turnId = randomUUID();
  await backend.prepare(id);
  await backend.send(id, '仅回复上一轮让你记住的标记，不使用工具。', turnId);
  await waitForResult(turnId);
  console.log('Claude 自检通过：创建 → 首轮回复 → 恢复历史 → 续发与上下文验证');
  console.log('自检目录：' + directory);
} finally { await backend.close(); }
