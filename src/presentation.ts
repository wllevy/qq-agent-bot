import { basename } from 'node:path';
import type { ActivityEntry, AgentItem, Snapshot, Thread, Turn, Button } from './types.js';

import { canReportTurn, reportableTerminal, sessionStatus, terminal } from './domain.js';
export { terminal } from './domain.js';
export const messages = (turn: Turn) => turn.items.filter(item => item.type === 'agentMessage' && item.text?.trim());
export const title = (thread: Thread) => (thread.name || thread.preview || thread.id.slice(0, 8)).replace(/\s+/g, ' ').slice(0, 55);
export const label = (thread: Thread) => `${thread.machine ? (thread.machine === 'claude' ? 'Claude' : thread.machine === 'local' ? 'Codex' : thread.machine) + " · " : ""}${basename(thread.cwd) || thread.cwd} · ${title(thread)}`;
export const modelSummary = (thread: Thread) => `模型：${thread.model || '未提供'}\n推理强度：${thread.reasoningEffort || '默认或未提供'}`;
export function status(snapshot: Snapshot): string {
  return { running: '运行中', approval: '等待确认', input: '等待回答', error: '连接异常', failed: '执行失败', interrupted: '已中断', unloaded: '未加载', idle: '空闲' }[sessionStatus(snapshot)];
}
type View = { text: string; acknowledge: string[] };
const clip = (text: string, limit: number) => {
  const chars = Array.from(text.trim());
  return chars.length > limit ? chars.slice(0, limit).join('') + '…（已截取）' : chars.join('');
};
const quote = (text: string) => text.split('\n').map(line => '> ' + line).join('\n');
const inline = (text: string, limit = 220) => '`' + clip(text.replace(/\s+/g, ' ').replace(/`/g, "'"), limit) + '`';
const finalText = (turn: Turn) => {
  const all = messages(turn), final = all.filter(item => item.phase === 'final_answer');
  return (final.length ? final : all.slice(-1)).map(item => item.text).join('\n\n');
};
const userText = (turn: Turn) => turn.items.filter(item => item.type === 'userMessage')
  .map(item => item.content?.map(part => part.type === 'text' ? part.text || '' : '（附件）').join('\n') || item.text || '')
  .filter(Boolean).join('\n\n');
function exchange(turn: Turn, excerpt = false): string {
  const question = userText(turn) || '未读到本轮用户要求。';
  const answer = finalText(turn) || '本轮暂无模型回答。';
  const error = turn.error?.message ? `\n\n**本轮异常**\n\n${turn.error.message}` : '';
  return `**用户要求**\n\n${quote(excerpt ? clip(question, 450) : question)}\n\n**模型回答**\n\n${excerpt ? quote(clip(answer, 700)) : answer}${error}`;
}
const turnState = (turn: Turn) => turn.status === 'failed' ? '执行失败' : turn.status === 'interrupted' ? '已中断' : '本轮完成';
const heading = (snapshot: Snapshot) => `**${label(snapshot.thread)}**\n\n状态：${status(snapshot)}\n${modelSummary(snapshot.thread)}`;
const recordedTime = (entry: ActivityEntry) => entry.completedAtMs ?? entry.startedAtMs;
const clockTime = (ms: number) => new Date(ms).toLocaleString('zh-CN', { timeZone: 'Asia/Hong_Kong', hour12: false });
function ago(ms: number): string {
  const seconds = Math.max(0, Math.floor((Date.now() - ms) / 1000));
  return seconds < 60 ? `${seconds} 秒前` : seconds < 3600 ? `${Math.floor(seconds / 60)} 分钟前` : `${Math.floor(seconds / 3600)} 小时前`;
}
function toolDetail(item: AgentItem): string {
  const args = item.arguments;
  if (args && typeof args === 'object' && !Array.isArray(args)) {
    const fields = args as Record<string, unknown>;
    const value = fields.cmd ?? fields.command ?? fields.title ?? fields.query ?? fields.path ?? fields.code;
    if (typeof value === 'string') return ' · ' + inline(value);
  }
  return '';
}
function activityText(item: AgentItem): string | undefined {
  const state = item.status === 'inProgress' ? '执行中' : item.status === 'completed' ? '已完成' : item.status === 'failed' ? '失败' : item.status === 'declined' ? '已拒绝' : '已记录';
  switch (item.type) {
    case 'agentMessage': return item.text?.trim() ? `进度消息：${clip(item.text, 350)}` : undefined;
    case 'commandExecution': return `${state} · 命令 ${inline(item.command || '命令未提供')}${item.exitCode != null ? ` · 退出码 ${item.exitCode}` : ''}`;
    case 'fileChange': return `${state} · 修改文件 ${(item.changes || []).slice(0, 3).map(change => inline(change.path, 100)).join('、')}`;
    case 'mcpToolCall': return `${state} · 工具 ${inline([item.server, item.tool].filter(Boolean).join('/'), 100)}${toolDetail(item)}`;
    case 'dynamicToolCall': return `${state} · 工具 ${inline([item.namespace, item.tool].filter(Boolean).join('.'), 100)}${toolDetail(item)}`;
    case 'collabAgentToolCall': return `${state} · 子任务 ${inline(item.tool || '协作调用')}`;
    case 'webSearch': return `搜索网页：${inline(item.query || '查询未提供')}`;
    case 'imageView': return `查看图片：${inline(item.path || '路径未提供')}`;
    case 'plan': return item.text ? `更新计划：${clip(item.text, 300)}` : undefined;
    case 'sleep': return `等待${item.durationMs != null ? ` ${Math.round(item.durationMs / 1000)} 秒` : ''}`;
    case 'contextCompaction': return '整理会话上下文';
    // Reasoning payloads are not user-facing progress messages.
    default: return undefined;
  }
}
export function latest(snapshot: Snapshot, count = 1): string { return (count > 1 ? recentView(snapshot, count) : latestView(snapshot)).text; }
export function latestView(snapshot: Snapshot): View {
  const current = snapshot.turns[0];
  const active = ['running', 'approval', 'input'].includes(sessionStatus(snapshot));
  if (!active) {
    if (current && terminal(current) && !reportableTerminal(current)) {
      return { text: `**${label(snapshot.thread)}**\n\n${modelSummary(snapshot.thread)}\n\n暂未读到本轮问答内容，结束状态尚待确认。请稍后查看最新动向。`, acknowledge: [] };
    }
    const output = current ? finalText(current) : '';
    return {
      text: `${heading(snapshot)}\n\n**最后一轮对答**\n\n${current ? exchange(current) : '暂无会话记录。'}`,
      acknowledge: current?.status === 'completed' && output ? [current.id] : [],
    };
  }
  const activity = snapshot.activity?.turnId === current?.id ? snapshot.activity : undefined;
  const entries = activity?.entries.length ? activity.entries : [...(current?.items || [])].reverse().map(item => ({ turnId: current!.id, item }));
  const ordered = entries.map((entry, index) => ({ entry, index })).sort((a, b) => {
    const ta = recordedTime(a.entry), tb = recordedTime(b.entry);
    return ta != null && tb != null ? tb - ta || a.index - b.index : a.index - b.index;
  }).map(row => row.entry);
  const actions = ordered.flatMap(entry => {
    const text = activityText(entry.item);
    const time = recordedTime(entry);
    return text ? [`${time != null ? `${clockTime(time)}（${ago(time)}） · ` : ''}${text}`] : [];
  }).slice(0, 3);
  const lastTime = ordered.map(recordedTime).find(time => time != null);
  const freshness = lastTime != null ? `\n最近记录：${clockTime(lastTime)}（${ago(lastTime)}）` : '';
  const started = current?.startedAt ? `\n本轮开始：${clockTime(current.startedAt * 1000)}` : '';
  const details = activity?.error ? '工具动向暂时读取失败，以下仅展示已读到的消息。\n\n' : '';
  const activityBlock = actions.length ? actions.map(action => '- ' + action.replace(/\n/g, '\n  ')).join('\n') : '尚无可展示的操作记录，等待新的进度。';
  const request = current ? userText(current) : '';
  const previous = snapshot.turns.slice(1).find(reportableTerminal);
  return {
    text: `${heading(snapshot)}${started}${freshness}\n\n**最新动向**\n\n${details}${activityBlock}\n\n**本轮用户要求**\n\n${quote(clip(request || '未读到本轮用户要求。', 450))}\n\n**上一轮对答（上下文）**\n\n${previous ? exchange(previous, true) : '暂无上一轮对答。'}${previous ? '\n\n完整对答：/结果' : ''}`,
    acknowledge: [],
  };
}
export function answerView(snapshot: Snapshot): View {
  const turn = snapshot.turns.find(turn => canReportTurn(snapshot, turn));
  return {
    text: `${heading(snapshot)}\n\n**最近一轮对答${turn ? ' · ' + turnState(turn) : ''}**\n\n${turn ? exchange(turn) : '暂无已结束轮次的对答。'}`,
    acknowledge: turn?.status === 'completed' ? [turn.id] : [],
  };
}
export function recentView(snapshot: Snapshot, count = 2): View {
  const turns = snapshot.turns.filter(turn => canReportTurn(snapshot, turn)).slice(0, count).reverse();
  const blocks = turns.map((turn, i) => `**对答 ${i + 1} · ${turnState(turn)}**\n\n${exchange(turn)}`);
  return {
    text: `${heading(snapshot)}\n\n${blocks.join('\n\n────────\n\n') || '暂无已结束轮次的对答。'}`,
    acknowledge: turns.filter(turn => turn.status === 'completed').map(turn => turn.id),
  };
}
export function completion(snapshot: Snapshot, turn: Turn): string {
  const ongoing = ['running', 'approval', 'input'].includes(sessionStatus(snapshot));
  const otherTurn = snapshot.turns[0]?.id !== turn.id;
  const state = turn.status === 'interrupted' ? '该轮已中断' : turn.status === 'failed' ? '该轮执行失败' : '本轮完成';
  const current = ongoing || otherTurn ? `\n会话当前：${status(snapshot)}` : '';
  const time = turn.startedAt ? `\n该轮开始：${clockTime(turn.startedAt * 1000)}` : '';
  return `[${label(snapshot.thread)}]\n${state}${current}${time}\n\n${exchange(turn)}`;
}
export function splitText(text: string, limit = 1700): string[] {
  const result: string[] = [];
  let rest = text;
  while (rest.length > limit) {
    let end = rest.lastIndexOf('\n', limit);
    if (end < limit / 2) end = limit;
    // Preserve a surrogate pair at the split boundary.
    const code = rest.charCodeAt(end - 1);
    if (code >= 0xd800 && code <= 0xdbff) end--;
    result.push(rest.slice(0, end)); rest = rest.slice(end);
    if (rest.startsWith('\n')) rest = rest.slice(1);
  }
  if (rest) result.push(rest);
  return result.length > 1 ? result.map((part, i) => `(${i + 1}/${result.length})\n${part}`) : result;
}
export function controls(thread: string, options: { current?: boolean; state?: string; empty?: boolean; view?: string } = {}): Button[] {
  const buttons: Button[] = [];
  buttons.push({ label: '选中会话', command: `/选择 ${thread}` });
  if (options.empty) buttons.push({ label: '模型设置', command: `/设置 ${thread}` });
  else {
    buttons.push({ label: '刷新', command: `/最新 ${thread}` });
    if (['running', 'approval', 'input'].includes(options.state || '')) {
      if (options.view !== 'answer') buttons.push({ label: '上一轮对答', command: `/结果 ${thread}` });
      buttons.push({ label: '停止任务', command: `/停止 ${thread}` });
    } else buttons.push({ label: '历史对答', command: `/历史 ${thread}` });
  }
  buttons.push({ label: '新建会话', command: `/新建会话 ${thread}` }, { label: '更多操作', command: `/操作 ${thread}` });
  return buttons;
}
