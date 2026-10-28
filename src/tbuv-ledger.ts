/**
 * The TB/UV ledger reader (standup spec §2, §3): tombstone and
 * unverified-claim rows are JSONL files on a repo's ledger ref, read with
 * `git show <ref>:<file>`. One parser serves the hub's sign-off lookup and
 * the Lightning Round. Git runs only through the injected Runner, as an argv
 * array. A repo with no ledger branch is normal, and a failure never throws.
 */

import { realpath } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import type { Runner } from './runner.js';

export const DEFAULT_LEDGER_REF = 'wiki';
/** A ledger file larger than this (bytes of git output) is not read: git is killed at the cap, and the file is reported as too large, never read as a silent prefix. */
export const MAX_LEDGER_BYTES = 2 * 1024 * 1024;

const GIT_TIMEOUT_MS = 20_000;
const LEDGER_FILES = [
  { kind: 'tombstone', file: 'tombstones.jsonl' },
  { kind: 'unverified', file: 'unverified.jsonl' },
] as const;

export type RowKind = 'tombstone' | 'unverified';
export interface RepoRef {
  name: string;
  /** The repo root (the main worktree). */
  path: string;
}

export interface LedgerRow {
  /** `<tb|uv>:<repo name>:<ID>` */
  key: string;
  /** Uppercased. */
  id: string;
  kind: RowKind;
  repo: string;
  repoPath: string;
  /** 'YYYY-MM-DD': an ISO timestamp is cut to its date. */
  date?: string;
  claim?: string;
  doubt?: string;
  settlesIt?: string;
  raisedBy?: string;
  /** Lower-cased; 'open' when absent. */
  status: string;
  supersededBy?: string;
  open: boolean;
  /** The parsed line, unknown fields included. */
  raw: Record<string, unknown>;
}

/**
 * `unavailable`: git could not run, or neither file could be read.
 * `note`: a file that was there but could not be read (over 2 MiB, git timed out); its rows are missing, which is not the same as an absent ledger.
 */
export interface LedgerRead {
  rows: LedgerRow[];
  unavailable: boolean;
  note?: string;
}

const CLOSED_STATUSES = new Set(['settled', 'confirmed', 'denied', 'superseded', 'resolved', 'closed', 'done', 'wontfix', 'withdrawn']);

/** Open unless the status is a closed word or a superseder is named; an unknown status reads as open, so nothing silently disappears. */
export function isOpen(status: string | undefined, supersededBy?: string): boolean {
  if (supersededBy !== undefined && supersededBy.trim() !== '') return false;
  return !CLOSED_STATUSES.has((status ?? '').trim().toLowerCase());
}

/** A trimmed non-blank string, else undefined: other types are ignored, not coerced. */
function text(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined;
  const t = v.trim();
  return t === '' ? undefined : t;
}

/** The first alias holding usable text. */
function firstText(o: Record<string, unknown>, keys: readonly string[]): string | undefined {
  for (const k of keys) {
    const t = text(o[k]);
    if (t !== undefined) return t;
  }
  return undefined;
}

const pad = (n: number, width = 2) => String(n).padStart(width, '0');

/** 'YYYY-MM-DD' from an ISO date or timestamp string, or from an epoch number (seconds below 1e11, else milliseconds; the user's local day); undefined for anything else. */
function ledgerDate(v: unknown): string | undefined {
  if (typeof v === 'string') {
    const m = /^(\d{4})-(\d{2})-(\d{2})(?:$|[T ])/.exec(v.trim());
    if (!m) return undefined;
    const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
    const check = new Date(Date.UTC(y, mo - 1, d));
    // 2026-02-30 rolls over in Date.UTC: a date that does not survive the round trip is not a date.
    return check.getUTCFullYear() === y && check.getUTCMonth() === mo - 1 && check.getUTCDate() === d ? `${m[1]}-${m[2]}-${m[3]}` : undefined;
  }
  if (typeof v === 'number' && Number.isFinite(v) && v > 0) {
    const t = new Date(v < 1e11 ? v * 1000 : v);
    if (Number.isNaN(t.getTime()) || t.getFullYear() > 9999) return undefined;
    return `${pad(t.getFullYear(), 4)}-${pad(t.getMonth() + 1)}-${pad(t.getDate())}`;
  }
  return undefined;
}

/** What an id may be: it is quoted into the agent prompts and the panel, so a space, a newline or a sentence in it is not an id. */
const ROW_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** A row id: a non-blank string or a finite number (as the hub's lookup always read it), uppercased; '' when it is not a plain identifier. */
function rowId(v: unknown): string {
  const id = typeof v === 'string' ? v.trim().toUpperCase() : typeof v === 'number' && Number.isFinite(v) ? String(v).toUpperCase() : '';
  return ROW_ID.test(id) ? id : '';
}

/** The row that closes this one: a non-blank string or a finite number, or the first such value of a list, from either spelling. */
function supersederOf(o: Record<string, unknown>): string | undefined {
  for (const k of ['superseded_by', 'supersededBy']) {
    for (const v of Array.isArray(o[k]) ? o[k] : [o[k]]) {
      const t = typeof v === 'number' && Number.isFinite(v) ? String(v) : text(v);
      if (t !== undefined) return t;
    }
  }
  return undefined;
}

/** One JSON object per line. Blank and malformed lines, and lines that are not objects, are skipped; the first row for an id wins. */
export function parseLedger(jsonl: string, kind: RowKind, repo: RepoRef): LedgerRow[] {
  const prefix = kind === 'tombstone' ? 'tb' : 'uv';
  const rows: LedgerRow[] = [];
  const seen = new Set<string>();
  for (const line of jsonl.replace(/^\uFEFF/, '').split(/\r?\n/)) {
    if (line.trim() === '') continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue; // a malformed line is skipped, never fatal
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) continue;
    const raw = parsed as Record<string, unknown>;
    const id = rowId(raw.id);
    if (id === '' || seen.has(id)) continue;
    seen.add(id);
    const date = ledgerDate(raw.date) ?? ledgerDate(raw.ts);
    const claim = text(raw.claim);
    const doubt = text(raw.doubt);
    const settlesIt = firstText(raw, ['settles_it', 'settlesIt']);
    const raisedBy = firstText(raw, ['raised_by', 'raisedBy', 'skeptic', 'by']);
    const supersededBy = supersederOf(raw);
    const status = text(raw.status)?.toLowerCase() ?? 'open';
    rows.push({
      key: `${prefix}:${repo.name}:${id}`,
      id,
      kind,
      repo: repo.name,
      repoPath: repo.path,
      ...(date !== undefined && { date }),
      ...(claim !== undefined && { claim }),
      ...(doubt !== undefined && { doubt }),
      ...(settlesIt !== undefined && { settlesIt }),
      ...(raisedBy !== undefined && { raisedBy }),
      status,
      ...(supersededBy !== undefined && { supersededBy }),
      open: isOpen(status, supersededBy),
      raw,
    });
  }
  return rows;
}

/** A ref reaches git argv only when it cannot be read as an option or split into several arguments. */
function safeRef(ref: unknown): boolean {
  return typeof ref === 'string' && ref !== '' && !ref.startsWith('-') && !/[\s\0]/.test(ref);
}

/** What one ledger file gave: its rows, a note when it was there but could not be read, or null when git has no such file. */
type FileRead = { rows: LedgerRow[] } | { note: string } | null;

/**
 * Both ledger files of one repo, read concurrently: the tombstones first, then the unverified rows.
 * A file git cannot show (no ledger ref, not in it, git failing) has no rows, and a read is `unavailable` only when no file gave any.
 * A file that is there but unreadable (over the size cap, which kills git early, or git timing out) also has no rows, but it is named in `note`: it is not an absent ledger.
 */
export async function readLedger(run: Runner, repo: RepoRef, ref: string = DEFAULT_LEDGER_REF): Promise<LedgerRead> {
  if (!safeRef(ref) || repo.path === '' || repo.path.includes('\0')) return { rows: [], unavailable: true };
  const read = async ({ kind, file }: (typeof LEDGER_FILES)[number]): Promise<FileRead> => {
    try {
      const r = await run('git', ['-C', repo.path, 'show', `${ref}:${file}`], { timeoutMs: GIT_TIMEOUT_MS, maxOutputBytes: MAX_LEDGER_BYTES });
      if (r.timedOut) return { note: `git timed out reading ${file}` };
      if (r.truncated) return { note: `${file} is larger than 2 MiB` };
      if (r.code !== 0) return null;
      if (Buffer.byteLength(r.stdout) > MAX_LEDGER_BYTES) return { note: `${file} is larger than 2 MiB` }; // a runner that does not cap its output
      return { rows: parseLedger(r.stdout, kind, repo) };
    } catch {
      return null; // git missing or a bad cwd: the file reads as absent
    }
  };
  const results = await Promise.all(LEDGER_FILES.map(read));
  const notes = [...new Set(results.flatMap((r) => (r !== null && 'note' in r ? [r.note] : [])))];
  return {
    rows: results.flatMap((r) => (r !== null && 'rows' in r ? r.rows : [])),
    unavailable: results.every((r) => r === null || 'note' in r),
    ...(notes.length > 0 && { note: notes.join('; ') }),
  };
}

const byPath = (a: RepoRef, b: RepoRef) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);

/**
 * Repos that share a folder name would share row keys (`uv:app:UV-1`), so each of them is named `<parent folder>~<folder>`;
 * when that still collides, `~2`, `~3` follow in path order. The names depend on the paths only, not on the order the repos were found in, and a name that is already unique is kept.
 */
export function uniqueRepoNames(repos: RepoRef[]): RepoRef[] {
  const sharing = new Map<string, RepoRef[]>();
  for (const r of repos) sharing.set(r.name, [...(sharing.get(r.name) ?? []), r]);
  const names = new Map<RepoRef, string>();
  for (const group of sharing.values()) {
    if (group.length < 2) continue;
    const used = new Map<string, number>();
    for (const r of [...group].sort(byPath)) {
      const base = `${basename(dirname(r.path))}~${r.name}`;
      const n = (used.get(base) ?? 0) + 1;
      used.set(base, n);
      names.set(r, n === 1 ? base : `${base}~${n}`);
    }
  }
  return repos.map((r) => (names.has(r) ? { ...r, name: names.get(r) as string } : r));
}

/**
 * The distinct repos behind a list of directories (agent working directories), first seen first.
 * `git rev-parse --git-common-dir` is relative to the directory for a main worktree and absolute for a linked one;
 * only a common dir named `.git` is a repo (its parent is the root), so worktrees of one repo collapse, and bare repos and submodule gitdirs are skipped.
 * A root is compared by its real path, so a symlinked or differently spelled path is the same repo; two repos with one folder name get distinct names (`uniqueRepoNames`).
 */
export async function discoverRepos(run: Runner, dirs: string[]): Promise<RepoRef[]> {
  const distinct = [...new Set(dirs.filter((d) => d.trim() !== ''))];
  const roots = await Promise.all(
    distinct.map(async (dir): Promise<string | null> => {
      try {
        const r = await run('git', ['-C', dir, 'rev-parse', '--git-common-dir'], { timeoutMs: GIT_TIMEOUT_MS });
        if (r.code !== 0) return null;
        const out = r.stdout.split('\n')[0].replace(/\r$/, '');
        if (out.trim() === '') return null;
        const common = resolve(dir, out);
        if (basename(common) !== '.git') return null;
        const root = dirname(common);
        return await realpath(root).catch(() => root); // a path that is not on this disk (or not readable) is compared as written
      } catch {
        return null; // git missing or a bad directory: not a repo as far as we can tell
      }
    })
  );
  const repos: RepoRef[] = [];
  const seen = new Set<string>();
  for (const root of roots) {
    if (root === null || seen.has(root)) continue;
    const name = basename(root);
    if (name === '') continue; // the filesystem root has no name
    seen.add(root);
    repos.push({ name, path: root });
  }
  return uniqueRepoNames(repos);
}
