/**
 * The structured status reply (spec §7): the `cim-status` fenced block an
 * agent answers a Status Check with, its parser, the derived chore states,
 * the rollup, and the worktree-cleanup confirmation logic. Pure functions.
 */

export const STATUS_FENCE = 'cim-status';

export type Status = 'working' | 'planning' | 'paused' | 'waiting_for_human' | 'blocked' | 'gave_up' | 'done';

/** Declaration order: how the rollup reads, like a standup. */
export const STATUS_ORDER: Status[] = ['working', 'planning', 'paused', 'waiting_for_human', 'blocked', 'gave_up', 'done'];

export type Tint = 'blue' | 'grey' | 'amber' | 'red' | 'green';

export const STATUS_TINT: Record<Status, Tint> = {
  working: 'blue',
  planning: 'grey',
  paused: 'amber',
  waiting_for_human: 'red',
  blocked: 'amber',
  gave_up: 'red',
  done: 'green',
};

export interface StatusReport {
  /** The recognized status, or null when the spelling was not one of the seven. */
  status: Status | null;
  /** The status text as written, kept for an unrecognized spelling. */
  statusRaw: string;
  scope: string | null;
  remaining: string[];
  /** Set instead of `remaining` when the value was a path to a file. */
  remainingFile: string | null;
  wikiJournaled: boolean | null;
  worktreesCleaned: boolean | null;
  tbUvCleared: boolean | null;
  wikiEntry: string | null;
  tbUvRefs: string[];
  raw: string;
}

const LIST_KEYS = new Set(['remaining', 'tb_uv_refs']);

function normalizeStatus(v: string): Status | null {
  const s = v.trim().toLowerCase().replace(/[-\s]+/g, '_');
  return (STATUS_ORDER as string[]).includes(s) ? (s as Status) : null;
}

function parseBool(v: string | undefined): boolean | null {
  if (v === undefined) return null;
  const s = v.trim().toLowerCase();
  if (s === 'true' || s === 'yes' || s === '1') return true;
  if (s === 'false' || s === 'no' || s === '0') return false;
  return null;
}

const looksLikePath = (v: string): boolean => /\.md$/i.test(v) || v.startsWith('/') || v.startsWith('~/');

/** The body of the first fenced block with this info string, or null without an opening and a closing fence. */
export function fencedBlock(text: string, info: string): string | null {
  const open = new RegExp('```[ \\t]*' + info.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&') + '[ \\t]*\\r?\\n');
  const m = open.exec(text);
  if (!m) return null;
  const bodyStart = m.index + m[0].length;
  const close = text.indexOf('```', bodyStart);
  if (close < 0) return null;
  return text.slice(bodyStart, close);
}

/** Parse a turn's text as a status report; null for anything that is not one (it renders as an ordinary bubble). */
export function parseStatusReport(text: string): StatusReport | null {
  const body = fencedBlock(text, STATUS_FENCE);
  if (body === null) return null;
  const scalars = new Map<string, string>();
  const lists = new Map<string, string[]>();
  let listKey: string | null = null;
  for (const rawLine of body.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    if (line.startsWith('- ')) {
      if (listKey) lists.set(listKey, [...(lists.get(listKey) ?? []), line.slice(2).trim()]);
      continue;
    }
    const colon = line.indexOf(':');
    if (colon < 0) continue;
    const key = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
    if (!key) {
      listKey = null;
      continue;
    }
    if (!value) {
      listKey = key;
      continue;
    }
    scalars.set(key, value);
    // A model that writes `remaining: first item` and then more bullets keeps them; a stray bullet after `scope: X` is not misattributed.
    listKey = LIST_KEYS.has(key) ? key : null;
  }
  const statusRaw = scalars.get('status');
  if (statusRaw === undefined) return null;
  if (statusRaw.includes('|')) return null; // the ask's own template echoed back
  const remainingInline = scalars.get('remaining');
  const remainingBullets = lists.get('remaining') ?? [];
  let remaining: string[] = [];
  let remainingFile: string | null = null;
  if (remainingInline !== undefined && looksLikePath(remainingInline)) remainingFile = remainingInline;
  else if (remainingInline !== undefined) remaining = [remainingInline, ...remainingBullets];
  else remaining = remainingBullets;
  const refsInline = scalars.get('tb_uv_refs');
  const tbUvRefs = [...(refsInline !== undefined ? [refsInline] : []), ...(lists.get('tb_uv_refs') ?? [])];
  const wikiEntryRaw = scalars.get('wiki_entry');
  const wikiEntry = wikiEntryRaw && !/^<.*>$/.test(wikiEntryRaw) ? wikiEntryRaw : null;
  return {
    status: normalizeStatus(statusRaw),
    statusRaw,
    scope: scalars.get('scope') ?? null,
    remaining,
    remainingFile,
    wikiJournaled: parseBool(scalars.get('wiki_journaled')),
    worktreesCleaned: parseBool(scalars.get('worktrees_cleaned')),
    tbUvCleared: parseBool(scalars.get('tb_uv_cleared')),
    wikiEntry,
    tbUvRefs,
    raw: body,
  };
}

/** Only `done` ends a session; waiting_for_human still has the agent mid-task. */
export const isSessionComplete = (r: StatusReport): boolean => r.status === 'done';

export type ChoreState = 'done' | 'needs-attention' | 'pending';

/** Done when reported true; needs attention when not true and the session is complete; pending while the session still has work. */
export function choreState(flag: boolean | null, report: StatusReport): ChoreState {
  if (flag === true) return 'done';
  return isSessionComplete(report) ? 'needs-attention' : 'pending';
}

export interface ChoreStates {
  wiki: ChoreState;
  worktrees: ChoreState;
  tbUv: ChoreState;
  /** At least one flag was reported, so the chore row shows at all. */
  anyReported: boolean;
}

export function choreStates(r: StatusReport): ChoreStates {
  return {
    wiki: choreState(r.wikiJournaled, r),
    worktrees: choreState(r.worktreesCleaned, r),
    tbUv: choreState(r.tbUvCleared, r),
    anyReported: r.wikiJournaled !== null || r.worktreesCleaned !== null || r.tbUvCleared !== null,
  };
}

/** The rollup line: a count per status that has at least one agent, in declaration order. */
export function rollup(latest: Array<StatusReport | null>): Array<{ status: Status; count: number }> {
  const counts = new Map<Status, number>();
  for (const r of latest) if (r?.status) counts.set(r.status, (counts.get(r.status) ?? 0) + 1);
  return STATUS_ORDER.filter((s) => counts.has(s)).map((s) => ({ status: s, count: counts.get(s)! }));
}

export interface WorktreeFinding {
  /** null: the status check could not run. */
  dirty: boolean | null;
  /** null: unknown, for instance no upstream. Never zero by default. */
  unpushed: number | null;
}

export interface WorktreeDecision {
  /** Show the confirmation alert with these reasons; empty means the safe path. */
  reasons: string[];
  concerning: boolean;
}

/**
 * Whether cleaning up needs a confirmation: when the session is not
 * complete, or the finding is concerning, or a check could not run. Unknown
 * counts as concerning, never as safe.
 */
export function worktreeDecision(report: StatusReport, finding: WorktreeFinding): WorktreeDecision {
  const reasons: string[] = [];
  if (!isSessionComplete(report)) reasons.push('the session hasn’t completed its assigned task(s)');
  if (finding.dirty === true) reasons.push('there’s uncommitted work in the worktree');
  if (finding.unpushed !== null && finding.unpushed > 0) reasons.push('there are commits not yet pushed/merged');
  if (finding.unpushed === null) reasons.push('whether there are unpushed commits couldn’t be checked (no upstream?)');
  if (finding.dirty === null) reasons.push('the worktree’s git state couldn’t be checked');
  const concerning = finding.dirty !== false || finding.unpushed === null || finding.unpushed > 0;
  return { reasons, concerning };
}
