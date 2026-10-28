/**
 * The Lightning Round wire formats (standup spec §3, §4): the `cim-lightning`
 * block a presenting agent answers with, the `cim-vote` block a skeptic
 * answers with, their parsers, and the vote tally. A reply is untrusted text:
 * a field outside the listed words is null, never guessed, a block is read at
 * most as far as its size cap, and nothing here throws. The prompts that ask
 * for these blocks live in prompts.ts. Pure functions.
 */

import { fencedBlock } from './status-report.js';
import { LIGHTNING_FENCE, VOTE_FENCE } from './prompts.js';

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

/** `Confirm`, `Deny`, `Challenge`, `No change`: how the card spells a verb. */
export const verbLabel = (v: Verb): string => VERB_LABEL[v];

/** True when the text opens this fence, closed or not: "replied in the format, but not usably" versus "did not use the format at all". */
export function hasFence(text: string, info: string): boolean {
  if (typeof text !== 'string') return false;
  return fencedBlock(text + '\n```', info) !== null; // a closing fence is appended so an unclosed one still counts
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

/** `key: value` scalars (keys lower-cased) and `- ` list lines under a bare `key:`; a value with `|` or a bare `<placeholder>` is the ask's template echoed back and is left out. */
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
    if (value && !value.includes('|') && !isPlaceholder(value)) scalars.set(key, value);
  }
  return { scalars, lists };
}

/** The parsed first block with this info string, or null without a closing fence or when it is too large. */
function readBlock(text: string, info: string): Block | null {
  if (typeof text !== 'string') return null;
  const body = fencedBlock(text, info);
  if (body === null || body.length > MAX_BLOCK_CHARS) return null;
  return parseBlock(body);
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

/** Comma or space separated positive whole numbers, each once, in order; anything else in the field is ignored. */
function citesOf(field: string): number[] {
  const out: number[] = [];
  for (const token of field.split(/[\s,]+/)) {
    if (!/^[0-9]+$/.test(token)) continue;
    const n = Number(token);
    if (Number.isSafeInteger(n) && n >= 1 && !out.includes(n)) out.push(n);
    if (out.length >= MAX_CITES) break;
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

/** Parse a turn's text as a presentation: the first `cim-lightning` block only; null unless it closes, the id matches `expectId` when given, there are 2+ well-formed options and a claim or assessment. */
export function parsePresentation(text: string, expectId?: string): RawPresentation | null {
  const block = readBlock(text, LIGHTNING_FENCE);
  if (!block) return null;
  const { scalars, lists } = block;
  const id = scalars.get('id') ?? null;
  if (expectId !== undefined && !sameId(id, expectId)) return null;
  const claim = clip(scalars.get('claim') ?? '', MAX_TEXT);
  const assessment = clip(scalars.get('assessment') ?? '', MAX_TEXT);
  if (!claim && !assessment) return null;
  const options = optionsOf(lists.get('options') ?? []);
  if (options.length < 2) return null;
  return {
    id,
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

/** Parse a turn's text as a vote. Only the first `cim-vote` block is read. Null without a recognized `vote` or when `id` does not match `expectId`. */
export function parseVote(text: string, expectId?: string): RawVote | null {
  const block = readBlock(text, VOTE_FENCE);
  if (!block) return null;
  const { scalars } = block;
  const id = scalars.get('id') ?? null;
  if (expectId !== undefined && !sameId(id, expectId)) return null;
  const vote = listed(scalars.get('vote'), VOTES);
  if (!vote) return null;
  return { id, vote, prefers: letterOf(scalars.get('prefers')), reason: clip(scalars.get('reason') ?? '', MAX_TEXT) };
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
