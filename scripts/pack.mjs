import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

mkdirSync('release', { recursive: true });
const npm = process.env.npm_execpath;
if (!npm) throw new Error('Run npm run package:release');
const result = spawnSync(process.execPath, [npm, 'pack', '--json', '--pack-destination', 'release'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });
if (result.status !== 0) process.exit(result.status || 1);
const [pkg] = JSON.parse(result.stdout);
// Report the deliverable and contents; package-manager metadata stays internal.
console.log(`${resolve('release', pkg.filename)} (${pkg.files.length} files)`);
