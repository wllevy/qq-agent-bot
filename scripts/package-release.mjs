import { cpSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const destination = resolve(process.argv[2] || join(root, 'release/package'));
if (existsSync(destination)) throw new Error('Release destination already exists; select a new directory');
if (!existsSync(join(root, 'dist/src/cli.js'))) throw new Error('Run npm run build first');
mkdirSync(destination, { recursive: true });
for (const name of ['package.json', 'package-lock.json', '.env.example', 'README.md', 'SECURITY.md', 'LICENSE']) cpSync(join(root, name), join(destination, name));
// Only emitted JavaScript is distributable; never copy arbitrary local dist files.
for (const directory of ['src', 'scripts']) {
  mkdirSync(join(destination, 'dist', directory), { recursive: true });
  for (const entry of readdirSync(join(root, 'dist', directory), { withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith('.js')) cpSync(join(root, 'dist', directory, entry.name), join(destination, 'dist', directory, entry.name));
  }
}
mkdirSync(join(destination, 'scripts'));
for (const name of ['windows-service.ps1', 'supervisor.mjs', 'launcher.mjs', 'launcher.ps1', 'install.ps1']) cpSync(join(root, 'scripts', name), join(destination, 'scripts', name));
mkdirSync(join(destination, 'docs/images'), { recursive: true });
for (const name of ['agent-install.md', 'usage.md', 'development.md', 'images/qq-menu.jpg', 'images/qq-markdown.jpg']) cpSync(join(root, 'docs', name), join(destination, 'docs', name));
console.log(destination);
