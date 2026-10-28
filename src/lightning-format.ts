/**
 * The Lightning Round wire formats (standup spec §3, §4): the `cim-lightning`
 * block a presenting agent answers with, the `cim-vote` block a skeptic
 * answers with, their parsers, and the vote tally. A reply is untrusted text:
 * a field outside the listed words is null, never guessed, a block is read at
 * most as far as its size cap, and nothing here throws. The prompts that ask
 * for these blocks live in prompts.ts. Pure functions.
 */

import { fencedBlock } from './status-report.js';
import { LIGHTNING_FENCE, VOTE_FENCE, quoted } from './prompts.js';

export type Needs = 'human' | 'agent' | 'none';
export type Nature = 'decision' | 'fact' | 'measurement';
export type Checkable = 'now' | 'later' | 'never';
export type Verb = 'confirm' | 'deny' | 'challenge' | 'no_change';
export type Letter = 'A' | 'B' | 'C' | 'D';

export interface RawOption {
  letter: Letter;
  verb: Verb;
  title: string;
  /** 1-based indexes into `evidence`; empty when the option cites nothing. */
  cites: number[];
  why: string;
}

export interface RawPresentation {
  id: string | null;
  /** The `repo:` line as written; null when the block has none. */
  repo: string | null;
  needs: Needs | null;
  nature: Nature | null;
  checkable: Checkable | null;
  title: string;
  claim: string;
  assessment: string;
  /** One entry per list line, as written (`<cite>` or `<cite> "<quote>"`). */
  evidence: string[];
  options: RawOption[];
}

export interface RawVote {
  id: string | null;
  repo: string | null;
  vote: 'concur' | 'concern' | 'refuted';
  prefers: Letter | null;
  reason: string;
}

export interface VoteTally {
  concur: number;
  concern: number;
  refuted: number;
  /** Asked and did not give a usable vote. */
  silent: number;
  asked: number;
}

const NEEDS: readonly Needs[] = ['human', 'agent', 'none'];
const NATURES: readonly Nature[] = ['decision', 'fact', 'measurement'];
const CHECKABLES: readonly Checkable[] = ['now', 'later', 'never'];
const VOTES: ReadonlyArray<RawVote['vote']> = ['concur', 'concern', 'refuted'];

const VERB_LABEL: Record<Verb, string> = { confirm: 'Confirm', deny: 'Deny', challenge: 'Challenge', no_change: 'No change' };

/** A block longer than this is not a block an agent meant to send. */
const MAX_BLOCK_CHARS = 32_768;
const MAX_TITLE = 200;
const MAX_TEXT = 1_500;
const MAX_EVIDENCE = 20;
const MAX_EVIDENCE_LINE = 1_000;
const MAX_CITES = 20;
/** A reply that opens more fences of one kind than this is not read past the last of them. */
const MAX_FENCES = 8;
/** The template's `needs`, `nature`, `checkable`, `vote` and `prefers` lines list the words with pipes: only there is a `|` the ask echoed back. */
const ENUM_KEYS: ReadonlySet<string> = new Set(['needs', 'nature', 'checkable', 'vote', 'prefers']);

/** `Confirm`, `Deny`, `Challenge`, `No change`: how the card spells a verb. */
export const verbLabel = (v: Verb): string => VERB_LABEL[v];

/** True when the text opens this fence, closed or not: "replied in the format, but not usably" versus "did not use the format at all". */
export function hasFence(text: string, info: string): boolean {
  if (typeof text !== 'string') return false;
  return fencedBlock(text + '\n```', info) !== null; // a closing fence is appended so an unclosed one still counts
}

/** The closed fences with this info string, in order: their bodies, from at most MAX_FENCES opening lines. The same fence syntax as `fencedBlock` (status-report.ts), which reads only the first. */
function* fencedBlocks(text: string, info: string): Generator<string> {
  const open = new RegExp('```[ \\t]*' + info.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&') + '[ \\t]*\\r?\\n', 'g');
  let from = 0;
  for (let n = 0; n < MAX_FENCES; n++) {
    open.lastIndex = from;
    const m = open.exec(text);
    if (!m) return;
    const bodyStart = m.index + m[0].length;
    const close = text.indexOf('```', bodyStart);
    if (close < 0) return;
    yield text.slice(bodyStart, close);
    from = close + 3;
  }
}

function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  let cut = text.slice(0, max - 1);
  if (/[\uD800-\uDBFF]$/.test(cut)) cut = cut.slice(0, -1); // never leave half a surrogate pair
  return cut.trimEnd() + '…';
}

const isPlaceholder = (v: string): boolean => v.startsWith('<') && v.endsWith('>');

interface Block {
  scalars: Map<string, string>;
  lists: Map<string, string[]>;
}

/** `key: value` scalars (keys lower-cased) and `- ` list lines under a bare `key:`; a bare `<placeholder>` is the ask's template echoed back and is left out, and so is a `|` in one of the enumerated fields (free text keeps its pipes). */
function parseBlock(body: string): Block {
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
    listKey = value ? null : key;
    if (value && !isPlaceholder(value) && !(ENUM_KEYS.has(key) && value.includes('|'))) scalars.set(key, value);
  }
  return { scalars, lists };
}

/** The parsed closed blocks with this info string, in order; one that is too large is skipped. */
function* readBlocks(text: string, info: string): Generator<Block> {
  if (typeof text !== 'string') return;
  for (const body of fencedBlocks(text, info)) if (body.length <= MAX_BLOCK_CHARS) yield parseBlock(body);
}

/** The value of the last `key:` line of a fence body (empty and placeholder values do not count), or null. Linear in the body: no backtracking, whatever the text. */
function scalarOf(body: string, key: string): string | null {
  let found: string | null = null;
  for (const raw of body.split(/\r?\n/)) {
    const line = raw.trim();
    const colon = line.indexOf(':');
    if (colon < 0 || line.slice(0, colon).trim().toLowerCase() !== key) continue;
    const value = line.slice(colon + 1).trim();
    if (value && !isPlaceholder(value)) found = value;
  }
  return found;
}

/** One of the listed words, matched whole and case-insensitively (a trailing full stop or comma is allowed), else null. */
function listed<T extends string>(value: string | undefined, words: readonly T[]): T | null {
  if (value === undefined) return null;
  const word = value.trim().toLowerCase().replace(/[.,;]+$/, '');
  return (words as readonly string[]).includes(word) ? (word as T) : null;
}

function letterOf(value: string | undefined): Letter | null {
  const v = value?.trim().toUpperCase().replace(/[.,;]+$/, '');
  return v !== undefined && /^[A-D]$/.test(v) ? (v as Letter) : null;
}

/** `confirm`, `deny`, `challenge`, and `no_change` spelled with a space, hyphen, underscore or none, in any case. */
function verbOf(value: string): Verb | null {
  const v = value.trim().toLowerCase().replace(/[\s_-]+/g, '');
  if (v === 'confirm' || v === 'deny' || v === 'challenge') return v;
  return v === 'nochange' ? 'no_change' : null;
}

/**
 * The evidence numbers an option cites: positive whole numbers separated by commas, semicolons or spaces, optionally in brackets or
 * after a `#`, each once, in order, at most MAX_CITES; `1-3` is 1, 2 and 3. A field with anything else in it (a word, a full stop, a
 * stray hyphen) is prose, not a cite list, and cites nothing: the digits inside "none (checked 2 files)" are not evidence 2.
 */
function citesOf(field: string): number[] {
  const out: number[] = [];
  if (!/^[\d\s,;#[\]()-]*$/.test(field)) return out;
  const spans = field
    .split(/[\s,;#[\]()]+/)
    .filter((token) => token !== '')
    .map((token) => /^(\d+)(?:-(\d+))?$/.exec(token));
  for (const m of spans) {
    if (!m) return [];
    const from = Number(m[1]);
    const to = m[2] === undefined ? from : Number(m[2]);
    if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from < 1) continue;
    for (let n = from; n <= to && out.length < MAX_CITES; n++) if (!out.includes(n)) out.push(n);
  }
  return out;
}

/** `letter | verb | title | cite numbers | why`, split on the first four pipes so `why` may hold more; null when malformed. */
function optionOf(line: string): RawOption | null {
  const fields: string[] = [];
  let rest = line;
  for (let i = 0; i < 4; i++) {
    const pipe = rest.indexOf('|');
    if (pipe < 0) return null;
    fields.push(rest.slice(0, pipe).trim());
    rest = rest.slice(pipe + 1);
  }
  fields.push(rest.trim());
  const [letterText, verbText, title, cites, why] = fields;
  const letter = letterOf(letterText);
  const verb = verbOf(verbText);
  if (!letter || !verb || !title || isPlaceholder(title) || isPlaceholder(why)) return null;
  return { letter, verb, title: clip(title, MAX_TITLE), cites: citesOf(cites), why: clip(why, MAX_TEXT) };
}

/** The well-formed option lines, a repeated letter keeping its first line. */
function optionsOf(lines: string[]): RawOption[] {
  const out: RawOption[] = [];
  for (const line of lines) {
    const option = optionOf(line);
    if (option && !out.some((o) => o.letter === option.letter)) out.push(option);
  }
  return out;
}

const sameId = (id: string | null, expected: string): boolean => id !== null && id.toLowerCase() === expected.trim().toLowerCase();
/** A block with no `repo:` line is about any repo (agents drop lines); one with a line must name this repo, as the template wrote it. */
const sameRepo = (repo: string | null, expected: string): boolean => repo === null || quoted(repo, 120).toLowerCase() === quoted(expected, 120).toLowerCase();

/** One block read as a presentation; null unless the id (and repo, when given) match, there are 2+ well-formed options and a claim or assessment. */
function presentationOf({ scalars, lists }: Block, expectId: string | undefined, expectRepo: string | undefined): RawPresentation | null {
  const id = scalars.get('id') ?? null;
  const repo = scalars.get('repo') ?? null;
  if (expectId !== undefined && !sameId(id, expectId)) return null;
  if (expectRepo !== undefined && !sameRepo(repo, expectRepo)) return null;
  const claim = clip(scalars.get('claim') ?? '', MAX_TEXT);
  const assessment = clip(scalars.get('assessment') ?? '', MAX_TEXT);
  if (!claim && !assessment) return null;
  const options = optionsOf(lists.get('options') ?? []);
  if (options.length < 2) return null;
  return {
    id,
    repo,
    needs: listed(scalars.get('needs'), NEEDS),
    nature: listed(scalars.get('nature'), NATURES),
    checkable: listed(scalars.get('checkable'), CHECKABLES),
    title: clip(scalars.get('title') ?? '', MAX_TITLE),
    claim,
    assessment,
    evidence: (lists.get('evidence') ?? [])
      .filter((line) => line !== '')
      .slice(0, MAX_EVIDENCE)
      .map((line) => clip(line, MAX_EVIDENCE_LINE)),
    options,
  };
}

/**
 * Parse a turn's text as a presentation: the first `cim-lightning` block (of at most 8) that is usable and about this row. A block whose
 * id differs from `expectId`, or whose `repo:` line differs from `expectRepo`, is another row's and is skipped; one without a repo line is not.
 */
export function parsePresentation(text: string, expectId?: string, expectRepo?: string): RawPresentation | null {
  for (const block of readBlocks(text, LIGHTNING_FENCE)) {
    const found = presentationOf(block, expectId, expectRepo);
    if (found) return found;
  }
  return null;
}

/** Parse a turn's text as a vote: the first `cim-vote` block (of at most 8) with a recognized `vote` that is about this row, as for `parsePresentation`. */
export function parseVote(text: string, expectId?: string, expectRepo?: string): RawVote | null {
  for (const { scalars } of readBlocks(text, VOTE_FENCE)) {
    const id = scalars.get('id') ?? null;
    const repo = scalars.get('repo') ?? null;
    if (expectId !== undefined && !sameId(id, expectId)) continue;
    if (expectRepo !== undefined && !sameRepo(repo, expectRepo)) continue;
    const vote = listed(scalars.get('vote'), VOTES);
    if (vote) return { id, repo, vote, prefers: letterOf(scalars.get('prefers')), reason: clip(scalars.get('reason') ?? '', MAX_TEXT) };
  }
  return null;
}

/**
 * True when the text has fences of this kind and every one says it is about another row: another id, or this id under another repo.
 * A fence with no id line (or only the template's placeholder) is not provably another's. Reads unclosed fences too, and does not
 * parse the body: only its `id:` and `repo:` lines, in time linear in the text.
 */
export function namesAnotherRow(text: string, info: string, expectId: string, expectRepo?: string): boolean {
  if (typeof text !== 'string') return false;
  let any = false;
  for (const body of fencedBlocks(text + '\n```', info)) {
    const id = scalarOf(body, 'id');
    if (id === null || (sameId(id, expectId) && (expectRepo === undefined || sameRepo(scalarOf(body, 'repo'), expectRepo)))) return false;
    any = true;
  }
  return any;
}

/** Count the votes; a null entry was asked and did not answer, so it is silent. */
export function tallyVotes(votes: Array<RawVote | null>): VoteTally {
  const tally: VoteTally = { concur: 0, concern: 0, refuted: 0, silent: 0, asked: votes.length };
  for (const v of votes) {
    if (v) tally[v.vote] += 1;
    else tally.silent += 1;
  }
  return tally;
}
