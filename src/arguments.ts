export function argumentsFor(args: string[], flags: string[], values: string[]) {
  const options: Record<string, string | boolean> = {}, positional: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (flags.includes(arg)) options[arg] = true;
    else if (values.includes(arg)) {
      const value = args[++i];
      if (!value || value.startsWith('--')) throw new Error(`${arg} 需要值`);
      options[arg] = value;
    } else if (arg.startsWith('-')) throw new Error(`未知参数 ${arg}`);
    else positional.push(arg);
  }
  return { options, positional };
}
