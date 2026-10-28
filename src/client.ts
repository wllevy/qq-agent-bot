import { Codex } from './codex.js';
import { LocalCodex, codexExecutable } from './local-codex.js';
import { ClaudeBackend } from './claude.js';
import { resolve } from 'node:path';
import { homedir } from 'node:os';
import type { CodexPort } from './types.js';

export function createCodex(endpoint: string): Codex {
  return endpoint === 'desktop' ? new LocalCodex() : endpoint === 'stdio' ? new LocalCodex(codexExecutable(), false) : new Codex(endpoint);
}
export function createBackend(endpoint: string, dataDir: string, recover = false): CodexPort {
  return endpoint === 'claude' ? new ClaudeBackend(dataDir, process.env.CLAUDE_DEFAULT_CWD || (process.env.QQ_AGENT_HOME ? homedir() : resolve('..')), undefined, recover) : createCodex(endpoint);
}
