#!/usr/bin/env node
import { defaultHome } from '../dist/src/paths.js';

if (Number(process.versions.node.split('.')[0]) < 24) {
  console.error('QQ Agent Bot requires Node.js 24 or newer.');
  process.exit(1);
}
process.env.QQ_AGENT_HOME ||= defaultHome();
await import('../dist/src/cli.js');
