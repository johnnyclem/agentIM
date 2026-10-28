/**
 * The Morning Standup (standup spec §3, §6.1): what moved since the last
 * working day, read from three independent sources (local git, the TB/UV
 * ledger, the live sessions) and joined into a board of three lanes. Each
 * source fails on its own into a note on its chip; none can fail the
 * standup. Dates are the user's local days. Git runs only through the
 * injected Runner, as argv arrays, and nothing here writes or sends.
 */

import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { type Agent, isStopped, projectName } from './agent.js';
import type { Clock } from './clock.js';
import type { Runner } from './runner.js';
import { STATUS_TINT, type Status, type Tint } from './status-report.js';
import { DEFAULT_LEDGER_REF, readLedger, type LedgerRow, type RepoRef } from './tbuv-ledger.js';

const GIT_TIMEOUT_MS = 20_000;
/** for-each-ref output larger than this (bytes) is not read: the repo counts as unreadable, never as a silent prefix. */
const MAX_REFS_BYTES = 4 * 1024 * 1024;
const REFS_FORMAT = '--format=%(refname)%09%(committerdate:unix)%09%(objectname:short)%09%(subject)';
const DEFAULT_BRANCHES = ['main', 'master', 'develop', 'trunk'];
/** Text carried on a board item (a subject, a claim, a scope) is cut here: the full text lives in the source. */
const TEXT_CAP = 300;
const TITLE_MAX = 72;

export type Lane = 'triage' | 'agents' | 'lightning';

export interface BoardItem {
  /** 'branch:<repo>:<ticket key or branch>' | 'session:<sessionID>' | the LedgerRow.key */
  id: string;
  lane: Lane;
  title: string;
  detail?: string;
  repo?: string;
  /** 'branch' | 'working' | 'blocked' | 'stopped' | 'open' … */
  state: string;
  tint: Tint;
  /** Ticket keys, 'QP-27153'. */
  refs: string[];
  sources: Array<'git' | 'sessions' | 'ledger'>;
  /** Triage: sessions whose checkout is on the branch, or whose name mentions the ticket. */
  sessionIDs?: string[];
  /** Lightning only. */
  rowKey?: string;
  /** Epoch ms of the last activity. */
  at?: number;
}

export interface SourceChip {
  id: 'git' | 'ledger' | 'sessions';
  label: string;
  count: number;
  note?: string;
}

export interface Standup {
  at: number;
  /** 'YYYY-MM-DD', local dates. */
  covering: string;
  through: string;
  run: string;
  /** Epoch ms: the window is [windowStart, windowEnd). */
  windowStart: number;
  windowEnd: number;
  /** Raw counts per source. */
  sources: SourceChip[];
  /** After the join. */
  lanes: Record<Lane, number>;
  /** Triage, then agents, then lightning. */
  board: BoardItem[];
}

export interface SessionActivity {
  lastAt: number | null;
  lastStatus: Status | null;
  lastScope: string | null;
}

export interface StandupDeps {
  clock: Clock;
  run: Runner;
  /** Git and the ledger are read from each. */
  repos: RepoRef[];
  /** The visible agents. */
  agents: Agent[];
  /** An agent's last transcript turn; a rejection reads as no activity. */
  activity: (a: Agent) => Promise<SessionActivity>;
}

export interface StandupOptions {
  /** 'YYYY-MM-DD': cover that one day instead of the previous weekday. */
  covering?: string;
  /** Prefixes whose unhyphenated form (`qp27153`) is a ticket key (QP-27153). */
  ticketPrefixes?: string[];
  ledgerRef?: string;
  /** True for a ledger row the decision store hides. */
  hidden?: (rowKey: string) => boolean;
  /** Branches that are never items; default main, master, develop, trunk. */
  defaultBranches?: string[];
}

interface TimeWindow {
  start: number;
  end: number;
}

const pad = (n: number, width = 2) => String(n).padStart(width, '0');
const ymd = (d: Date): string => `${pad(d.getFullYear(), 4)}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

/** The local midnight of a 'YYYY-MM-DD' that is a real calendar date, else null: Date rolls 2026-02-30 over, so the date must survive the round trip. */
function localDay(s: unknown): Date | null {
  const m = typeof s === 'string' ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(s) : null;
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const t = new Date(y, mo - 1, d);
  return t.getFullYear() === y && t.getMonth() === mo - 1 && t.getDate() === d ? t : null;
}

/** Days back to the previous weekday, by the run's weekday (0 is Sunday): Mon looks back to Fri, Sat and Sun to Fri, the rest to yesterday. */
const DAYS_BACK = [2, 3, 1, 1, 1, 1, 1];

/**
 * `run` is the local date of `now`. Without `covering` the window is [previous weekday 00:00, run 00:00), so a Monday spans the weekend and `through` is the last day inside it;
 * with `covering` it is that one day. Every boundary is a local `new Date(y, m, d)`, so DST cannot shift it.
 */
export function standupWindow(now: number, covering?: string): { covering: string; through: string; run: string; start: number; end: number } {
  const n = new Date(now);
  const [ry, rm, rd] = [n.getFullYear(), n.getMonth(), n.getDate()];
  const runDay = new Date(ry, rm, rd);
  if (covering !== undefined) {
    const day = localDay(covering);
    if (day === null) throw new Error('covering must be a real calendar date as YYYY-MM-DD');
    const end = new Date(day.getFullYear(), day.getMonth(), day.getDate() + 1);
    return { covering: ymd(day), through: ymd(day), run: ymd(runDay), start: day.getTime(), end: end.getTime() };
  }
  const start = new Date(ry, rm, rd - DAYS_BACK[runDay.getDay()]);
  return { covering: ymd(start), through: ymd(new Date(ry, rm, rd - 1)), run: ymd(runDay), start: start.getTime(), end: runDay.getTime() };
}

/**
 * The Lightning queue order: rows dated inside the window first, then the rest, each oldest date first, rows with no (or an unreadable) date last.
 * Stable, and the input is not mutated.
 */
export function orderLightningRows(rows: LedgerRow[], window?: { start: number; end: number }): LedgerRow[] {
  const keyed = rows.map((row, i) => ({ row, i, t: localDay(row.date)?.getTime() ?? null }));
  const group = (t: number | null) => (t === null ? 2 : window !== undefined && t >= window.start && t < window.end ? 0 : 1);
  keyed.sort((a, b) => group(a.t) - group(b.t) || (a.t ?? 0) - (b.t ?? 0) || a.i - b.i);
  return keyed.map((k) => k.row);
}

// ---- ticket keys

type KeyFinder = (text: string) => string[];

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Ticket keys in a text, uppercased, in order of appearance: `ABC-123` anywhere, plus the unhyphenated `abc123` of each configured prefix when no letter or digit touches it
 * (so `sha256` and `utf8` are never keys unless their prefix is configured).
 */
function ticketKeyFinder(prefixes: string[] = []): KeyFinder {
  const forms = prefixes
    .map((p) => (typeof p === 'string' ? p.trim().replace(/-+$/, '') : ''))
    .filter((p) => p !== '')
    .map((p) => ({ upper: p.toUpperCase(), re: new RegExp(`(?<![A-Za-z0-9])${escapeRegExp(p)}(\\d+)(?![A-Za-z0-9])`, 'gi') }));
  return (text) => {
    const found: Array<{ at: number; key: string }> = [];
    for (const m of text.matchAll(/\b[A-Z][A-Z0-9]+-\d+\b/gi)) found.push({ at: m.index ?? 0, key: m[0].toUpperCase() });
    for (const f of forms) for (const m of text.matchAll(f.re)) found.push({ at: m.index ?? 0, key: `${f.upper}-${m[1]}` });
    found.sort((a, b) => a.at - b.at);
    return [...new Set(found.map((f) => f.key))];
  };
}

/** The first of each key, in order: a repo or a session listed twice would otherwise be read, counted and shown twice. */
function firstOf<T>(items: T[], key: (item: T) => string): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const item of items) {
    const k = key(item);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(item);
  }
  return out;
}

/** At most `n` code points of a text, with an ellipsis when cut. */
function clip(s: string, n: number): string {
  const cps = Array.from(s);
  return cps.length > n ? cps.slice(0, n - 1).join('') + '…' : s;
}

// ---- sources

interface Sourced<T> {
  value: T;
  note?: string;
}

/** A source that throws is a note on its chip, never a failed standup. */
async function guarded<T>(empty: T, note: string, read: () => Promise<Sourced<T>>): Promise<Sourced<T>> {
  try {
    return await read();
  } catch {
    return { value: empty, note };
  }
}

/** A path reaches `git -C` only when it is absolute: an empty or relative one would run in the daemon's own directory. */
const usable = (p: unknown): p is string => typeof p === 'string' && isAbsolute(p) && !p.includes('\0');

/** A branch with its newest commit in the window; `origin/x` and `x` are one. */
interface Branch {
  repo: RepoRef;
  name: string;
  at: number;
  subject: string;
  keys: string[];
}

/** `refs/heads/x` and `refs/remotes/<remote>/x` are the branch `x`; any other ref is not a branch. */
function branchName(ref: string): string | null {
  if (ref.startsWith('refs/heads/')) return ref.slice('refs/heads/'.length);
  if (ref.startsWith('refs/remotes/')) {
    const rest = ref.slice('refs/remotes/'.length);
    const slash = rest.indexOf('/');
    return slash < 0 ? null : rest.slice(slash + 1);
  }
  return null;
}

/** Tab-separated `ref, unix date, short sha, subject`. A malformed line is skipped; a subject may be empty, missing, or hold tabs. */
function parseRefs(out: string, repo: RepoRef, w: TimeWindow, skip: ReadonlySet<string>, keysOf: KeyFinder): Branch[] {
  const byName = new Map<string, Branch>();
  for (const line of out.split('\n')) {
    const parts = line.replace(/\r$/, '').split('\t');
    if (parts.length < 2 || !/^\d+$/.test(parts[1])) continue;
    const name = branchName(parts[0]);
    if (name === null || name === '' || name === 'HEAD' || skip.has(name)) continue;
    const at = Number(parts[1]) * 1000;
    if (!(at >= w.start && at < w.end)) continue;
    const prev = byName.get(name);
    if (prev !== undefined && prev.at >= at) continue; // the newest ref of a branch speaks for it
    const subject = clip(parts.slice(3).join('\t').trim(), TEXT_CAP);
    byName.set(name, { repo, name, at, subject, keys: [...new Set([...keysOf(name), ...keysOf(subject)])] });
  }
  return [...byName.values()];
}

/** Branches with a commit in the window, over every repo. A repo git cannot read is a note; the others still count. */
async function readBranches(run: Runner, repos: RepoRef[], w: TimeWindow, opts: StandupOptions, keysOf: KeyFinder): Promise<Sourced<Branch[]>> {
  if (repos.length === 0) return { value: [], note: 'no repository' };
  const skip = new Set([...(opts.defaultBranches ?? DEFAULT_BRANCHES), opts.ledgerRef ?? DEFAULT_LEDGER_REF]);
  const per = await Promise.all(
    repos.map(async (repo): Promise<Branch[] | null> => {
      if (!usable(repo.path)) return null;
      try {
        const r = await run('git', ['-C', repo.path, 'for-each-ref', '--sort=-committerdate', REFS_FORMAT, 'refs/heads', 'refs/remotes'], { timeoutMs: GIT_TIMEOUT_MS });
        if (r.code !== 0 || Buffer.byteLength(r.stdout) > MAX_REFS_BYTES) return null;
        return parseRefs(r.stdout, repo, w, skip, keysOf);
      } catch {
        return null; // git missing, a bad directory or a timeout
      }
    })
  );
  const failed = per.filter((p) => p === null).length;
  const note = failed === 0 ? undefined : failed === repos.length ? 'git unavailable' : `git unavailable in ${failed} of ${repos.length} repos`;
  return { value: per.flatMap((p) => p ?? []), ...(note !== undefined && { note }) };
}

/** The open, un-hidden rows of every repo's ledger. `no ledger` only when no repo's ledger could be read. */
async function readRows(run: Runner, repos: RepoRef[], opts: StandupOptions): Promise<Sourced<LedgerRow[]>> {
  if (repos.length === 0) return { value: [], note: 'no repository' };
  const reads = await Promise.all(repos.map((repo) => readLedger(run, repo, opts.ledgerRef ?? DEFAULT_LEDGER_REF).catch(() => null)));
  const rows = reads.flatMap((r) => r?.rows ?? []).filter((row) => row.open && !opts.hidden?.(row.key));
  return { value: rows, ...(reads.every((r) => r === null || r.unavailable) && { note: 'no ledger' }) };
}

/** A counted session with what the join needs: its repo, the branch its checkout is on, and the ticket keys in its name. */
interface Live {
  agent: Agent;
  repo: RepoRef | null;
  branch: string | null;
  keys: string[];
  lastAt: number | null;
  lastStatus: Status | null;
  lastScope: string | null;
}

const NO_ACTIVITY: SessionActivity = { lastAt: null, lastStatus: null, lastScope: null };

/** Whatever `activity` returned, narrowed to what it promises. */
function cleanActivity(a: Partial<SessionActivity> | null | undefined): SessionActivity {
  return {
    lastAt: typeof a?.lastAt === 'number' && Number.isFinite(a.lastAt) ? a.lastAt : null,
    lastStatus: typeof a?.lastStatus === 'string' && Object.hasOwn(STATUS_TINT, a.lastStatus) ? a.lastStatus : null,
    lastScope: typeof a?.lastScope === 'string' && a.lastScope.trim() !== '' ? a.lastScope.trim() : null,
  };
}

/** The deepest repo whose directory holds `cwd` (or is it). Paths are resolved first, so `..` cannot climb into a repo and a sibling that shares a prefix is not inside. */
function repoHolding(repos: RepoRef[], cwd: string): RepoRef | null {
  let best: RepoRef | null = null;
  for (const repo of repos) {
    if (!usable(repo.path)) continue;
    const root = resolve(repo.path);
    const rel = relative(root, resolve(cwd));
    const inside = rel === '' || (rel !== '..' && !rel.startsWith('..' + sep) && !isAbsolute(rel));
    if (inside && (best === null || root.length > resolve(best.path).length)) best = repo;
  }
  return best;
}

/** The repo of a linked worktree outside the repo's directory, by its common git dir (the way discoverRepos finds roots). */
async function repoByCommonDir(run: Runner, repos: RepoRef[], cwd: string): Promise<RepoRef | null> {
  try {
    const r = await run('git', ['-C', cwd, 'rev-parse', '--git-common-dir'], { timeoutMs: GIT_TIMEOUT_MS });
    if (r.code !== 0) return null;
    const out = r.stdout.split('\n')[0].replace(/\r$/, '');
    if (out.trim() === '') return null;
    const common = resolve(cwd, out);
    if (basename(common) !== '.git') return null;
    const root = dirname(common);
    return repos.find((repo) => usable(repo.path) && resolve(repo.path) === root) ?? null;
  } catch {
    return null;
  }
}

/** The branch a checkout is on; null when git fails or HEAD is detached. */
async function currentBranch(run: Runner, cwd: string): Promise<string | null> {
  try {
    const r = await run('git', ['-C', cwd, 'rev-parse', '--abbrev-ref', 'HEAD'], { timeoutMs: GIT_TIMEOUT_MS });
    if (r.code !== 0) return null;
    const name = r.stdout.split('\n')[0].trim();
    return name === '' || name === 'HEAD' ? null : name;
  } catch {
    return null;
  }
}

/** Live sessions, and stopped ones whose last turn is in the window. A failing `activity` reads as no activity, with a note. */
async function readSessions(deps: StandupDeps, repos: RepoRef[], w: TimeWindow, keysOf: KeyFinder): Promise<Sourced<Live[]>> {
  const agents = firstOf(deps.agents, (a) => a.sessionID);
  let failed = 0;
  const acts = await Promise.all(
    agents.map(async (agent) => {
      try {
        return cleanActivity(await deps.activity(agent));
      } catch {
        failed++;
        return NO_ACTIVITY;
      }
    })
  );
  const counted = agents.map((agent, i) => ({ agent, act: acts[i] })).filter(({ agent, act }) => !isStopped(agent) || (act.lastAt !== null && act.lastAt >= w.start && act.lastAt < w.end));
  // One lookup per distinct checkout, all at once. Failures leave the session unjoined.
  const where = new Map<string, { repo: RepoRef | null; branch: string | null }>();
  if (repos.length > 0) {
    await Promise.all(
      [...new Set(counted.map((c) => c.agent.cwd))]
        .filter(usable)
        .map(async (cwd) => {
          const held = repoHolding(repos, cwd);
          const [branch, repo] = await Promise.all([currentBranch(deps.run, cwd), held !== null ? held : repoByCommonDir(deps.run, repos, cwd)]);
          where.set(cwd, { repo, branch });
        })
    );
  }
  const value = counted.map(({ agent, act }): Live => {
    const loc = where.get(agent.cwd);
    return { agent, repo: loc?.repo ?? null, branch: loc?.branch ?? null, keys: keysOf(clip(agent.name, TEXT_CAP)), ...act };
  });
  return { value, ...(failed > 0 && { note: `activity unavailable for ${failed} of ${agents.length} sessions` }) };
}

// ---- the join and the board

interface Group {
  repo: RepoRef;
  branches: Branch[];
  keys: Set<string>;
}

/** Branches of one repo that share any ticket key are one group; a branch with no key is its own. */
function groupBranches(branches: Branch[]): Group[] {
  const groups: Group[] = [];
  for (const b of branches) {
    const hit = groups.filter((g) => g.repo.path === b.repo.path && b.keys.some((k) => g.keys.has(k)));
    const into = hit[0] ?? { repo: b.repo, branches: [], keys: new Set<string>() };
    if (hit.length === 0) groups.push(into);
    for (const other of hit.slice(1)) {
      into.branches.push(...other.branches);
      for (const k of other.keys) into.keys.add(k);
      groups.splice(groups.indexOf(other), 1);
    }
    into.branches.push(b);
    for (const k of b.keys) into.keys.add(k);
  }
  return groups;
}

/** Red and amber lead, then the newest activity first. The sort is stable. */
function orderBoard(items: BoardItem[]): BoardItem[] {
  const attention = (t: Tint) => (t === 'red' ? 0 : t === 'amber' ? 1 : 2);
  return [...items].sort((a, b) => attention(a.tint) - attention(b.tint) || (b.at ?? 0) - (a.at ?? 0));
}

const SEVERITY: Record<Tint, number> = { red: 4, amber: 3, blue: 2, grey: 1, green: 0 };

/** One item per group: titled by its newest branch, tinted by the worst last status among the sessions that joined it. */
function triageItems(branches: Branch[], sessions: Live[]): BoardItem[] {
  const items = groupBranches(branches).map((g): BoardItem => {
    const bs = [...g.branches].sort((a, b) => b.at - a.at);
    const head = bs[0];
    const names = new Set(bs.map((b) => b.name));
    const joined = sessions.filter((s) => s.repo?.path === g.repo.path && ((s.branch !== null && names.has(s.branch)) || s.keys.some((k) => g.keys.has(k))));
    const tints = joined.flatMap((s) => (s.lastStatus !== null ? [STATUS_TINT[s.lastStatus]] : []));
    const detail = bs.length > 1 ? `+${bs.length - 1} more` : head.subject;
    return {
      id: `branch:${g.repo.name}:${head.keys[0] ?? head.name}`,
      lane: 'triage',
      title: head.name,
      ...(detail !== '' && { detail }),
      repo: g.repo.name,
      state: 'branch',
      tint: tints.length > 0 ? tints.reduce((worst, t) => (SEVERITY[t] > SEVERITY[worst] ? t : worst)) : 'blue',
      refs: [...new Set(bs.flatMap((b) => b.keys))],
      sources: joined.length > 0 ? ['git', 'sessions'] : ['git'],
      ...(joined.length > 0 && { sessionIDs: joined.map((s) => s.agent.sessionID) }),
      at: head.at,
    };
  });
  return orderBoard(items);
}

function agentItems(sessions: Live[]): BoardItem[] {
  return orderBoard(
    sessions.map((s): BoardItem => {
      const a = s.agent;
      const stopped = isStopped(a);
      return {
        id: `session:${a.sessionID}`,
        lane: 'agents',
        title: clip(a.name, TEXT_CAP) || projectName(a),
        ...(s.lastScope !== null && { detail: clip(s.lastScope, TEXT_CAP) }),
        repo: s.repo?.name ?? projectName(a),
        state: stopped ? 'stopped' : (s.lastStatus ?? (a.status === 'busy' ? 'working' : 'idle')),
        tint: s.lastStatus !== null ? STATUS_TINT[s.lastStatus] : stopped ? 'grey' : a.status === 'busy' ? 'blue' : 'green',
        refs: s.keys,
        sources: ['sessions'],
        at: s.lastAt ?? a.startedAt,
      };
    })
  );
}

function lightningItem(row: LedgerRow): BoardItem {
  const day = localDay(row.date);
  return {
    id: row.key,
    lane: 'lightning',
    title: clip(row.claim !== undefined ? `${row.id} ${row.claim}` : row.id, TEXT_CAP),
    ...(row.doubt !== undefined && { detail: clip(row.doubt, TEXT_CAP) }),
    repo: row.repo,
    state: 'open',
    tint: 'green',
    refs: [],
    sources: ['ledger'],
    rowKey: row.key,
    ...(day !== null && { at: day.getTime() }),
  };
}

const chip = (id: SourceChip['id'], label: string, s: Sourced<unknown[]>): SourceChip => ({ id, label, count: s.value.length, ...(s.note !== undefined && { note: s.note }) });

/**
 * Build the standup. Throws only for a `covering` that is not a real date; a source that cannot be read is a note on its chip with count 0.
 * Chip counts are raw per source; `lanes` count the board after the join.
 */
export async function buildStandup(deps: StandupDeps, opts: StandupOptions = {}): Promise<Standup> {
  const at = deps.clock();
  const w = standupWindow(at, opts.covering);
  const repos = firstOf(deps.repos, (r) => r.path);
  const keysOf = ticketKeyFinder(opts.ticketPrefixes);
  const [git, ledger, sessions] = await Promise.all([
    guarded<Branch[]>([], 'git unavailable', () => readBranches(deps.run, repos, w, opts, keysOf)),
    guarded<LedgerRow[]>([], 'ledger unavailable', () => readRows(deps.run, repos, opts)),
    guarded<Live[]>([], 'sessions unavailable', () => readSessions(deps, repos, w, keysOf)),
  ]);
  const triage = triageItems(git.value, sessions.value);
  const agents = agentItems(sessions.value);
  const lightning = orderLightningRows(ledger.value, w).map(lightningItem);
  return {
    at,
    covering: w.covering,
    through: w.through,
    run: w.run,
    windowStart: w.start,
    windowEnd: w.end,
    sources: [chip('git', 'Local git', git), chip('ledger', 'Ledger', ledger), chip('sessions', 'Sessions', sessions)],
    lanes: { triage: triage.length, agents: agents.length, lightning: lightning.length },
    board: [...triage, ...agents, ...lightning],
  };
}

// ---- terminal rendering

/** Untrusted text on one line: control characters (an escape sequence, a newline) and bidi overrides become a space, and runs of white space collapse to one. */
// eslint-disable-next-line no-control-regex
const oneLine = (s: string): string => s.replace(/[\u0000-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, ' ').replace(/\s+/g, ' ').trim();

/** At most 72 characters including the ASCII ellipsis. */
function shorten(s: string): string {
  const cps = Array.from(oneLine(s));
  return cps.length > TITLE_MAX ? cps.slice(0, TITLE_MAX - 3).join('') + '...' : cps.join('');
}

function boardLine(i: BoardItem): string {
  const repo = i.repo === undefined ? '' : oneLine(i.repo);
  const refs = i.refs.map(oneLine).filter((r) => r !== '').join(' ');
  return `[${i.lane}] ${shorten(i.title)}${repo !== '' ? `  (${repo})` : ''}${refs !== '' ? `  ${refs}` : ''}`;
}

/** The terminal rendering: header, chips, lane counts, then one line per board item. ASCII apart from the data; the data has its control characters removed. */
export function renderStandupText(s: Standup): string {
  const span = s.through === s.covering ? s.covering : `${s.covering} through ${s.through}`;
  const lines = [
    `Morning Standup  covering ${span}, run ${s.run}`,
    s.sources.map((c) => `${c.label} ${c.count}${c.note ? ` (${c.note})` : ''}`).join(' | '),
    `Triage ${s.lanes.triage} | Agents ${s.lanes.agents} | Lightning ${s.lanes.lightning}`,
  ];
  if (s.board.length > 0) lines.push('', ...s.board.map(boardLine));
  return lines.join('\n');
}
