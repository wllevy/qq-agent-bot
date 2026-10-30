import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import { EventEmitter } from 'node:events';
import { RpcError } from './codex.js';

export class StdioRPC extends EventEmitter {
  private child?: ChildProcessWithoutNullStreams;
  private opening?: Promise<void>;
  private closed = false;
  private sequence = 0;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  constructor(private executable: string | (() => string), private args = ['app-server']) { super(); }
  async connect() {
    if (this.closed) throw new RpcError('本地 app-server 已关闭');
    if (this.opening) return this.opening;
    if (this.child) return;
    this.opening = this.open().finally(() => { this.opening = undefined; });
    return this.opening;
  }
  private async open() {
    const child = spawn(typeof this.executable === 'function' ? this.executable() : this.executable, this.args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    this.child = child;
    child.stderr.on('data', () => {});
    const fail = () => this.reset(child, new RpcError('本地 app-server 连接中断，操作结果未知', undefined, true));
    child.stdin.on('error', fail);
    child.on('error', fail); child.on('exit', fail);
    createInterface({ input: child.stdout }).on('line', line => {
      if (this.child !== child) return;
      let m: any; try { m = JSON.parse(line); } catch { return; }
      if (m.method) { this.emit(m.id === undefined ? 'notification' : 'serverRequest', m); return; }
      const p = this.pending.get(m.id); if (!p) return;
      clearTimeout(p.timer); this.pending.delete(m.id);
      if (m.error) p.reject(new RpcError(m.error.message, m.error.code)); else p.resolve(m.result);
    });
    try {
      await this.call('initialize', { clientInfo: { name: 'qq_codex_console', title: 'QQ Codex Console', version: '0.2.0' }, capabilities: { experimentalApi: true } }, 15000);
      child.stdin.write(JSON.stringify({ method: 'initialized', params: {} }) + '\n');
    } catch (error) { child.kill(); fail(); throw error; }
  }
  call<T = any>(method: string, params: unknown, timeout = 20000): Promise<T> {
    if (!this.child || this.closed) return Promise.reject(new RpcError('本地 app-server 未连接'));
    const child = this.child;
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.reset(child, new RpcError(`${method} 超时，操作结果未知`, undefined, true)), timeout);
      this.pending.set(id, { resolve, reject, timer });
      child.stdin.write(JSON.stringify({ id, method, params }) + '\n', error => {
        if (error) this.reset(child, new RpcError(error.message, undefined, true));
      });
    });
  }
  private reset(child: ChildProcessWithoutNullStreams, error: Error) {
    if (this.child !== child) return;
    this.child = undefined;
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(error); }
    this.pending.clear();
    child.kill();
  }
  close() { this.closed = true; if (this.child) this.reset(this.child, new RpcError('本地 app-server 已关闭，操作结果未知', undefined, true)); }
}
