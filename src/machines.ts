import { EventEmitter } from 'node:events';
import type { CodexPort, ModelSettings, PreparedFile, Snapshot, SnapshotOptions, Thread } from './types.js';

// Stable routing key, independent of where the QQ process is deployed.
export const sessionKey = (machine: string, thread: string) => `${machine}:${thread}`;
export const normalizeSessionKey = (thread: string) => thread.includes(':') ? thread : sessionKey('local', thread);
export const machineOf = (thread: string) => thread.includes(':') ? thread.slice(0, thread.indexOf(':')) : 'local';

export class MachineCodex extends EventEmitter implements CodexPort {
  readonly machines: string[];
  constructor(private clients: Record<string, CodexPort>) {
    super();
    this.machines = Object.keys(clients);
    for (const [machine, client] of Object.entries(clients)) {
      if (client instanceof EventEmitter) {
        for (const event of ['notification', 'serverRequest']) {
          client.on(event, message => this.emit(event, { ...message, machine }));
        }
      }
    }
  }
  qualify(id: string) { return normalizeSessionKey(id); }
  backendLabel(machine: string) { return machine === 'local' ? 'Codex' : machine === 'claude' ? 'Claude Code' : machine; }
  canCreate(machine: string) { return !!this.clients[machine]?.create; }
  async create(machine: string, cwd: string | undefined, requestId: string, sourceId?: string, settings?: ModelSettings) {
    const client = this.client(machine);
    if (!client.create) throw new Error('该后端暂不支持通过 QQ 新建会话');
    if (sourceId && machineOf(sourceId) !== machine) throw new Error('不能跨后端恢复会话');
    return this.decorate(machine, await client.create(machine, cwd, requestId, sourceId ? this.target(sourceId).id : undefined, settings));
  }
  async respond(id: string, actionId: string, answer: string) {
    const t = this.target(id);
    if (!t.client.respond) throw new Error('该后端请在本机应用处理确认或回答');
    await t.client.respond(t.id, actionId, answer);
  }
  private target(id: string) {
    const key = this.qualify(id), machine = machineOf(key);
    return { machine, id: key.slice(machine.length + 1), client: this.client(machine) };
  }
  private client(machine: string) {
    const client = this.clients[machine];
    if (!client) throw new Error(`没有配置机器 ${machine}，请重新打开“会话”。`);
    return client;
  }
  private decorate(machine: string, thread: Thread): Thread {
    return { ...thread, id: sessionKey(machine, thread.id), machine };
  }
  async list(machine?: string): Promise<Thread[]> {
    if (!machine) throw new Error('先选择机器。');
    try { return (await this.client(machine).list()).map(thread => this.decorate(machine, thread)); }
    catch { throw new Error(`${machine} 暂时无法读取会话，机器可能已关机、休眠或 Codex 未运行。可以返回选择其他机器，稍后再试。`); }
  }
  async snapshot(id: string, options?: SnapshotOptions): Promise<Snapshot> {
    const target = this.target(id);
    try {
      const snapshot = await target.client.snapshot(target.id, options);
      return { ...snapshot, thread: this.decorate(target.machine, snapshot.thread) };
    } catch (error) {
      throw new Error(`${target.machine} 会话暂时不可读：${error instanceof Error ? error.message : String(error)}`);
    }
  }
  async history(id: string, cursor?: string) { const t = this.target(id); return t.client.history ? t.client.history(t.id, cursor) : { turns: (await t.client.snapshot(t.id)).turns }; }
  async models(id: string) { const t = this.target(id); return t.client.models(t.id); }
  async updateSettings(id: string, settings: ModelSettings) {
    const t = this.target(id);
    return this.decorate(t.machine, await t.client.updateSettings(t.id, settings));
  }
  async prepare(id: string) { const t = this.target(id); await t.client.prepare(t.id); }
  async send(id: string, text: string, inputId: string, files?: PreparedFile[]) { const t = this.target(id); return t.client.send(t.id, text, inputId, files); }
  async readFile(id: string, path: string, maxBytes: number) {
    const t = this.target(id);
    if (!t.client.readFile) throw new Error('该机器不支持文件读取');
    return t.client.readFile(t.id, path, maxBytes);
  }
  async writeFile(id: string, path: string, data: Buffer) {
    const t = this.target(id);
    if (!t.client.writeFile) throw new Error('该机器不支持文件写入');
    return t.client.writeFile(t.id, path, data);
  }
  async interrupt(id: string, turn: string) { const t = this.target(id); await t.client.interrupt(t.id, turn); }
  async close() { await Promise.allSettled(Object.values(this.clients).map(client => client.close?.())); }
}
