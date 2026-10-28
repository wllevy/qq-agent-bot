import { mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { execFileSync } from 'node:child_process';

const directory = resolve('.');
const unitDir = join(homedir(), '.config/systemd/user');
mkdirSync(unitDir, { recursive: true });
const quote = (value: string) => '"' + value.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('%', '%%') + '"';
const unit = `[Unit]
Description=QQ Codex private chat console
After=network-online.target

[Service]
Type=simple
WorkingDirectory=${directory.replaceAll('%', '%%')}
ExecStart=${quote(process.execPath)} dist/src/main.js
Environment="PATH=${dirname(process.execPath)}:${homedir()}/.local/bin:/usr/local/bin:/usr/bin:/bin"
UMask=0077
Restart=on-failure
RestartSec=10
TimeoutStopSec=45

[Install]
WantedBy=default.target
`;
writeFileSync(join(unitDir, 'qq-codex-console.service'), unit);
execFileSync('systemctl', ['--user', 'daemon-reload']);
if (process.argv.includes('--enable')) execFileSync('systemctl', ['--user', 'enable', 'qq-codex-console.service']);
execFileSync('systemctl', ['--user', 'restart', 'qq-codex-console.service']);
console.log('已启动用户服务 qq-codex-console' + (process.argv.includes('--enable') ? '（已设置开机自启）' : '（未设置开机自启）'));
