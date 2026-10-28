/**
 * The command line's argument reader, apart from cli.ts so it can be imported without running the CLI.
 */

/**
 * Words that do not start with `--` are positional. A flag is `--name value` or `--name=value` (the value may itself contain `=`; `--name=` is an empty one);
 * a flag with no value after it, or followed by another flag, reads as `'true'`. A flag given more than once keeps every value, in order.
 */
export function parseArgs(argv: string[]): { positional: string[]; flags: Record<string, string[]> } {
  const positional: string[] = [];
  const flags: Record<string, string[]> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq > 2) {
        (flags[a.slice(2, eq)] ??= []).push(a.slice(eq + 1));
        continue;
      }
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        (flags[key] ??= []).push(next);
        i++;
      } else (flags[key] ??= []).push('true');
    } else positional.push(a);
  }
  return { positional, flags };
}
