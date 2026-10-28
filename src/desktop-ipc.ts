import { connect, type Socket } from 'node:net';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';

export class DesktopError extends Error {
  constructor(message: string, public uncertain = false) { super(message); }
}

// Desktop IPC uses length-prefixed JSON on the current user's named pipe.
// Isolate this versioned desktop protocol from the app-server protocol.
export class DesktopIPC extends EventEmitter {
  private socket?: Socket;
  private opening?: Promise<void>;
  private closed = false;
  private client = 'initializing-client';
  private pending = new Map<string, { resolve: (v: any) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  constructor(private endpoint = '\\\\.\\pipe\\codex-ipc') { super(); }
  async connect() {
    if (this.closed) throw new DesktopError('桌面连接已关闭');
    if (this.opening) return this.opening;
    if (this.socket && !this.socket.destroyed && this.client !== 'initializing-client') return;
    this.opening = this.open().finally(() => { this.opening = undefined; });
    return this.opening;
  }
  private async open() {
    const socket = connect(this.endpoint);
    this.socket = socket;
    let buffer = Buffer.alloc(0);
    socket.on('data', chunk => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 4) {
        const length = buffer.readUInt32LE(0);
        if (!length || length > 268435456) { socket.destroy(new Error('无效的桌面 IPC 数据帧')); return; }
        if (buffer.length < length + 4) return;
        let message: any;
        try { message = JSON.parse(buffer.subarray(4, length + 4).toString()); }
        catch { socket.destroy(new Error('无效的桌面 IPC JSON')); return; }
        buffer = buffer.subarray(length + 4);
        if (message.type === 'response') {
          const request = this.pending.get(message.requestId);
          if (!request) continue;
          clearTimeout(request.timer); this.pending.delete(message.requestId);
          if (message.resultType === 'success') request.resolve(message);
          else request.reject(new DesktopError(message.error || '桌面请求失败', !['no-client-found', 'request-version-mismatch', 'no-handler-for-request'].includes(message.error)));
        } else if (message.type === 'client-discovery-request') {
          this.write({ type: 'client-discovery-response', requestId: message.requestId, response: { canHandle: false } });
        } else if (message.type === 'broadcast') this.emit('broadcast', message);
      }
    });
    socket.on('error', () => {});
    socket.on('close', () => {
      if (this.socket !== socket) return;
      this.client = 'initializing-client';
      for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new DesktopError('Codex 桌面连接中断，操作结果未知', true)); }
      this.pending.clear();
    });
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { socket.destroy(); reject(new DesktopError('连接 Codex 桌面端超时')); }, 5000);
      socket.once('connect', () => { clearTimeout(timer); resolve(); });
      socket.once('error', () => { clearTimeout(timer); reject(new DesktopError('请先打开本机 Codex 桌面应用')); });
    });
    const response = await this.call('initialize', { clientType: 'qqbot' }, 0);
    this.client = response.result.clientId;
  }
  private write(message: unknown) {
    if (!this.socket || this.socket.destroyed) throw new DesktopError('Codex 桌面端未连接');
    const body = Buffer.from(JSON.stringify(message)), header = Buffer.alloc(4);
    header.writeUInt32LE(body.length);
    this.socket.write(Buffer.concat([header, body]));
  }
  private call(method: string, params: unknown, version: number, targetClientId?: string, timeout = 20000): Promise<any> {
    const requestId = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(requestId); reject(new DesktopError(`${method} 超时，操作结果未知`, true)); }, timeout);
      this.pending.set(requestId, { resolve, reject, timer });
      try { this.write({ type: 'request', requestId, sourceClientId: this.client, method, params, version, targetClientId, timeoutMs: timeout }); }
      catch (error) { clearTimeout(timer); this.pending.delete(requestId); reject(error); }
    });
  }
  async owner(id: string): Promise<string | undefined> {
    await this.connect();
    try {
      return (await this.call('thread-owner-discovery', { conversationId: id, hostId: 'local' }, 1, undefined, 5000)).handledByClientId;
    } catch (error) {
      if (error instanceof DesktopError && error.message === 'no-client-found') return undefined;
      throw error;
    }
  }
  async request(owner: string, method: string, params: unknown, version: number) {
    await this.connect();
    return (await this.call(method, params, version, owner)).result;
  }
  async snapshot(id: string, owner: string): Promise<any> {
    await this.connect();
    return new Promise((resolve, reject) => {
      const follow = (following: boolean) => this.write({ type: 'broadcast', method: 'thread-stream-following-changed', sourceClientId: this.client, version: 1, targetClientIds: [owner], params: { conversationId: id, hostId: 'local', following } });
      const cleanup = () => { clearTimeout(timer); this.off('broadcast', onMessage); try { follow(false); } catch {} };
      const onMessage = (m: any) => {
        if (m.sourceClientId !== owner || m.method !== 'thread-stream-state-changed' || m.params?.conversationId !== id || m.params?.hostId !== 'local' || m.params.change?.type !== 'snapshot') return;
        cleanup(); resolve(m.params.change.conversationState);
      };
      const timer = setTimeout(() => { cleanup(); reject(new DesktopError('读取桌面会话实时状态超时')); }, 5000);
      this.on('broadcast', onMessage);
      try { follow(true); } catch (error) { cleanup(); reject(error); }
    });
  }
  close() { this.closed = true; this.socket?.destroy(); }
}
