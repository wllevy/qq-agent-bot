import { QQBot } from '@tencent-connect/qqbot-nodejs';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { configuration, errorText } from '../src/config.js';

type MenuItem = { type: string; name: string; send_message?: string; sub_menu_items?: MenuItem[] };
type PanelItem = { type: 'command'; name: string; desc: string };
type Panel = { items?: PanelItem[]; remark?: string };
type PanelRecord = { panel_id: string; scope: string; target_type: string; panel: Panel };
const config = configuration();
const bot = new QQBot({ appId: config.appId, appSecret: config.appSecret, baseUrl: 'https://api.bot.qq.com' });
const action = (name: string, command: string): MenuItem => ({ type: 'send_message', name, send_message: command });
// QQ adds default icon URLs on read. Compare configured fields only, without
// depending on JSON object property order.
const menuItems = (items: MenuItem[] = []): MenuItem[] => items.map(item => ({
  name: item.name, type: item.type,
  ...(item.send_message !== undefined ? { send_message: item.send_message } : {}),
  ...(item.sub_menu_items ? { sub_menu_items: menuItems(item.sub_menu_items) } : {}),
}));
const menu = { items: [
  action('会话', '/会话'),
  action('当前会话', '/当前'),
  action('消息订阅', '/订阅'),
  { type: 'menu', name: '更多', sub_menu_items: [
    action('会话操作', '/操作'),
    action('历史对答', '/历史'),
    action('Claude 会话', '/Claude'),
    action('新建会话', '/新会话'),
    action('帮助', '/帮助'),
  ] },
] satisfies MenuItem[] };
const panel: Panel = {
  remark: 'qq-codex-console:c2c',
  items: [
    { type: 'command', name: '会话', desc: '选择 Codex 或 Claude Code 会话' },
    { type: 'command', name: '最新', desc: '查看最新操作与本轮进度' },
    { type: 'command', name: '结果', desc: '查看最近一轮用户要求与回答' },
    { type: 'command', name: '最近', desc: '查看最近两轮完整对答' },
    { type: 'command', name: '文件', desc: '查看附件，或按路径取文件' },
    { type: 'command', name: '订阅', desc: '查看本轮回复与长期订阅' },
    { type: 'command', name: '长期订阅', desc: '长期订阅，含电脑端回复' },
    { type: 'command', name: '取消订阅', desc: '取消订阅，保留当前选择' },
    { type: 'command', name: '停止', desc: '中断当前任务并清除排队' },
    { type: 'command', name: '队列', desc: '查看当前会话排队指令' },
    { type: 'command', name: '帮助', desc: '查看完整使用说明' },
  ],
};

async function panels(): Promise<PanelRecord[]> {
  const records: PanelRecord[] = [];
  let cursor: string | undefined;
  do {
    const page = await bot.api.get<{ records?: PanelRecord[]; next_cursor?: string; is_end?: boolean }>('/v2/panels', {
      scope: 'c2c', limit: 50, ...(cursor ? { cursor } : {}),
    });
    records.push(...page.records || []);
    cursor = page.is_end ? undefined : page.next_cursor || undefined;
  } while (cursor);
  return records;
}

try {
  const beforeMenu = await bot.api.get<{ menu?: { items?: MenuItem[] }; version?: number }>('/v2/menu');
  const beforePanels = await panels();
  mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
  const backup = join(config.dataDir, 'platform-menus-before.json');
  if (!existsSync(backup)) writeFileSync(backup, JSON.stringify({ menu: beforeMenu, panels: beforePanels }, null, 2), { mode: 0o600 });

  if (!isDeepStrictEqual(menuItems(beforeMenu.menu?.items), menuItems(menu.items))) {
    const result = await bot.api.put<{ version: number }>('/v2/menu', { menu });
    console.log(`底部菜单已设置（版本 ${result.version}）`);
  } else console.log('底部菜单已是当前配置');

  const existing = beforePanels.find(record => record.panel.remark === panel.remark)
;
  let panelId = existing?.panel_id;
  if (!existing) {
    const created = await bot.api.post<{ panel_id: string }>('/v2/panels', { scope: 'c2c', target_type: 'all', panel });
    panelId = created.panel_id;
    console.log('私聊指令面板已创建');
  } else if (!isDeepStrictEqual(existing.panel.items, panel.items)) {
    await bot.api.put(`/v2/panels/${encodeURIComponent(existing.panel_id)}`, { panel });
    console.log('私聊指令面板已更新');
  } else console.log('私聊指令面板已是当前配置');

  const confirmedMenu = await bot.api.get<{ menu?: { items?: MenuItem[] }; version?: number }>('/v2/menu');
  const confirmedPanel = (await panels()).find(record => record.panel_id === panelId);
  if (!isDeepStrictEqual(menuItems(confirmedMenu.menu?.items), menuItems(menu.items))) throw new Error('菜单回读结果与设置不一致');
  if (!confirmedPanel || !isDeepStrictEqual(confirmedPanel.panel.items, panel.items)) throw new Error('指令面板回读结果与设置不一致');
  writeFileSync(join(config.dataDir, 'platform-menus.json'), JSON.stringify({ menu: confirmedMenu, panel: confirmedPanel }, null, 2), { mode: 0o600 });
  console.log(`回读确认：${menu.items.length} 个一级菜单、${panel.items!.length} 条私聊指令。`);
} catch (error) { console.error(errorText(error)); process.exitCode = 1; }
