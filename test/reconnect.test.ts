import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Socket } from 'node:net';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DesktopIPC, DesktopError } from '../src/desktop-ipc.js';
import { StdioRPC } from '../src/stdio-rpc.js';
import { RpcError } from '../src/codex.js';

test('同一桌面客户端从未启动、握手失败、超时和桌面重开中恢复，不重发未知提交', async t => {
  const endpoint = process.platform === 'win32' ? `\\\\.\\pipe\\qqbot-reconnect-${randomUUID()}` : join(tmpdir(), `qqbot-${randomUUID()}.sock`);
  const client = new DesktopIPC(endpoint, 150);
  await assert.rejects(client.owner('t'));
  let initialized = 0, submitted = 0, hangInitialize = true;
  const sockets = new Set<Socket>();
  const server = createServer(socket => {
    sockets.add(socket); socket.on('close', () => sockets.delete(socket)); socket.on('error', () => {});
    let buffer = Buffer.alloc(0);
    socket.on('data', data => {
      buffer = Buffer.concat([buffer, data]);
      while (buffer.length >= 4 && buffer.length >= buffer.readUInt32LE(0) + 4) {
        const size = buffer.readUInt32LE(0), m = JSON.parse(buffer.subarray(4, size + 4).toString()); buffer = buffer.subarray(size + 4);
        if (m.method === 'initialize') { initialized++; if (hangInitialize) continue; }
        if (m.method === 'thread-follower-start-turn') { submitted++; continue; }
        const body = Buffer.from(JSON.stringify({ type: 'response', requestId: m.requestId, resultType: 'success', handledByClientId: 'desktop-' + initialized, result: { clientId: 'bot-' + initialized } }));
        const head = Buffer.alloc(4); head.writeUInt32LE(body.length); socket.write(Buffer.concat([head, body]));
      }
    });
  });
  t.after(async () => { client.close(); for (const socket of sockets) socket.destroy(); await new Promise<void>(resolve => server.close(() => resolve())); });
  await new Promise<void>(resolve => server.listen(endpoint, resolve));
  await assert.rejects(client.owner('t'), /initialize 超时/);
  hangInitialize = false;
  const owners = await Promise.all([client.owner('t'), client.owner('t')]);
  assert.equal(initialized, 2); assert.deepEqual(owners, ['desktop-2', 'desktop-2']);
  await assert.rejects(client.request(owners[0]!, 'thread-follower-start-turn', {}, 2), e => e instanceof DesktopError && e.uncertain);
  assert.equal(await client.owner('t'), 'desktop-3');
  assert.equal(submitted, 1);
  for (const socket of sockets) socket.destroy();
  await new Promise<void>(resolve => server.close(() => resolve()));
  await assert.rejects(client.owner('t'));
  await new Promise<void>(resolve => server.listen(endpoint, resolve));
  assert.equal(await client.owner('t'), 'desktop-4');
  client.close(); await assert.rejects(client.owner('t'), /已关闭/);
});

test('app-server 重启重查可执行文件，失效进程和迟到事件不能卡死新连接或重复提交', async t => {
  const root = mkdtempSync(join(tmpdir(), 'qqbot-stdio-reconnect-')), script = join(root, 'server.mjs'), log = join(root, 'requests.txt');
  writeFileSync(script, `import {createInterface} from 'node:readline'; import {appendFileSync} from 'node:fs';
const log=process.argv[2]; createInterface({input:process.stdin}).on('line', line=>{
 const m=JSON.parse(line); if(m.id===undefined)return;
 appendFileSync(log,m.method+'\\n');
 if(m.method==='turn/start')return;
 if(m.method==='exit'){process.exit(0);return;}
 console.log(JSON.stringify({id:m.id,result:{pid:process.pid}}));
});`);
  let executable = join(root, 'missing-node'), resolutions = 0;
  const rpc = new StdioRPC(() => { resolutions++; return executable; }, [script, log]);
  t.after(() => rpc.close());
  await assert.rejects(rpc.connect());
  executable = process.execPath;
  await Promise.all([rpc.connect(), rpc.connect()]);
  assert.equal(resolutions, 2);
  const before = await rpc.call<{ pid: number }>('thread/list', {});
  await assert.rejects(rpc.call('turn/start', {}, 100), e => e instanceof RpcError && e.uncertain);
  await rpc.connect();
  const after = await rpc.call<{ pid: number }>('thread/list', {});
  assert.notEqual(after.pid, before.pid);
  assert.equal(readFileSync(log, 'utf8').split('\n').filter(s => s === 'turn/start').length, 1);
  await assert.rejects(rpc.call('exit', {}), e => e instanceof RpcError && e.uncertain);
  await rpc.connect();
  assert.notEqual((await rpc.call<{ pid: number }>('thread/list', {})).pid, after.pid);
  const pending = rpc.call('turn/start', {});
  const rejected = assert.rejects(pending, e => e instanceof RpcError && e.uncertain);
  rpc.close(); await rejected;
  await assert.rejects(rpc.connect(), /已关闭/);
});
