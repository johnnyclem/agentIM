import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { parseCite, groundCite, type Cite } from '../src/grounding.js';
import type { RunOptions, RunResult, Runner } from '../src/runner.js';

const DIR = '/work/shop-app';
const OLD = '1a2b3c4' + 'd'.repeat(33);
const HEAD = '75c7b13' + 'e'.repeat(33);
const MB2 = 2 * 1024 * 1024;

// ---- a tiny repo behind a fake Runner -------------------------------------------------------------------------------

interface Entry {
  type: 'blob' | 'tree';
  content: string;
  /** What `cat-file -s` reports when it should differ from the content. */
  size?: number;
}
const blob = (content: string, size?: number): Entry => ({ type: 'blob', content, size });
const TREE: Entry = { type: 'tree', content: '' };
interface Commit {
  sha: string;
  files: Record<string, Entry>;
}

const SESSION = [
  'export function mintSession(online: boolean): string {', // 1
  '  if (!online) return queuedId();', // 2
  '  return crypto.randomUUID();', // 3
  '}', // 4
  '// offline uploads reuse the session id minted online', // 5
  'export function reuse(id: string) {', // 6
  '  return id;', // 7
  '}', // 8
].join('\n') + '\n';
const OLD_SESSION = ['export function mintSession(): string {', '  return crypto.randomUUID();', '}'].join('\n') + '\n';

const COMMITS: Commit[] = [
  { sha: OLD, files: { 'src/session.ts': blob(OLD_SESSION) } },
  {
    sha: HEAD,
    files: {
      'src/session.ts': blob(SESSION),
      'src/new.ts': blob('export const n = 1;\n'),
      src: TREE,
      'node_modules/@scope/pkg/index.js': blob('module.exports = {};\n'),
      'src/$(id);x.ts': blob('export const x = 1;\n'),
      'assets/logo.bin': blob('PNG\0\0data\n'),
      'docs/huge.log': blob('line\n', MB2 + 1),
      'docs/edge.log': blob('line\n', MB2),
    },
  },
];

type Hook = (args: string[]) => RunResult;

/** Where the checkout sits: `prefix` is its folder below the repo root ('' at the root, else ending in '/'), `top` the root. null: git cannot say. */
interface Layout {
  prefix: string;
  top: string;
}
const isLayoutCall = (args: string[]) => args[2] === 'rev-parse' && args[3] === '--show-prefix';

/**
 * Records every call. A hook is keyed by 'rev-parse', 'layout' (the `--show-prefix --show-toplevel` question), 'cat-file -t', 'cat-file -s' or 'show'; it may return a result or throw.
 * The checkout is at the repo root unless `h.layout` says otherwise; `subs()` leaves the layout question out, so the sequences below read as the work done on the cite.
 */
function harness(commits: Commit[] = COMMITS, head: string | null = HEAD) {
  const calls: Array<{ cmd: string; args: string[]; opts?: RunOptions }> = [];
  const hooks = new Map<string, Hook>();
  const state: { layout: Layout | null } = { layout: { prefix: '', top: DIR } };
  const ok = (stdout: string): RunResult => ({ code: 0, stdout, stderr: '' });
  const fail = (code: number, stderr = ''): RunResult => ({ code, stdout: '', stderr });
  const run: Runner = async (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    const [dashC, dir, sub, ...rest] = args;
    if (cmd !== 'git' || dashC !== '-C' || dir !== DIR) throw new Error(`unexpected invocation: ${cmd} ${args.join(' ')}`);
    const layoutCall = isLayoutCall(args);
    const hooked = hooks.get(layoutCall ? 'layout' : sub === 'cat-file' ? `cat-file ${rest[0]}` : sub);
    if (hooked) return hooked(rest);
    if (layoutCall) {
      if (rest.length !== 2 || rest[1] !== '--show-toplevel') throw new Error(`unexpected rev-parse: ${rest.join(' ')}`);
      return state.layout === null ? fail(128, 'fatal: this operation must be run in a work tree') : ok(`${state.layout.prefix}\n${state.layout.top}\n`);
    }
    if (sub === 'rev-parse') {
      if (rest.length !== 3 || rest[0] !== '--verify' || rest[1] !== '--quiet' || !rest[2].endsWith('^{commit}')) throw new Error(`unexpected rev-parse: ${rest.join(' ')}`);
      const name = rest[2].slice(0, -'^{commit}'.length);
      const hits = name === 'HEAD' ? commits.filter((c) => c.sha === head) : commits.filter((c) => c.sha.startsWith(name));
      return hits.length === 1 ? ok(`${hits[0].sha}\n`) : fail(1);
    }
    const isCat = sub === 'cat-file' && (rest[0] === '-t' || rest[0] === '-s') && rest.length === 2;
    if (!isCat && !(sub === 'show' && rest.length === 1)) throw new Error(`unexpected git ${sub} ${rest.join(' ')}`);
    const object = isCat ? rest[1] : rest[0];
    const colon = object.indexOf(':');
    if (colon < 0) throw new Error(`not a <commit>:<path> object: ${object}`);
    // Only a full commit sha resolves; a short one would be a bug in the module.
    const entry = commits.find((c) => c.sha === object.slice(0, colon))?.files[object.slice(colon + 1)];
    if (!entry) return fail(128, `fatal: path '${object.slice(colon + 1)}' does not exist`);
    if (!isCat) return ok(entry.content);
    return ok(rest[0] === '-t' ? `${entry.type}\n` : `${entry.size ?? Buffer.byteLength(entry.content)}\n`);
  };
  return {
    run,
    calls,
    hooks,
    set layout(l: Layout | null) {
      state.layout = l;
    },
    subs: () => calls.filter((c) => !isLayoutCall(c.args)).map((c) => (c.args[2] === 'cat-file' ? `cat-file ${c.args[3]}` : c.args[2])),
  };
}

const must = (raw: string): Cite => {
  const cite = parseCite(raw);
  if (!cite) throw new Error(`test setup: ${raw} should parse`);
  return cite;
};
const ground = (h: ReturnType<typeof harness>, raw: string) => groundCite(h.run, DIR, must(raw));
const bad = (reason: string) => ({ status: 'ungrounded', reason });

/** A repo whose only file has this content, at HEAD. */
const withFile = (content: string) => harness([{ sha: HEAD, files: { 'f.txt': blob(content) } }]);

// ---- parseCite ------------------------------------------------------------------------------------------------------

describe('parseCite: accepted forms', () => {
  it('a line, a range, a sha, a quote, and the combinations', () => {
    expect(parseCite('src/session.ts:12')).toStrictEqual({ raw: 'src/session.ts:12', path: 'src/session.ts', startLine: 12, endLine: 12 });
    expect(parseCite('src/session.ts:12-18')).toStrictEqual({ raw: 'src/session.ts:12-18', path: 'src/session.ts', startLine: 12, endLine: 18 });
    expect(parseCite('src/session.ts:12-18@75c7b13')).toStrictEqual({ raw: 'src/session.ts:12-18@75c7b13', path: 'src/session.ts', startLine: 12, endLine: 18, sha: '75c7b13' });
    expect(parseCite('src/session.ts:5@75c7b13 "reuse the session id"')).toStrictEqual({
      raw: 'src/session.ts:5@75c7b13 "reuse the session id"',
      path: 'src/session.ts',
      startLine: 5,
      endLine: 5,
      sha: '75c7b13',
      quote: 'reuse the session id',
    });
    expect(parseCite('src/session.ts:5-6 "reuse the session id"')).toStrictEqual({ raw: 'src/session.ts:5-6 "reuse the session id"', path: 'src/session.ts', startLine: 5, endLine: 6, quote: 'reuse the session id' });
    expect(parseCite('a.ts:3-3')).toMatchObject({ startLine: 3, endLine: 3 });
  });

  it('lower-cases the sha and accepts 7 to 40 hex digits', () => {
    expect(parseCite('a.ts:1@75C7B13')?.sha).toBe('75c7b13');
    expect(parseCite(`a.ts:1@${HEAD.toUpperCase()}`)?.sha).toBe(HEAD);
    expect(parseCite('a.ts:1@abcdef0')?.sha).toBe('abcdef0');
  });

  it('trims, and raw is the trimmed input', () => {
    const c = parseCite('  \t src/session.ts:12-18@75c7b13 "x y" \n');
    expect(c?.raw).toBe('src/session.ts:12-18@75c7b13 "x y"');
    expect(c).toMatchObject({ path: 'src/session.ts', startLine: 12, endLine: 18, sha: '75c7b13', quote: 'x y' });
  });

  it('allows "@" in a path, with or without a sha after the lines', () => {
    expect(parseCite('node_modules/@scope/pkg/index.js:10')).toStrictEqual({ raw: 'node_modules/@scope/pkg/index.js:10', path: 'node_modules/@scope/pkg/index.js', startLine: 10, endLine: 10 });
    expect(parseCite('node_modules/@scope/pkg/index.js:10-12@75c7b13')).toMatchObject({ path: 'node_modules/@scope/pkg/index.js', startLine: 10, endLine: 12, sha: '75c7b13' });
    // an "@" before the colon is part of the file name, not a sha
    expect(parseCite('a.ts@abc1234:1')).toStrictEqual({ raw: 'a.ts@abc1234:1', path: 'a.ts@abc1234', startLine: 1, endLine: 1 });
  });

  it('the quote is the text between the first and the last double quote', () => {
    expect(parseCite('a.ts:1 "say "hi" twice"')?.quote).toBe('say "hi" twice');
    expect(parseCite('a.ts:1 "key: value @ 12-14 | x"')?.quote).toBe('key: value @ 12-14 | x');
    expect(parseCite('a.ts:1  "  padded  "')?.quote).toBe('  padded  ');
  });

  it('an empty quote is no quote', () => {
    expect(parseCite('a.ts:1 ""')).toStrictEqual({ raw: 'a.ts:1 ""', path: 'a.ts', startLine: 1, endLine: 1 });
  });

  it('a ".." inside a name is not a ".." segment; shell characters are just characters of one argument', () => {
    expect(parseCite('docs/v1..v2.md:3')?.path).toBe('docs/v1..v2.md');
    expect(parseCite('docs/.../x:3')?.path).toBe('docs/.../x');
    expect(parseCite('src/$(id);x.ts:3')?.path).toBe('src/$(id);x.ts');
    expect(parseCite('a`b`|c&d>e.ts:1')?.path).toBe('a`b`|c&d>e.ts');
  });

  it('an absolute path is accepted as text, so groundCite can map it into the repo or refuse it; the other validations stay', () => {
    expect(parseCite('/work/shop-app/src/session.ts:12-18@75c7b13')).toStrictEqual({ raw: '/work/shop-app/src/session.ts:12-18@75c7b13', path: '/work/shop-app/src/session.ts', startLine: 12, endLine: 18, sha: '75c7b13' });
    expect(parseCite('/etc/passwd:1')?.path).toBe('/etc/passwd');
    for (const text of ['/a/../etc/passwd:1', '/..:1', '/a\\b:1', '/a\0b:1', '/etc/passwd', '/etc/passwd:0', '/:']) expect(parseCite(text), text).toBeNull();
  });

  it('the line bounds: 1 up to 10 000 000', () => {
    expect(parseCite('a.ts:1')?.startLine).toBe(1);
    expect(parseCite('a.ts:10000000')).toMatchObject({ startLine: 10_000_000, endLine: 10_000_000 });
    expect(parseCite('a.ts:1-10000000')).toMatchObject({ startLine: 1, endLine: 10_000_000 });
  });
});

describe('parseCite: rejected forms are null, never a throw', () => {
  const rejected: Array<[string, string]> = [
    // not a citation at all
    ['empty', ''],
    ['blank', '  \t '],
    ['no line', 'a.ts'],
    ['no line after the colon', 'a.ts:'],
    ['a word for a line', 'a.ts:x'],
    ['no path', ':12'],
    ['a second colon', 'a.ts:1:2'],
    ['a space in the path', 'my file.ts:3'],
    ['a quoted path', '"a.ts":1'],
    ['a negative line', 'a.ts:-1'],
    ['a dangling range', 'a.ts:1-'],
    ['a doubled dash', 'a.ts:1--2'],
    ['a fractional line', 'a.ts:1.5'],
    ['non-ASCII digits', 'a.ts:١٢'],
    ['a quote with no space before it', 'a.ts:1"q"'],
    ['a sha with no @', 'a.ts:1 75c7b13'],
    ['an unterminated quote', 'a.ts:1 "oops'],
    ['a lone quote mark', 'a.ts:1 "'],
    ['text after the quote', 'a.ts:1 "q" (note)'],
    ['two shas', 'a.ts:1@abc1234@def5678'],
    // argument injection into git
    ['an option', '--help'],
    ['an option with a line', '--help:1'],
    ['a path that starts with a dash', '-x/y:1'],
    ['a long option', '--output=/tmp/pwn:1'],
    ['a dash alone', '-:1'],
    // traversal
    ['a parent path', '../x:1'],
    ['a parent in the middle', 'a/../b:1'],
    ['a parent at the end', 'a/..:1'],
    ['a bare ..', '..:1'],
    ['a backslash', 'a\\b:1'],
    ['a windows parent', '..\\x:1'],
    ['a NUL in the path', 'a\0b:1'],
    // numbers
    ['line 0', 'a.ts:0'],
    ['range from 0', 'a.ts:0-3'],
    ['end before start', 'a.ts:5-3'],
    ['a line over the bound', 'a.ts:10000001'],
    ['an end over the bound', 'a.ts:1-10000001'],
    ['a huge line', 'a.ts:99999999999999999999'],
    ['a huge end', 'a.ts:1-99999999999999999999'],
    ['a line of a thousand digits', `a.ts:${'9'.repeat(1000)}`],
    // sha
    ['a sha one digit short', 'a.ts:1@abc123'],
    ['a sha of five digits', 'a.ts:1@abc12'],
    ['a sha with a non-hex digit', 'a.ts:1@abc123g'],
    ['a sha that is a word', 'a.ts:1@HEAD'],
    ['a sha that is a branch name', 'a.ts:1@main'],
    ['a sha longer than 40', `a.ts:1@${'f'.repeat(41)}`],
    ['an empty sha', 'a.ts:1@'],
    ['a sha that is an option', 'a.ts:1@--upload-pack=x'],
    ['a revision expression', 'a.ts:1@abc1234^{commit}'],
    ['a revision range', 'a.ts:1@abc1234..def5678'],
  ];
  it.each(rejected)('%s', (_name, text) => {
    expect(parseCite(text)).toBeNull();
  });

  it('a value that is not a string', () => {
    expect(parseCite(undefined as unknown as string)).toBeNull();
    expect(parseCite(null as unknown as string)).toBeNull();
    expect(parseCite(12 as unknown as string)).toBeNull();
  });
});

describe('parseCite: properties', () => {
  const citeish = fc
    .tuple(
      fc.constantFrom('', '-', '--', '/', '../', 'a/../', './', 'src/', '@scope/', '..', 'x\\', '\0'),
      fc.string({ maxLength: 12 }),
      fc.constantFrom(':', ':0', ':5', ':5-3', ':5-9', ':99999999999', ':1:2', ':10000001'),
      fc.constantFrom('', '@abc1234', '@ABCDEF1234', '@zzz', '@abc12', `@${'f'.repeat(41)}`, '@'),
      fc.constantFrom('', ' "q"', ' "a" b"', ' "', '"q"', ' ""')
    )
    .map((parts) => parts.join(''));
  const anything = fc.oneof(citeish, fc.string({ unit: 'binary', maxLength: 40 }));

  it('never throws, and whatever it accepts is safe to hand to git', () => {
    fc.assert(
      fc.property(anything, (text) => {
        const c = parseCite(text);
        if (c === null) return;
        expect(c.raw).toBe(text.trim());
        expect(c.path.startsWith('-')).toBe(false); // an absolute path is text here; groundCite never hands one to git (see below)
        expect(c.path.includes('\\') || c.path.includes('\0')).toBe(false);
        expect(c.path.split('/')).not.toContain('..');
        expect(c.path).not.toMatch(/[\s:"]/);
        expect(c.startLine).toBeGreaterThanOrEqual(1);
        expect(c.endLine).toBeGreaterThanOrEqual(c.startLine);
        expect(c.endLine).toBeLessThanOrEqual(10_000_000);
        if (c.sha !== undefined) expect(c.sha).toMatch(/^[0-9a-f]{7,40}$/);
        if (c.quote !== undefined) expect(c.quote.length).toBeGreaterThan(0);
        expect(parseCite(c.raw)).toStrictEqual(c); // parsing is stable
      }),
      { numRuns: 500 }
    );
  });
});

// ---- groundCite -----------------------------------------------------------------------------------------------------

describe('groundCite: the happy paths', () => {
  it('grounded at an explicit sha: the commit is resolved, then the full sha is used for every object', async () => {
    const h = harness();
    expect(await ground(h, 'src/session.ts:2-3@75c7b13')).toStrictEqual({ status: 'grounded', sha: '75c7b13' });
    const object = `${HEAD}:src/session.ts`;
    expect(h.calls.map((c) => c.args)).toStrictEqual([
      ['-C', DIR, 'rev-parse', '--verify', '--quiet', '75c7b13^{commit}'],
      ['-C', DIR, 'rev-parse', '--show-prefix', '--show-toplevel'],
      ['-C', DIR, 'cat-file', '-t', object],
      ['-C', DIR, 'cat-file', '-s', object],
      ['-C', DIR, 'show', object],
    ]);
    expect(h.calls.every((c) => c.cmd === 'git')).toBe(true);
    // every call has the timeout; only the read of the file is capped, one byte past the largest file that may be checked
    expect(h.calls.map((c) => c.opts)).toStrictEqual([{ timeoutMs: 20_000 }, { timeoutMs: 20_000 }, { timeoutMs: 20_000 }, { timeoutMs: 20_000 }, { timeoutMs: 20_000, maxOutputBytes: MB2 + 1 }]);
  });

  it('grounded with a 40-digit sha: the result carries only the first 7', async () => {
    const h = harness();
    expect(await ground(h, `src/session.ts:1@${HEAD}`)).toStrictEqual({ status: 'grounded', sha: '75c7b13' });
  });

  it('a cite without a sha is pinned to HEAD, the checkout the agent looked at', async () => {
    const h = harness();
    expect(await ground(h, 'src/session.ts:8')).toStrictEqual({ status: 'grounded', sha: '75c7b13' });
    expect(h.calls[0].args).toStrictEqual(['-C', DIR, 'rev-parse', '--verify', '--quiet', 'HEAD^{commit}']);
  });

  it('HEAD is whatever the checkout has: with HEAD on the older commit the answer changes', async () => {
    const h = harness(COMMITS, OLD);
    expect(await ground(h, 'src/session.ts:3')).toStrictEqual({ status: 'grounded', sha: '1a2b3c4' });
    expect(await ground(h, 'src/session.ts:5')).toStrictEqual(bad('lines 5-5 are beyond the end of the file (3 lines)'));
  });

  it('the sha decides which version of the file is read', async () => {
    const h = harness();
    expect(await ground(h, 'src/session.ts:5@75c7b13')).toStrictEqual({ status: 'grounded', sha: '75c7b13' });
    expect(await ground(h, 'src/session.ts:5@1a2b3c4')).toStrictEqual(bad('lines 5-5 are beyond the end of the file (3 lines)'));
  });

  it('a path with "@" and a path full of shell characters ground like any other', async () => {
    const h = harness();
    expect(await ground(h, 'node_modules/@scope/pkg/index.js:1')).toStrictEqual({ status: 'grounded', sha: '75c7b13' });
    expect(await ground(h, 'src/$(id);x.ts:1')).toStrictEqual({ status: 'grounded', sha: '75c7b13' });
    // one argv element, behind the commit, never split or interpreted
    expect(h.calls.map((c) => c.args.at(-1)).filter((a) => a?.includes('$(id)'))).toStrictEqual([`${HEAD}:src/$(id);x.ts`, `${HEAD}:src/$(id);x.ts`, `${HEAD}:src/$(id);x.ts`]);
  });
});

describe('groundCite: why a cite is ungrounded', () => {
  it('an unknown commit stops after one git call', async () => {
    const h = harness();
    expect(await ground(h, 'src/session.ts:1@deadbee')).toStrictEqual(bad('commit deadbee not found'));
    expect(await ground(h, `src/session.ts:1@${'c'.repeat(40)}`)).toStrictEqual(bad('commit ccccccc not found'));
    expect(h.subs()).toStrictEqual(['rev-parse', 'rev-parse']);
  });

  it('no usable HEAD', async () => {
    const h = harness(COMMITS, null);
    expect(await ground(h, 'src/session.ts:1')).toStrictEqual(bad('no commit at HEAD'));
    expect(h.subs()).toStrictEqual(['rev-parse']);
  });

  it('a path that is not in the commit names the short sha it looked at', async () => {
    const h = harness();
    expect(await ground(h, 'journal/2026-10-14.md:17')).toStrictEqual(bad('journal/2026-10-14.md is not in 75c7b13'));
    expect(await ground(h, 'src/new.ts:1@1a2b3c4')).toStrictEqual(bad('src/new.ts is not in 1a2b3c4')); // exists at HEAD, not at the older commit
    expect(await ground(h, 'src/new.ts:1@75c7b13')).toStrictEqual({ status: 'grounded', sha: '75c7b13' });
    expect(h.subs().filter((s) => s === 'show')).toHaveLength(1); // nothing was read for the two misses
  });

  it('a directory is not a file', async () => {
    const h = harness();
    expect(await ground(h, 'src:1')).toStrictEqual(bad('src is not a file'));
    expect(h.subs()).toStrictEqual(['rev-parse', 'cat-file -t']);
  });

  it('a file over 2 MB is too large to check, and is never read', async () => {
    const h = harness();
    expect(await ground(h, 'docs/huge.log:1')).toStrictEqual(bad('too large to check'));
    expect(h.subs()).toStrictEqual(['rev-parse', 'cat-file -t', 'cat-file -s']);
  });

  it('a file of exactly 2 MB is still checked', async () => {
    const h = harness();
    expect(await ground(h, 'docs/edge.log:1')).toStrictEqual({ status: 'grounded', sha: '75c7b13' });
    expect(h.subs()).toContain('show');
  });

  it('a runner that returns more than it reported is too large as well', async () => {
    const h = harness();
    h.hooks.set('show', () => ({ code: 0, stdout: 'x'.repeat(MB2 + 1), stderr: '' }));
    expect(await ground(h, 'src/session.ts:1')).toStrictEqual(bad('too large to check'));
  });

  it('a size git does not report is not guessed', async () => {
    for (const result of [{ code: 128, stdout: '', stderr: 'fatal: boom' }, { code: 0, stdout: 'big\n', stderr: '' }, { code: 0, stdout: '', stderr: '' }]) {
      const h = harness();
      h.hooks.set('cat-file -s', () => result);
      expect(await ground(h, 'src/session.ts:1')).toStrictEqual(bad('could not read the size of src/session.ts'));
      expect(h.subs()).not.toContain('show');
    }
  });

  it('a failed read is reported, not treated as an empty file', async () => {
    const h = harness();
    h.hooks.set('show', () => ({ code: 128, stdout: '', stderr: 'fatal: bad object' }));
    expect(await ground(h, 'src/session.ts:1')).toStrictEqual(bad('could not read src/session.ts at 75c7b13'));
  });

  it('a binary file', async () => {
    const h = harness();
    expect(await ground(h, 'assets/logo.bin:1')).toStrictEqual(bad('binary file'));
  });

  it('a type that is not "blob" (a submodule) is not a file', async () => {
    const h = harness();
    h.hooks.set('cat-file -t', () => ({ code: 0, stdout: 'commit\n', stderr: '' }));
    expect(await ground(h, 'src/session.ts:1')).toStrictEqual(bad('src/session.ts is not a file'));
  });
});

describe('groundCite: git that did not answer is not a verdict about the cite', () => {
  const timedOut: RunResult = { code: 1, stdout: '', stderr: '', timedOut: true };
  const cut: RunResult = { code: 1, stdout: 'partial', stderr: '', truncated: true };

  const object = `${HEAD}:src/session.ts`;
  // the stage a hook stands for, and the last call that may have been made when it answers
  const stages: Array<[string, string[]]> = [
    ['rev-parse', ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}']],
    ['layout', ['rev-parse', '--show-prefix', '--show-toplevel']],
    ['cat-file -t', ['cat-file', '-t', object]],
    ['cat-file -s', ['cat-file', '-s', object]],
    ['show', ['show', object]],
  ];

  it.each(stages)('a timeout at %s is "git timed out", not a missing commit or file, and nothing runs after it', async (stage, last) => {
    const h = harness();
    h.hooks.set(stage, () => timedOut);
    expect(await ground(h, 'src/session.ts:1')).toStrictEqual(bad('git timed out'));
    expect(h.calls.at(-1)?.args.slice(2)).toStrictEqual(last);
  });

  it.each(stages)('output cut at the cap at %s is "output too large"', async (stage, last) => {
    const h = harness();
    h.hooks.set(stage, () => cut);
    expect(await ground(h, 'src/session.ts:1')).toStrictEqual(bad('output too large'));
    expect(h.calls.at(-1)?.args.slice(2)).toStrictEqual(last);
  });

  it('a timeout reads the same with an explicit sha, and for a file that is not there either way', async () => {
    const h = harness();
    h.hooks.set('rev-parse', () => timedOut);
    expect(await ground(h, 'src/session.ts:1@75c7b13')).toStrictEqual(bad('git timed out'));
    expect(await ground(h, 'no/such/file.ts:1')).toStrictEqual(bad('git timed out'));
  });

  it('the read of the file is capped one byte above the largest file that may be checked; a cut read is not "too large to check" by guesswork', async () => {
    const h = harness();
    await ground(h, 'src/session.ts:1');
    const shown = h.calls.find((c) => c.args[2] === 'show');
    expect(shown?.opts).toStrictEqual({ timeoutMs: 20_000, maxOutputBytes: MB2 + 1 });
  });

  it('a plain failure is still a verdict: an unknown commit and a missing file read as before', async () => {
    const h = harness();
    expect(await ground(h, 'src/session.ts:1@deadbee')).toStrictEqual(bad('commit deadbee not found'));
    expect(await ground(h, 'nope.ts:1')).toStrictEqual(bad('nope.ts is not in 75c7b13'));
  });
});

describe('groundCite: a checkout below the repo root reads the cite the way the agent saw it', () => {
  const TOP = '/repo';
  const lines = (n: number, tag: string) => Array.from({ length: n }, (_, i) => `${tag} line ${i + 1}`).join('\n') + '\n';
  const MONO: Commit[] = [
    {
      sha: HEAD,
      files: {
        'src/a.ts': blob(lines(10, 'ROOT a.ts')),
        'src/rootonly.ts': blob(lines(5, 'ROOT only')),
        'packages/api/src/a.ts': blob(lines(3, 'API a.ts')),
        'packages/api/src/cwdonly.ts': blob(lines(5, 'API only')),
        lib: blob(lines(5, 'ROOT lib')),
        'packages/api/lib': TREE,
        'packages/api/lib/x.ts': blob('x\n'),
      },
    },
  ];
  const below = (layout: { prefix: string; top: string } | null = { prefix: 'packages/api/', top: TOP }) => {
    const h = harness(MONO);
    h.layout = layout;
    return h;
  };
  const objects = (h: ReturnType<typeof harness>, sub: string) => h.calls.filter((c) => c.args[2] === sub || c.args[3] === sub).map((c) => c.args.at(-1));

  it('asks git once where the checkout is, after the commit is known, and never for a commit that does not exist', async () => {
    const h = below();
    await ground(h, 'src/a.ts:1');
    expect(h.calls.map((c) => c.args.slice(2, 4))).toStrictEqual([['rev-parse', '--verify'], ['rev-parse', '--show-prefix'], ['cat-file', '-t'], ['cat-file', '-s'], ['show', `${HEAD}:packages/api/src/a.ts`]]);
    const none = below();
    await ground(none, 'src/a.ts:1@deadbee');
    expect(none.calls).toHaveLength(1);
  });

  it('a file in the checkout and a file of the same name at the root: the checkout wins, and a line only the root file has is not grounded', async () => {
    const h = below();
    expect(await ground(h, 'src/a.ts:2')).toStrictEqual({ status: 'grounded', sha: '75c7b13' });
    expect(objects(h, 'show')).toStrictEqual([`${HEAD}:packages/api/src/a.ts`]);
    // the root file has ten lines, the agent's own has three: grounding line 8 against the root file would be grounding a different file
    expect(await ground(h, 'src/a.ts:8')).toStrictEqual(bad('lines 8-8 are beyond the end of the file (3 lines)'));
    expect(await ground(h, 'src/a.ts:2 "API a.ts line 2"')).toStrictEqual({ status: 'grounded', sha: '75c7b13' });
    expect(await ground(h, 'src/a.ts:2 "ROOT a.ts line 2"')).toStrictEqual(bad('quote not found in lines 2-2'));
    expect(objects(h, 'show').every((o) => o === `${HEAD}:packages/api/src/a.ts`)).toBe(true);
  });

  it('only the root has the file: the root path is the fallback, and that file is the one read', async () => {
    const h = below();
    expect(await ground(h, 'src/rootonly.ts:5')).toStrictEqual({ status: 'grounded', sha: '75c7b13' });
    expect(objects(h, 'cat-file')).toStrictEqual([`${HEAD}:packages/api/src/rootonly.ts`, `${HEAD}:src/rootonly.ts`, `${HEAD}:src/rootonly.ts`]);
    expect(objects(h, 'show')).toStrictEqual([`${HEAD}:src/rootonly.ts`]);
  });

  it('only the checkout has the file: grounded at once, with no look at the root', async () => {
    const h = below();
    expect(await ground(h, 'src/cwdonly.ts:5')).toStrictEqual({ status: 'grounded', sha: '75c7b13' });
    expect(objects(h, 'cat-file')).toStrictEqual([`${HEAD}:packages/api/src/cwdonly.ts`, `${HEAD}:packages/api/src/cwdonly.ts`]);
  });

  it('neither has it: both are tried, and the cite is ungrounded', async () => {
    const h = below();
    expect(await ground(h, 'src/none.ts:1')).toStrictEqual(bad('src/none.ts is not in 75c7b13'));
    expect(objects(h, 'cat-file')).toStrictEqual([`${HEAD}:packages/api/src/none.ts`, `${HEAD}:src/none.ts`]);
  });

  it('a name that exists in the checkout but is not a file is that answer: no fallback to a root file of the same name', async () => {
    const h = below();
    expect(await ground(h, 'lib:1')).toStrictEqual(bad('lib is not a file'));
    expect(objects(h, 'cat-file')).toStrictEqual([`${HEAD}:packages/api/lib`]);
  });

  it('a "./" path says "from here": it is the checkout\'s file only, spelled with and without "./" alike', async () => {
    const h = below();
    expect(await ground(h, './src/a.ts:2')).toStrictEqual({ status: 'grounded', sha: '75c7b13' });
    expect(await ground(h, './src/a.ts:8')).toStrictEqual(bad('lines 8-8 are beyond the end of the file (3 lines)'));
    expect(await ground(h, './src/rootonly.ts:1')).toStrictEqual(bad('./src/rootonly.ts is not in 75c7b13'));
    expect(await ground(h, './././src/cwdonly.ts:1')).toStrictEqual({ status: 'grounded', sha: '75c7b13' });
    expect(h.calls.flatMap((c) => c.args).filter((a) => a.includes('./'))).toStrictEqual([]);
  });

  it('a checkout at the root has one reading, and git is not asked twice', async () => {
    const h = below({ prefix: '', top: TOP });
    expect(await ground(h, 'src/rootonly.ts:5')).toStrictEqual({ status: 'grounded', sha: '75c7b13' });
    expect(await ground(h, 'src/none.ts:1')).toStrictEqual(bad('src/none.ts is not in 75c7b13'));
    expect(objects(h, 'cat-file')).toStrictEqual([`${HEAD}:src/rootonly.ts`, `${HEAD}:src/rootonly.ts`, `${HEAD}:src/none.ts`]);
  });

  it('when git cannot say where the checkout is, the path is a repo path, as it was before', async () => {
    const h = below(null);
    expect(await ground(h, 'src/a.ts:8')).toStrictEqual({ status: 'grounded', sha: '75c7b13' });
    expect(objects(h, 'show')).toStrictEqual([`${HEAD}:src/a.ts`]);
  });

  it.each([
    ['no top', ''],
    ['a top that is not absolute', 'packages/api/\nrepo\n'],
    ['a prefix that does not end in a slash', 'packages/api\n/repo\n'],
    ['an absolute prefix', '/packages/api/\n/repo\n'],
    ['nothing', ''],
  ])('an answer that is not a prefix and an absolute top (%s) is no answer: repo paths again', async (_name, out) => {
    const h = below();
    h.hooks.set('layout', () => ({ code: 0, stdout: out, stderr: '' }));
    expect(await ground(h, 'src/a.ts:8')).toStrictEqual({ status: 'grounded', sha: '75c7b13' });
    expect(objects(h, 'show')).toStrictEqual([`${HEAD}:src/a.ts`]);
  });

  it('CRLF output is read the same', async () => {
    const h = below();
    h.hooks.set('layout', () => ({ code: 0, stdout: `packages/api/\r\n${TOP}\r\n`, stderr: '' }));
    expect(await ground(h, 'src/a.ts:8')).toStrictEqual(bad('lines 8-8 are beyond the end of the file (3 lines)'));
  });

  describe('absolute paths', () => {
    it('one inside the repo is the repo path, read as it stands: not through the checkout, and git is never given an absolute path', async () => {
      const h = below();
      expect(await ground(h, `${TOP}/src/a.ts:8`)).toStrictEqual({ status: 'grounded', sha: '75c7b13' }); // the root file, named outright
      expect(await ground(h, `${TOP}/packages/api/src/a.ts:3`)).toStrictEqual({ status: 'grounded', sha: '75c7b13' });
      expect(await ground(h, `${TOP}/packages/api/src/a.ts:4`)).toStrictEqual(bad('lines 4-4 are beyond the end of the file (3 lines)'));
      expect(objects(h, 'show')).toStrictEqual([`${HEAD}:src/a.ts`, `${HEAD}:packages/api/src/a.ts`, `${HEAD}:packages/api/src/a.ts`]);
      for (const c of h.calls) for (const a of c.args.slice(2)) expect(a.startsWith('/')).toBe(false);
      for (const a of h.calls.flatMap((c) => c.args)) expect(a.includes(`${TOP}/`)).toBe(false);
    });

    it('a path that is not under the top is outside the repository, whatever it names, and no object is looked up', async () => {
      const h = below();
      for (const text of ['/etc/passwd:1', `${TOP}:1`, `${TOP}/:1`, '/repository/src/a.ts:1', '/:1', `/other${TOP}/src/a.ts:1`]) {
        expect(await ground(h, text), text).toStrictEqual(bad('outside the repository'));
      }
      expect(h.subs().filter((s) => s.startsWith('cat-file') || s === 'show')).toStrictEqual([]);
    });

    it('with no layout there is no repo to be inside of', async () => {
      const h = below(null);
      expect(await ground(h, `${TOP}/src/a.ts:1`)).toStrictEqual(bad('outside the repository'));
      expect(h.subs()).toStrictEqual(['rev-parse']);
    });

    it('a hand-built cite with an absolute path is judged the same way', async () => {
      const h = below();
      const cite: Cite = { raw: `${TOP}/src/a.ts:1`, path: `${TOP}/src/a.ts`, startLine: 1, endLine: 1 };
      expect(await groundCite(h.run, DIR, cite)).toStrictEqual({ status: 'grounded', sha: '75c7b13' });
      expect(await groundCite(h.run, DIR, { ...cite, path: '/etc/passwd' })).toStrictEqual(bad('outside the repository'));
    });
  });
});

describe('groundCite: lines', () => {
  it('a range past the end of the file', async () => {
    const h = harness();
    expect(await ground(h, 'src/session.ts:6-8')).toStrictEqual({ status: 'grounded', sha: '75c7b13' });
    expect(await ground(h, 'src/session.ts:7-9')).toStrictEqual(bad('lines 7-9 are beyond the end of the file (8 lines)'));
    expect(await ground(h, 'src/session.ts:9')).toStrictEqual(bad('lines 9-9 are beyond the end of the file (8 lines)'));
    expect(await ground(h, 'src/session.ts:1-8')).toStrictEqual({ status: 'grounded', sha: '75c7b13' });
    expect(await ground(h, 'src/session.ts:1-10000000')).toStrictEqual(bad('lines 1-10000000 are beyond the end of the file (8 lines)'));
  });

  // content, how many lines it has: a trailing newline ends the last line and does not start another
  const counted: Array<[string, number]> = [
    ['', 0],
    ['\n', 1],
    ['a', 1],
    ['a\n', 1],
    ['a\nb', 2],
    ['a\nb\n', 2],
    ['a\n\n', 2],
    ['a\n\n\n', 3],
    ['a\r\nb\r\n', 2],
  ];
  it.each(counted)('%j has %i line(s)', async (content, n) => {
    const h = withFile(content);
    if (n > 0) expect(await ground(h, `f.txt:${n}`)).toStrictEqual({ status: 'grounded', sha: '75c7b13' });
    expect(await ground(h, `f.txt:${n + 1}`)).toStrictEqual(bad(`lines ${n + 1}-${n + 1} are beyond the end of the file (${n} lines)`));
    if (n > 0) expect(await ground(h, `f.txt:1-${n + 1}`)).toStrictEqual(bad(`lines 1-${n + 1} are beyond the end of the file (${n} lines)`));
  });
});

describe('groundCite: quotes', () => {
  const LINE5 = 'offline uploads reuse the session id minted online';

  it('a quote that is in the lines grounds', async () => {
    const h = harness();
    expect(await ground(h, `src/session.ts:5 "${LINE5}"`)).toStrictEqual({ status: 'grounded', sha: '75c7b13' });
    expect(await ground(h, 'src/session.ts:2 "return queuedId()"')).toStrictEqual({ status: 'grounded', sha: '75c7b13' });
    expect(await ground(h, `src/session.ts:5@75c7b13 "reuse the session"`)).toStrictEqual({ status: 'grounded', sha: '75c7b13' });
  });

  it('a quote that is not in the lines does not', async () => {
    const h = harness();
    expect(await ground(h, 'src/session.ts:5 "offline uploads mint a fresh id"')).toStrictEqual(bad('quote not found in lines 5-5'));
    expect(await ground(h, 'src/session.ts:5-6 "return nothing"')).toStrictEqual(bad('quote not found in lines 5-6'));
  });

  it('only the cited lines are searched', async () => {
    const h = harness();
    expect(await ground(h, 'src/session.ts:5-5 "minted online"')).toStrictEqual({ status: 'grounded', sha: '75c7b13' });
    expect(await ground(h, 'src/session.ts:6-7 "minted online"')).toStrictEqual(bad('quote not found in lines 6-7'));
    expect(await ground(h, 'src/session.ts:4 "minted online"')).toStrictEqual(bad('quote not found in lines 4-4'));
  });

  it('whitespace runs match each other, across indentation, tabs and line breaks', async () => {
    const h = harness();
    expect(await ground(h, 'src/session.ts:5 "offline   uploads\treuse the  session id"')).toStrictEqual({ status: 'grounded', sha: '75c7b13' });
    expect(await ground(h, 'src/session.ts:2 "if (!online)    return queuedId();"')).toStrictEqual({ status: 'grounded', sha: '75c7b13' });
    expect(await ground(h, 'src/session.ts:4-5 "} // offline"')).toStrictEqual({ status: 'grounded', sha: '75c7b13' }); // the newline between lines 4 and 5 is one space
    expect(await ground(h, 'src/session.ts:6-7 "(id: string) { return id;"')).toStrictEqual({ status: 'grounded', sha: '75c7b13' });
  });

  it('whitespace is not ignored altogether: it separates words', async () => {
    const h = harness();
    expect(await ground(h, 'src/session.ts:5 "offlineuploads"')).toStrictEqual(bad('quote not found in lines 5-5'));
  });

  it('a quote is case-sensitive', async () => {
    const h = harness();
    expect(await ground(h, 'src/session.ts:5 "Offline uploads"')).toStrictEqual(bad('quote not found in lines 5-5'));
    expect(await ground(h, 'src/session.ts:5 "OFFLINE UPLOADS"')).toStrictEqual(bad('quote not found in lines 5-5'));
  });

  it('CRLF line endings do not get in the way', async () => {
    const h = withFile('first line\r\nsecond   line\r\nthird\r\n');
    expect(await ground(h, 'f.txt:1-2 "first line second line"')).toStrictEqual({ status: 'grounded', sha: '75c7b13' });
    expect(await ground(h, 'f.txt:1-2 "first line third"')).toStrictEqual(bad('quote not found in lines 1-2'));
  });

  it('the lines are checked before the quote', async () => {
    const h = harness();
    expect(await ground(h, `src/session.ts:9 "${LINE5}"`)).toStrictEqual(bad('lines 9-9 are beyond the end of the file (8 lines)'));
  });
});

describe('groundCite: failures of git never throw', () => {
  const stages = ['rev-parse', 'cat-file -t', 'cat-file -s', 'show'];

  it.each(stages)('a runner that throws at %s: the error message is the reason', async (stage) => {
    const h = harness();
    h.hooks.set(stage, () => {
      throw new Error('git timed out after 20000ms');
    });
    expect(await ground(h, 'src/session.ts:1')).toStrictEqual(bad('git timed out after 20000ms'));
    expect(h.subs().at(-1)).toBe(stage); // and nothing ran after it
  });

  it('a runner that throws something that is not an Error, or an Error with no message', async () => {
    const h = harness();
    h.hooks.set('rev-parse', () => {
      throw 'spawn git ENOENT'; // eslint-disable-line no-throw-literal
    });
    expect(await ground(h, 'src/session.ts:1')).toStrictEqual(bad('spawn git ENOENT'));
    h.hooks.set('rev-parse', () => {
      throw new Error('');
    });
    expect(await ground(h, 'src/session.ts:1')).toStrictEqual(bad('git failed'));
  });

  it('a runner that throws before it returns a promise', async () => {
    const run: Runner = () => {
      throw new Error('cwd is not an existing directory');
    };
    expect(await groundCite(run, DIR, must('a.ts:1'))).toStrictEqual(bad('cwd is not an existing directory'));
  });

  it('a runner that rejects', async () => {
    const run: Runner = () => Promise.reject(new Error('EMFILE: too many open files'));
    expect(await groundCite(run, DIR, must('a.ts:1@abc1234'))).toStrictEqual(bad('EMFILE: too many open files'));
  });

  it('an empty checkout directory is not "the current directory"', async () => {
    const h = harness();
    expect(await groundCite(h.run, '', must('src/session.ts:1'))).toStrictEqual(bad('no checkout to check against'));
    expect(h.calls).toHaveLength(0);
  });
});

describe('groundCite: nothing hostile reaches git', () => {
  const good: Cite = { raw: 'src/session.ts:1', path: 'src/session.ts', startLine: 1, endLine: 1 };
  const hostile: Array<[string, Partial<Cite>]> = [
    ['an option as the path', { path: '-x' }],
    ['a long option as the path', { path: '--output=/tmp/pwn' }],
    ['a dash as the path', { path: '-' }],
    ['a parent path', { path: '../x' }],
    ['a parent in the middle', { path: 'src/../../x' }],
    ['a trailing parent', { path: 'src/..' }],
    ['a bare ..', { path: '..' }],
    ['a backslash', { path: 'src\\session.ts' }],
    ['a NUL', { path: 'src/session.ts\0.png' }],
    ['an empty path', { path: '' }],
    ['HEAD as the sha', { sha: 'HEAD' }],
    ['a branch as the sha', { sha: 'main' }],
    ['an option as the sha', { sha: '--upload-pack=touch' }],
    ['a dash-led sha', { sha: '-1234567' }],
    ['a short sha', { sha: 'abc123' }],
    ['an upper-case sha', { sha: 'ABCDEF1' }],
    ['a revision expression', { sha: 'abc1234^{commit}' }],
    ['a revision range', { sha: 'abc1234..def5678' }],
    ['a sha over 40 digits', { sha: 'f'.repeat(41) }],
    ['a sha with a trailing space', { sha: 'abc1234 ' }],
    ['a sha with a newline', { sha: 'abc1234\n--help' }],
    ['an empty sha', { sha: '' }],
    ['line 0', { startLine: 0 }],
    ['a negative line', { startLine: -3 }],
    ['NaN', { startLine: NaN, endLine: NaN }],
    ['a fraction', { startLine: 1.5, endLine: 2 }],
    ['infinity', { endLine: Infinity }],
    ['end before start', { startLine: 5, endLine: 4 }],
    ['an end over the bound', { endLine: 10_000_001 }],
    ['a line that is a string', { startLine: '1' as unknown as number }],
  ];
  it.each(hostile)('%s: ungrounded as not a valid citation, and git is never run', async (_name, over) => {
    const h = harness();
    expect(await groundCite(h.run, DIR, { ...good, ...over })).toStrictEqual(bad('not a valid citation'));
    expect(h.calls).toHaveLength(0);
  });

  it('a runner that answers the commit lookup with an option gets nothing more to run', async () => {
    const h = harness();
    h.hooks.set('rev-parse', () => ({ code: 0, stdout: '--output=/tmp/pwn\n', stderr: '' }));
    expect(await ground(h, 'src/session.ts:1@75c7b13')).toStrictEqual(bad('commit 75c7b13 not found'));
    h.hooks.set('rev-parse', () => ({ code: 0, stdout: `${HEAD}\n--help\n`, stderr: '' }));
    expect(await ground(h, 'src/session.ts:1')).toStrictEqual(bad('no commit at HEAD'));
    expect(h.subs()).toStrictEqual(['rev-parse', 'rev-parse']);
  });

  // The only options the module passes itself. Everything else it hands over is a directory, or a <full sha>:<path> object.
  const OWN_FLAGS = new Set(['-C', '-t', '-s', '--verify', '--quiet', '--show-prefix', '--show-toplevel']);

  it('no argv element starts with "-" except the flags the module itself passes', async () => {
    const h = harness();
    const texts = [
      'src/session.ts:2-3@75c7b13',
      '/work/shop-app/src/session.ts:5',
      '/etc/passwd:1',
      'src/session.ts:5',
      'src/session.ts:5 "reuse the session"',
      'src/session.ts:1@deadbee',
      'src/session.ts:5@1a2b3c4',
      'src:1',
      'docs/huge.log:1',
      'assets/logo.bin:1',
      'src/$(id);x.ts:1',
      'node_modules/@scope/pkg/index.js:1',
      '-x/y:1',
      '--help',
      '--help:1',
      '../x:1',
      'a.ts:1@--upload-pack=x',
    ];
    for (const text of texts) {
      const cite = parseCite(text);
      if (cite) await groundCite(h.run, DIR, cite);
    }
    for (const [, over] of hostile) await groundCite(h.run, DIR, { ...good, ...over });
    expect(h.calls.length).toBeGreaterThan(20);
    const dashed = new Set(h.calls.flatMap((c) => c.args).filter((a) => a.startsWith('-')));
    expect([...dashed].filter((a) => !OWN_FLAGS.has(a))).toStrictEqual([]);
    // and they really are used: the check above is not passing because nothing ran
    expect([...dashed].sort()).toStrictEqual([...OWN_FLAGS].sort());
    for (const c of h.calls) {
      expect(c.cmd).toBe('git');
      expect(c.args.slice(0, 2)).toStrictEqual(['-C', DIR]);
      expect(c.opts).toStrictEqual(c.args[2] === 'show' ? { timeoutMs: 20_000, maxOutputBytes: MB2 + 1 } : { timeoutMs: 20_000 });
      // every object handed to git is a full commit sha, a colon, then the path
      for (const a of c.args.slice(2)) if (a.includes(':') && !a.endsWith('^{commit}')) expect(a).toMatch(/^[0-9a-f]{40}:[^-]/);
    }
  });

  it('for any text the parser accepts, git only ever sees its own flags', async () => {
    const citeish = fc
      .tuple(
        fc.constantFrom('', '-', 'src/', 'node_modules/@scope/pkg/', 'docs/', 'assets/', '/', '/work/shop-app/src/', '/work/shop-app/', '/etc/'),
        fc.constantFrom('session.ts', 'new.ts', 'index.js', 'huge.log', 'logo.bin', 'x', '--x'),
        fc.constantFrom(':1', ':5', ':1-8', ':9', ':3-2', ':0'),
        fc.constantFrom('', '@75c7b13', '@1a2b3c4', '@deadbee', '@-abc1234', '@HEAD'),
        fc.constantFrom('', ' "minted online"', ' "nope"')
      )
      .map((parts) => parts.join(''));
    await fc.assert(
      fc.asyncProperty(citeish, async (text) => {
        const h = harness();
        const cite = parseCite(text);
        if (cite) await groundCite(h.run, DIR, cite);
        for (const c of h.calls) for (const a of c.args) if (a.startsWith('-')) expect(OWN_FLAGS.has(a)).toBe(true);
        // and an object is a full sha and a repo path: an absolute path never gets that far
        for (const c of h.calls) for (const a of c.args.slice(2)) if (/^[0-9a-f]{40}:/.test(a)) expect(a.slice(41).startsWith('/')).toBe(false);
      }),
      { numRuns: 300 }
    );
  });
});
