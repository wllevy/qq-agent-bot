import { findDirectories, rememberDirectories, shortDirectory } from './directories.js';
import { randomUUID } from 'node:crypto';
import { errorText, log } from './config.js';
import { completion, controls, label, latest, latestView, recentView, answerView, modelSummary, splitText, status } from './presentation.js';
import { machineOf } from './machines.js';
import { Store } from './store.js';
import { FileError, FileTransfers, targetPath } from './files.js';
import { canDispatch, canReportTurn, sessionStatus, SubmissionError, terminal } from './domain.js';
import { forEachConcurrent, SerialWork } from './work.js';
import type { Attachment, Button, Chat, CodexPort, Incoming, Outgoing, PreparedFile, QueuedInput, Sender, Snapshot, Thread, ModelSettings } from './types.js';

const HELP = `编程助手中控台

/会话：选择 Codex 或 Claude Code，再选择会话
/Claude：打开 Claude Code 会话列表
/新会话 [后端] [目录或关键词]：选择项目目录创建空白会话
/同目录新建：沿用当前目录、模型和推理强度
/取消新建：退出目录选择
/新建 [项目绝对路径]：创建由 Bot 管理的 Claude 会话
/恢复 [编号]：将已有 Claude 历史恢复为独立副本
/批准、/拒绝、/回答 内容：处理 Claude 当前确认或提问
/机器：返回后端列表
/模型：查看并选择当前会话的模型
/推理强度：选择当前模型支持的推理强度
/最新消息（或 /最新）：查看运行中的最新操作；结束后查看最后一轮对答
/结果（或 /最后回答）：查看最近已结束轮次的用户要求与模型回答
/最近：查看最近两轮完整对答
/文件：查看待用附件和成果文件；/文件 路径：取回指定文件
/清除附件：取消当前会话尚未绑定任务的附件
支持 20 MiB 以内文件；只发文件时等待下一条文字要求。
/搜索会话 [后端] 关键词：搜索标题和目录
/当前：查看当前会话
/操作：文件、模型设置、订阅和队列
/设置：模型与推理强度
/历史：向前翻阅完整对答
/订阅：查看本轮回复订阅和长期订阅
/长期订阅：长期订阅，电脑端交互的回复也会推送
/取消订阅：取消该会话所有消息订阅，保留当前选择
/停止：中断当前一轮，并取消该会话排队的指令
/队列：查看排队或发送结果待确认的指令
/清空队列：清除当前会话尚未发送及需人工处理的队列记录

选择后直接发文字即可继续任务；运行中收到的指令排到下一轮。
引用 Bot 的会话消息可向对应会话发指令，不改变当前会话。
“发送 内容”可以原样提交与菜单命令同名的文字。`;

export class ConsoleApp {
  private userWork = new SerialWork();
  private threadWork = new SerialWork();
  private activeIncoming = new Map<string, Incoming>();
  private polling = new Map<string, Promise<void>>();
  private delivery?: Promise<void>;
  private stopping = false;
  private emptyTerminalLogged = new Set<string>();
  readonly files: FileTransfers;
  constructor(public store: Store, private codex: CodexPort, private sender: Sender) { this.files = new FileTransfers(store, codex); }
  isSubscribed(chat: Chat, thread: string): boolean { return !!chat.subscriptions[thread]?.persistent || !!chat.subscriptions[thread]?.replies?.length; }

  async receive(user: string, text: string, messageId: string, reference?: string, attachments: Attachment[] = []) {
    if (this.stopping) return;
    const id = `${user}:${messageId}`;
    if (this.store.state.received.includes(id)) return;
    if (!this.store.state.inbox.some(entry => entry.id === id)) {
      const target = reference ? this.store.state.refs[reference] : undefined;
      const thread = reference ? target?.user === user ? target.thread : undefined : this.store.chat(user).current;
      const fileIds = attachments.length ? thread ? this.files.incoming(user, thread, attachments) : [] : undefined;
      this.store.state.inbox.push({ id, user, text: text.trim(), messageId, reference, fileIds, attachmentThread: fileIds ? thread : undefined });
      this.store.save();
    }
    void this.files.tick().catch(error => log('文件传输失败', error));
    await this.processUser(user);
    await this.deliver();
  }
  async recover() {
    await Promise.all([...new Set(this.store.state.inbox.map(entry => entry.user))].map(user => this.processUser(user)));
  }
  private processUser(user: string) {
    return this.userWork.run(user, async () => {
      while (!this.stopping) {
        const incoming = this.store.state.inbox.find(entry => entry.user === user);
        if (!incoming) return;
        this.activeIncoming.set(user, incoming);
        try {
          await this.handle(user, incoming.text, incoming.messageId, incoming.reference);
          if (!this.stopping) { this.store.completeIncoming(incoming.id); this.store.save(); }
        } catch (error) {
          log('处理私聊消息失败', error);
          if (!this.stopping) this.reply(user, `操作未完成：${errorText(error)}`, incoming.messageId);
        } finally { this.activeIncoming.delete(user); }
      }
    });
  }
  private reply(user: string, text: string, replyTo?: string, thread?: string, buttons?: Button[], acknowledge?: string[]) {
    if (this.stopping) return;
    this.enqueue({ kind: 'reply', user, text, replyTo, thread, buttons, acknowledge });
    const incoming = this.activeIncoming.get(user);
    if (incoming) this.store.completeIncoming(incoming.id);
    this.store.save();
  }
  async shutdown() {
    this.stopping = true;
    await Promise.allSettled([this.userWork.drain(), ...this.polling.values(), this.delivery, this.files.shutdown()]);
    await this.threadWork.drain();
    this.store.save();
  }
  private resolve(chat: Chat, value?: string): string {
    if (!value) {
      if (!chat.current) throw new Error('先发送“会话”选择一个 session。');
      return chat.current;
    }
    if (/^\d+$/.test(value)) {
      if (this.codex.machines && !chat.menuMachine) throw new Error('先选择机器并打开会话列表。');
      const id = chat.menu[Number(value) - 1];
      if (!id) throw new Error('会话编号已失效，请重新打开“会话”。');
      return id;
    }
    if (!/^[a-zA-Z0-9_-]+(?::[a-zA-Z0-9_-]+)?$/.test(value)) throw new Error('请使用会话菜单选择。');
    return this.codex.qualify?.(value) ?? value;
  }
  private syncSubscriptions(user: string, chat: Chat) {
    for (const thread of Object.keys(chat.subscriptions)) {
      if (!this.isSubscribed(chat, thread)) delete chat.subscriptions[thread];
    }
    this.store.state.outbox = this.store.state.outbox.filter(entry => entry.kind === 'reply' || entry.user !== user || this.isSubscribed(chat, entry.thread!));
  }
  private baseline(chat: Chat, snapshot: Snapshot) {
    const id = snapshot.thread.id;
    const subscription = chat.subscriptions[id] ??= { persistent: false, replies: [], seen: [] };
    const turns = snapshot.turns.filter(turn => canReportTurn(snapshot, turn) && !subscription.replies?.some(r => r.turnId === turn.id));
    subscription.seen = [...new Set([...subscription.seen, ...turns.map(turn => turn.id)])].slice(-100);
    subscription.terminalStatuses = Object.fromEntries(subscription.seen.flatMap(id => {
      const status = turns.find(turn => turn.id === id)?.status || subscription.terminalStatuses?.[id];
      return status ? [[id, status]] : [];
    }));
  }
  private async show(user: string, thread: string, viewKind: 'latest' | 'recent' | 'answer', replyTo?: string, selecting = false) {
    const snapshot = await this.codex.snapshot(thread, { activity: viewKind === 'latest' });
    const chat = this.store.chat(user);
    if (selecting) {
      chat.current = thread; this.resetMenu(chat);
      this.syncSubscriptions(user, chat);
    }
    if (this.isSubscribed(chat, thread) && !chat.subscriptions[thread]) this.baseline(chat, snapshot);
    const view = viewKind === 'recent' ? recentView(snapshot) : viewKind === 'answer' ? answerView(snapshot) : latestView(snapshot);
    const turns = snapshot.turns.filter(terminal).slice(0, viewKind === 'recent' ? 2 : 1);
    const files = this.files.candidates(user, snapshot, turns);
    const suffix = files.length ? '\n\n**相关文件**\n' + files.map(file => '- ' + this.files.describe(file)).join('\n') : '';
    const historical = machineOf(thread) === 'claude' && !snapshot.thread.managed;
    const note = historical ? '\n\n这是已有历史。发送“恢复”创建由 Bot 管理的独立副本，保留原会话。' : '';
    this.reply(user, view.text + suffix + note + (snapshot.pendingAction ? '\n\n' + snapshot.pendingAction.text : ''), replyTo, thread,
      [...this.actionButtons(snapshot), ...(historical ? [{ label: '恢复为副本', command: `/恢复 ${thread}` }] : []), ...this.files.buttons(files), ...controls(thread, { state: sessionStatus(snapshot), empty: !snapshot.turns.length, view: viewKind })], view.acknowledge);
    void this.files.tick().catch(error => log('文件缓存失败', error));
  }
  private actionButtons(snapshot: Snapshot): Button[] {
    const pending = snapshot.pendingAction;
    return pending?.kind === 'approval' ? [
      { label: '批准', command: `/批准 ${snapshot.thread.id} ${pending.id}` },
      { label: '拒绝', command: `/拒绝 ${snapshot.thread.id} ${pending.id}` },
    ] : [];
  }

  private resetMenu(chat: Chat) { chat.menu = []; delete chat.settingsMenu; delete chat.creationMenu; }
  private newSessionMenu(user: string, id: string, replyTo: string) {
    this.resetMenu(this.store.chat(user));
    this.reply(user, '新建空白会话：选择项目目录。', replyTo, id, [
      { label: '同目录会话', command: `/同目录新建 ${id}` },
      { label: '其他目录', command: `/新会话 ${machineOf(id)}` },
    ]);
  }
  private async subscriptionList(user: string, replyTo: string, page = 0) {
    const chat = this.store.chat(user);
    const ids = Object.keys(chat.subscriptions).filter(id => this.isSubscribed(chat, id));
    page = Math.min(Math.max(0, Number.isSafeInteger(page) ? page : 0), Math.max(0, Math.ceil(ids.length / 6) - 1));
    const buttons: Button[] = [];
    const rows = await Promise.all(ids.slice(page * 6, page * 6 + 6).map(async id => {
      let name = this.shortTarget(id);
      try { name = label((await this.codex.snapshot(id)).thread); } catch {}
      return { id, name };
    }));
    const lines = rows.map(({ id, name }, i) => {
      const number = page * 6 + i + 1;
      buttons.push({ label: `${id === chat.current ? '查看' : '切换'} ${number}`, command: `/${id === chat.current ? '最新' : '选择'} ${id}` },
        { label: `取消订阅 ${number}`, command: `/取消订阅 ${id}` });
      return `${number}. ${name}\n${chat.subscriptions[id]?.persistent ? '★ 长期订阅' : '本轮回复订阅'}${id === chat.current ? ' · 当前' : ''}`;
    });
    if (page > 0) buttons.push({ label: '上一页', command: `/订阅 ${page - 1}` });
    if ((page + 1) * 6 < ids.length) buttons.push({ label: '下一页', command: `/订阅 ${page + 1}` });
    if (!ids.length) buttons.push({ label: '选择会话', command: '/会话' });
    this.reply(user, lines.length ? `消息订阅 ${page + 1}/${Math.ceil(ids.length / 6)}\n\n${lines.join('\n\n')}\n\n可逐条取消；取消不改变当前会话，也不停止任务。` : '暂无消息订阅。发送任务后自动订阅该轮回复；“长期订阅”可持续接收后续回复。', replyTo, undefined, buttons);
  }
  private queueView(user: string, id: string, replyTo: string) {
    const inputs = this.store.state.inputs.filter(i => i.user === user && i.thread === id);
    this.reply(user, inputs.map((i, n) => `${n + 1}. ${i.state === 'queued' ? i.waitReason || '等待会话可用' : i.state === 'rejected' ? '提交被拒绝' : '提交结果待确认'}：${i.text.slice(0, 180)}${i.error ? '\n' + i.error : ''}`).join('\n\n') || '没有排队指令。', replyTo, id,
      [...inputs.slice(0, 12).map((i, n) => ({ label: `移除 ${n + 1}`, command: `/取消指令 ${i.id}` })), ...controls(id)]);
  }
  private async interfaceCommand(user: string, text: string, replyTo: string) {
    const chat = this.store.chat(user);
    const search = /^\/?搜索会话(?:\s+([\s\S]+))?$/.exec(text);
    if (search) {
      const argument = search[1]?.trim() || '', first = argument.split(/\s/)[0]!;
      const explicit = this.codex.machines?.includes(first) ? first : undefined;
      const machine = explicit || chat.menuMachine || (chat.current ? machineOf(chat.current) : undefined);
      await this.menu(user, 0, replyTo, machine, explicit ? argument.slice(first.length).trim() : argument); return true;
    }
    const m = /^\/?(当前|操作|设置|历史|新建会话|取消指令)(?:\s+(\S+))?(?:\s+(\S+))?$/.exec(text);
    if (!m) return false;
    this.resetMenu(chat);
    if (m[1] === '取消指令') {
      const input = this.store.state.inputs.find(i => i.id === m[2] && i.user === user);
      if (!input) throw new Error('该指令已发送或已移除');
      await this.threadWork.run(input.thread, async () => {
        this.store.state.inputs = this.store.state.inputs.filter(i => i !== input);
        const sub = chat.subscriptions[input.thread];
        if (sub) sub.replies = sub.replies.filter(r => r.inputId !== input.id || !!r.turnId);
      });
      this.queueView(user, input.thread, replyTo); return true;
    }
    const id = this.resolve(chat, m[2]);
    if (m[1] === '当前') { await this.show(user, id, 'latest', replyTo); return true; }
    if (m[1] === '新建会话') { this.newSessionMenu(user, id, replyTo); return true; }
    if (m[1] === '历史') {
      const snapshot = await this.codex.snapshot(id);
      const page = this.codex.history ? await this.codex.history(id, m[3] ? decodeURIComponent(m[3]) : undefined) : { turns: snapshot.turns };
      const view = recentView({ ...snapshot, turns: page.turns }, page.turns.length);
      this.reply(user, view.text, replyTo, id, [...(page.nextCursor ? [{ label: '更早对答', command: `/历史 ${id} ${encodeURIComponent(page.nextCursor)}` }] : []), ...controls(id)], view.acknowledge); return true;
    }
    const buttons = m[1] === '设置' ? [{ label: '选择模型', command: `/模型 ${id}` }, { label: '推理强度', command: `/推理强度 ${id}` }] : [
      { label: '文件', command: `/文件列表 ${id}` }, { label: '模型设置', command: `/设置 ${id}` },
      { label: '历史对答', command: `/历史 ${id}` },
      ...(this.isSubscribed(chat, id) ? [{ label: '取消订阅', command: `/取消订阅 ${id}` }] : []),
      { label: '消息订阅', command: '/订阅' },
      { label: '队列', command: `/队列 ${id}` }, { label: '停止任务', command: `/停止 ${id}` },
    ];
    const snapshot = await this.codex.snapshot(id);
    this.reply(user, `${label(snapshot.thread)}\n${id === chat.current ? '当前发送目标' : '正在查看此会话，普通消息仍发给当前选择'}\n${modelSummary(snapshot.thread)}`, replyTo, id, [...buttons, ...controls(id)]); return true;
  }
  private machineMenu(user: string, replyTo?: string) {
    const machines = this.codex.machines!;
    const chat = this.store.chat(user);
    this.resetMenu(chat);
    chat.menu = [...machines]; chat.menuMachine = undefined; chat.page = 0;
    this.reply(user, `选择后端\n\n${machines.map((id, i) => `${i + 1}. ${this.codex.backendLabel?.(id) || id}`).join('\n')}\n\n仅浏览会话列表，不改变当前会话和订阅。`, replyTo, undefined,
      machines.map(id => ({ label: this.codex.backendLabel?.(id) || id, command: `/机器 ${id}` })));
  }
  private async menu(user: string, page: number, replyTo?: string, machine?: string, query = '') {
    if (!machine && this.codex.machines?.length === 1) machine = this.codex.machines[0];
    if (this.codex.machines && !machine) { this.machineMenu(user, replyTo); return; }
    if (machine && !this.codex.machines?.includes(machine)) throw new Error('请选择菜单中的机器。');
    const chat = this.store.chat(user);
    this.resetMenu(chat); chat.menuMachine = machine; chat.menuQuery = query;
    let threads;
    try { threads = await this.codex.list(machine); }
    catch (error) {
      this.reply(user, errorText(error), replyTo, undefined, [
        { label: '重试', command: `/机器 ${machine}` }, { label: '返回机器', command: '/机器' },
      ]);
      return;
    }
    if (query) { const words = query.toLocaleLowerCase().split(/\s+/).filter(Boolean); threads = threads.filter(t => words.every(w => `${t.name || ''} ${t.preview || ''} ${t.cwd}`.toLocaleLowerCase().includes(w))); }
    chat.menu = threads.map(thread => thread.id);
    chat.page = Math.min(Math.max(0, page), Math.max(0, Math.ceil(threads.length / 8) - 1));
    const createButtons = machine && this.codex.canCreate?.(machine) ? [{ label: '新建会话', command: `/新会话 ${machine}` }] : [];
    if (!threads.length) { this.reply(user, `${this.codex.backendLabel?.(machine!) || machine || ''} 没有找到可用会话。${createButtons.length ? '\n发送“新会话”，选择项目目录。' : ''}`, replyTo, undefined, [...createButtons, { label: '返回后端', command: '/机器' }]); return; }
    const offset = chat.page * 8;
    const rows = threads.slice(offset, offset + 8);
    const lines = rows.map((thread, i) => {
      const marker = chat.current === thread.id ? '● 当前' : !!chat.subscriptions[thread.id]?.persistent ? '★ 长期订阅' : '';
      const state = thread.status.type === 'active' ? '运行中' : thread.status.type === 'idle' ? '空闲' : '历史';
      return `${offset + i + 1}. ${label(thread)}\n    ${state}${thread.managed ? ' · Bot管理' : machine === 'claude' ? ' · 可恢复为副本' : ''}${marker ? ' · ' + marker : ''}`;
    });
    const buttons: Button[] = rows.map((thread, i) => ({ label: `选择 ${offset + i + 1}`, command: `/选择 ${thread.id}` }));
    buttons.push(...createButtons);
    if (chat.page > 0) buttons.push({ label: '上一页', command: `/上一页${machine ? ' ' + machine : ''}` });
    if (offset + 8 < threads.length) buttons.push({ label: '下一页', command: `/下一页${machine ? ' ' + machine : ''}` });
    if ((this.codex.machines?.length || 0) > 1) buttons.push({ label: '返回机器', command: '/机器' });
    buttons.push({ label: '消息订阅', command: '/订阅' });
    this.reply(user, `会话${machine ? " · " + machine : ""} ${chat.page + 1}/${Math.ceil(threads.length / 8)}\n\n${lines.join('\n\n')}\n\n点击按钮，或发送编号选择。\n翻页：/上一页、/下一页${(this.codex.machines?.length || 0) > 1 ? '；返回机器：/机器' : ''}`, replyTo, undefined, buttons);
  }
  private creationMachines(user: string, replyTo: string) {
    const machines = [...this.codex.machines || ['local']];
    const chat = this.store.chat(user);
    delete chat.settingsMenu;
    chat.creationMenu = { token: randomUUID(), choices: machines, query: '', page: 0 };
    this.reply(user, '新建会话：选择机器\n\n' + machines.map((machine, i) => `${i + 1}. ${this.codex.backendLabel?.(machine) || machine}`).join('\n'), replyTo, undefined,
      machines.map(machine => ({ label: this.codex.backendLabel?.(machine) || machine, command: `/新会话 ${machine}` })));
  }
  private async directoryMenu(user: string, machine: string, query: string, replyTo: string, page = 0, refresh = true) {
    if (!(this.codex.machines || ['local']).includes(machine)) throw new Error('请选择菜单中的机器。');
    const chat = this.store.chat(user);
    let offline = false;
    if (refresh) {
      try { rememberDirectories(this.store.state, machine, await this.codex.list(machine)); }
      catch { offline = true; }
    }
    this.resetMenu(chat);
    const choices = findDirectories(this.store.state, machine, query);
    page = Math.min(Math.max(0, page), Math.max(0, Math.ceil(choices.length / 8) - 1));
    const token = randomUUID();
    chat.creationMenu = { token, machine, choices, query, page }; delete chat.settingsMenu;
    const offset = page * 8, rows = choices.slice(offset, offset + 8);
    const buttons: Button[] = rows.map((path, i) => ({ label: `${offset + i + 1}. ${targetPath(path).basename(path) || path}`.slice(0, 10), command: `/新建目录 ${token} ${offset + i + 1}` }));
    if (page > 0) buttons.push({ label: '上一页', command: `/目录翻页 ${token} ${page - 1}` });
    if (offset + 8 < choices.length) buttons.push({ label: '下一页', command: `/目录翻页 ${token} ${page + 1}` });
    buttons.push({ label: '全部最近目录', command: `/新会话 ${machine}` }, { label: '切换机器', command: '/新会话机器' }, { label: '取消新建', command: '/取消新建' });
    const lines = rows.map((path, i) => `${offset + i + 1}. **${targetPath(path).basename(path) || path}**\n${shortDirectory(path)}`);
    this.reply(user, `**新建会话 · ${machine}**${query ? '\n搜索：' + query : ''}\n第 ${page + 1}/${Math.max(1, Math.ceil(choices.length / 8))} 页${offline ? '\n机器暂时离线，显示缓存目录；开机后重新点击创建。' : ''}\n\n${lines.join('\n\n') || '没有匹配的历史目录。可以直接输入绝对路径。'}\n\n点击目录或发送编号，即在该目录新建空白会话。\n输入关键词可筛选；输入 F:/项目路径 或 ~/路径 可直接创建。\n/取消新建 返回原会话。`, replyTo, undefined, buttons);
  }
  private finishCreation(user: string, thread: Thread, replyTo: string) {
    const chat = this.store.chat(user);
    chat.current = thread.id; delete chat.creationMenu; delete chat.settingsMenu;
    // Old numeric session choices should not turn a new task such as "1" into navigation.
    chat.menu = []; chat.menuMachine = thread.machine || machineOf(thread.id);
    this.syncSubscriptions(user, chat);
    rememberDirectories(this.store.state, thread.machine || machineOf(thread.id), [{ cwd: thread.cwd, updatedAt: Date.now() / 1000 }]);
    this.reply(user, `**已创建并切换到空白会话**\n机器：${thread.machine || machineOf(thread.id)}\n目录：${thread.cwd}\n${modelSummary(thread)}\n\n发送第一条要求即可开始。`, replyTo, thread.id, controls(thread.id));
  }
  private async createSession(user: string, machine: string, cwd: string, replyTo: string, settings?: ModelSettings) {
    if (!this.codex.create) throw new Error('当前连接不支持创建会话。');
    if (this.stopping) return;
    const incoming = this.activeIncoming.get(user)!;
    // thread/start has no idempotency key. Persist the attempt before the RPC;
    // recovery may finish a known result but must never repeat an unknown one.
    incoming.creation = { machine, cwd }; this.store.save();
    try {
      const thread = await this.codex.create(machine, cwd, incoming.id, undefined, settings);
      incoming.creation.thread = thread; this.store.save();
      if (!this.stopping) this.finishCreation(user, thread, replyTo);
    } catch (error) {
      if (this.stopping) return;
      const uncertain = error instanceof SubmissionError && error.outcome === 'uncertain';
      this.reply(user, `${uncertain ? '创建结果待确认，请先查看会话列表，避免重复新建。' : '未能创建会话，原会话保持不变；本次操作不会自动重试。'}\n${errorText(error)}`, replyTo, undefined,
        [{ label: '查看会话', command: `/机器 ${machine}` }, { label: '选择目录', command: `/新会话 ${machine}` }]);
    }
  }
  private async handleCreation(user: string, text: string, replyTo: string): Promise<boolean> {
    const chat = this.store.chat(user), incoming = this.activeIncoming.get(user)!;
    if (incoming.creation) {
      if (incoming.creation.thread) this.finishCreation(user, incoming.creation.thread, replyTo);
      else this.reply(user, '上次创建会话的结果未确认，未自动重复创建。请先打开会话列表查看。', replyTo, undefined,
        [{ label: '查看会话', command: `/机器 ${incoming.creation.machine}` }]);
      return true;
    }
    if (/^\/?取消新建$/.test(text)) {
      delete chat.creationMenu; this.reply(user, '已退出目录选择，当前会话未改变。', replyTo, chat.current, chat.current ? controls(chat.current) : [{ label: '会话', command: '/会话' }]); return true;
    }
    if (/^\/?新会话机器$/.test(text)) { this.creationMachines(user, replyTo); return true; }
    const same = /^\/?同目录新建(?:\s+(\S+))?$/.exec(text);
    if (same) {
      const source = await this.codex.snapshot(this.resolve(chat, same[1]));
      await this.createSession(user, source.thread.machine || machineOf(source.thread.id), source.thread.cwd, replyTo,
        { model: source.thread.model || undefined, effort: source.thread.reasoningEffort || undefined });
      return true;
    }
    const pick = /^\/?(新建目录|目录翻页)\s+(\S+)\s+(\d+)$/.exec(text);
    if (pick) {
      const menu = chat.creationMenu;
      if (!menu?.machine || pick[2] !== menu.token) throw new Error('目录菜单已失效，请重新发送 /新会话。');
      if (pick[1] === '目录翻页') await this.directoryMenu(user, menu.machine, menu.query, replyTo, Number(pick[3]));
      else {
        const cwd = menu.choices[Number(pick[3]) - 1];
        if (!cwd) throw new Error('目录编号无效，请重新选择。');
        await this.createSession(user, menu.machine, cwd, replyTo);
      }
      return true;
    }
    const start = /^\/?新会话(?:\s+([\s\S]+))?$/.exec(text);
    if (start) {
      if (!start[1] && chat.current) { this.newSessionMenu(user, chat.current, replyTo); return true; }
      const argument = start[1]?.trim() || '', first = argument.split(/\s/)[0]!;
      const explicitMachine = (this.codex.machines || ['local']).includes(first) ? first : undefined;
      const machine = explicitMachine || chat.creationMenu?.machine || (chat.current ? machineOf(chat.current) : chat.menuMachine);
      const query = (explicitMachine ? argument.slice(first.length).trim() : argument).replace(/^<([\s\S]*)>$/, '$1').replace(/^"([\s\S]*)"$/, '$1');
      if (!machine) { this.creationMachines(user, replyTo); return true; }
      if (targetPath(query).isAbsolute(query) || query === '~' || query.startsWith('~/')) await this.createSession(user, machine, query, replyTo);
      else await this.directoryMenu(user, machine, query, replyTo);
      return true;
    }
    const menu = chat.creationMenu;
    if (!menu) return false;
    if ((this.codex.machines || ['local']).includes(text)) { await this.directoryMenu(user, text, '', replyTo); return true; }
    if (/^\d+$/.test(text)) {
      const chosen = menu.choices[Number(text) - 1];
      if (!chosen) throw new Error('目录编号无效，请重新选择。');
      if (menu.machine) await this.createSession(user, menu.machine, chosen, replyTo);
      else await this.directoryMenu(user, chosen, '', replyTo);
      return true;
    }
    const command = /^(?:Claude|claude|Codex|codex|新建|恢复|批准|拒绝|回答|发送|机器|会话|sessions|菜单|帮助|help|start|选择|切换|最新消息|最新|状态|最后回答|结果|最近|订阅|长期订阅|取消订阅|停止|上一页|下一页|队列|清空队列|文件列表|取文件|清除附件|文件|模型|推理强度|强度|设置模型|设置强度)(?:\s|$)/;
    if (command.test(text.replace(/^\//, ''))) return false;
    if (menu.machine && (targetPath(text).isAbsolute(text) || text === '~' || text.startsWith('~/'))) {
      await this.createSession(user, menu.machine, text, replyTo); return true;
    }
    if (menu.machine && text && !text.startsWith('/')) { await this.directoryMenu(user, menu.machine, text, replyTo); return true; }
    return false;
  }
  private async modelMenu(user: string, thread: string, replyTo: string, page = 0) {
    const [snapshot, models] = await Promise.all([this.codex.snapshot(thread), this.codex.models(thread)]);
    if (!models.length) throw new Error('该机器没有返回可选模型。');
    const index = Math.min(Math.max(0, page), Math.ceil(models.length / 8) - 1);
    const offset = index * 8;
    this.resetMenu(this.store.chat(user));
    this.store.chat(user).settingsMenu = { thread, kind: 'model', values: models.map(model => model.model) };
    const rows = models.slice(offset, offset + 8);
    const lines = rows.map((model, i) => `${offset + i + 1}. ${model.model}${model.model === snapshot.thread.model ? ' · 当前' : ''}`);
    const buttons: Button[] = rows.map((model, i) => ({ label: `模型 ${offset + i + 1}`, command: `/设置模型 ${thread} ${model.model}` }));
    if (index > 0) buttons.push({ label: '上一页', command: `/模型 ${thread} ${index - 1}` });
    if (offset + 8 < models.length) buttons.push({ label: '下一页', command: `/模型 ${thread} ${index + 1}` });
    buttons.push({ label: '推理强度', command: `/推理强度 ${thread}` }, { label: '返回会话', command: `/最新 ${thread}` });
    this.reply(user, `[${label(snapshot.thread)}]\n${modelSummary(snapshot.thread)}\n\n选择模型 ${index + 1}/${Math.ceil(models.length / 8)}\n${lines.join('\n')}\n\n点击按钮或发送编号。也可发送：/设置模型 模型名\n修改对后续轮次生效。`, replyTo, thread, buttons);
  }
  private async effortMenu(user: string, thread: string, replyTo: string) {
    const [snapshot, models] = await Promise.all([this.codex.snapshot(thread), this.codex.models(thread)]);
    const model = models.find(model => model.model === snapshot.thread.model);
    if (!model?.supportedReasoningEfforts.length) {
      this.reply(user, `[${label(snapshot.thread)}]\n${modelSummary(snapshot.thread)}\n\n当前模型没有提供可选推理强度，请先选择模型。`, replyTo, thread, [{ label: '选择模型', command: `/模型 ${thread}` }]);
      return;
    }
    const values = model.supportedReasoningEfforts.map(option => option.reasoningEffort);
    this.resetMenu(this.store.chat(user));
    this.store.chat(user).settingsMenu = { thread, kind: 'effort', values };
    const lines = values.map((effort, i) => `${i + 1}. ${effort}${effort === snapshot.thread.reasoningEffort ? ' · 当前' : ''}${effort === model.defaultReasoningEffort ? ' · 模型默认' : ''}`);
    const buttons = values.map(effort => ({ label: effort, command: `/设置强度 ${thread} ${effort}` }));
    buttons.push({ label: '选择模型', command: `/模型 ${thread}` }, { label: '返回会话', command: `/最新 ${thread}` });
    this.reply(user, `[${label(snapshot.thread)}]\n${modelSummary(snapshot.thread)}\n\n选择推理强度\n${lines.join('\n')}\n\n点击按钮或发送编号。也可发送：/设置强度 high\n修改对后续轮次生效。`, replyTo, thread, buttons);
  }
  private async changeModelSetting(user: string, thread: string, kind: 'model' | 'effort', value: string, replyTo: string) {
    await this.threadWork.run(thread, async () => {
      if (this.stopping) return;
      const updated = await this.codex.updateSettings(thread, { [kind]: value });
      delete this.store.chat(user).settingsMenu;
      this.reply(user, `[${label(updated)}]\n已更新会话设置\n${modelSummary(updated)}\n\n对后续轮次生效，当前任务继续运行。`, replyTo, thread, controls(thread));
    });
  }
  private async handle(user: string, text: string, replyTo: string, reference?: string) {
    const chat = this.store.chat(user);
    const incomingFiles = this.activeIncoming.get(user)!;
    if (incomingFiles.fileIds) {
      delete chat.creationMenu;
      if (!incomingFiles.attachmentThread) { this.reply(user, '请先选择会话，再重新发送附件。', replyTo); return; }
      if (!text) {
        const records = incomingFiles.fileIds.map(id => this.files.get(id)!);
        this.reply(user, '已登记附件：\n' + records.map(file => this.files.describe(file)).join('\n') + '\n\n文件保存后会用于该会话的下一条文字要求。可用 /文件 查看，/清除附件 取消。', replyTo, incomingFiles.attachmentThread,
          [{ label: '查看附件', command: `/文件列表 ${incomingFiles.attachmentThread}` }]);
        return;
      }
      await this.submit(user, text, replyTo, undefined, incomingFiles.attachmentThread); return;
    }
    if (await this.interfaceCommand(user, text, replyTo)) return;
    if (!reference && await this.handleCreation(user, text, replyTo)) return;
    delete chat.creationMenu;
    const fileCommand = /^(?:\/)?(文件列表|取文件|清除附件|文件)(?:\s+([\s\S]+))?$/.exec(text);
    if (fileCommand) {
      delete chat.settingsMenu;
      const command = fileCommand[1], argument = fileCommand[2]?.trim();
      if (command === '取文件') {
        const file = argument ? this.files.get(argument) : undefined;
        if (!file || file.user !== user) throw new Error('文件记录不存在，请重新查看 /文件。');
        this.queueFile(user, file.id, replyTo); return;
      }
      const thread = this.resolve(chat, command === '文件列表' ? argument : undefined);
      if (command === '清除附件') {
        this.files.clearPending(user, thread); this.reply(user, '已取消尚未绑定任务的附件，已排队任务不受影响。', replyTo, thread); return;
      }
      if (command === '文件' && argument) {
        let path = argument.replace(/^<|>$/g, '').replace(/^file:\/\//, '');
        if (/^\/[a-z]:\//i.test(path)) path = path.slice(1);
        const cwd = (await this.codex.snapshot(thread)).thread.cwd;
        path = targetPath(cwd).resolve(cwd, path);
        const file = this.files.explicit(user, thread, path);
        this.queueFile(user, file.id, replyTo); return;
      }
      try {
        const snapshot = await this.codex.snapshot(thread);
        this.files.candidates(user, snapshot, snapshot.turns.filter(terminal).slice(0, 2));
      } catch { /* Cached files remain accessible while the machine is offline. */ }
      const pending = this.files.pending(user, thread);
      const results = this.files.list(user, thread).filter(file => file.direction === 'out').slice(-20).reverse();
      const body = '**待用附件**\n' + (pending.map(file => '- ' + this.files.describe(file)).join('\n') || '无') + '\n\n**成果文件**\n' + (results.map(file => `- ${this.files.describe(file)}\n  /取文件 ${file.id}`).join('\n') || '无');
      this.reply(user, body, replyTo, thread, [...this.files.buttons(results), ...controls(thread)]);
      void this.files.tick().catch(error => log('文件缓存失败', error)); return;
    }
    const forced = /^(?:发送|\/发送)\s+([\s\S]+)$/.exec(text);
    if (!forced && /^\/?(?:claude|claude code)$/i.test(text)) { await this.menu(user, 0, replyTo, 'claude'); return; }
    if (!forced && /^\/?codex$/i.test(text)) { await this.menu(user, 0, replyTo, 'local'); return; }
    const creation = /^\/?(新建|恢复)(?:\s+([\s\S]+))?$/.exec(text);
    if (!forced && creation) {
      if (!this.codex.create || !this.codex.canCreate?.('claude')) throw new Error('Claude 后端未启用');
      const sourceId = creation[1] === '恢复' ? this.resolve(chat, creation[2]?.trim()) : undefined;
      if (sourceId && machineOf(sourceId) !== 'claude') throw new Error('请先选择 Claude 历史会话再恢复');
      const cwd = creation[1] === '新建' ? creation[2]?.trim().replace(/^"|"$/g, '') : undefined;
      const thread = await this.codex.create('claude', cwd, this.activeIncoming.get(user)!.id, sourceId);
      await this.show(user, thread.id, 'latest', replyTo, true);
      return;
    }
    const response = /^\/?(批准|拒绝)(?:\s+(\S+)\s+(\S+))?$/.exec(text);
    const answer = /^\/?回答\s+([\s\S]+)$/.exec(text);
    if (!forced && (response || answer)) {
      const referenced = reference ? this.store.state.refs[reference] : undefined;
      if (reference && (!referenced || referenced.user !== user)) throw new Error('引用消息已失效，请重新打开会话');
      const id = response?.[2] ? this.resolve(chat, response[2]) : referenced?.thread || this.resolve(chat);
      const snapshot = await this.codex.snapshot(id);
      const pending = snapshot.pendingAction;
      if (!pending || !this.codex.respond) throw new Error('当前没有等待处理的 Claude 确认或提问');
      if (response?.[3] && response[3] !== pending.id) throw new Error('该确认按钮已失效，请查看最新状态');
      if (answer && pending.kind !== 'input' || response && pending.kind !== 'approval') throw new Error('请按当前确认或提问的说明回复');
      await this.codex.respond(id, pending.id, answer?.[1] || response![1]!);
      this.reply(user, '已处理，Claude 将继续当前任务。', replyTo, id); return;
    }
    const setting = /^(?:\/)?(模型|推理强度|强度|设置模型|设置强度)(?:\s+(\S+))?(?:\s+(\S+))?\s*$/.exec(text);
    if (!forced && setting) {
      const [, command, first, second] = setting;
      if (command === '设置模型' || command === '设置强度') {
        const value = second || first;
        if (!value) throw new Error('请先打开模型或推理强度菜单进行选择。');
        const thread = this.resolve(chat, second ? first : chat.settingsMenu?.thread);
        await this.changeModelSetting(user, thread, command === '设置模型' ? 'model' : 'effort', value, replyTo);
      } else {
        const thread = this.resolve(chat, first);
        if (command === '模型') {
          if (second && !/^\d+$/.test(second)) throw new Error('模型页码无效。');
          await this.modelMenu(user, thread, replyTo, Number(second || 0));
        } else await this.effortMenu(user, thread, replyTo);
      }
      return;
    }
    if (!forced && /^\d+$/.test(text) && chat.settingsMenu) {
      const { thread, kind, values } = chat.settingsMenu;
      const value = values[Number(text) - 1];
      if (!value) throw new Error('该编号不在当前选项中，请重新打开模型或推理强度菜单。');
      await this.changeModelSetting(user, thread, kind, value, replyTo);
      return;
    }
    delete chat.settingsMenu;
    const match = /^(?:\/)?(机器|会话|sessions|菜单|帮助|help|start|选择|切换|最新消息|最新|状态|最后回答|结果|最近|订阅|长期订阅|取消订阅|停止|上一页|下一页|队列|清空队列)(?:\s+(\S+))?\s*$/.exec(text);
    if (!forced && this.codex.machines?.includes(text)) { await this.menu(user, 0, replyTo, text); return; }
    if (!forced && /^\d+$/.test(text) && chat.menu.length) {
      if (this.codex.machines && !chat.menuMachine) {
        const machine = chat.menu[Number(text) - 1];
        if (!machine) throw new Error('请选择菜单中的机器编号。');
        await this.menu(user, 0, replyTo, machine); return;
      }
      await this.show(user, this.resolve(chat, text), 'latest', replyTo, true); return;
    }
    if (!forced && match) {
      const command = match[1]!; const argument = match[2];
      if (['帮助', 'help', 'start'].includes(command)) { this.reply(user, HELP, replyTo, undefined, [{ label: '打开会话', command: '/会话' }]); return; }
      if (['机器', '会话', 'sessions', '菜单', '上一页', '下一页'].includes(command)) {
        await this.menu(user, command === '下一页' ? chat.page + 1 : command === '上一页' ? chat.page - 1 : 0, replyTo, argument || (['上一页', '下一页'].includes(command) ? chat.menuMachine : undefined), ['上一页', '下一页'].includes(command) ? chat.menuQuery : ''); return;
      }
      if (['选择', '切换'].includes(command)) {
        if (!argument) { await this.menu(user, 0, replyTo); return; }
        if (this.codex.machines && !chat.menuMachine && /^\d+$/.test(argument)) {
          const machine = chat.menu[Number(argument) - 1];
          if (!machine) throw new Error('请选择菜单中的机器编号。');
          await this.menu(user, 0, replyTo, machine); return;
        }
        await this.show(user, this.resolve(chat, argument), 'latest', replyTo, true); return;
      }
      if (['最新消息', '最新', '状态', '最后回答', '结果', '最近'].includes(command)) {
        await this.show(user, this.resolve(chat, argument), command === '最近' ? 'recent' : ['结果', '最后回答'].includes(command) ? 'answer' : 'latest', replyTo); return;
      }
      if (command === '订阅') {
        await this.subscriptionList(user, replyTo, Number(argument || 0)); return;
      }
      const id = this.resolve(chat, argument);
      if (command === '长期订阅') {
        const snapshot = await this.codex.snapshot(id);
        if (!chat.subscriptions[id]?.persistent) { this.baseline(chat, snapshot); chat.subscriptions[id]!.persistent = true; }
        this.reply(user, `已长期订阅：${label(snapshot.thread)}\n之后每轮结果都会推送，包括在电脑上交互产生的回复。`, replyTo, id, [{ label: '取消订阅', command: `/取消订阅 ${id}` }]); return;
      }
      if (command === '取消订阅') {
        delete chat.subscriptions[id];
        this.syncSubscriptions(user, chat);
        this.reply(user, '已取消该会话的消息订阅，当前选择不变。任务会继续运行。', replyTo, id,
          [{ label: '消息订阅', command: '/订阅' }, { label: '查看会话', command: `/最新 ${id}` }]); return;
      }
      if (command === '队列') { this.queueView(user, this.resolve(chat, argument), replyTo); return; }
      if (command === '清空队列') {
        await this.threadWork.run(id, async () => {
          if (this.stopping) return;
          this.clearInputs(user, id);
          this.reply(user, '已清除尚未发送及需要人工处理的队列记录。', replyTo, id);
        });
        return;
      }
      if (command === '停止') {
        await this.threadWork.run(id, async () => {
          if (this.stopping) return;
          const incoming = this.activeIncoming.get(user)!;
          if (!incoming.stopTarget) {
            this.clearInputs(user, id); this.store.save();
            let snapshot: Snapshot;
            try { snapshot = await this.codex.snapshot(id); }
            catch {
              this.reply(user, `已清除排队指令；${this.shortTarget(id)} 暂时无法连接，未能确认或中断正在运行的任务。`, replyTo, id);
              return;
            }
            if (this.stopping) return;
            const turn = snapshot.thread.status.type !== 'notLoaded' ? snapshot.turns.find(turn => turn.status === 'inProgress') : undefined;
            this.clearInputs(user, id);
            // Persist the exact turn before interruption; recovery must never stop a newer turn.
            incoming.stopTarget = { thread: id, turn: turn?.id };
            this.store.save();
          }
          const target = incoming.stopTarget;
          if (target.turn) await this.codex.interrupt(target.thread, target.turn);
          this.reply(user, target.turn ? '已请求中断，并取消该会话尚未发送的排队指令。' : '当前没有执行中的任务，排队指令已清除。', replyTo, target.thread);
        });
        return;
      }
    }
    if (!forced && text.startsWith('/')) { this.reply(user, '未知指令，请发送“帮助”查看当前命令。', replyTo); return; }
    if (!text) { this.reply(user, '第一版支持文字指令。发送“会话”打开菜单。', replyTo); return; }
    await this.submit(user, forced?.[1] ?? text, replyTo, reference);
  }
  private async submit(user: string, text: string, replyTo: string, reference?: string, selectedThread?: string) {
    const chat = this.store.chat(user);
    let id = selectedThread || chat.current;
    if (reference) {
      const target = this.store.state.refs[reference];
      if (!target || target.user !== user) {
        this.reply(user, '无法确定引用消息对应的会话，请通过“会话”菜单选择后发送。', replyTo); return;
      }
      id = target.thread;
    }
    if (!id) { await this.menu(user, 0, replyTo); return; }
    this.resetMenu(chat);
    const incoming = this.activeIncoming.get(user)!;
    const fileIds = this.files.pending(user, id)
      .filter(file => !this.store.state.inbox.some(entry => entry.id !== incoming.id && entry.fileIds?.includes(file.id)))
      .map(file => file.id);
    const input: QueuedInput = { id: randomUUID(), user, thread: id, text, state: 'queued', ...(fileIds.length ? { fileIds } : {}) };
    for (const fileId of fileIds) this.files.get(fileId)!.claimedBy = input.id;
    // Input acceptance and event deduplication share one durable write, before any RPC.
    this.store.state.inputs.push(input);
    const subscription = chat.subscriptions[id] ??= { persistent: false, replies: [], seen: [] };
    (subscription.replies ??= []).push({ inputId: input.id });
    this.store.completeIncoming(incoming.id);
    this.store.save();
    const sent = await this.dispatch(input);
    const outcome = sent ? '已发送，已订阅本轮回复' : input.state === 'queued' ? '已排队：' + (input.waitReason || '等待发送') + '；发送后推送对应回复' : input.state === 'rejected' ? '提交被拒绝，请查看队列' : '发送结果待确认，请查看本机会话；Bot 不会自动重复提交';
    this.reply(user, `${outcome} → ${input.threadLabel || this.shortTarget(id)}${input.error ? "\n原因：" + input.error : ""}`, replyTo, id);
  }
  private queueFile(user: string, id: string, replyTo: string) {
    const file = this.files.get(id)!;
    this.files.request(file);
    if (!this.store.state.outbox.some(entry => entry.user === user && entry.fileId === id)) {
      this.enqueue({ kind: 'reply', user, thread: file.thread, fileId: id, text: file.name });
    }
    this.reply(user, `已加入文件发送队列：${file.name}${file.status === 'ready' ? '' : '\n正在获取；机器离线时等待恢复。'}`, replyTo, file.thread);
    void this.files.tick().catch(error => log('文件传输失败', error));
  }
  private shortTarget(id: string) { return id.includes(':') ? `${machineOf(id)} · ${id.split(':')[1]!.slice(0, 8)}` : id.slice(0, 8); }
  private clearInputs(user: string, thread: string) {
    const removed = this.store.state.inputs.filter(input => input.thread === thread && input.user === user).map(input => input.id);
    const subscription = this.store.chat(user).subscriptions[thread];
    if (subscription?.replies) subscription.replies = subscription.replies.filter(r => r.turnId || !removed.includes(r.inputId));
    this.store.state.inputs = this.store.state.inputs.filter(input => input.thread !== thread || input.user !== user);
  }

  private dispatch(input: QueuedInput): Promise<boolean> {
    return this.threadWork.run(input.thread, async () => {
      if (this.stopping || input.state !== 'queued' || !this.store.state.inputs.includes(input)) return false;
      if (this.store.state.inputs.find(other => other.thread === input.thread) !== input) { input.waitReason = '前面还有待发或待确认指令'; this.store.save(); return false; }
      let preparedFiles: PreparedFile[] = [];
      try {
        const fresh = await this.codex.snapshot(input.thread);
        if (this.stopping) return false;
        input.threadLabel = label(fresh.thread);
        delete input.waitReason; delete input.error;
        if (!canDispatch(fresh)) { input.waitReason = `${status(fresh)}，会话可用后发送`; this.store.save(); return false; }
        preparedFiles = await this.files.prepare(input.fileIds || [], fresh.thread.cwd);
        await this.codex.prepare(input.thread);
      } catch (error) {
        // No turn/start has been attempted; a transient read/resume failure is retryable.
        if (error instanceof FileError && error.permanent) {
          input.state = 'rejected';
          const subscription = this.store.chat(input.user).subscriptions[input.thread];
          if (subscription?.replies) subscription.replies = subscription.replies.filter(r => r.inputId !== input.id);
        }
        input.waitReason = error instanceof FileError ? '等待附件准备完成' : '等待连接恢复';
        input.error = errorText(error); this.store.save();
        log('准备 Codex 会话失败，保留排队指令', error); return false;
      }
      if (this.stopping) return false;
      input.state = 'sending'; delete input.error; this.store.save();
      try {
        const turn = await this.codex.send(input.thread, input.text, input.id, preparedFiles);
        const reply = this.store.chat(input.user).subscriptions[input.thread]?.replies?.find(r => r.inputId === input.id);
        if (reply) reply.turnId = turn.id;
        this.store.state.inputs = this.store.state.inputs.filter(other => other.id !== input.id);
        this.store.save(); return true;
      } catch (error) {
        const outcome = error instanceof SubmissionError ? error.outcome : 'uncertain';
        input.state = outcome === 'retryable' ? 'queued' : outcome;
        if (outcome === 'rejected') {
          const subscription = this.store.chat(input.user).subscriptions[input.thread];
          if (subscription?.replies) subscription.replies = subscription.replies.filter(r => r.inputId !== input.id);
        }
        input.error = errorText(error);
        this.store.save(); log('提交 Codex 指令失败', error);
        return false;
      }
    });
  }
  tick(): Promise<void> {
    if (this.stopping) return Promise.resolve();
    const machines = this.codex.machines || ['single'];
    const jobs = machines.map(machine => {
      const running = this.polling.get(machine);
      if (running) return running;
      const job = this.poll(machine);
      this.polling.set(machine, job);
      void job.finally(() => { if (this.polling.get(machine) === job) this.polling.delete(machine); }).catch(() => {});
      return job;
    });
    return Promise.allSettled(jobs).then(results => {
      const failure = results.find(result => result.status === 'rejected');
      if (failure?.status === 'rejected') throw failure.reason;
    });
  }
  private async poll(machine: string) {
    const ids = new Set<string>();
    for (const chat of Object.values(this.store.state.chats)) {
      for (const id of Object.keys(chat.subscriptions)) if (this.isSubscribed(chat, id)) ids.add(id);
    }
    for (const input of this.store.state.inputs) if (input.state === 'queued') ids.add(input.thread);
    const targets = [...ids].filter(id => !this.codex.machines || machineOf(id) === machine);
    await forEachConcurrent(targets, 4, async id => {
      if (this.stopping) return;
      let snapshot: Snapshot;
      try { snapshot = await this.codex.snapshot(id); }
      catch (error) { if (!this.stopping) log(`读取会话 ${id.slice(0, 8)} 失败`, error); return; }
      if (this.stopping) return;
      for (const [user, chat] of Object.entries(this.store.state.chats)) {
        if (!this.isSubscribed(chat, id)) continue;
        const subscription = chat.subscriptions[id];
        if (!subscription) { this.baseline(chat, snapshot); continue; }
        for (const reply of subscription.replies || []) if (!reply.turnId) {
          const turn = snapshot.turns.find(t => t.items.some(item => item.type === 'userMessage' && item.id === reply.inputId));
          if (turn) reply.turnId = turn.id;
        }
        for (const turn of [...snapshot.turns].reverse()) {
          if (!chat.subscriptions[id]?.persistent && !subscription.replies?.some(r => r.turnId === turn.id)) continue;
          if (!terminal(turn)) continue;
          if (!canReportTurn(snapshot, turn)) {
            const key = id + '/' + turn.id;
            if (!this.emptyTerminalLogged.has(key)) {
              log(`暂缓未确认的轮次通知 thread=${id} turn=${turn.id} status=${turn.status} threadStatus=${snapshot.thread.status.type} items=${turn.items.length} startedAt=${turn.startedAt ?? 'unknown'} completedAt=${turn.completedAt ?? 'unknown'}`);
              this.emptyTerminalLogged.add(key);
              if (this.emptyTerminalLogged.size > 200) this.emptyTerminalLogged.delete(this.emptyTerminalLogged.values().next().value!);
            }
            continue;
          }
          this.emptyTerminalLogged.delete(id + '/' + turn.id);
          const statuses = subscription.terminalStatuses ??= {};
          if (subscription.seen.includes(turn.id) && (!statuses[turn.id] || statuses[turn.id] === turn.status)) {
            // Upgrade legacy ID-only deduplication without replaying old history.
            statuses[turn.id] = turn.status; continue;
          }
          // Replace an obsolete queued outcome, including one awaiting a retry.
          this.store.state.outbox = this.store.state.outbox.filter(entry => entry.kind !== 'notification' || entry.user !== user || entry.thread !== id || entry.turn !== turn.id);
          const files = this.files.candidates(user, snapshot, [turn]);
          const suffix = files.length ? '\n\n**相关文件**\n' + files.map(file => '- ' + this.files.describe(file)).join('\n') : '';
          this.enqueue({ kind: 'notification', user, thread: id, text: completion(snapshot, turn) + suffix, turn: turn.id, buttons: [...this.files.buttons(files), ...controls(id)] });
          subscription.seen = [...new Set([...subscription.seen, turn.id])].slice(-100);
          statuses[turn.id] = turn.status;
          subscription.terminalStatuses = Object.fromEntries(Object.entries(statuses).filter(([turnId]) => subscription.seen.includes(turnId)));
          log(`排入轮次通知 thread=${id} turn=${turn.id} status=${turn.status} items=${turn.items.length} startedAt=${turn.startedAt ?? 'unknown'} completedAt=${turn.completedAt ?? 'unknown'}`);
        }
        const attention = sessionStatus(snapshot);
        const attentionKey = snapshot.pendingAction ? `${attention}:${snapshot.pendingAction.id}` : attention;
        if ((!!chat.subscriptions[id]?.persistent || snapshot.turns.some(t => t.status === 'inProgress' && subscription.replies?.some(r => r.turnId === t.id))) && ['approval', 'input'].includes(attention) && subscription.attention !== attentionKey) {
          this.enqueue({ kind: 'notification', user, thread: id, text: `[${label(snapshot.thread)}]\n${status(snapshot)}\n\n${snapshot.pendingAction?.text || '可在该会话所属机器的 Codex 中处理。\n\n' + latest(snapshot)}`, buttons: [...this.actionButtons(snapshot), ...controls(id)] });
        }
        subscription.attention = attentionKey;
      }
      this.store.save();
      const next = this.store.state.inputs.find(input => input.thread === id);
      if (next?.state === 'queued' && canDispatch(snapshot)) await this.dispatch(next);
    });
  }
  private enqueue(message: Omit<Outgoing, 'id' | 'parts' | 'part' | 'attempts' | 'retryAt'>) {
    if (message.turn && this.store.state.outbox.some(entry => entry.user === message.user && entry.thread === message.thread && entry.turn === message.turn)) return;
    this.store.state.outbox.push({ ...message, id: randomUUID(), parts: splitText(message.text), part: 0, attempts: 0, retryAt: 0 });
  }
  deliver(): Promise<void> {
    if (this.stopping) return Promise.resolve();
    if (this.delivery) return this.delivery;
    const job = this.deliverPending();
    this.delivery = job;
    void job.finally(() => { if (this.delivery === job) this.delivery = undefined; }).catch(() => {});
    return job;
  }
  private async deliverPending() {
    for (const entry of [...this.store.state.outbox]) {
      if (this.stopping) return;
      if (!this.store.state.outbox.includes(entry)) continue;
      if (entry.kind === 'notification' && !this.isSubscribed(this.store.chat(entry.user), entry.thread!)) {
        this.removeOutgoing(entry); this.store.save(); continue;
      }
      if (entry.retryAt > Date.now()) continue;
      try {
        if (entry.fileId) {
          const file = this.files.get(entry.fileId);
          if (!file || file.status === 'failed') {
            entry.text = `文件发送失败：${file?.name || entry.fileId}\n${file?.error || '文件记录不存在'}`;
            entry.parts = splitText(entry.text); delete entry.fileId; this.store.save();
          } else {
            if (file.status !== 'ready') throw new Error(`等待文件缓存：${file.name}`);
            if (!this.sender.sendFile) throw new Error('发送器不支持附件');
            const ids = await this.sender.sendFile(entry.user, file, upload => { file.upload = upload; this.store.save(); });
            this.store.remember(entry.user, ids, entry.thread, false);
            this.removeOutgoing(entry); this.store.save(); continue;
          }
        }
        while (entry.part < entry.parts.length) {
          if (this.stopping) return;
          if (!this.store.state.outbox.includes(entry)) break;
          const ids = await this.sender.send(entry.user, entry.parts[entry.part]!, {
            replyTo: entry.part < 4 ? entry.replyTo : undefined,
            thread: entry.thread,
            buttons: entry.part === entry.parts.length - 1 ? entry.buttons : undefined,
          });
          // Save routing and progress together after every confirmed segment.
          this.store.remember(entry.user, ids, entry.thread, false);
          entry.part++; entry.attempts = 0; this.store.save();
        }
        if (entry.part === entry.parts.length && entry.acknowledge?.length && entry.thread) {
          const subscription = this.store.chat(entry.user).subscriptions[entry.thread];
          if (subscription) {
            subscription.seen = [...new Set([...subscription.seen, ...entry.acknowledge])].slice(-100);
            const statuses = subscription.terminalStatuses ??= {};
            for (const turnId of entry.acknowledge) statuses[turnId] = 'completed';
            subscription.terminalStatuses = Object.fromEntries(Object.entries(statuses).filter(([turnId]) => subscription.seen.includes(turnId)));
          }
          this.store.state.outbox = this.store.state.outbox.filter(other => other.kind !== 'notification' || other.user !== entry.user || other.thread !== entry.thread || !other.turn || !entry.acknowledge!.includes(other.turn));
        }
        if (entry.part === entry.parts.length && entry.thread) {
          const subscription = this.store.chat(entry.user).subscriptions[entry.thread];
          const delivered = [...entry.acknowledge || [], ...(entry.turn ? [entry.turn] : [])];
          if (subscription?.replies) subscription.replies = subscription.replies.filter(r => !r.turnId || !delivered.includes(r.turnId));
        }
        this.removeOutgoing(entry); this.store.save();
      } catch (error) {
        const httpStatus = (error as { httpStatus?: number }).httpStatus;
        if (entry.fileId && httpStatus && httpStatus >= 400 && httpStatus < 500 && ![408, 429].includes(httpStatus)) {
          const file = this.files.get(entry.fileId);
          if (file) delete file.upload;
          entry.text = `QQ 拒绝文件发送：${entry.text}\n${errorText(error)}\n请检查文件格式或 Bot 的文件消息权限。`;
          entry.parts = splitText(entry.text); entry.part = 0; delete entry.fileId;
        }
        entry.attempts++;
        entry.retryAt = Date.now() + Math.min(300000, 5000 * 2 ** Math.min(entry.attempts, 6));
        this.store.save();
        if (!this.stopping) log('QQ 消息投递失败，将重试', error);
      }
    }
  }
  private removeOutgoing(entry: Outgoing) {
    this.store.state.outbox = this.store.state.outbox.filter(current => current.id !== entry.id);
  }
}
