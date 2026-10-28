import { cpSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// Explicit allowlist: runtime state, credentials, logs and backups never enter the export.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const target = resolve(root, process.argv[2] || 'release/qqbot-source');
if (existsSync(target)) throw new Error('Export destination already exists; choose a new empty destination.');
mkdirSync(target, { recursive: true });
for (const name of ['package.json', 'package-lock.json', 'tsconfig.json', 'tsconfig.build.json', '.gitignore', '.gitattributes', '.env.example', 'README.md', 'SECURITY.md', 'LICENSE']) {
  cpSync(join(root, name), join(target, name));
}
for (const directory of ['src', 'test', 'scripts', 'docs', '.github/workflows']) {
  mkdirSync(join(target, directory), { recursive: true });
  for (const entry of readdirSync(join(root, directory), { withFileTypes: true })) {
    if (entry.isFile() && /\.(ts|mjs|ps1|sh|yml|md)$/.test(entry.name)) cpSync(join(root, directory, entry.name), join(target, directory, entry.name));
  }
}
mkdirSync(join(target, 'docs/images'), { recursive: true });
for (const name of ['qq-menu.jpg', 'qq-markdown.jpg']) cpSync(join(root, 'docs/images', name), join(target, 'docs/images', name));
console.log(target);
