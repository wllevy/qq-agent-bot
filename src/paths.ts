import { isAbsolute, join, resolve } from 'node:path';

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
