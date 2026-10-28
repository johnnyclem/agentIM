/**
 * Evidence grounding (standup spec §3, §5): parse a citation an agent wrote
 * (`path:lines@sha "quote"`) and check it against the repository, so the card
 * can say grounded or UNGROUNDED. Grounded means the file exists at that
 * commit, the lines exist, and a quote, when given, is in them. The text is
 * untrusted: the path and sha reach git as argv, so both are validated twice
 * (parse and ground), git runs only through the injected Runner as argv
 * arrays, and a file is read only after its size is known to be small.
 * A cite is read the way the agent saw it: relative to its working
 * directory, which may be below the repo root. Nothing here throws.
 */

import { posix } from 'node:path';
import type { RunResult, Runner } from './runner.js';

export interface Cite {
  raw: string;
  path: string;
  startLine: number;
  endLine: number;
  sha?: string;
  quote?: string;
}

export interface Grounding {
  status: 'grounded' | 'ungrounded';
  /** The first 7 characters of the commit checked; set when grounded. */
  sha?: string;
  /** Why the cite could not be confirmed; set when ungrounded. */
  reason?: string;
}

const GIT_TIMEOUT_MS = 20_000;
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_LINE = 10_000_000;
const SHA = /^[0-9a-f]{7,40}$/;
/** What git prints for a resolved commit; checked before it is used as argv again. */
const FULL_SHA = /^[0-9a-f]{7,64}$/;
/** path, start, end, sha, quote. The path excludes whitespace, ":" and the double quote; "@" is fine in a path. */
const CITE = /^([^\s:"]+):([0-9]+)(?:-([0-9]+))?(?:@([^\s"]+))?(?:\s+"([\s\S]*)")?$/;

/**
 * Not an option, no `..` segment, no NUL, no backslash. An absolute path is accepted as text (the tools of an agent print them):
 * groundCite turns one that lies inside the repo into a repo path and refuses any other, so git never sees an absolute path.
 */
function validPath(path: unknown): path is string {
  if (typeof path !== 'string' || path === '') return false;
  if (path.startsWith('-')) return false;
  if (path.includes('\0') || path.includes('\\')) return false;
  return !path.split('/').includes('..');
}

/** 1-based, whole numbers, start <= end, bounded; a NaN or a string from a hand-built Cite fails here. */
function validLines(start: number, end: number): boolean {
  return Number.isInteger(start) && Number.isInteger(end) && start >= 1 && end >= start && end <= MAX_LINE;
}

/** `<path>:<start>[-<end>][@<sha>][ "<quote>"]`, or null for anything else, including a path or sha git could read as an option. */
export function parseCite(text: string): Cite | null {
  if (typeof text !== 'string') return null;
  const raw = text.trim();
  const m = CITE.exec(raw);
  if (!m) return null;
  const [, path, first, last, sha, quote] = m;
  const startLine = Number(first);
  const endLine = last === undefined ? startLine : Number(last);
  if (!validPath(path) || !validLines(startLine, endLine)) return null;
  const cite: Cite = { raw, path, startLine, endLine };
  if (sha !== undefined) {
    const lower = sha.toLowerCase();
    if (!SHA.test(lower)) return null;
    cite.sha = lower;
  }
  if (quote) cite.quote = quote;
  return cite;
}

const ungrounded = (reason: string): Grounding => ({ status: 'ungrounded', reason });

const collapse = (s: string): string => s.replace(/\s+/g, ' ');

/** Lines of a file: a trailing newline ends the last line, it does not start another. */
function linesOf(content: string): string[] {
  if (content === '') return [];
  const lines = content.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/** Where the checkout sits in its repo: `prefix` is its path below the top ('' at the top, else ending in '/'), `top` the repo root. */
interface Layout {
  prefix: string;
  top: string;
}

/**
 * Check a cite against `gitDir`: resolve the commit (the cite's sha, else
 * HEAD, the checkout the agent looked at), then the file, its size, its
 * lines and its quote. Every git call has a timeout. A runner that throws, a
 * git that times out (`git timed out`) and one whose output was cut
 * (`output too large`) make the cite ungrounded with that as the reason.
 * The path is read from `gitDir`, as the agent saw it: `<prefix><path>`
 * first (the prefix is the checkout's folder below the repo root), the repo-root path only when that file is not in the commit; an
 * absolute path inside the repo is mapped to its repo path, any other is
 * "outside the repository".
 */
export async function groundCite(run: Runner, gitDir: string, cite: Cite): Promise<Grounding> {
  const valid = typeof cite === 'object' && cite !== null && validPath(cite.path) && validLines(cite.startLine, cite.endLine) && (cite.sha === undefined || (typeof cite.sha === 'string' && SHA.test(cite.sha)));
  if (!valid) return ungrounded('not a valid citation');
  // `git -C ""` changes nothing, so an empty dir would check the daemon's own checkout.
  if (typeof gitDir !== 'string' || gitDir === '') return ungrounded('no checkout to check against');
  try {
    return await check(run, gitDir, cite);
  } catch (err) {
    return ungrounded((err instanceof Error ? err.message : String(err)) || 'git failed');
  }
}

async function check(run: Runner, gitDir: string, cite: Cite): Promise<Grounding> {
  /** A git call that timed out or was cut at its output cap is not an answer about the cite: it throws, and groundCite says why. */
  const git = async (args: string[], maxOutputBytes?: number) => {
    const r = await run('git', ['-C', gitDir, ...args], { timeoutMs: GIT_TIMEOUT_MS, ...(maxOutputBytes !== undefined && { maxOutputBytes }) });
    if (r.timedOut) throw new Error('git timed out');
    if (r.truncated) throw new Error('output too large');
    return r;
  };
  const { path, startLine, endLine } = cite;

  const resolved = await git(['rev-parse', '--verify', '--quiet', `${cite.sha ?? 'HEAD'}^{commit}`]);
  const full = resolved.stdout.trim();
  if (resolved.code !== 0 || !FULL_SHA.test(full)) return ungrounded(cite.sha ? `commit ${cite.sha.slice(0, 7)} not found` : 'no commit at HEAD');
  const short = full.slice(0, 7);

  // The names to try, in order: where the agent was standing, then the repo root. git cannot say where that is (a bare repo, a failing git): the path is a repo-root path, as it always was.
  const where = await layout(git);
  const tries: string[] = [];
  if (path.startsWith('/')) {
    const inside = where === null ? '' : posix.relative(where.top, path);
    if (inside === '' || inside === '..' || inside.startsWith('../') || posix.isAbsolute(inside)) return ungrounded('outside the repository');
    tries.push(inside);
  } else if (where === null) {
    tries.push(path);
  } else {
    const here = path.replace(/^(?:\.\/)+/, ''); // "./x" says "from here"
    tries.push(where.prefix + here);
    if (here === path && where.prefix !== '') tries.push(path);
  }

  let object = `${full}:${tries[0]}`;
  let kind = await git(['cat-file', '-t', object]);
  if (kind.code !== 0 && tries.length > 1) {
    object = `${full}:${tries[1]}`;
    kind = await git(['cat-file', '-t', object]);
  }
  if (kind.code !== 0) return ungrounded(`${path} is not in ${short}`);
  if (kind.stdout.trim() !== 'blob') return ungrounded(`${path} is not a file`);

  const sized = await git(['cat-file', '-s', object]);
  const size = sized.stdout.trim();
  if (sized.code !== 0 || !/^[0-9]+$/.test(size)) return ungrounded(`could not read the size of ${path}`);
  if (Number(size) > MAX_FILE_BYTES) return ungrounded('too large to check');

  const shown = await git(['show', object], MAX_FILE_BYTES + 1);
  if (shown.code !== 0) return ungrounded(`could not read ${path} at ${short}`);
  const content = shown.stdout;
  if (content.length > MAX_FILE_BYTES) return ungrounded('too large to check');
  if (content.includes('\0')) return ungrounded('binary file');

  const lines = linesOf(content);
  if (endLine > lines.length) return ungrounded(`lines ${startLine}-${endLine} are beyond the end of the file (${lines.length} lines)`);

  if (cite.quote && !collapse(lines.slice(startLine - 1, endLine).join('\n')).includes(collapse(cite.quote))) {
    return ungrounded(`quote not found in lines ${startLine}-${endLine}`);
  }
  return { status: 'grounded', sha: short };
}

/** `git rev-parse --show-prefix --show-toplevel` run from the checkout: null when git refuses or prints something that is not a prefix and an absolute top. */
async function layout(git: (args: string[]) => Promise<RunResult>): Promise<Layout | null> {
  const r = await git(['rev-parse', '--show-prefix', '--show-toplevel']);
  if (r.code !== 0) return null;
  const [prefix, top] = r.stdout.split('\n').map((l) => l.replace(/\r$/, ''));
  if (prefix === undefined || top === undefined || !top.startsWith('/') || prefix.startsWith('/') || (prefix !== '' && !prefix.endsWith('/'))) return null;
  return { prefix, top };
}
