/**
 * A fake machine for the standup and Lightning Round integration tests: a
 * clock whose sleep advances it, a git that answers from tables (repos,
 * linked worktrees, ledgers, one file at one commit), transcripts and an inbox
 * whose agents can answer an ask. Shared by test/standup-hub.test.ts and
 * test/standup-daemon.test.ts; it holds no tests of its own.
 */

import { Hub, type HubEvent, type Settings } from '../src/hub.js';
import { MemoryKV } from '../src/store.js';
import { transcriptPath, type TranscriptRead } from '../src/transcript.js';
import type { Agent, Turn } from '../src/agent.js';
import type { RunResult, Runner } from '../src/runner.js';

export const CLAUDE_DIR = '/claude';
/** Tuesday 2026-10-27, 09:00 local: the standup covers Monday 2026-10-26. */
export const NOW = new Date(2026, 9, 27, 9).getTime();
export const HOUR = 3_600_000;
export const DAY = 24 * HOUR;
/** Monday 00:00 local, where the window of a Tuesday run starts. */
export const MONDAY = new Date(2026, 9, 26).getTime();
export const SHOP = '/work/shop-app';
export const BILLING = '/work/billing';
export const HEAD = '75c7b13' + 'e'.repeat(33);

/** Line 5 holds the quote the canned block cites; the file has 8 lines. */
export const SESSION_TS =
  [
    'export function mintSession(online: boolean): string {', // 1
    '  if (!online) return queuedId();', // 2
    '  return crypto.randomUUID();', // 3
    '}', // 4
    '// offline uploads reuse the session id minted online', // 5
    'export function reuse(id: string) {', // 6
    '  return id;', // 7
    '}', // 8
  ].join('\n') + '\n';

export interface RepoSpec {
  /** `git for-each-ref` output lines. */
  refs?: string[];
  /** `<ref>:<file>` to the file's content on that ledger ref; a ref or file that is missing is a failed `git show`. */
  ledger?: Record<string, string>;
  /** Files at HEAD, for grounding. */
  files?: Record<string, string>;
}

/** One `for-each-ref` line in the engine's format. */
export const refLine = (name: string, at: number, subject = '', remote = false): string => `refs/${remote ? 'remotes/origin' : 'heads'}/${name}\t${Math.floor(at / 1000)}\tabc1234\t${subject}`;

/** Ledger rows as a JSONL file. */
export const jsonl = (...rows: Array<Record<string, unknown>>): string => rows.map((r) => JSON.stringify(r)).join('\n') + '\n';

/** A cim-lightning reply: cite 1 is on line 5 of the file and grounded, cite 2 is a journal note that is not in the code repo and is not; the options rest on them. */
export const block = (id: string, title = 'Session id reuse'): string =>
  [
    '```cim-lightning',
    `id: ${id}`,
    'needs: human',
    'nature: decision',
    'checkable: now',
    `title: ${title}`,
    'claim: offline uploads reuse the session id minted online',
    'assessment: The upload queue stores the id it minted online and replays it.',
    'evidence:',
    '- src/session.ts:5@75c7b13 "reuse the session id"',
    '- journal/2026-10-14.md:17',
    'options:',
    '- A | challenge | Qualify the claim | 1 | Holds only while the queue keeps the id.',
    '- B | deny | Deny the claim | 2 | The journal note is not code.',
    '- C | no_change | Leave the row alone | | Nothing new to add.',
    '```',
  ].join('\n');

export const voteBlock = (id: string, vote: string, prefers = 'A'): string => ['```cim-vote', `id: ${id}`, `vote: ${vote}`, `prefers: ${prefers}`, 'reason: matches the code', '```'].join('\n');

/** What an ask to an agent is: the fixed phrases of the prompts, so a test can tell the sends apart. */
export const kindOf = (text: string): 'decision' | 'ask' | 'vote' | 'other' => (text.startsWith('[cIM Lightning Round]') ? 'decision' : text.includes('Lightning Round: a human') ? 'ask' : text.includes('independent vote') ? 'vote' : 'other');
export const idIn = (text: string): string => /(?:UV|TB)-\d{4}/.exec(text)?.[0] ?? '?';

const ok = (stdout: string): RunResult => ({ code: 0, stdout, stderr: '' });
const no = (): RunResult => ({ code: 128, stdout: '', stderr: 'fatal: not found' });

export function world(
  opts: {
    settings?: Partial<Settings>;
    /** sleeps that never wake */
    park?: boolean;
    /** Wraps the git the hub is given (delay it, count it, make it fail); `runs` still lists every call the machine itself answered. */
    wrapRun?: (inner: Runner) => Runner;
  } = {}
) {
  let now = NOW;
  let sleeps = 0;
  let roster: Agent[] = [];
  const files = new Map<string, Turn[]>();
  const sent: Array<{ to: string; text: string }> = [];
  const runs: string[][] = [];
  const events: HubEvent[] = [];
  /** repo root to its git. */
  const repos = new Map<string, RepoSpec>();
  /** a linked worktree outside the repo folder: its directory to the repo root. */
  const linked = new Map<string, string>();
  /** the branch a checkout is on. */
  const onBranch = new Map<string, string>();
  /** an agent's answer to the ask of kind `ask` or `vote` it is sent, appended to its transcript on the spot. */
  const answers = new Map<string, (text: string) => string | undefined>();
  const failing = new Set<string>();
  /** Transcript paths whose read fails. */
  const unreadable = new Set<string>();

  /** What the roster read does next: wait on `rosterGate`, or fail with `rosterError`. */
  let rosterGate: Promise<void> | null = null;
  let rosterError: string | null = null;

  const rootOf = (dir: string): string | null => (repos.has(dir) ? dir : (linked.get(dir) ?? null));
  const answer: Runner = async (cmd, args) => {
    runs.push([cmd, ...args]);
    if (cmd !== 'git' || args[0] !== '-C') return ok('');
    const [, dir, sub, ...rest] = args;
    const root = rootOf(dir);
    if (root === null) return no(); // not a repository
    const repo = repos.get(root)!;
    if (sub === 'rev-parse' && rest[0] === '--git-common-dir') return ok(root === dir ? '.git\n' : `${root}/.git\n`);
    if (sub === 'rev-parse' && rest[0] === '--abbrev-ref') return onBranch.has(dir) ? ok(`${onBranch.get(dir)}\n`) : no();
    if (sub === 'for-each-ref') return repo.refs ? ok(repo.refs.join('\n') + '\n') : no();
    if (sub === 'rev-parse' && rest[0] === '--verify') {
      const name = (rest[2] ?? '').replace(/\^\{commit\}$/, '');
      return name === 'HEAD' || (name.length >= 7 && HEAD.startsWith(name)) ? ok(HEAD + '\n') : no();
    }
    const object = (sub === 'cat-file' ? rest[1] : rest[0]) ?? '';
    if (sub === 'show' && repo.ledger?.[object] !== undefined) return ok(repo.ledger[object]);
    const content = object.startsWith(`${HEAD}:`) ? repo.files?.[object.slice(HEAD.length + 1)] : undefined;
    if (content === undefined) return no();
    if (sub === 'show') return ok(content);
    return ok(rest[0] === '-t' ? 'blob\n' : `${Buffer.byteLength(content)}\n`);
  };

  const run: Runner = opts.wrapRun ? opts.wrapRun(answer) : answer;

  const path = (a: Agent): string => transcriptPath(a.cwd, a.sessionID, CLAUDE_DIR);
  /** A turn in the agent's transcript, stamped with the fake clock unless given a time. */
  const append = (a: Agent, role: 'user' | 'assistant', text: string, at: number = now): void => {
    const list = files.get(path(a)) ?? [];
    list.push({ id: `${a.sessionID}-${list.length}`, role, text, timestamp: at });
    files.set(path(a), list);
  };

  const hub = new Hub({
    kv: new MemoryKV(),
    clock: () => now,
    sleep: (ms) => {
      sleeps++;
      // The roster poll sleeps for the interval the daemon was given (a minute); only the round's short polls move the clock.
      if (opts.park || ms >= 30_000) return new Promise<void>(() => undefined);
      return new Promise<void>((r) => {
        now += ms;
        setImmediate(r);
      });
    },
    run,
    alive: () => false,
    listAgents: async () => {
      if (rosterGate) await rosterGate;
      if (rosterError !== null) throw new Error(rosterError);
      return roster;
    },
    sendInbox: async (a, text) => {
      if (failing.has(a.sessionID)) throw new Error(`refused by ${a.name}`);
      sent.push({ to: a.sessionID, text });
      const kind = kindOf(text);
      if (kind === 'ask' || kind === 'vote') {
        const reply = answers.get(a.sessionID)?.(text);
        if (reply !== undefined) append(a, 'assistant', reply);
      }
    },
    readTail: async (p): Promise<TranscriptRead> => {
      if (unreadable.has(p)) throw new Error(`cannot read ${p}`);
      return { turns: (files.get(p) ?? []).slice(-40), endOffset: (files.get(p) ?? []).length, latestModel: null };
    },
    readSince: async (p, o): Promise<TranscriptRead> => ({ turns: (files.get(p) ?? []).slice(o), endOffset: (files.get(p) ?? []).length, latestModel: null }),
    gitChecks: async () => ({ dirty: false, unpushed: 0 }),
    osUserName: 'tester',
    settings: { claudeDir: CLAUDE_DIR, claudePath: process.execPath, ...opts.settings },
  });
  hub.subscribe((e) => events.push(e));

  const agent = (id: string, over: Partial<Agent> = {}): Agent => ({ sessionID: id, pid: 1, name: `agent-${id}`, cwd: SHOP, kind: 'interactive', status: 'idle', startedAt: NOW - HOUR, inboxSocketPath: `/tmp/${id}.sock`, ...over });
  /** A session that is not running any more. */
  const stopped = (id: string, over: Partial<Agent> = {}): Agent => {
    const a = agent(id, over);
    delete a.pid;
    delete a.status;
    delete a.inboxSocketPath;
    return a;
  };

  return {
    hub,
    agent,
    stopped,
    append,
    repos,
    linked,
    onBranch,
    answers,
    failing,
    /** Make reading this agent's transcript fail. */
    breakTranscript: (a: Agent): void => void unreadable.add(path(a)),
    sent,
    runs,
    events,
    /** Every agent answers every ask it is sent with a presentation of the row it was asked about. */
    answerAsks: (...agents: Agent[]) => {
      for (const a of agents) answers.set(a.sessionID, (text) => (kindOf(text) === 'ask' ? block(idIn(text), `${a.name} on ${idIn(text)}`) : undefined));
    },
    /** List these sessions without reading the roster: the hub has not seen them yet. */
    list: (...agents: Agent[]): void => void (roster = agents),
    /** Make the roster read wait until the returned function is called. */
    holdRoster: (): (() => void) => {
      let release = (): void => undefined;
      rosterGate = new Promise<void>((r) => (release = r));
      return () => {
        rosterGate = null;
        release();
      };
    },
    /** Make the roster read fail with this message (null: succeed again). */
    failRoster: (message: string | null): void => void (rosterError = message),
    /** List these sessions and read the roster. */
    ready: async (...agents: Agent[]): Promise<void> => {
      roster = agents;
      await hub.refresh();
    },
    now: () => now,
    set: (ms: number) => void (now = ms),
    sleeps: () => sleeps,
    /** Wait for the round's background work (presenting, grounding) to come to rest. */
    settle: async (): Promise<void> => {
      await hub.lightning?.settle();
    },
  };
}

export type World = ReturnType<typeof world>;

/** The usual shop-app: a Monday branch pair on one ticket, one branch on another, and a ledger with open and closed rows. */
export function shopApp(w: World, over: RepoSpec = {}): void {
  w.repos.set(SHOP, {
    refs: [
      refLine('SHOP-123-queue', MONDAY + 10 * HOUR, 'SHOP-123: queue offline uploads'),
      refLine('SHOP-123-queue', MONDAY + 9 * HOUR, 'SHOP-123: queue offline uploads', true),
      refLine('SHOP-123-backoff', MONDAY + 12 * HOUR, 'Back off retries'),
      refLine('qp27153-export-fix', MONDAY + 14 * HOUR, 'Fix the export'),
      refLine('main', MONDAY + 15 * HOUR, 'Merge pull request #9'),
      refLine('wiki', MONDAY + 16 * HOUR, 'Journal'),
      refLine('old-spike', MONDAY - 3 * DAY, 'A spike from last week'),
    ],
    ledger: {
      'wiki:unverified.jsonl': jsonl(
        { id: 'UV-0036', date: '2026-10-26', claim: 'Offline uploads reuse the session id minted online', doubt: 'the retry path may mint a fresh id', settles_it: 'trace the id through reuse()' },
        { id: 'UV-0021', date: '2026-10-20', claim: 'Retries stop after three attempts' },
        { id: 'UV-0005', date: '2026-10-01', claim: 'Thumbnails are generated once', status: 'confirmed' }
      ),
      'wiki:tombstones.jsonl': jsonl({ id: 'TB-0042', date: '2026-10-01', claim: 'the old API is gone', superseded_by: 'TB-0051' }),
    },
    files: { 'src/session.ts': SESSION_TS },
    ...over,
  });
}
