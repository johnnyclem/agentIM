import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildStandup, orderLightningRows, renderStandupText, standupWindow, type BoardItem, type Lane, type SessionActivity, type Standup, type StandupDeps, type StandupOptions } from '../src/standup.js';
import type { Agent } from '../src/agent.js';
import type { RunOptions, RunResult, Runner } from '../src/runner.js';
import type { LedgerRow, RepoRef } from '../src/tbuv-ledger.js';

/** A local time, month 1-based. Built with the local constructor, so every expectation holds in any TZ. */
const local = (y: number, mo: number, d: number, h = 0, mi = 0, s = 0) => new Date(y, mo - 1, d, h, mi, s).getTime();
const unix = (ms: number) => Math.floor(ms / 1000);
/** Tuesday 2026-10-27 09:00: the standup covers Monday 2026-10-26, the window [Mon 00:00, Tue 00:00). */
const NOW = local(2026, 10, 27, 9, 0);
const mon = (h: number, mi = 0) => local(2026, 10, 26, h, mi);

const SHOP: RepoRef = { name: 'shop-app', path: '/work/shop-app' };
const BILLING: RepoRef = { name: 'billing', path: '/work/billing' };

interface Call {
  cmd: string;
  args: string[];
  opts?: RunOptions;
}
const ok = (stdout = ''): RunResult => ({ code: 0, stdout, stderr: '' });
const fail = (code = 128): RunResult => ({ code, stdout: '', stderr: 'fatal: not a git repository' });

type Answer = string | RunResult | Error;
interface World {
  /** repo path to for-each-ref output */
  refs: Record<string, Answer>;
  /** cwd to `rev-parse --abbrev-ref HEAD` */
  heads: Record<string, Answer>;
  /** cwd to `rev-parse --git-common-dir` */
  common: Record<string, Answer>;
  /** `<repo path>|<ref>:<file>` to the file (git show) */
  files: Record<string, Answer>;
  /** git is not installed: every call throws */
  noGit: boolean;
}

/** A runner keyed on argv. Unknown questions fail with 128. Every call yields once, so calls made together overlap and calls made one after another do not. */
function fakeGit(world: Partial<World> = {}) {
  const calls: Call[] = [];
  const events: string[] = [];
  const reply = (table: Record<string, Answer> | undefined, key: string): RunResult => {
    const v = table?.[key];
    if (v === undefined) return fail();
    if (v instanceof Error) throw v;
    return typeof v === 'string' ? ok(v) : v;
  };
  const run: Runner = async (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    const [flag, path, sub, a] = args;
    const kind = sub === 'rev-parse' ? (a === '--abbrev-ref' ? 'abbrev-ref' : 'common-dir') : sub;
    events.push(`start ${kind} ${path}`);
    await new Promise<void>((r) => setImmediate(r));
    events.push(`end ${kind} ${path}`);
    if (world.noGit) throw new Error('spawn git ENOENT');
    if (flag !== '-C') return fail(129);
    if (sub === 'for-each-ref') return reply(world.refs, path);
    if (kind === 'abbrev-ref') return reply(world.heads, path);
    if (kind === 'common-dir') return reply(world.common, path);
    if (sub === 'show') return reply(world.files, `${path}|${a}`);
    return fail(129);
  };
  /** How many calls of one kind had started before the first of them finished: all of them when concurrent, one when sequential. */
  const startedBeforeFirstEnd = (kind: string) => {
    const mine = events.filter((e) => e.split(' ')[1] === kind);
    const firstEnd = mine.findIndex((e) => e.startsWith('end '));
    return mine.slice(0, firstEnd < 0 ? mine.length : firstEnd).filter((e) => e.startsWith('start ')).length;
  };
  const callsOf = (sub: string) => calls.filter((c) => c.args[2] === sub || (sub === 'abbrev-ref' && c.args[3] === '--abbrev-ref') || (sub === 'common-dir' && c.args[3] === '--git-common-dir'));
  return { run, calls, events, startedBeforeFirstEnd, callsOf };
}

const refLine = (ref: string, ms: number, subject = '', sha = 'a1b2c3d') => `${ref}\t${unix(ms)}\t${sha}\t${subject}`;
const head = (name: string, ms: number, subject = '') => refLine(`refs/heads/${name}`, ms, subject);
const remote = (name: string, ms: number, subject = '', origin = 'origin') => refLine(`refs/remotes/${origin}/${name}`, ms, subject);
const refs = (...lines: string[]) => lines.join('\n') + '\n';

const jsonl = (...rows: object[]) => rows.map((r) => JSON.stringify(r)).join('\n') + '\n';
const ledger = (repo: RepoRef, files: { unverified?: string; tombstones?: string }, ref = 'wiki'): Record<string, Answer> => ({
  ...(files.unverified !== undefined && { [`${repo.path}|${ref}:unverified.jsonl`]: files.unverified }),
  ...(files.tombstones !== undefined && { [`${repo.path}|${ref}:tombstones.jsonl`]: files.tombstones }),
});

const agent = (id: string, over: Partial<Agent> = {}): Agent => ({ sessionID: id, pid: 100, name: `agent-${id}`, cwd: `/work/${id}`, kind: 'interactive', status: 'idle', startedAt: NOW - 3_600_000, ...over });
const stopped = (id: string, over: Partial<Agent> = {}): Agent => {
  const a = agent(id, over);
  delete a.pid;
  delete a.status;
  return a;
};
const NONE: SessionActivity = { lastAt: null, lastStatus: null, lastScope: null };
const activityOf =
  (table: Record<string, Partial<SessionActivity> | Error> = {}) =>
  async (a: Agent): Promise<SessionActivity> => {
    const t = table[a.sessionID];
    if (t instanceof Error) throw t;
    return { ...NONE, ...t };
  };

async function build(world: Partial<World> = {}, extra: { deps?: Partial<StandupDeps>; opts?: StandupOptions; now?: number } = {}) {
  const git = fakeGit(world);
  const deps: StandupDeps = { clock: () => extra.now ?? NOW, run: git.run, repos: [SHOP], agents: [], activity: activityOf(), ...extra.deps };
  const standup = await buildStandup(deps, extra.opts);
  return { standup, ...git };
}

const lane = (s: Standup, l: Lane): BoardItem[] => s.board.filter((i) => i.lane === l);
const titles = (s: Standup, l: Lane) => lane(s, l).map((i) => i.title);
const item = (s: Standup, id: string): BoardItem => {
  const found = s.board.find((i) => i.id === id);
  expect(found, `board item ${id}`).toBeDefined();
  return found as BoardItem;
};
const chipOf = (s: Standup, id: 'git' | 'ledger' | 'sessions') => s.sources.find((c) => c.id === id);

describe('standupWindow', () => {
  // The week of Monday 2026-10-26, run at 09:00 local.
  it.each([
    ['Monday looks back over the weekend to Friday', local(2026, 10, 26, 9), '2026-10-23', '2026-10-25', '2026-10-26', local(2026, 10, 23), local(2026, 10, 26)],
    ['Tuesday covers Monday', local(2026, 10, 27, 9), '2026-10-26', '2026-10-26', '2026-10-27', local(2026, 10, 26), local(2026, 10, 27)],
    ['Wednesday covers Tuesday', local(2026, 10, 28, 9), '2026-10-27', '2026-10-27', '2026-10-28', local(2026, 10, 27), local(2026, 10, 28)],
    ['Thursday covers Wednesday', local(2026, 10, 29, 9), '2026-10-28', '2026-10-28', '2026-10-29', local(2026, 10, 28), local(2026, 10, 29)],
    ['Friday covers Thursday', local(2026, 10, 30, 9), '2026-10-29', '2026-10-29', '2026-10-30', local(2026, 10, 29), local(2026, 10, 30)],
    ['Saturday covers Friday', local(2026, 10, 31, 9), '2026-10-30', '2026-10-30', '2026-10-31', local(2026, 10, 30), local(2026, 10, 31)],
    ['Sunday covers Friday, up to Sunday 00:00, so through is Saturday', local(2026, 11, 1, 9), '2026-10-30', '2026-10-31', '2026-11-01', local(2026, 10, 30), local(2026, 11, 1)],
  ])('%s', (_label, now, covering, through, run, start, end) => {
    expect(standupWindow(now)).toEqual({ covering, through, run, start, end });
  });

  it('the run date is the local date of now, whatever the time of day', () => {
    const early = standupWindow(local(2026, 10, 27, 0, 0, 0));
    const late = standupWindow(local(2026, 10, 27, 23, 59, 59));
    expect(early).toEqual(late);
    expect(early.run).toBe('2026-10-27');
    expect(early.covering).toBe('2026-10-26');
  });

  it.each([
    ['month boundary, Monday', local(2026, 11, 2, 9), '2026-10-30', '2026-11-01', '2026-11-02', local(2026, 10, 30), local(2026, 11, 2)],
    ['month boundary, Wednesday', local(2026, 7, 1, 9), '2026-06-30', '2026-06-30', '2026-07-01', local(2026, 6, 30), local(2026, 7, 1)],
    ['year boundary, Friday', local(2027, 1, 1, 9), '2026-12-31', '2026-12-31', '2027-01-01', local(2026, 12, 31), local(2027, 1, 1)],
    ['year boundary, Monday', local(2029, 1, 1, 9), '2028-12-29', '2028-12-31', '2029-01-01', local(2028, 12, 29), local(2029, 1, 1)],
    ['leap day', local(2028, 3, 1, 9), '2028-02-29', '2028-02-29', '2028-03-01', local(2028, 2, 29), local(2028, 3, 1)],
  ])('%s', (_label, now, covering, through, run, start, end) => {
    expect(standupWindow(now)).toEqual({ covering, through, run, start, end });
  });

  it('both ends are local midnights, never a fixed number of hours apart (the clocks change on 2026-11-01 in some zones)', () => {
    for (const now of [local(2026, 10, 26, 9), local(2026, 11, 2, 9), local(2026, 3, 9, 9), local(2026, 11, 1, 12)]) {
      const w = standupWindow(now);
      for (const edge of [w.start, w.end]) {
        const d = new Date(edge);
        expect([d.getHours(), d.getMinutes(), d.getSeconds(), d.getMilliseconds()]).toEqual([0, 0, 0, 0]);
      }
    }
    // Monday 2026-11-02 reaches back to Friday 2026-10-30 00:00 across the clock change in the zones that have one.
    const w = standupWindow(local(2026, 11, 2, 9));
    expect(w.end).toBe(new Date(2026, 10, 2).getTime());
    expect(w.start).toBe(new Date(2026, 9, 30).getTime());
  });

  it('an explicit date is a window of that one local day and through equals covering', () => {
    expect(standupWindow(NOW, '2026-10-26')).toEqual({ covering: '2026-10-26', through: '2026-10-26', run: '2026-10-27', start: local(2026, 10, 26), end: local(2026, 10, 27) });
    // a weekend day is taken as asked, not moved to a weekday
    expect(standupWindow(NOW, '2026-10-24')).toMatchObject({ covering: '2026-10-24', through: '2026-10-24', start: local(2026, 10, 24), end: local(2026, 10, 25) });
  });

  it.each([
    ['2026-10-31', local(2026, 11, 1)],
    ['2026-12-31', local(2027, 1, 1)],
    ['2028-02-29', local(2028, 3, 1)],
    ['2026-02-28', local(2026, 3, 1)],
  ])('the day after the explicit date %s is the next local midnight', (covering, end) => {
    expect(standupWindow(NOW, covering).end).toBe(end);
  });

  it.each([
    '2026-02-30',
    '2027-02-29',
    '2026-04-31',
    '2026-13-01',
    '2026-00-10',
    '2026-10-00',
    '2026-10-32',
    '26-10-26',
    '2026/10/26',
    '2026-1-5',
    '20261026',
    ' 2026-10-26',
    '2026-10-26 ',
    '2026-10-26\n',
    '2026-10-26T09:00',
    'tomorrow',
    '',
    '0050-01-01',
  ])('rejects %j', (covering) => {
    expect(() => standupWindow(NOW, covering)).toThrow(Error);
    expect(() => standupWindow(NOW, covering)).toThrow(/^covering must be/);
  });

  it('rejects a covering that is not a string', () => {
    expect(() => standupWindow(NOW, 20261026 as unknown as string)).toThrow(/^covering must be/);
    expect(() => standupWindow(NOW, null as unknown as string)).toThrow(/^covering must be/);
  });
});

describe('the local git source', () => {
  it('counts a branch only when its commit date is in [windowStart, windowEnd)', async () => {
    const { standup } = await build({
      refs: {
        [SHOP.path]: refs(
          head('pushed-this-morning', local(2026, 10, 27, 8, 30)),
          head('at-window-end', local(2026, 10, 27, 0, 0, 0)),
          head('in-last-second', local(2026, 10, 26, 23, 59, 59)),
          head('feat/upload-session', mon(15)),
          head('at-window-start', local(2026, 10, 26, 0, 0, 0)),
          head('before-window', local(2026, 10, 25, 23, 59, 59)),
          head('older', local(2026, 10, 23, 12))
        ),
      },
    });
    expect(titles(standup, 'triage')).toEqual(['in-last-second', 'feat/upload-session', 'at-window-start']);
    expect(lane(standup, 'triage').map((i) => i.at)).toEqual([local(2026, 10, 26, 23, 59, 59), mon(15), local(2026, 10, 26, 0, 0, 0)]);
    expect(chipOf(standup, 'git')).toEqual({ id: 'git', label: 'Local git', count: 3 });
    expect(standup.windowStart).toBe(local(2026, 10, 26));
    expect(standup.windowEnd).toBe(local(2026, 10, 27));
  });

  it('a Monday run reaches back to Friday 00:00 and stops before Monday 00:00', async () => {
    const { standup } = await build(
      {
        refs: {
          [SHOP.path]: refs(
            head('monday-morning', local(2026, 10, 26, 7)),
            head('sunday-night', local(2026, 10, 25, 22)),
            head('saturday', local(2026, 10, 24, 11)),
            head('friday-start', local(2026, 10, 23, 0, 0, 0)),
            head('thursday-night', local(2026, 10, 22, 23, 59, 59))
          ),
        },
      },
      { now: local(2026, 10, 26, 9) }
    );
    expect(titles(standup, 'triage')).toEqual(['sunday-night', 'saturday', 'friday-start']);
    expect(standup.covering).toBe('2026-10-23');
    expect(standup.through).toBe('2026-10-25');
  });

  it('an explicit covering date reads that one day only', async () => {
    const { standup } = await build(
      { refs: { [SHOP.path]: refs(head('on-the-day', local(2026, 10, 24, 10)), head('day-after', local(2026, 10, 25, 10)), head('day-before', local(2026, 10, 23, 10))) } },
      { opts: { covering: '2026-10-24' } }
    );
    expect(titles(standup, 'triage')).toEqual(['on-the-day']);
    expect([standup.covering, standup.through, standup.run]).toEqual(['2026-10-24', '2026-10-24', '2026-10-27']);
  });

  it('asks git once per repo with the exact argv and a 20 s timeout, all repos at once', async () => {
    const { calls, callsOf, startedBeforeFirstEnd } = await build({}, { deps: { repos: [SHOP, BILLING] } });
    const reads = callsOf('for-each-ref');
    expect(reads.map((c) => c.args)).toEqual([
      ['-C', '/work/shop-app', 'for-each-ref', '--sort=-committerdate', '--format=%(refname)%09%(committerdate:unix)%09%(objectname:short)%09%(subject)', 'refs/heads', 'refs/remotes'],
      ['-C', '/work/billing', 'for-each-ref', '--sort=-committerdate', '--format=%(refname)%09%(committerdate:unix)%09%(objectname:short)%09%(subject)', 'refs/heads', 'refs/remotes'],
    ]);
    expect(reads.every((c) => c.cmd === 'git' && c.opts?.timeoutMs === 20_000)).toBe(true);
    expect(reads.map((c) => c.opts)).toEqual([{ timeoutMs: 20_000, maxOutputBytes: 4 * 1024 * 1024 }, { timeoutMs: 20_000, maxOutputBytes: 4 * 1024 * 1024 }]); // the runner stops reading there
    expect(startedBeforeFirstEnd('for-each-ref')).toBe(2);
    expect(calls.every((c) => c.cmd === 'git')).toBe(true);
  });

  it('skips HEAD, the default branches and the ledger ref, local or remote, however recent', async () => {
    const t = mon(10);
    const { standup } = await build({
      refs: {
        [SHOP.path]: refs(
          head('main', t),
          head('master', t),
          head('develop', t),
          head('trunk', t),
          head('wiki', t),
          head('HEAD', t),
          remote('main', t),
          remote('wiki', t),
          remote('HEAD', t),
          remote('trunk', t, '', 'upstream'),
          head('feat/real', t),
          head('main-menu-rework', t),
          head('release/main', t)
        ),
      },
    });
    expect(titles(standup, 'triage').sort()).toEqual(['feat/real', 'main-menu-rework', 'release/main']);
    expect(chipOf(standup, 'git')?.count).toBe(3);
  });

  it('defaultBranches replaces the default list and ledgerRef names the branch to skip', async () => {
    const t = mon(10);
    const world = { refs: { [SHOP.path]: refs(head('main', t), head('release', t), head('wiki', t), head('notes', t)) } };
    const custom = await build(world, { opts: { defaultBranches: ['release'], ledgerRef: 'notes' } });
    expect(titles(custom.standup, 'triage').sort()).toEqual(['main', 'wiki']);
  });

  it('origin/x and x are one branch: the newest ref speaks for it, whichever side it is on', async () => {
    const newerRemote = await build({ refs: { [SHOP.path]: refs(remote('feat/x', mon(12), 'remote subject'), head('feat/x', mon(10), 'local subject')) } });
    expect(lane(newerRemote.standup, 'triage')).toHaveLength(1);
    expect(newerRemote.standup.board[0]).toMatchObject({ id: 'branch:shop-app:feat/x', title: 'feat/x', detail: 'remote subject', at: mon(12) });
    expect(chipOf(newerRemote.standup, 'git')?.count).toBe(1);

    const newerLocal = await build({ refs: { [SHOP.path]: refs(head('feat/x', mon(14), 'local subject'), remote('feat/x', mon(9), 'remote subject')) } });
    expect(newerLocal.standup.board[0]).toMatchObject({ title: 'feat/x', detail: 'local subject', at: mon(14) });

    // two remotes and a local one: still one branch; only the first path component of the remote ref is dropped
    const three = await build({ refs: { [SHOP.path]: refs(remote('feat/x', mon(9), '', 'origin'), remote('feat/x', mon(11), 'fork', 'fork'), head('feat/x', mon(8))) } });
    expect(titles(three.standup, 'triage')).toEqual(['feat/x']);
    expect(three.standup.board[0].detail).toBe('fork');
    expect(chipOf(three.standup, 'git')?.count).toBe(1);
  });

  it('a stale local ref does not hide a remote ref that is in the window, and the reverse', async () => {
    const remoteIn = await build({ refs: { [SHOP.path]: refs(remote('feat/x', mon(12)), head('feat/x', local(2026, 10, 20, 12))) } });
    expect(remoteIn.standup.board[0]).toMatchObject({ title: 'feat/x', at: mon(12) });
    const localIn = await build({ refs: { [SHOP.path]: refs(head('feat/y', mon(12)), remote('feat/y', local(2026, 10, 20, 12))) } });
    expect(localIn.standup.board[0]).toMatchObject({ title: 'feat/y', at: mon(12) });
    const neither = await build({ refs: { [SHOP.path]: refs(head('feat/z', local(2026, 10, 20, 12)), remote('feat/z', local(2026, 10, 21, 12))) } });
    expect(neither.standup.board).toEqual([]);
  });

  it('reads malformed output defensively: an empty or missing subject, tabs in a subject, CRLF, blanks, junk, other refs', async () => {
    const t = unix(mon(10));
    const out = [
      `refs/heads/empty-subject\t${t}\tabc1234\t`,
      `refs/heads/no-subject-column\t${t}\tabc1234`,
      `refs/heads/tabs-in-subject\t${t}\tabc1234\tfix:\tgreat\tmerge`,
      '',
      '   ',
      'junk without any tab',
      `refs/heads/bad-date\tsoon\tabc1234\tx`,
      `refs/heads/negative-date\t-5\tabc1234\tx`,
      `refs/heads/empty-date\t\tabc1234\tx`,
      `refs/tags/v1\t${t}\tabc1234\ttag`,
      `refs/stash\t${t}\tabc1234\tstash`,
      `refs/remotes/origin\t${t}\tabc1234\tx`,
      `refs/heads/\t${t}\tabc1234\tx`,
      `\t${t}\tabc1234\tx`,
      `refs/heads/crlf-branch\t${t}\tabc1234\tsubject`,
    ].join('\r\n');
    const { standup } = await build({ refs: { [SHOP.path]: out + '\r\n' } });
    expect(titles(standup, 'triage').sort()).toEqual(['crlf-branch', 'empty-subject', 'no-subject-column', 'tabs-in-subject']);
    expect(item(standup, 'branch:shop-app:empty-subject')).not.toHaveProperty('detail');
    expect(item(standup, 'branch:shop-app:no-subject-column')).not.toHaveProperty('detail');
    expect(item(standup, 'branch:shop-app:tabs-in-subject').detail).toBe('fix:\tgreat\tmerge');
    expect(item(standup, 'branch:shop-app:crlf-branch').detail).toBe('subject');
    expect(chipOf(standup, 'git')?.count).toBe(4);
  });

  it('a repo that fails is a note, not a zero: one failing repo of two keeps the other, all failing says git unavailable', async () => {
    const good = refs(head('feat/billing-export', mon(10)));
    const oneBad = await build({ refs: { [BILLING.path]: good, [SHOP.path]: fail(128) } }, { deps: { repos: [SHOP, BILLING] } });
    expect(chipOf(oneBad.standup, 'git')).toEqual({ id: 'git', label: 'Local git', count: 1, note: 'git unavailable in 1 of 2 repos' });
    expect(titles(oneBad.standup, 'triage')).toEqual(['feat/billing-export']);

    const threw = await build({ refs: { [BILLING.path]: good, [SHOP.path]: new Error('spawn git ENOENT') } }, { deps: { repos: [SHOP, BILLING] } });
    expect(chipOf(threw.standup, 'git')?.note).toBe('git unavailable in 1 of 2 repos');

    const allBad = await build({ refs: { [BILLING.path]: fail(), [SHOP.path]: fail(1) } }, { deps: { repos: [SHOP, BILLING] } });
    expect(chipOf(allBad.standup, 'git')).toEqual({ id: 'git', label: 'Local git', count: 0, note: 'git unavailable' });
  });

  it('a non-zero exit never has its output read, even if it printed branches', async () => {
    const { standup } = await build({ refs: { [SHOP.path]: { code: 1, stdout: head('looks-fine', mon(10)), stderr: 'boom' } } });
    expect(standup.board).toEqual([]);
    expect(chipOf(standup, 'git')?.note).toBe('git unavailable');
  });

  it('output beyond 4 MiB is unreadable, never a silent prefix of the newest refs', async () => {
    const huge = head('feat/newest', mon(10)) + '\n' + 'x'.repeat(4 * 1024 * 1024);
    const { standup } = await build({ refs: { [SHOP.path]: huge } });
    expect(chipOf(standup, 'git')).toEqual({ id: 'git', label: 'Local git', count: 0, note: 'git unavailable' });
    expect(titles(standup, 'triage')).toEqual([]);
    const justUnder = await build({ refs: { [SHOP.path]: head('feat/newest', mon(10)) + '\n' + 'x'.repeat(1024) } });
    expect(titles(justUnder.standup, 'triage')).toEqual(['feat/newest']);
  });

  it('a listing the runner cut at the cap is unreadable too, whatever prefix of it came back, and does not hide the repo that read fine', async () => {
    const cut: RunResult = { code: 1, stdout: refs(head('feat/newest', mon(10))), stderr: '', truncated: true };
    const one = await build({ refs: { [SHOP.path]: cut } });
    expect(chipOf(one.standup, 'git')).toEqual({ id: 'git', label: 'Local git', count: 0, note: 'git unavailable' });
    expect(titles(one.standup, 'triage')).toEqual([]);
    const two = await build({ refs: { [SHOP.path]: cut, [BILLING.path]: refs(head('feat/billing', mon(11))) } }, { deps: { repos: [SHOP, BILLING] } });
    expect(chipOf(two.standup, 'git')).toEqual({ id: 'git', label: 'Local git', count: 1, note: 'git unavailable in 1 of 2 repos' });
    // a code of 0 does not make a cut listing whole
    const zero = await build({ refs: { [SHOP.path]: { ...cut, code: 0 } } });
    expect(chipOf(zero.standup, 'git')?.note).toBe('git unavailable');
  });

  it('a repo with no refs in the window is a genuine zero, with no note', async () => {
    const { standup } = await build({ refs: { [SHOP.path]: refs(head('older', local(2026, 10, 1))) } });
    expect(chipOf(standup, 'git')).toEqual({ id: 'git', label: 'Local git', count: 0 });
  });
});

describe('ticket keys', () => {
  it('finds ABC-123 in the branch name and the commit subject, in order of appearance', async () => {
    const { standup } = await build({
      refs: {
        [SHOP.path]: refs(head('feat/SHOP-142-retry', mon(16), 'also touches PAY-9'), head('cleanup', mon(15), 'drop the flag (SHOP-77)'), head('plain-branch', mon(14), 'no ticket here'), head('SHOP-142abc', mon(13), 'glued to letters')),
      },
    });
    expect(item(standup, 'branch:shop-app:SHOP-142')).toMatchObject({ title: 'feat/SHOP-142-retry', refs: ['SHOP-142', 'PAY-9'] });
    expect(item(standup, 'branch:shop-app:SHOP-77')).toMatchObject({ title: 'cleanup', refs: ['SHOP-77'] });
    expect(item(standup, 'branch:shop-app:plain-branch').refs).toEqual([]);
    expect(item(standup, 'branch:shop-app:SHOP-142abc').refs).toEqual([]); // the digits run into letters: not a key
  });

  it('a hyphenated key must be written in capitals, unless its prefix is configured: lowercase words with a number are not tickets', async () => {
    const world = { refs: { [SHOP.path]: refs(head('feat/shop-142-retry', mon(16), 'also touches pay-9'), head('Feat/Shop-77', mon(15), 'mixed case')) } };
    const without = await build(world);
    expect(without.standup.board.map((i) => i.refs)).toEqual([[], []]);
    expect(without.standup.lanes.triage).toBe(2);
    const configured = await build(world, { opts: { ticketPrefixes: ['SHOP'] } }); // any case, once the prefix is named
    expect(item(configured.standup, 'branch:shop-app:SHOP-142')).toMatchObject({ title: 'feat/shop-142-retry', refs: ['SHOP-142'] });
    expect(item(configured.standup, 'branch:shop-app:SHOP-77')).toMatchObject({ title: 'Feat/Shop-77', refs: ['SHOP-77'] });
  });

  it('words and versions with a hyphen and a number do not merge unrelated branches', async () => {
    const t = mon(10);
    const names = ['fix/utf-8-bom', 'feat/utf-8-output', 'fix/off-by-1', 'feat/release-2026', 'chore/release-2027', 'fix/sha-256-hash', 'chore/node-18-upgrade', 'chore/node-20-upgrade'];
    const { standup } = await build({ refs: { [SHOP.path]: refs(...names.map((n, i) => head(n, t - i * 1000))) } });
    expect(lane(standup, 'triage')).toHaveLength(names.length);
    expect(lane(standup, 'triage').every((i) => i.refs.length === 0 && !i.detail)).toBe(true); // nothing was merged, so there is no "+N more"
    expect(standup.lanes.triage).toBe(names.length);
  });

  it('a session whose name has a lowercase word-and-number joins nothing', async () => {
    const world = { refs: { [SHOP.path]: refs(head('feat/retry-3-cleanup', mon(15)), head('feat/RETRY-3-other', mon(14))) } };
    const agents = [agent('A1', { name: 'retry-3 cleanup', cwd: '/work/shop-app' })];
    const { standup } = await build(world, { deps: { agents } });
    expect(lane(standup, 'triage').map((i) => [i.title, i.sessionIDs, i.tint])).toEqual([
      ['feat/retry-3-cleanup', undefined, 'blue'],
      ['feat/RETRY-3-other', undefined, 'blue'],
    ]);
  });

  it('prefixes that are never tickets make no key, written in capitals or configured: UTF-8, SHA-256, CVE-2021-44228 and the like', async () => {
    const t = mon(10);
    const subjects = ['Fix UTF-8 handling', 'use SHA-256', 'ISO-8601 dates', 'RFC-2119 words', 'AES-128 keys', 'RSA-2048 keys', 'TLS-13 only', 'SSL-3 off', 'HTTP-2 on', 'HTTPS-443', 'WCAG-22 pass', 'IPV-6 ready', 'MD-5 gone', 'X-86 port', 'V-8 engine', 'Fix CVE-2021-44228'];
    const world = { refs: { [SHOP.path]: refs(...subjects.map((sub, i) => head(`b${i}`, t - i * 1000, sub))) } };
    const plain = await build(world);
    expect(plain.standup.board.map((i) => i.refs)).toEqual(subjects.map(() => []));
    expect(plain.standup.lanes.triage).toBe(subjects.length);
    const configured = await build(world, { opts: { ticketPrefixes: ['utf', 'sha', 'iso', 'cve', 'x', 'v', 'http'] } });
    expect(configured.standup.board.map((i) => i.refs)).toEqual(subjects.map(() => []));
    const unhyphenated = await build({ refs: { [SHOP.path]: refs(head('feat/utf8-sha256-v8-x86', t)) } }, { opts: { ticketPrefixes: ['utf', 'sha', 'v', 'x'] } });
    expect(unhyphenated.standup.board[0].refs).toEqual([]);
  });

  it('a prefix near a denied one is a ticket: only the exact names are denied', async () => {
    const { standup } = await build({ refs: { [SHOP.path]: refs(head('feat/UTFX-8', mon(10)), head('feat/SHAKE-2', mon(9)), head('feat/ISOS-1', mon(8))) } });
    expect(standup.board.map((i) => i.refs)).toEqual([['UTFX-8'], ['SHAKE-2'], ['ISOS-1']]);
  });

  it('reads the unhyphenated form only for a configured prefix, case-insensitively', async () => {
    const world = { refs: { [SHOP.path]: refs(head('fix/shop4417-mask', mon(10))) } };
    const without = await build(world);
    expect(without.standup.board[0]).toMatchObject({ id: 'branch:shop-app:fix/shop4417-mask', refs: [] });
    const wrongPrefix = await build(world, { opts: { ticketPrefixes: ['pay'] } });
    expect(wrongPrefix.standup.board[0].refs).toEqual([]);
    for (const prefixes of [['shop'], ['SHOP'], ['SHOP-'], [' shop ']]) {
      const withPrefix = await build(world, { opts: { ticketPrefixes: prefixes } });
      expect(withPrefix.standup.board[0]).toMatchObject({ id: 'branch:shop-app:SHOP-4417', title: 'fix/shop4417-mask', refs: ['SHOP-4417'] });
    }
  });

  it('the prefix form needs a non-alphanumeric or string boundary on both sides', async () => {
    const names = ['shop12', 'SHOP99', 'chore_shop13_cleanup', 'x/shop14-y', 'reshop15', 'shop16x', 'xshop17y', 'shop', 'shop-', 'shops18'];
    const { standup } = await build(
      { refs: { [SHOP.path]: refs(...names.map((n, i) => head(n, mon(20 - i)))) } },
      { opts: { ticketPrefixes: ['shop'] } }
    );
    const refsOf = Object.fromEntries(lane(standup, 'triage').map((i) => [i.title, i.refs]));
    expect(refsOf).toEqual({
      shop12: ['SHOP-12'],
      SHOP99: ['SHOP-99'],
      chore_shop13_cleanup: ['SHOP-13'],
      'x/shop14-y': ['SHOP-14'],
      reshop15: [],
      shop16x: [],
      xshop17y: [],
      shop: [],
      'shop-': [],
      shops18: [],
    });
  });

  it('sha256 and utf8 are never keys unless their prefix is configured', async () => {
    const world = { refs: { [SHOP.path]: refs(head('feat/sha256-utf8-fix', mon(10), 'use sha256 and utf8 everywhere')) } };
    expect((await build(world)).standup.board[0].refs).toEqual([]);
    expect((await build(world, { opts: { ticketPrefixes: ['shop'] } })).standup.board[0].refs).toEqual([]);
    // naming a prefix is what makes the unhyphenated form a key
    const node = { refs: { [SHOP.path]: refs(head('chore/node18-upgrade', mon(10)), head('chore/node20-upgrade', mon(9))) } };
    expect((await build(node)).standup.board.map((i) => i.refs)).toEqual([[], []]);
    expect((await build(node, { opts: { ticketPrefixes: ['node'] } })).standup.board.map((i) => i.refs)).toEqual([['NODE-18'], ['NODE-20']]);
    // ... except for the prefixes that are never tickets
    expect((await build(world, { opts: { ticketPrefixes: ['sha'] } })).standup.board[0].refs).toEqual([]);
  });

  it('a prefix is a literal, not a pattern: metacharacters are escaped and blank prefixes are ignored', async () => {
    const { standup } = await build(
      { refs: { [SHOP.path]: refs(head('abc12', mon(12)), head('a.c13', mon(11)), head('release/2026', mon(10)), head('a-c14', mon(9))) } },
      { opts: { ticketPrefixes: ['a.c', '', '   ', '(', '.*', '['] } }
    );
    const refsOf = Object.fromEntries(lane(standup, 'triage').map((i) => [i.title, i.refs]));
    expect(refsOf).toEqual({ abc12: [], 'a.c13': ['A.C-13'], 'release/2026': [], 'a-c14': [] });
  });
});

describe('the triage join', () => {
  it('branches sharing a ticket key in one repo are one item: titled by the newest, "+1 more", refs merged, raw chip count unchanged', async () => {
    const { standup } = await build({
      refs: {
        [SHOP.path]: refs(
          head('feat/SHOP-142-ui', mon(14), 'ui part'),
          remote('feat/SHOP-142-ui', mon(13), 'older remote ui'),
          head('feat/SHOP-142-api', mon(10), 'api part'),
          head('fix/other-thing', mon(9), 'unrelated')
        ),
      },
    });
    expect(lane(standup, 'triage').map((i) => i.id)).toEqual(['branch:shop-app:SHOP-142', 'branch:shop-app:fix/other-thing']);
    expect(item(standup, 'branch:shop-app:SHOP-142')).toStrictEqual({
      id: 'branch:shop-app:SHOP-142',
      lane: 'triage',
      title: 'feat/SHOP-142-ui',
      detail: '+1 more',
      repo: 'shop-app',
      state: 'branch',
      tint: 'blue',
      refs: ['SHOP-142'],
      sources: ['git'],
      at: mon(14),
    });
    expect(chipOf(standup, 'git')?.count).toBe(3); // raw: three branches
    expect(standup.lanes.triage).toBe(2); // after the join: two items
    expect(item(standup, 'branch:shop-app:fix/other-thing').detail).toBe('unrelated');
  });

  it('the detail counts the other branches: three on one ticket say "+2 more"', async () => {
    const { standup } = await build({ refs: { [SHOP.path]: refs(head('a/SHOP-5', mon(12)), head('b/SHOP-5', mon(11)), head('c/SHOP-5', mon(10))) } });
    expect(standup.board).toHaveLength(1);
    expect(standup.board[0]).toMatchObject({ title: 'a/SHOP-5', detail: '+2 more' });
  });

  it('a chain of shared keys merges transitively, whatever order the branches arrive in', async () => {
    const { standup } = await build({
      refs: {
        [SHOP.path]: refs(
          head('feat/SHOP-2-x', mon(16), 'second ticket'),
          head('feat/SHOP-1-y', mon(14), 'first ticket'),
          head('feat/bridge', mon(10), 'relates SHOP-1 and SHOP-2')
        ),
      },
    });
    expect(standup.board).toHaveLength(1);
    expect(standup.board[0]).toMatchObject({ title: 'feat/SHOP-2-x', detail: '+2 more', id: 'branch:shop-app:SHOP-2' });
    expect(standup.board[0].refs.sort()).toEqual(['SHOP-1', 'SHOP-2']);
    expect(chipOf(standup, 'git')?.count).toBe(3);
  });

  it('the same ticket in two repos stays two items, and branches without a key never merge', async () => {
    const { standup } = await build(
      {
        refs: {
          [SHOP.path]: refs(head('feat/SHOP-142-ui', mon(14)), head('spike-a', mon(12)), head('spike-b', mon(11))),
          [BILLING.path]: refs(head('feat/SHOP-142-ledger', mon(13))),
        },
      },
      { deps: { repos: [SHOP, BILLING] } }
    );
    expect(lane(standup, 'triage').map((i) => i.id).sort()).toEqual(['branch:billing:SHOP-142', 'branch:shop-app:SHOP-142', 'branch:shop-app:spike-a', 'branch:shop-app:spike-b']);
    expect(standup.lanes.triage).toBe(4);
  });

  it('joins a session whose checkout is on one of the branches: sessionIDs, sources, and one branch lookup per distinct checkout', async () => {
    const a = agent('A1', { cwd: '/work/shop-app', name: 'upload fixer' });
    const b = agent('B2', { cwd: '/work/shop-app', name: 'second window' });
    const { standup, callsOf, startedBeforeFirstEnd } = await build(
      { refs: { [SHOP.path]: refs(head('feat/upload-session', mon(15), 'reuse the session id minted online'), head('cleanup', mon(9))) }, heads: { '/work/shop-app': 'feat/upload-session\n' } },
      { deps: { agents: [a, b] } }
    );
    expect(item(standup, 'branch:shop-app:feat/upload-session')).toStrictEqual({
      id: 'branch:shop-app:feat/upload-session',
      lane: 'triage',
      title: 'feat/upload-session',
      detail: 'reuse the session id minted online',
      repo: 'shop-app',
      state: 'branch',
      tint: 'blue',
      refs: [],
      sources: ['git', 'sessions'],
      sessionIDs: ['A1', 'B2'],
      at: mon(15),
    });
    expect(item(standup, 'branch:shop-app:cleanup')).not.toHaveProperty('sessionIDs');
    expect(item(standup, 'branch:shop-app:cleanup').sources).toEqual(['git']);
    const lookups = callsOf('abbrev-ref');
    expect(lookups).toHaveLength(1);
    expect(lookups[0].args).toEqual(['-C', '/work/shop-app', 'rev-parse', '--abbrev-ref', 'HEAD']);
    expect(lookups[0].opts).toEqual({ timeoutMs: 20_000 });
    expect(startedBeforeFirstEnd('abbrev-ref')).toBe(1);
  });

  it('looks up distinct checkouts concurrently', async () => {
    const agents = [agent('A1', { cwd: '/work/shop-app' }), agent('A2', { cwd: '/work/shop-app/api' }), agent('A3', { cwd: '/work/billing' })];
    const { startedBeforeFirstEnd, callsOf } = await build({}, { deps: { repos: [SHOP, BILLING], agents } });
    expect(callsOf('abbrev-ref')).toHaveLength(3);
    expect(startedBeforeFirstEnd('abbrev-ref')).toBe(3);
  });

  it('a session on the remote-only branch name joins, since origin/x and x are one branch', async () => {
    const { standup } = await build(
      { refs: { [SHOP.path]: refs(remote('feat/upload-session', mon(15))) }, heads: { '/work/shop-app': 'feat/upload-session' } },
      { deps: { agents: [agent('A1', { cwd: '/work/shop-app' })] } }
    );
    expect(standup.board[0]).toMatchObject({ title: 'feat/upload-session', sessionIDs: ['A1'] });
  });

  it('joins on a ticket key in the session name, by key and not by substring', async () => {
    const world = { refs: { [SHOP.path]: refs(head('feat/SHOP-142-retry', mon(15))) }, heads: { '/work/billing': 'unrelated' } };
    const agents = [
      agent('exact', { name: 'SHOP-142 mask fix', cwd: '/work/shop-app' }),
      agent('lower', { name: 'working on shop-142 retries', cwd: '/work/shop-app' }),
      agent('shorter', { name: 'SHOP-14 other work', cwd: '/work/shop-app' }),
      agent('longer', { name: 'SHOP-1423 other work', cwd: '/work/shop-app' }),
      agent('glued', { name: 'MYSHOP-142 other', cwd: '/work/shop-app' }),
      agent('nokey', { name: 'general helper', cwd: '/work/shop-app' }),
    ];
    const { standup } = await build(world, { deps: { agents } });
    expect(standup.board[0].sessionIDs).toEqual(['exact']); // "shop-142" in lowercase is a word and a number, not a key
    const named = await build(world, { deps: { agents }, opts: { ticketPrefixes: ['shop'] } });
    expect(named.standup.board[0].sessionIDs).toEqual(['exact', 'lower']); // unless the prefix is named
  });

  it('joins the unhyphenated ticket in a session name only when the prefix is configured', async () => {
    const world = { refs: { [SHOP.path]: refs(head('feat/SHOP-142-retry', mon(15))) } };
    const deps = { agents: [agent('A1', { name: 'shop142 retries', cwd: '/work/shop-app' })] };
    expect((await build(world, { deps })).standup.board[0]).not.toHaveProperty('sessionIDs');
    expect((await build(world, { deps, opts: { ticketPrefixes: ['shop'] } })).standup.board[0].sessionIDs).toEqual(['A1']);
  });

  it('never joins across repos, by branch or by ticket', async () => {
    const world = { refs: { [SHOP.path]: refs(head('feat/SHOP-142-retry', mon(15))) }, heads: { '/work/billing': 'feat/SHOP-142-retry' } };
    const { standup } = await build(world, { deps: { repos: [SHOP, BILLING], agents: [agent('B1', { name: 'SHOP-142 in billing', cwd: '/work/billing' })] } });
    expect(standup.board.find((i) => i.lane === 'triage')).not.toHaveProperty('sessionIDs');
    expect(item(standup, 'session:B1').repo).toBe('billing');
  });

  it('a detached HEAD, a failing lookup and a throwing runner join nothing by branch, and the session is still listed', async () => {
    const world: Partial<World> = {
      refs: { [SHOP.path]: refs(head('feat/upload-session', mon(15))) },
      heads: { '/work/shop-app': 'HEAD', '/work/shop-app/api': fail(128), '/work/shop-app/web': new Error('timed out') },
    };
    const agents = [agent('D1', { cwd: '/work/shop-app' }), agent('D2', { cwd: '/work/shop-app/api' }), agent('D3', { cwd: '/work/shop-app/web' }), agent('D4', { cwd: '/work/shop-app/empty' })];
    const { standup } = await build({ ...world, heads: { ...world.heads, '/work/shop-app/empty': '\n' } }, { deps: { agents } });
    expect(standup.board.find((i) => i.lane === 'triage')).not.toHaveProperty('sessionIDs');
    expect(lane(standup, 'agents')).toHaveLength(4);
  });

  it('a stopped session outside the window is not on the board and its checkout is never looked up', async () => {
    const out = stopped('S1', { cwd: '/work/shop-app/old' });
    const inside = stopped('S2', { cwd: '/work/shop-app/new' });
    const { standup, callsOf } = await build({ heads: { '/work/shop-app/new': 'x' } }, { deps: { agents: [out, inside], activity: activityOf({ S1: { lastAt: local(2026, 10, 20) }, S2: { lastAt: mon(10) } }) } });
    expect(lane(standup, 'agents').map((i) => i.id)).toEqual(['session:S2']);
    expect(callsOf('abbrev-ref').map((c) => c.args[1])).toEqual(['/work/shop-app/new']);
  });

  it('a session can join two items: the one it is on and the one its name mentions', async () => {
    const { standup } = await build(
      { refs: { [SHOP.path]: refs(head('feat/upload-session', mon(15)), head('feat/SHOP-9-docs', mon(12))) }, heads: { '/work/shop-app': 'feat/upload-session' } },
      { deps: { agents: [agent('A1', { name: 'SHOP-9 helper', cwd: '/work/shop-app' })] } }
    );
    expect(lane(standup, 'triage').map((i) => i.sessionIDs)).toEqual([['A1'], ['A1']]);
  });

  it('a linked worktree outside the repo directory joins through its common git dir', async () => {
    const world: Partial<World> = {
      refs: { [SHOP.path]: refs(head('feat/upload-session', mon(15))) },
      heads: { '/wt/upload': 'feat/upload-session', '/elsewhere/clone': 'feat/upload-session', '/mirrors/bare': 'feat/upload-session', '/wt/broken': 'feat/upload-session', '/wt/empty': 'feat/upload-session' },
      common: { '/wt/upload': '/work/shop-app/.git\n', '/elsewhere/clone': '.git\n', '/mirrors/bare': '/mirrors/bare.git\n', '/wt/broken': fail(128), '/wt/empty': '\n' },
    };
    const agents = [
      agent('linked', { cwd: '/wt/upload' }),
      agent('other-clone', { cwd: '/elsewhere/clone' }),
      agent('bare', { cwd: '/mirrors/bare' }),
      agent('broken', { cwd: '/wt/broken' }),
      agent('empty', { cwd: '/wt/empty' }),
    ];
    const { standup, callsOf } = await build(world, { deps: { agents } });
    expect(standup.board[0].sessionIDs).toEqual(['linked']);
    expect(item(standup, 'session:linked').repo).toBe('shop-app');
    expect(item(standup, 'session:other-clone').repo).toBe('clone'); // not a known repo: labelled by its folder
    const asked = callsOf('common-dir');
    expect(asked.map((c) => c.args)).toContainEqual(['-C', '/wt/upload', 'rev-parse', '--git-common-dir']);
    expect(asked.every((c) => c.opts?.timeoutMs === 20_000)).toBe(true);
  });

  it('a cwd inside the repo directory needs no common-dir question; a relative common dir is resolved against the cwd', async () => {
    const { standup, callsOf } = await build(
      { refs: { [SHOP.path]: refs(head('feat/upload-session', mon(15))) }, heads: { '/work/shop-app/api': 'feat/upload-session', '/work/shop-app-linked': 'feat/upload-session' }, common: { '/work/shop-app-linked': '../shop-app/.git' } },
      { deps: { agents: [agent('in', { cwd: '/work/shop-app/api' }), agent('rel', { cwd: '/work/shop-app-linked' })] } }
    );
    expect(standup.board[0].sessionIDs).toEqual(['in', 'rel']);
    expect(callsOf('common-dir').map((c) => c.args[1])).toEqual(['/work/shop-app-linked']);
  });

  it('path containment is by resolved path: a shared prefix is not inside, ".." does not climb into a repo, the deepest repo wins', async () => {
    const docs: RepoRef = { name: 'shop-app-docs', path: '/work/shop-app/docs' };
    const agents = [
      agent('prefix', { cwd: '/work/shop-app-2' }),
      agent('climb-out', { cwd: '/work/shop-app/../elsewhere' }),
      agent('climb-in', { cwd: '/work/shop-app/../billing/api' }),
      agent('nested', { cwd: '/work/shop-app/docs/guide' }),
      agent('top', { cwd: '/work/shop-app/src' }),
      agent('slash', { cwd: '/work/shop-app/' }),
    ];
    const { standup } = await build({}, { deps: { repos: [SHOP, BILLING, docs], agents } });
    const repoOf = Object.fromEntries(lane(standup, 'agents').map((i) => [i.id.replace('session:', ''), i.repo]));
    expect(repoOf).toEqual({ prefix: 'shop-app-2', 'climb-out': 'elsewhere', 'climb-in': 'billing', nested: 'shop-app-docs', top: 'shop-app', slash: 'shop-app' });
  });

  it('a cwd that is empty, relative, option-shaped or holds a NUL never reaches git', async () => {
    const hostile = ['', '--upload-pack=touch /tmp/pwned', '-rf', 'relative/dir', '/work/shop-app\0/x'];
    const { standup, calls } = await build({}, { deps: { agents: hostile.map((cwd, i) => agent(`H${i}`, { cwd })) } });
    expect(lane(standup, 'agents')).toHaveLength(hostile.length);
    for (const c of calls) {
      for (const cwd of hostile.filter((h) => h !== '')) expect(c.args).not.toContain(cwd);
      expect(c.args[1]).toMatch(/^\//);
    }
    expect(calls.some((c) => c.args[2] === 'rev-parse')).toBe(false);
  });
});

describe('grouping branches by ticket key', () => {
  /** What an item stands for: how many branches it merged and the keys they carry. */
  const shape = (i: BoardItem) => `${i.repo}:${i.detail?.match(/^\+(\d+) more$/) ? Number(i.detail.match(/^\+(\d+) more$/)?.[1]) + 1 : 1}:${[...i.refs].sort().join(',')}`;

  it('20 000 branches without a key, or each with a key of its own, are 20 000 items, and the standup returns in a fraction of the time it took when every branch scanned every group', async () => {
    const at = mon(10);
    for (const subject of [(i: number) => `subject ${i}`, (i: number) => `PRJ${i}-1 subject`]) {
      const lines = Array.from({ length: 20_000 }, (_, i) => head(`b${i}`, at - i * 1000, subject(i)));
      const started = Date.now();
      const { standup } = await build({ refs: { [SHOP.path]: refs(...lines) } });
      const took = Date.now() - started;
      expect(standup.lanes.triage).toBe(20_000);
      expect(chipOf(standup, 'git')?.count).toBe(20_000);
      expect(took).toBeLessThan(1500);
    }
  });

  it('20 000 branches in chains of shared keys merge into their chains, in the same time', async () => {
    const at = mon(10);
    // branch i carries the keys KEY<i/2>-1 and KEY<i/2+1>-1, so every branch is linked to the next: one chain of 20 000
    const lines = Array.from({ length: 20_000 }, (_, i) => head(`b${i}`, at - i * 1000, `KEY${Math.floor(i / 2)}-1 KEY${Math.floor(i / 2) + 1}-1`));
    const started = Date.now();
    const { standup } = await build({ refs: { [SHOP.path]: refs(...lines) } });
    expect(Date.now() - started).toBeLessThan(1500);
    expect(standup.lanes.triage).toBe(1);
    expect(standup.board[0].detail).toBe('+19999 more');
  });

  it('branches that share a key merge through a third, and keys of different repos never join', async () => {
    const lines = (...l: string[]) => refs(...l);
    const { standup } = await build(
      {
        refs: {
          [SHOP.path]: lines(head('a', mon(20), 'AB-1'), head('b', mon(19), 'CD-2'), head('c', mon(18), 'AB-1 CD-2'), head('d', mon(17), 'EF-3'), head('e', mon(16))),
          [BILLING.path]: lines(head('f', mon(15), 'AB-1'), head('g', mon(14), 'EF-3')),
        },
      },
      { deps: { repos: [SHOP, BILLING] } }
    );
    expect(lane(standup, 'triage').map(shape).sort()).toEqual(['billing:1:AB-1', 'billing:1:EF-3', 'shop-app:1:', 'shop-app:1:EF-3', 'shop-app:3:AB-1,CD-2'].sort());
  });

  it('the group is titled by its newest branch whichever order the branches were read in, and equal times keep the order they were listed in', async () => {
    const t = mon(12);
    const { standup } = await build({ refs: { [SHOP.path]: refs(head('first', t, 'TK-1'), head('second', t, 'TK-1'), head('third', t, 'TK-1')) } });
    expect(standup.board[0]).toMatchObject({ id: 'branch:shop-app:TK-1', title: 'first', detail: '+2 more' });
    const newer = await build({ refs: { [SHOP.path]: refs(head('old', mon(9), 'TK-2'), head('new', mon(14), 'TK-2')) } });
    expect(newer.standup.board[0]).toMatchObject({ title: 'new', detail: '+1 more' });
  });

  it('forms the same groups as a branch-by-branch scan on any mix of keyed and unkeyed branches (property)', async () => {
    const keys = ['AA-1', 'BB-2', 'CC-3', 'DD-4', 'EE-5'];
    const branch = fc.record({ repo: fc.constantFrom(0, 1), keys: fc.subarray(keys, { maxLength: 3 }) });
    await fc.assert(
      fc.asyncProperty(fc.array(branch, { maxLength: 30 }), async (bs) => {
        const repos = [SHOP, BILLING];
        const byRepo = (r: number) => refs(...bs.flatMap((b, i) => (b.repo === r ? [head(`b${i}`, mon(10) - i * 1000, b.keys.join(' '))] : [])));
        const { standup } = await build({ refs: { [SHOP.path]: byRepo(0), [BILLING.path]: byRepo(1) } }, { deps: { repos } });
        // the reference: connected components of "shares a key within a repo"
        const parent = bs.map((_, i) => i);
        const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
        bs.forEach((a, i) => bs.forEach((b, j) => a.repo === b.repo && a.keys.some((k) => b.keys.includes(k)) && (parent[find(i)] = find(j))));
        const comps = new Map<number, number[]>();
        bs.forEach((_, i) => comps.set(find(i), [...(comps.get(find(i)) ?? []), i]));
        const expected = [...comps.values()].map((m) => `${repos[bs[m[0]].repo].name}:${m.length}:${[...new Set(m.flatMap((i) => bs[i].keys))].sort().join(',')}`);
        expect(lane(standup, 'triage').map(shape).sort()).toEqual(expected.sort());
      }),
      { numRuns: 100 }
    );
  });
});

describe('triage tint and order', () => {
  const refsFor = (...names: Array<[string, number]>) => ({ [SHOP.path]: refs(...names.map(([n, t]) => head(n, t))) });

  it.each([
    ['waiting_for_human', 'red'],
    ['gave_up', 'red'],
    ['blocked', 'amber'],
    ['paused', 'amber'],
    ['working', 'blue'],
    ['planning', 'grey'],
    ['done', 'green'],
  ] as const)('a joined session whose last status is %s tints the branch %s', async (lastStatus, tint) => {
    const { standup } = await build(
      { refs: refsFor(['feat/upload-session', mon(15)]), heads: { '/work/shop-app': 'feat/upload-session' } },
      { deps: { agents: [agent('A1', { cwd: '/work/shop-app' })], activity: activityOf({ A1: { lastStatus } }) } }
    );
    expect(standup.board[0].tint).toBe(tint);
  });

  it('takes the worst of several sessions, ignores sessions without a status or on another branch, and defaults to blue', async () => {
    const agents = [agent('done', { cwd: '/work/shop-app/a' }), agent('blocked', { cwd: '/work/shop-app/b' }), agent('quiet', { cwd: '/work/shop-app/c' }), agent('elsewhere', { cwd: '/work/shop-app/d' })];
    const world = {
      refs: refsFor(['feat/upload-session', mon(15)]),
      heads: { '/work/shop-app/a': 'feat/upload-session', '/work/shop-app/b': 'feat/upload-session', '/work/shop-app/c': 'feat/upload-session', '/work/shop-app/d': 'other' },
    };
    const worst = await build(world, { deps: { agents, activity: activityOf({ done: { lastStatus: 'done' }, blocked: { lastStatus: 'blocked' }, elsewhere: { lastStatus: 'waiting_for_human' } }) } });
    expect(worst.standup.board[0]).toMatchObject({ tint: 'amber', sessionIDs: ['done', 'blocked', 'quiet'] });
    const onlyQuiet = await build(world, { deps: { agents: [agents[2]], activity: activityOf() } });
    expect(onlyQuiet.standup.board[0]).toMatchObject({ tint: 'blue', sessionIDs: ['quiet'] });
    const onlyDone = await build(world, { deps: { agents: [agents[0]], activity: activityOf({ done: { lastStatus: 'done' } }) } });
    expect(onlyDone.standup.board[0].tint).toBe('green');
  });

  it('puts red, then amber, ahead of the rest; inside each group the newest activity first', async () => {
    const names: Array<[string, number]> = [['blue-new', mon(20)], ['red-old', mon(8)], ['blue-old', mon(9)], ['amber-new', mon(18)], ['red-new', mon(19)], ['amber-old', mon(7)]];
    const cwd = (n: string) => `/work/shop-app/${n}`;
    const status: Record<string, Partial<SessionActivity>> = { 'red-old': { lastStatus: 'waiting_for_human' }, 'red-new': { lastStatus: 'gave_up' }, 'amber-new': { lastStatus: 'blocked' }, 'amber-old': { lastStatus: 'paused' } };
    const { standup } = await build(
      { refs: refsFor(...names), heads: Object.fromEntries(names.map(([n]) => [cwd(n), n])) },
      { deps: { agents: names.map(([n]) => agent(n, { cwd: cwd(n) })), activity: activityOf(status) } }
    );
    expect(titles(standup, 'triage')).toEqual(['red-new', 'red-old', 'amber-new', 'amber-old', 'blue-new', 'blue-old']);
  });
});

describe('the sessions source', () => {
  it('counts live sessions, and stopped ones only when their last turn is in the window (start inclusive, end exclusive)', async () => {
    const agents = [
      agent('live-idle'),
      agent('live-busy', { status: 'busy' }),
      agent('live-long-ago'),
      stopped('stopped-in', {}),
      stopped('stopped-at-start', {}),
      stopped('stopped-at-end', {}),
      stopped('stopped-before', {}),
      stopped('stopped-after', {}),
      stopped('stopped-never', {}),
    ];
    const { standup } = await build(
      {},
      {
        deps: {
          agents,
          activity: activityOf({
            'live-long-ago': { lastAt: local(2026, 9, 1) },
            'stopped-in': { lastAt: mon(12) },
            'stopped-at-start': { lastAt: local(2026, 10, 26, 0, 0, 0) },
            'stopped-at-end': { lastAt: local(2026, 10, 27, 0, 0, 0) },
            'stopped-before': { lastAt: local(2026, 10, 25, 23, 59, 59) },
            'stopped-after': { lastAt: local(2026, 10, 27, 8) },
          }),
        },
      }
    );
    expect(lane(standup, 'agents').map((i) => i.id).sort()).toEqual(['session:live-busy', 'session:live-idle', 'session:live-long-ago', 'session:stopped-at-start', 'session:stopped-in']);
    expect(chipOf(standup, 'sessions')).toEqual({ id: 'sessions', label: 'Sessions', count: 5 });
    expect(standup.lanes.agents).toBe(5);
  });

  it('awaits every activity at once, and a rejection reads as no activity: a live session stays, a stopped one drops, and the chip says so', async () => {
    const events: string[] = [];
    const agents = [agent('live'), stopped('gone'), stopped('fine'), agent('live-too')];
    const activity = async (a: Agent): Promise<SessionActivity> => {
      events.push(`start ${a.sessionID}`);
      await new Promise<void>((r) => setImmediate(r));
      events.push(`end ${a.sessionID}`);
      if (a.sessionID === 'live' || a.sessionID === 'gone') throw new Error('transcript unreadable');
      return a.sessionID === 'fine' ? { ...NONE, lastAt: mon(10) } : NONE;
    };
    const { standup } = await build({}, { deps: { agents, activity } });
    expect(events.slice(0, 4)).toEqual(['start live', 'start gone', 'start fine', 'start live-too']);
    expect(lane(standup, 'agents').map((i) => i.id).sort()).toEqual(['session:fine', 'session:live', 'session:live-too']);
    expect(chipOf(standup, 'sessions')).toEqual({ id: 'sessions', label: 'Sessions', count: 3, note: 'activity unavailable for 2 of 4 sessions' });
    expect(item(standup, 'session:live').at).toBe(NOW - 3_600_000); // no lastAt: the start time
  });

  it('a session listed twice is on the board once', async () => {
    const { standup } = await build({}, { deps: { agents: [agent('A1'), agent('A1', { name: 'duplicate' })] } });
    expect(lane(standup, 'agents').map((i) => i.title)).toEqual(['agent-A1']);
    expect(chipOf(standup, 'sessions')?.count).toBe(1);
  });

  it('shapes an agent item: title, repo, scope, state, tint, refs and time', async () => {
    const a = agent('S1', { name: 'SHOP-142 mask fix', cwd: '/work/shop-app/api', status: 'busy' });
    const { standup } = await build({}, { deps: { agents: [a], activity: activityOf({ S1: { lastAt: mon(11), lastStatus: 'working', lastScope: '  masking card numbers in the upload log ' } }) } });
    expect(standup.board[0]).toStrictEqual({
      id: 'session:S1',
      lane: 'agents',
      title: 'SHOP-142 mask fix',
      detail: 'masking card numbers in the upload log',
      repo: 'shop-app',
      state: 'working',
      tint: 'blue',
      refs: ['SHOP-142'],
      sources: ['sessions'],
      at: mon(11),
    });
  });

  it('labels a session outside every repo by its folder, and an unnamed one by its folder too', async () => {
    const { standup } = await build({}, { deps: { agents: [agent('S1', { name: '', cwd: '/home/ana/scratch' })] } });
    expect(standup.board[0]).toMatchObject({ title: 'scratch', repo: 'scratch' });
  });

  it.each([
    ['live idle, no status', {}, {}, 'green', 'idle'],
    ['live busy, no status', { status: 'busy' as const }, {}, 'blue', 'working'],
    ['live with no status field at all', { status: undefined }, {}, 'green', 'idle'],
    ['stopped, no status', { pid: undefined, status: undefined }, { lastAt: mon(9) }, 'grey', 'stopped'],
    ['stopped whose last status was done', { pid: undefined, status: undefined }, { lastAt: mon(9), lastStatus: 'done' as const }, 'green', 'stopped'],
    ['live, waiting_for_human', {}, { lastStatus: 'waiting_for_human' as const }, 'red', 'waiting_for_human'],
    ['live, gave_up', {}, { lastStatus: 'gave_up' as const }, 'red', 'gave_up'],
    ['live, blocked', {}, { lastStatus: 'blocked' as const }, 'amber', 'blocked'],
    ['live, paused', {}, { lastStatus: 'paused' as const }, 'amber', 'paused'],
    ['live, planning', {}, { lastStatus: 'planning' as const }, 'grey', 'planning'],
    ['live, done', {}, { lastStatus: 'done' as const }, 'green', 'done'],
    ['busy but last status working', { status: 'busy' as const }, { lastStatus: 'working' as const }, 'blue', 'working'],
    ['busy but last status done: the status wins', { status: 'busy' as const }, { lastStatus: 'done' as const }, 'green', 'done'],
  ])('tint and state: %s', async (_label, over, act, tint, state) => {
    const { standup } = await build({}, { deps: { agents: [agent('S1', over)], activity: activityOf({ S1: act }) } });
    expect(standup.board[0]).toMatchObject({ tint, state });
  });

  it('an activity with a status that is not one of the seven reads as no status', async () => {
    const odd = async (): Promise<SessionActivity> => ({ lastAt: Number.NaN, lastStatus: 'celebrating' as unknown as SessionActivity['lastStatus'], lastScope: '   ' });
    const { standup } = await build({}, { deps: { agents: [agent('S1')], activity: odd } });
    expect(standup.board[0]).toMatchObject({ tint: 'green', state: 'idle', at: NOW - 3_600_000 });
    expect(standup.board[0]).not.toHaveProperty('detail');
  });

  it('orders the lane red, amber, then newest first', async () => {
    const agents = [agent('calm-new'), agent('red-old'), agent('calm-old'), agent('amber-new'), agent('red-new')];
    const { standup } = await build(
      {},
      {
        deps: {
          agents,
          activity: activityOf({
            'calm-new': { lastAt: mon(20) },
            'calm-old': { lastAt: mon(5) },
            'red-old': { lastAt: mon(6), lastStatus: 'waiting_for_human' },
            'amber-new': { lastAt: mon(19), lastStatus: 'blocked' },
            'red-new': { lastAt: mon(18), lastStatus: 'gave_up' },
          }),
        },
      }
    );
    expect(lane(standup, 'agents').map((i) => i.id.replace('session:', ''))).toEqual(['red-new', 'red-old', 'amber-new', 'calm-new', 'calm-old']);
  });
});

describe('a session in a symlinked spelling of a repo', () => {
  it('is found in its repo by the common git dir, because the repo is named by its real path', async () => {
    const base = realpathSync(mkdtempSync(join(tmpdir(), 'agentim-standup-')));
    try {
      const real = join(base, 'real', 'proj');
      mkdirSync(real, { recursive: true });
      symlinkSync(join(base, 'real'), join(base, 'link'), 'dir');
      const cwd = join(base, 'link', 'proj', 'sub'); // the agent's own spelling, outside the repo's real path
      const proj: RepoRef = { name: 'proj', path: real };
      const { standup } = await build({ common: { [cwd]: '../.git' } }, { deps: { repos: [proj], agents: [agent('A1', { cwd })] } });
      expect(standup.board.find((i) => i.id === 'session:A1')).toMatchObject({ repo: 'proj' });
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});

describe('the ledger source and the Lightning lane', () => {
  const uv = (id: string, over: object = {}) => ({ id, date: '2026-10-12', claim: 'offline uploads reuse the session id minted online', doubt: 'never checked against a cold start', ...over });

  it('reads both files of every repo, keeps the open rows only, and shapes a lightning item', async () => {
    const { standup, callsOf } = await build({
      files: ledger(SHOP, {
        unverified: jsonl(uv('UV-0036'), uv('UV-0037', { status: 'settled' }), uv('UV-0038', { superseded_by: 'UV-0040' }), uv('UV-0039', { status: 'parked' }), uv('UV-0041', { status: 'DENIED' })),
        tombstones: jsonl({ id: 'TB-0007', date: '2026-10-01', claim: 'the v1 export path is gone' }, { id: 'TB-0008', status: 'resolved' }),
      }),
    });
    expect(lane(standup, 'lightning').map((i) => i.id).sort()).toEqual(['tb:shop-app:TB-0007', 'uv:shop-app:UV-0036', 'uv:shop-app:UV-0039']);
    expect(item(standup, 'uv:shop-app:UV-0036')).toStrictEqual({
      id: 'uv:shop-app:UV-0036',
      lane: 'lightning',
      title: 'UV-0036 offline uploads reuse the session id minted online',
      detail: 'never checked against a cold start',
      repo: 'shop-app',
      state: 'open',
      tint: 'green',
      refs: [],
      sources: ['ledger'],
      rowKey: 'uv:shop-app:UV-0036',
      at: local(2026, 10, 12),
    });
    expect(chipOf(standup, 'ledger')).toEqual({ id: 'ledger', label: 'Ledger', count: 7 }); // every row read, closed or not
    expect(standup.lanes.lightning).toBe(3); // the open ones
    expect(callsOf('show').map((c) => c.args)).toEqual([
      ['-C', '/work/shop-app', 'show', 'wiki:tombstones.jsonl'],
      ['-C', '/work/shop-app', 'show', 'wiki:unverified.jsonl'],
    ]);
  });

  it('a row with no date has no time, and one with only an id has the id as its title', async () => {
    const { standup } = await build({ files: ledger(SHOP, { unverified: jsonl({ id: 'uv-9' }) }) });
    expect(standup.board[0]).toStrictEqual({ id: 'uv:shop-app:UV-9', lane: 'lightning', title: 'UV-9', repo: 'shop-app', state: 'open', tint: 'green', refs: [], sources: ['ledger'], rowKey: 'uv:shop-app:UV-9' });
  });

  it('rows the decision store hides leave the lane but not the chip, and the callback gets the row key', async () => {
    const asked: string[] = [];
    const hidden = (key: string) => {
      asked.push(key);
      return key === 'uv:shop-app:UV-0036';
    };
    const { standup } = await build({ files: ledger(SHOP, { unverified: jsonl(uv('UV-0036'), uv('UV-0037')) }) }, { opts: { hidden } });
    expect(lane(standup, 'lightning').map((i) => i.id)).toEqual(['uv:shop-app:UV-0037']);
    expect(chipOf(standup, 'ledger')?.count).toBe(2);
    expect(standup.lanes.lightning).toBe(1);
    expect(asked).toContain('uv:shop-app:UV-0036');
    expect(asked).toContain('uv:shop-app:UV-0037');
  });

  it('opens a hidden row again once the callback stops hiding it', async () => {
    let hide = true;
    const world = { files: ledger(SHOP, { unverified: jsonl(uv('UV-0036')) }) };
    const first = await build(world, { opts: { hidden: () => hide } });
    hide = false;
    const second = await build(world, { opts: { hidden: () => hide } });
    expect([first.standup.lanes.lightning, second.standup.lanes.lightning]).toEqual([0, 1]);
  });

  it('reads the configured ledger ref', async () => {
    const { standup, callsOf } = await build({ files: ledger(SHOP, { unverified: jsonl(uv('UV-0036')) }, 'notes') }, { opts: { ledgerRef: 'notes' } });
    expect(callsOf('show').map((c) => c.args[3])).toEqual(['notes:tombstones.jsonl', 'notes:unverified.jsonl']);
    expect(standup.lanes.lightning).toBe(1);
  });

  it('reads every repo, and a repo with no ledger among others is normal and carries no note', async () => {
    const { standup } = await build(
      { files: ledger(BILLING, { unverified: jsonl(uv('UV-0001')) }) },
      { deps: { repos: [SHOP, BILLING] } }
    );
    expect(lane(standup, 'lightning').map((i) => i.id)).toEqual(['uv:billing:UV-0001']);
    expect(chipOf(standup, 'ledger')).toEqual({ id: 'ledger', label: 'Ledger', count: 1 });
  });

  it('no ledger in any repo is a note, not a silent zero', async () => {
    const { standup } = await build({}, { deps: { repos: [SHOP, BILLING] } });
    expect(chipOf(standup, 'ledger')).toEqual({ id: 'ledger', label: 'Ledger', count: 0, note: 'no ledger' });
    // a ledger that exists but holds only closed rows has nothing to open: the chip counts the row it read, the lane is a real zero, and there is no note
    const closed = await build({ files: ledger(SHOP, { unverified: jsonl(uv('UV-1', { status: 'closed' })) }) });
    expect(chipOf(closed.standup, 'ledger')).toEqual({ id: 'ledger', label: 'Ledger', count: 1 });
    expect(closed.standup.lanes.lightning).toBe(0);
  });

  it('the Ledger chip counts every row read and the Lightning lane the open un-hidden ones, like the photo (101 and 98)', async () => {
    const open = Array.from({ length: 6 }, (_, i) => uv(`UV-${i + 1}`));
    const closed = [uv('UV-7', { status: 'settled' }), uv('UV-8', { status: 'Denied' }), uv('UV-9', { superseded_by: 'UV-1' })];
    const hiddenKeys = new Set(['uv:shop-app:UV-1', 'uv:shop-app:UV-2']);
    const { standup } = await build(
      { files: ledger(SHOP, { unverified: jsonl(...open, ...closed), tombstones: jsonl({ id: 'TB-1', claim: 'a', status: 'closed' }) }) },
      { opts: { hidden: (key) => hiddenKeys.has(key) } }
    );
    expect(chipOf(standup, 'ledger')).toEqual({ id: 'ledger', label: 'Ledger', count: 10 });
    expect(standup.lanes.lightning).toBe(4);
    expect(lane(standup, 'lightning').map((i) => i.id).sort()).toEqual(['uv:shop-app:UV-3', 'uv:shop-app:UV-4', 'uv:shop-app:UV-5', 'uv:shop-app:UV-6']);
    expect(renderStandupText(standup)).toContain('Ledger 10 ');
    expect(renderStandupText(standup)).toContain('Lightning 4');
  });

  it('a file too large to read, or git timing out on one, is a note on the chip; the rows of the other file still count', async () => {
    const big: RunResult = { code: 1, stdout: 'partial', stderr: '', truncated: true };
    const slow: RunResult = { code: 1, stdout: '', stderr: '', timedOut: true };
    const files = (tombstones: Answer) => ({ [`${SHOP.path}|wiki:tombstones.jsonl`]: tombstones, ...ledger(SHOP, { unverified: jsonl(uv('UV-1'), uv('UV-2')) }) });
    const tooBig = await build({ files: files(big) });
    expect(chipOf(tooBig.standup, 'ledger')).toEqual({ id: 'ledger', label: 'Ledger', count: 2, note: 'tombstones.jsonl is larger than 2 MiB' });
    expect(tooBig.standup.lanes.lightning).toBe(2);
    const timedOut = await build({ files: files(slow) });
    expect(chipOf(timedOut.standup, 'ledger')).toEqual({ id: 'ledger', label: 'Ledger', count: 2, note: 'git timed out reading tombstones.jsonl' });
    // a file that is merely not there says nothing
    const absent = await build({ files: files(fail()) });
    expect(chipOf(absent.standup, 'ledger')).toEqual({ id: 'ledger', label: 'Ledger', count: 2 });
    expect(renderStandupText(tooBig.standup)).toContain('Ledger 2 (tombstones.jsonl is larger than 2 MiB)');
  });

  it('an unreadable ledger is its own note, not "no ledger"; with several repos the note names the repo, and a fine repo beside it adds nothing', async () => {
    const big: RunResult = { code: 1, stdout: '', stderr: '', truncated: true };
    const only = await build({ files: { [`${SHOP.path}|wiki:unverified.jsonl`]: big } });
    expect(chipOf(only.standup, 'ledger')).toEqual({ id: 'ledger', label: 'Ledger', count: 0, note: 'unverified.jsonl is larger than 2 MiB' });
    const two = await build({ files: { [`${SHOP.path}|wiki:unverified.jsonl`]: big, ...ledger(BILLING, { unverified: jsonl(uv('UV-1')) }) } }, { deps: { repos: [SHOP, BILLING] } });
    expect(chipOf(two.standup, 'ledger')).toEqual({ id: 'ledger', label: 'Ledger', count: 1, note: 'shop-app: unverified.jsonl is larger than 2 MiB' });
  });

  it('asks git for each ledger file with the same cap the reader applies', async () => {
    const { callsOf } = await build({ files: ledger(SHOP, { unverified: jsonl(uv('UV-1')) }) });
    expect(callsOf('show').map((c) => c.opts)).toEqual([
      { timeoutMs: 20_000, maxOutputBytes: 2 * 1024 * 1024 },
      { timeoutMs: 20_000, maxOutputBytes: 2 * 1024 * 1024 },
    ]);
  });

  it('orders the lane: rows dated inside the window first, then the rest, oldest first, undated last', async () => {
    const { standup } = await build(
      {
        files: ledger(SHOP, {
          unverified: jsonl(uv('UV-5', { date: '2026-10-01' }), uv('UV-1', { date: '2026-10-25' }), uv('UV-6', { date: undefined }), uv('UV-2', { date: '2026-10-23' }), uv('UV-4', { date: '2026-09-15' })),
          tombstones: jsonl({ id: 'TB-1', date: '2026-10-24', claim: 'weekend tombstone' }, { id: 'TB-2', date: '2026-10-26', claim: 'monday: outside a Friday-to-Sunday window' }),
        }),
      },
      { now: local(2026, 10, 26, 9) }
    );
    expect(lane(standup, 'lightning').map((i) => i.id.split(':')[2])).toEqual(['UV-2', 'TB-1', 'UV-1', 'UV-4', 'UV-5', 'TB-2', 'UV-6']);
  });

  it('a throwing hidden callback is a ledger note and leaves git and sessions intact', async () => {
    const { standup } = await build(
      { refs: { [SHOP.path]: refs(head('feat/x', mon(10))) }, files: ledger(SHOP, { unverified: jsonl(uv('UV-1')) }) },
      { deps: { agents: [agent('A1')] }, opts: { hidden: () => { throw new Error('store corrupt'); } } }
    );
    expect(chipOf(standup, 'ledger')).toEqual({ id: 'ledger', label: 'Ledger', count: 0, note: 'ledger unavailable' });
    expect(chipOf(standup, 'git')?.count).toBe(1);
    expect(chipOf(standup, 'sessions')?.count).toBe(1);
    expect(standup.lanes).toEqual({ triage: 1, agents: 1, lightning: 0 });
  });

  it('an unsafe ledger ref is never put in a git argument', async () => {
    for (const ledgerRef of ['--output=/tmp/pwned', '-x', 'wiki main', '', 'a\nb']) {
      const { standup, calls } = await build({ files: ledger(SHOP, { unverified: jsonl(uv('UV-1')) }) }, { opts: { ledgerRef } });
      expect(calls.filter((c) => c.args[2] === 'show')).toEqual([]);
      expect(chipOf(standup, 'ledger')).toEqual({ id: 'ledger', label: 'Ledger', count: 0, note: 'no ledger' });
    }
  });
});

describe('the standup as a whole', () => {
  it('has the three chips in order with their labels, raw counts apart from the lane counts, and a board of triage, agents, lightning', async () => {
    const { standup } = await build(
      {
        refs: { [SHOP.path]: refs(head('feat/SHOP-142-ui', mon(14)), head('feat/SHOP-142-api', mon(10)), head('fix/typo', mon(9))) },
        files: ledger(SHOP, { unverified: jsonl({ id: 'UV-1', date: '2026-10-12', claim: 'c' }, { id: 'UV-2', date: '2026-10-13', claim: 'd' }) }),
        heads: { '/work/shop-app': 'feat/SHOP-142-ui' },
      },
      { deps: { agents: [agent('A1', { cwd: '/work/shop-app' }), agent('A2'), agent('A3')] } }
    );
    expect(standup.sources).toEqual([
      { id: 'git', label: 'Local git', count: 3 },
      { id: 'ledger', label: 'Ledger', count: 2 },
      { id: 'sessions', label: 'Sessions', count: 3 },
    ]);
    expect(standup.lanes).toEqual({ triage: 2, agents: 3, lightning: 2 });
    expect(standup.board.map((i) => i.lane)).toEqual(['triage', 'triage', 'agents', 'agents', 'agents', 'lightning', 'lightning']);
    expect(standup.sources[0].count).not.toBe(standup.lanes.triage);
    expect(standup.board.map((i) => i.id)).toHaveLength(new Set(standup.board.map((i) => i.id)).size);
  });

  it('stamps the standup with the clock and the window', async () => {
    const { standup } = await build({});
    expect(standup).toMatchObject({ at: NOW, covering: '2026-10-26', through: '2026-10-26', run: '2026-10-27', windowStart: local(2026, 10, 26), windowEnd: local(2026, 10, 27) });
  });

  it('an invalid covering rejects before git is asked anything', async () => {
    const git = fakeGit();
    const deps: StandupDeps = { clock: () => NOW, run: git.run, repos: [SHOP], agents: [agent('A1')], activity: activityOf() };
    await expect(buildStandup(deps, { covering: '2026-02-30' })).rejects.toThrow(/^covering must be/);
    await expect(buildStandup(deps, { covering: 'yesterday' })).rejects.toThrow(/^covering must be/);
    expect(git.calls).toEqual([]);
  });

  it('git failing leaves the ledger and the sessions intact', async () => {
    const { standup } = await build(
      { refs: { [SHOP.path]: fail(128) }, files: ledger(SHOP, { unverified: jsonl({ id: 'UV-1', claim: 'c' }) }) },
      { deps: { agents: [agent('A1')] } }
    );
    expect(standup.sources).toEqual([
      { id: 'git', label: 'Local git', count: 0, note: 'git unavailable' },
      { id: 'ledger', label: 'Ledger', count: 1 },
      { id: 'sessions', label: 'Sessions', count: 1 },
    ]);
    expect(standup.lanes).toEqual({ triage: 0, agents: 1, lightning: 1 });
  });

  it('the ledger failing leaves git and the sessions intact', async () => {
    const { standup } = await build({ refs: { [SHOP.path]: refs(head('feat/x', mon(10))) } }, { deps: { agents: [agent('A1')] } });
    expect(standup.sources.map((c) => [c.id, c.count, c.note])).toEqual([['git', 1, undefined], ['ledger', 0, 'no ledger'], ['sessions', 1, undefined]]);
    expect(standup.lanes).toEqual({ triage: 1, agents: 1, lightning: 0 });
  });

  it('a sessions source that blows up is a note and leaves git and the ledger intact', async () => {
    const exploding = Object.assign([] as Agent[], {
      [Symbol.iterator]() {
        throw new Error('roster unreadable');
      },
    });
    const { standup } = await build(
      { refs: { [SHOP.path]: refs(head('feat/x', mon(10))) }, files: ledger(SHOP, { unverified: jsonl({ id: 'UV-1', claim: 'c' }) }) },
      { deps: { agents: exploding } }
    );
    expect(chipOf(standup, 'sessions')).toEqual({ id: 'sessions', label: 'Sessions', count: 0, note: 'sessions unavailable' });
    expect(standup.lanes).toEqual({ triage: 1, agents: 0, lightning: 1 });
  });

  it('git unavailable everywhere still builds a standup from the sessions', async () => {
    const { standup, calls } = await build({ noGit: true }, { deps: { repos: [SHOP, BILLING], agents: [agent('A1'), agent('A2', { cwd: '/work/shop-app' })] } });
    expect(standup.sources).toEqual([
      { id: 'git', label: 'Local git', count: 0, note: 'git unavailable' },
      { id: 'ledger', label: 'Ledger', count: 0, note: 'no ledger' },
      { id: 'sessions', label: 'Sessions', count: 2 },
    ]);
    expect(standup.lanes).toEqual({ triage: 0, agents: 2, lightning: 0 });
    expect(item(standup, 'session:A2').repo).toBe('shop-app'); // by path: no git needed
    // it did try: two for-each-refs, four ledger files, two branch lookups, and one common-dir question for the checkout outside every repo
    expect(calls).toHaveLength(2 + 4 + 2 + 1);
  });

  it('no repositories: both git sources say so, git is never run, the sessions still list', async () => {
    const { standup, calls } = await build({}, { deps: { repos: [], agents: [agent('A1', { cwd: '/home/ana/scratch' })] } });
    expect(standup.sources).toEqual([
      { id: 'git', label: 'Local git', count: 0, note: 'no repository' },
      { id: 'ledger', label: 'Ledger', count: 0, note: 'no repository' },
      { id: 'sessions', label: 'Sessions', count: 1 },
    ]);
    expect(calls).toEqual([]);
    expect(standup.board).toHaveLength(1);
    expect(standup.board[0]).toMatchObject({ id: 'session:A1', repo: 'scratch' });
  });

  it('an empty fleet and an empty repo build an empty board with no notes', async () => {
    const { standup } = await build({ refs: { [SHOP.path]: '' }, files: ledger(SHOP, { unverified: '', tombstones: '' }) });
    expect(standup.sources).toEqual([
      { id: 'git', label: 'Local git', count: 0 },
      { id: 'ledger', label: 'Ledger', count: 0 },
      { id: 'sessions', label: 'Sessions', count: 0 },
    ]);
    expect(standup.board).toEqual([]);
  });

  it('a repo listed twice is read once', async () => {
    const { callsOf } = await build({}, { deps: { repos: [SHOP, { ...SHOP }] } });
    expect(callsOf('for-each-ref')).toHaveLength(1);
    expect(callsOf('show')).toHaveLength(2);
  });

  it('does not change the lists it is given', async () => {
    const repos = [SHOP, BILLING];
    const agents = [agent('B'), agent('A', { name: 'SHOP-1' })];
    const snapshot = JSON.stringify({ repos, agents });
    await build({ refs: { [SHOP.path]: refs(head('feat/x', mon(10))) } }, { deps: { repos, agents } });
    expect(JSON.stringify({ repos, agents })).toBe(snapshot);
  });

  it('keeps every git call to a fixed argv: hostile branch names, subjects, names and cwds never reach it', async () => {
    const hostile = ['$(touch /tmp/pwned)', '; rm -rf /', '--upload-pack=evil', '-x', '`id`'];
    const { calls } = await build(
      {
        refs: { [SHOP.path]: refs(...hostile.map((h, i) => head(h, mon(10 + i), h)), head('feat/SHOP-1', mon(9), hostile[0])) },
        heads: { '/work/shop-app': hostile[0] },
        files: ledger(SHOP, { unverified: jsonl({ id: 'UV-1', claim: hostile[1], doubt: hostile[2] }) }),
      },
      { deps: { agents: [agent('A1', { name: hostile[3], cwd: '/work/shop-app' }), agent('A2', { name: hostile[4], cwd: '/wt/x' })] } }
    );
    const fixedFlags = new Set(['-C', '--sort=-committerdate', '--format=%(refname)%09%(committerdate:unix)%09%(objectname:short)%09%(subject)', '--abbrev-ref', '--git-common-dir']);
    expect(calls).toHaveLength(6); // one for-each-ref, two ledger files, two branch lookups, one common-dir question
    for (const c of calls) {
      expect(c.cmd).toBe('git');
      expect(Array.isArray(c.args) && c.args.every((a) => typeof a === 'string')).toBe(true);
      expect(c.args[0]).toBe('-C');
      expect(c.args[1]).toMatch(/^\//);
      expect(c.args.filter((a) => a.startsWith('-') && !fixedFlags.has(a))).toEqual([]);
      for (const h of hostile) expect(c.args).not.toContain(h);
      expect(c.opts?.timeoutMs).toBe(20_000);
    }
  });
});

describe('orderLightningRows', () => {
  const row = (id: string, date?: string): LedgerRow => ({ key: `uv:r:${id}`, id, kind: 'unverified', repo: 'r', repoPath: '/r', status: 'open', open: true, raw: {}, ...(date !== undefined && { date }) });
  const ids = (rows: LedgerRow[]) => rows.map((r) => r.id);
  const win = { start: local(2026, 10, 23), end: local(2026, 10, 26) };

  it('without a window: oldest date first, rows with no date last', () => {
    expect(ids(orderLightningRows([row('c', '2026-10-25'), row('x'), row('a', '2026-09-01'), row('b', '2026-10-01'), row('y')]))).toEqual(['a', 'b', 'c', 'x', 'y']);
  });

  it('with a window: rows dated inside it first, then the rest, each oldest first, undated last', () => {
    const rows = [row('old', '2026-08-01'), row('in-late', '2026-10-25'), row('none'), row('after', '2026-11-03'), row('in-early', '2026-10-23'), row('before', '2026-10-22'), row('older', '2026-02-02')];
    expect(ids(orderLightningRows(rows, win))).toEqual(['in-early', 'in-late', 'older', 'old', 'before', 'after', 'none']);
  });

  it('the window start is inside and the end is not', () => {
    expect(ids(orderLightningRows([row('at-end', '2026-10-26'), row('at-start', '2026-10-23'), row('last-day', '2026-10-25')], win))).toEqual(['at-start', 'last-day', 'at-end']);
  });

  it('is stable: rows on the same date keep their order, in a group and out of one', () => {
    const rows = [row('p', '2026-10-24'), row('q', '2026-10-24'), row('r', '2026-01-01'), row('s', '2026-01-01'), row('t'), row('u')];
    expect(ids(orderLightningRows(rows, win))).toEqual(['p', 'q', 'r', 's', 't', 'u']);
    expect(ids(orderLightningRows([...rows].reverse(), win))).toEqual(['q', 'p', 's', 'r', 'u', 't']);
  });

  it('does not mutate its input and returns the same row objects in a new array', () => {
    const rows = [row('b', '2026-10-25'), row('a', '2026-10-01'), row('c')];
    const before = [...rows];
    const out = orderLightningRows(rows, win);
    expect(rows).toEqual(before);
    expect(rows.every((r, i) => r === before[i])).toBe(true);
    expect(out).not.toBe(rows);
    expect(out.every((r) => rows.includes(r))).toBe(true);
    expect(ids(out)).toEqual(['b', 'a', 'c']);
  });

  it('a date that is not a real date counts as no date', () => {
    expect(ids(orderLightningRows([row('bad-day', '2026-02-30'), row('word', 'soon'), row('good', '2026-10-24'), row('empty', '')], win))).toEqual(['good', 'bad-day', 'word', 'empty']);
  });

  it('an empty queue is an empty queue', () => {
    expect(orderLightningRows([])).toEqual([]);
    expect(orderLightningRows([], win)).toEqual([]);
  });
});

describe('renderStandupText', () => {
  const base: Standup = {
    at: 0,
    covering: '2026-10-26',
    through: '2026-10-26',
    run: '2026-10-27',
    windowStart: 0,
    windowEnd: 1,
    sources: [
      { id: 'git', label: 'Local git', count: 18 },
      { id: 'ledger', label: 'Ledger', count: 101 },
      { id: 'sessions', label: 'Sessions', count: 43 },
    ],
    lanes: { triage: 29, agents: 43, lightning: 98 },
    board: [],
  };
  const boardItem = (over: Partial<BoardItem>): BoardItem => ({ id: 'x', lane: 'triage', title: 't', state: 'branch', tint: 'blue', refs: [], sources: ['git'], ...over });

  it('prints the header, the chips, the lanes, a blank line and one line per board item', () => {
    const s: Standup = {
      ...base,
      board: [
        boardItem({ title: 'feat/SHOP-142-retry', repo: 'shop-app', refs: ['SHOP-142'] }),
        boardItem({ lane: 'agents', title: 'upload fixer', repo: 'shop-app' }),
        boardItem({ lane: 'lightning', title: 'UV-0036 offline uploads reuse the session id minted online', repo: 'shop-app' }),
        boardItem({ lane: 'triage', title: 'no repo here', refs: ['AB-1', 'CD-22'] }),
        boardItem({ lane: 'agents', title: 'bare' }),
      ],
    };
    expect(renderStandupText(s)).toBe(
      [
        'Morning Standup  covering 2026-10-26, run 2026-10-27',
        'Local git 18 | Ledger 101 | Sessions 43',
        'Triage 29 | Agents 43 | Lightning 98',
        '',
        '[triage] feat/SHOP-142-retry  (shop-app)  SHOP-142',
        '[agents] upload fixer  (shop-app)',
        '[lightning] UV-0036 offline uploads reuse the session id minted online  (shop-app)',
        '[triage] no repo here  AB-1 CD-22',
        '[agents] bare',
      ].join('\n')
    );
  });

  it('adds "through" when the window spans several days, a note in brackets on a chip that has one, and no blank line for an empty board', () => {
    const s: Standup = {
      ...base,
      covering: '2026-10-23',
      through: '2026-10-25',
      run: '2026-10-26',
      sources: [
        { id: 'git', label: 'Local git', count: 0, note: 'git unavailable' },
        { id: 'ledger', label: 'Ledger', count: 0, note: 'no repository' },
        { id: 'sessions', label: 'Sessions', count: 3 },
      ],
      lanes: { triage: 0, agents: 3, lightning: 0 },
    };
    expect(renderStandupText(s)).toBe(['Morning Standup  covering 2026-10-23 through 2026-10-25, run 2026-10-26', 'Local git 0 (git unavailable) | Ledger 0 (no repository) | Sessions 3', 'Triage 0 | Agents 3 | Lightning 0'].join('\n'));
  });

  it('cuts a title to 72 characters including a three-dot ellipsis, and leaves 72 alone', () => {
    const exactly = 'a'.repeat(72);
    const over = 'b'.repeat(73);
    const out = renderStandupText({ ...base, board: [boardItem({ title: exactly }), boardItem({ title: over })] }).split('\n');
    expect(out[4]).toBe(`[triage] ${exactly}`);
    expect(out[5]).toBe(`[triage] ${'b'.repeat(69)}...`);
    expect(out[5].slice('[triage] '.length)).toHaveLength(72);
  });

  it('never cuts through a surrogate pair', () => {
    const title = 'a'.repeat(68) + '\u{1F600}'.repeat(6);
    const line = renderStandupText({ ...base, board: [boardItem({ title })] }).split('\n')[4];
    expect(line).toBe(`[triage] ${'a'.repeat(68)}\u{1F600}...`);
  });

  it('untrusted text stays on its line and carries no terminal control: escapes, newlines and bidi overrides become spaces', () => {
    const s: Standup = {
      ...base,
      board: [boardItem({ title: 'evil\x1b[31m red\nnext\u202e flipped', repo: 'x)\n[agents] forged line', refs: ['AB-1\x07', '\n'] })],
    };
    const lines = renderStandupText(s).split('\n');
    expect(lines).toHaveLength(5);
    expect(lines[4]).toBe('[triage] evil [31m red next flipped  (x) [agents] forged line)  AB-1');
    expect(lines.join('\n')).not.toMatch(/[\x00-\x09\x0b-\x1f\x7f\u202e]/);
  });

  it('renders a built standup end to end', async () => {
    const { standup } = await build(
      {
        refs: { [SHOP.path]: refs(head('feat/SHOP-142-retry', mon(16), 'retry the upload'), head('cleanup', mon(10), 'tidy')) },
        files: ledger(SHOP, { unverified: jsonl({ id: 'UV-0036', date: '2026-10-12', claim: 'offline uploads reuse the session id minted online' }) }),
        heads: { '/work/shop-app': 'feat/SHOP-142-retry' },
      },
      { deps: { agents: [agent('abc12345', { name: 'upload fixer', cwd: '/work/shop-app', status: 'busy' })], activity: activityOf({ abc12345: { lastAt: mon(15), lastStatus: 'working' } }) } }
    );
    expect(renderStandupText(standup)).toBe(
      [
        'Morning Standup  covering 2026-10-26, run 2026-10-27',
        'Local git 2 | Ledger 1 | Sessions 1',
        'Triage 2 | Agents 1 | Lightning 1',
        '',
        '[triage] feat/SHOP-142-retry  (shop-app)  SHOP-142',
        '[triage] cleanup  (shop-app)',
        '[agents] upload fixer  (shop-app)',
        '[lightning] UV-0036 offline uploads reuse the session id minted online  (shop-app)',
      ].join('\n')
    );
  });
});
