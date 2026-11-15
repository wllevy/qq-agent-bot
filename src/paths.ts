import { isAbsolute, join, resolve } from 'node:path';
import { homedir } from 'node:os';

export function defaultHome(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform) {
  const user = homedir();
  return platform === 'win32' ? join(env.LOCALAPPDATA || join(user, 'AppData', 'Local'), 'QQAgentBot')
    : platform === 'darwin' ? join(user, 'Library', 'Application Support', 'QQAgentBot')
    : join(env.XDG_DATA_HOME || join(user, '.local', 'share'), 'qq-agent-bot');
}

export function runtimePaths(env: NodeJS.ProcessEnv = process.env, cwd = process.cwd()) {
  if (env.QQ_AGENT_HOME && !isAbsolute(env.QQ_AGENT_HOME)) throw new Error('QQ_AGENT_HOME 必须是绝对路径');
  const home = env.QQ_AGENT_HOME ? resolve(env.QQ_AGENT_HOME) : undefined;
  const base = home || cwd, configDir = home ? join(home, 'config') : cwd;
  return {
    home, configDir, configFile: join(configDir, '.env'),
    dataDir: resolve(base, env.BOT_DATA_DIR || 'data'),
    machinesFile: resolve(configDir, env.BOT_MACHINES_FILE || 'machines.json'),
  };
}
