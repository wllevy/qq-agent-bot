import { createRequire } from 'node:module';

export function claudeExecutable() {
  if (process.env.CLAUDE_EXECUTABLE) return process.env.CLAUDE_EXECUTABLE;
  const suffix = process.platform === 'linux' && !(process.report.getReport() as { header?: { glibcVersionRuntime?: string } }).header?.glibcVersionRuntime ? '-musl' : '';
  return createRequire(import.meta.url).resolve(`@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}${suffix}/${process.platform === 'win32' ? 'claude.exe' : 'claude'}`);
}
