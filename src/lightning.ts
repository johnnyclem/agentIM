/**
 * The Lightning Round engine (standup spec §6.2, §6.3): a queue of open
 * TB/UV ledger rows that a human settles one card at a time. A row is
 * presented by an agent that works in its repo: asked over the inbox, its
 * reply read from its transcript past the size it had when the ask went out,
 * and every cite grounded against that agent's checkout before the card is
 * shown. When no agent gives a usable block the card shows the ledger row.
 * The human's choice goes back to an agent as an instruction; this module
 * never writes the ledger. Timing, sends, reads and git are injected, and
 * abort() cancels every poller.
 */

import { randomUUID } from 'node:crypto';
import { type Agent, shortID } from './agent.js';
import { parseCite, groundCite, type Cite, type Grounding } from './grounding.js';
import { hasFence, parsePresentation, parseVote, tallyVotes, type Checkable, type Letter, type Nature, type Needs, type RawOption, type RawPresentation, type RawVote, type Verb, type VoteTally } from './lightning-format.js';
import { LIGHTNING_FENCE, lightningDecision, lightningPresentAsk, lightningVoteAsk, quoted } from './prompts.js';
import { fencedBlock } from './status-report.js';
import { KEYS, type KV } from './store.js';
import type { Clock } from './clock.js';
import type { Runner } from './runner.js';
import type { LedgerRow, RowKind } from './tbuv-ledger.js';

export type ItemPhase = 'queued' | 'presenting' | 'presented' | 'fallback' | 'decided' | 'deferred';

/** `n` is 1-based: the number an option cites. */
export interface PresentedEvidence {
  n: number;
  raw: string;
  cite: Cite | null;
  grounding: Grounding;
}

export interface PresentedOption extends RawOption {
  grounding: 'grounded' | 'ungrounded';
}

export interface Presentation {
  source: 'agent' | 'ledger';
  presentedBy: string;
  needs: Needs | null;
  nature: Nature | null;
  checkable: Checkable | null;
  title: string;
  claim: string;
  assessment: string;
  evidence: PresentedEvidence[];
  options: PresentedOption[];
}

export interface VoteEntry {
  sessionID: string;
  name: string;
  vote: RawVote['vote'] | null;
  prefers: Letter | null;
  reason: string;
}

export interface LightningItemView {
  key: string;
  id: string;
  kind: RowKind;
  repo: string;
  /** `<ID> <claim>` */
  title: string;
  /** `<repo>. Doubt: <doubt>` */
  summary: string;
  row: Omit<LedgerRow, 'raw'>;
  phase: ItemPhase;
  presentation: Presentation | null;
  votes: { asked: boolean; tally: VoteTally; entries: VoteEntry[] };
  decision: { option: Letter; verb: Verb; at: number; delivered: boolean } | null;
}

export interface LightningView {
  active: boolean;
  current: string | null;
  panelSize: number;
  /** Queue order, decided and deferred items included so a card can show its history. */
  items: LightningItemView[];
  counts: { total: number; remaining: number; decided: number; deferred: number };
  /** The last 20 status lines, oldest first. */
  log: string[];
}

/** `decided`: the row is settled for this round, whether or not anything was sent (no_change sends nothing). */
export interface ApproveResult {
  delivered: boolean;
  decided: boolean;
}

const DAY_MS = 86_400_000;
/** A decided row comes back after this long if the ledger still lists it open. */
const DECISION_TTL_MS = 7 * DAY_MS;
/** A stored entry is dropped once its `until` is this far in the past. */
const KEEP_AFTER_UNTIL_MS = 30 * DAY_MS;

const PRESENT_TIMEOUT_MS = 90_000;
const VOTE_TIMEOUT_MS = 60_000;
/** After the vote window a late vote still counts for this long, as long as the card is open. */
const LATE_VOTE_MS = 15 * 60_000;
const POLL_MS = 2_000;
const MAX_PRESENTERS = 2;
const PANEL_SIZE = 4;
const PREFETCH = 1;
const LOG_LINES = 20;

interface DecisionRecord {
  state: 'decided' | 'deferred';
  option?: Letter;
  verb?: Verb;
  at: number;
  until: number;
}

function isDecisionRecord(v: unknown): v is DecisionRecord {
  if (typeof v !== 'object' || v === null) return false;
  const r = v as Record<string, unknown>;
  return (r.state === 'decided' || r.state === 'deferred') && Number.isFinite(r.at) && Number.isFinite(r.until);
}

/** Which rows a human has settled or put off, kept in the KV store so they stay out of the next round. */
export class DecisionStore {
  constructor(
    private readonly kv: KV,
    private readonly clock: Clock
  ) {}

  /** The stored entries; a value that is not an object reads as empty, and an entry that is not a record is skipped. */
  private load(): Map<string, DecisionRecord> {
    const out = new Map<string, DecisionRecord>();
    const stored = this.kv.get<unknown>(KEYS.lightning);
    if (typeof stored !== 'object' || stored === null || Array.isArray(stored)) return out;
    for (const [key, rec] of Object.entries(stored)) if (isDecisionRecord(rec)) out.set(key, rec);
    return out;
  }

  /** True until the entry's `until`. */
  hidden(key: string): boolean {
    return (this.load().get(key)?.until ?? 0) > this.clock();
  }

  /** Entries more than 30 days past their `until` are dropped on the way. */
  record(key: string, rec: { state: 'decided' | 'deferred'; option?: Letter; verb?: Verb }, until: number): void {
    const now = this.clock();
    const entries = this.load();
    entries.set(key, { state: rec.state, ...(rec.option !== undefined && { option: rec.option }), ...(rec.verb !== undefined && { verb: rec.verb }), at: now, until });
    for (const [k, r] of entries) if (now - r.until > KEEP_AFTER_UNTIL_MS) entries.delete(k);
    this.kv.set(KEYS.lightning, Object.fromEntries(entries));
  }
}

export interface LightningDeps {
  clock: Clock;
  sleep: (ms: number) => Promise<void>;
  run: Runner;
  /** The current messageable agents. */
  messageable: () => Agent[];
  /** The repo root the agent's cwd belongs to, or null. */
  repoOf: (agent: Agent) => string | null;
  sendInbox: (agent: Agent, text: string) => Promise<void>;
  /** The transcript's current byte size: replies are read from here on. */
  transcriptSize: (agent: Agent) => Promise<number>;
  /** New assistant texts past the offset, with the new offset. */
  readSince: (agent: Agent, offset: number) => Promise<{ texts: string[]; endOffset: number }>;
  decisions: DecisionStore;
  onChange?: (r: LightningRound) => void;
  /** Per presenter. */
  presentTimeoutMs?: number;
  voteTimeoutMs?: number;
  pollMs?: number;
  maxPresenters?: number;
}

interface Item {
  row: LedgerRow;
  phase: ItemPhase;
  presentation: Presentation | null;
  /** Who presented it, for the decision relay; null for a ledger presentation. */
  presenter: Agent | null;
  rejectedBy: Set<string>;
  /** Bumped whenever the presentation is replaced or the item leaves play, so a background task that outlived its moment can tell. */
  epoch: number;
  votes: { asked: boolean; entries: Map<string, VoteEntry> };
  decision: LightningItemView['decision'];
  /** The decision relay in flight: a second approve waits for it instead of sending again. */
  approving: Promise<ApproveResult> | null;
}

const newItem = (row: LedgerRow): Item => ({ row, phase: 'queued', presentation: null, presenter: null, rejectedBy: new Set(), epoch: 0, votes: { asked: false, entries: new Map() }, decision: null, approving: null });

/** A card with something to act on. */
const isOpenPhase = (p: ItemPhase): boolean => p === 'presented' || p === 'fallback';
/** Not yet settled or put off. */
const isLive = (p: ItemPhase): boolean => p !== 'decided' && p !== 'deferred';

const errText = (err: unknown): string => quoted(err instanceof Error ? err.message : String(err), 300);

/** A whole number option of at least `min`, or its default when it is not a finite number. */
const count = (v: number | undefined, dflt: number, min = 0): number => (typeof v === 'number' && Number.isFinite(v) ? Math.max(min, Math.floor(v)) : dflt);

/** The next midnight in the user's own time zone: built from the local date, so a DST change does not shift it. */
function nextLocalMidnight(now: number): number {
  const d = new Date(now);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime();
}

/** The card shown when no agent presented the row: the row itself, with the three plain ways to settle it. */
function ledgerPresentation(row: LedgerRow): Presentation {
  const tomb = row.kind === 'tombstone';
  const what = row.claim ? `“${quoted(row.claim, 120)}”` : row.id;
  const assessment = [row.doubt && `Doubt: ${row.doubt}`, row.settlesIt && `To settle it: ${row.settlesIt}`].filter(Boolean).join('\n');
  const options: PresentedOption[] = [
    { letter: 'A', verb: 'confirm', title: tomb ? 'The tombstone stands' : 'The claim holds', cites: [], why: `${what} ${tomb ? 'stands' : 'holds'}.`, grounding: 'ungrounded' },
    { letter: 'B', verb: 'deny', title: tomb ? 'The tombstone is wrong' : 'The claim is wrong', cites: [], why: `${what} is wrong.`, grounding: 'ungrounded' },
    { letter: 'C', verb: 'no_change', title: 'Leave the row as it is', cites: [], why: `${row.id} stays open for now.`, grounding: 'ungrounded' },
  ];
  return { source: 'ledger', presentedBy: row.raisedBy ?? '', needs: null, nature: null, checkable: null, title: quoted(row.claim ?? row.id, 200), claim: row.claim ?? '', assessment, evidence: [], options };
}

/** The `id:` line of the first cim-lightning block, closed or not; null when it has none or only the ask's echoed template. */
function fenceId(text: string): string | null {
  const body = fencedBlock(text + '\n```', LIGHTNING_FENCE);
  const value = body === null ? undefined : /^[ \t]*id[ \t]*:[ \t]*(.*?)[ \t]*$/im.exec(body)?.[1];
  return value && !value.includes('|') && !(value.startsWith('<') && value.endsWith('>')) ? value : null;
}

type Reply = { kind: 'usable'; parsed: RawPresentation } | { kind: 'unusable' } | { kind: 'chatty' } | { kind: 'foreign' };

/**
 * One assistant text read for the ask about row `id`. Two asks to one agent share a transcript, so a block that names
 * another row is `foreign`: neither a win nor a failure of this ask. No fence at all is `chatty` and is ignored.
 */
function classify(text: string, id: string): Reply {
  const parsed = parsePresentation(text, id);
  if (parsed) return { kind: 'usable', parsed };
  if (!hasFence(text, LIGHTNING_FENCE)) return { kind: 'chatty' };
  const other = fenceId(text);
  return other !== null && other.toLowerCase() !== id.trim().toLowerCase() ? { kind: 'foreign' } : { kind: 'unusable' };
}

type Asked = RawPresentation | 'unusable' | 'timeout' | 'failed' | 'stale';

export class LightningRound {
  readonly id = randomUUID();
  private items: Item[];
  private currentKey: string | null = null;
  private started = false;
  private readonly ctrl = new AbortController();
  private readonly lines: string[] = [];
  private readonly tasks = new Set<Promise<void>>();
  private readonly panelSize: number;
  private readonly prefetch: number;

  /** `rows` are used as given (the hub filters the hidden ones before); a repeated key keeps its first row. */
  constructor(
    rows: LedgerRow[],
    private readonly deps: LightningDeps,
    opts: { panelSize?: number; prefetch?: number } = {}
  ) {
    const seen = new Set<string>();
    this.items = [];
    for (const row of rows) {
      if (seen.has(row.key)) continue;
      seen.add(row.key);
      this.items.push(newItem(row));
    }
    this.panelSize = count(opts.panelSize, PANEL_SIZE);
    this.prefetch = count(opts.prefetch, PREFETCH);
  }

  private get presentTimeoutMs(): number {
    return count(this.deps.presentTimeoutMs, PRESENT_TIMEOUT_MS);
  }
  private get voteTimeoutMs(): number {
    return count(this.deps.voteTimeoutMs, VOTE_TIMEOUT_MS);
  }
  /** At least 1 ms: a poller never spins. */
  private get pollMs(): number {
    return count(this.deps.pollMs, POLL_MS, 1);
  }
  private get maxPresenters(): number {
    return count(this.deps.maxPresenters, MAX_PRESENTERS, 1);
  }
  private get active(): boolean {
    return this.started && !this.ctrl.signal.aborted;
  }

  private changed(): void {
    try {
      this.deps.onChange?.(this);
    } catch {
      // A broken listener never reaches the engine.
    }
  }

  /** One status line; the caller reports the change. */
  private note(line: string): void {
    this.lines.push(line);
    if (this.lines.length > LOG_LINES) this.lines.splice(0, this.lines.length - LOG_LINES);
  }

  private item(key: string): Item {
    const item = this.items.find((i) => i.row.key === key);
    if (!item) throw new Error(`No lightning item ${key}.`);
    return item;
  }

  private stale(item: Item, epoch: number): boolean {
    return this.ctrl.signal.aborted || item.epoch !== epoch;
  }

  /** Resolves when no background task is running. Tests call it; the pane never waits on it. */
  async settle(): Promise<void> {
    while (this.tasks.size) await Promise.all([...this.tasks]);
  }

  private spawn(task: Promise<void>, onError: (err: unknown) => void): void {
    const wrapped: Promise<void> = task.catch(onError).finally(() => this.tasks.delete(wrapped));
    this.tasks.add(wrapped);
  }

  /** Wait on the injected sleep; false when the round was aborted first, so a poller never waits out a sleep that will not wake. */
  private async nap(ms: number): Promise<boolean> {
    const { signal } = this.ctrl;
    if (signal.aborted) return false;
    let onAbort = (): void => undefined;
    const aborted = new Promise<false>((resolve) => {
      onAbort = () => resolve(false);
      signal.addEventListener('abort', onAbort, { once: true });
    });
    try {
      return await Promise.race([this.deps.sleep(Math.max(0, ms)).then(() => true), aborted]);
    } finally {
      signal.removeEventListener('abort', onAbort);
    }
  }

  view(): LightningView {
    const items = this.items.map((i) => this.itemView(i));
    const decided = items.filter((i) => i.phase === 'decided').length;
    const deferred = items.filter((i) => i.phase === 'deferred').length;
    return {
      active: this.active,
      current: this.currentKey,
      panelSize: this.panelSize,
      items,
      counts: { total: items.length, remaining: items.length - decided - deferred, decided, deferred },
      log: [...this.lines],
    };
  }

  private itemView(item: Item): LightningItemView {
    const { raw: _raw, ...row } = item.row;
    const entries = [...item.votes.entries.values()].map((e) => ({ ...e }));
    return {
      key: row.key,
      id: row.id,
      kind: row.kind,
      repo: row.repo,
      title: `${row.id} ${row.claim || item.presentation?.title || ''}`.trim(),
      summary: row.doubt ? `${row.repo}. Doubt: ${row.doubt}` : `${row.repo}.`,
      row,
      phase: item.phase,
      presentation: item.presentation,
      votes: { asked: item.votes.asked, tally: tallyVotes(entries.map((e) => (e.vote ? { id: row.id, vote: e.vote, prefers: e.prefers, reason: e.reason } : null))), entries },
      decision: item.decision ? { ...item.decision } : null,
    };
  }

  /** Begin the round: skip the rows the decision store hides, make the first open row current and start presenting it and the next few. */
  start(): void {
    if (this.started || this.ctrl.signal.aborted) return;
    this.started = true;
    this.items = this.items.filter((i) => !this.deps.decisions.hidden(i.row.key));
    this.pickCurrent(0);
    this.fill();
    this.changed();
  }

  /** Make this the current card, even a settled one (its history), and present it if it has not been. */
  select(key: string): void {
    this.item(key);
    this.currentKey = key;
    this.fill();
    this.changed();
  }

  /** The first undecided item at or after `from`, wrapping round the queue, becomes current; null when nothing is left. */
  private pickCurrent(from: number): void {
    const n = this.items.length;
    for (let k = 0; k < n; k++) {
      const item = this.items[(from + k) % n];
      if (isLive(item.phase)) {
        this.currentKey = item.row.key;
        return;
      }
    }
    this.currentKey = null;
  }

  /** Present the current item and the next `prefetch` undecided ones after it, each at once. */
  private fill(): void {
    if (!this.active) return;
    const at = this.items.findIndex((i) => i.row.key === this.currentKey);
    if (at < 0) return;
    const wanted = [this.items[at], ...this.items.slice(at + 1).filter((i) => isLive(i.phase)).slice(0, this.prefetch)];
    for (const item of wanted) if (item.phase === 'queued') this.present(item);
  }

  /** Move on from a settled item: current advances if it was the current one, and presenting continues. */
  private advanceFrom(item: Item): void {
    if (this.currentKey === item.row.key) this.pickCurrent(this.items.indexOf(item) + 1);
    this.fill();
    this.changed();
  }

  // ---- presenting ---------------------------------------------------------------------------------------------------

  private present(item: Item): void {
    item.phase = 'presenting';
    const epoch = ++item.epoch;
    this.spawn(this.runPresent(item, epoch), (err) => this.fallback(item, epoch, `The present call failed: ${errText(err)}`));
  }

  /** Candidates in turn: the first usable block wins; a failed candidate hands over to the next; none left shows the ledger row. */
  private async runPresent(item: Item, epoch: number): Promise<void> {
    const { row } = item;
    const inRepo = this.deps.messageable().filter((a) => this.deps.repoOf(a) === row.repoPath);
    const eligible = inRepo.filter((a) => !item.rejectedBy.has(a.sessionID));
    const candidates = [...eligible.filter((a) => a.status !== 'busy'), ...eligible.filter((a) => a.status === 'busy')].slice(0, this.maxPresenters);
    if (candidates.length === 0) {
      // Everyone in the repo already rejected this row: show the ledger row without a word. Nobody there at all is worth saying.
      this.fallback(item, epoch, inRepo.length > 0 ? null : `No agent in ${row.repo} can be messaged.`);
      return;
    }
    let timedOut = false;
    for (const agent of candidates) {
      const asked = await this.ask(item, epoch, agent);
      if (asked === 'stale') return;
      if (typeof asked === 'object') {
        await this.show(item, epoch, agent, asked);
        return;
      }
      if (asked === 'timeout') timedOut = true;
    }
    this.fallback(item, epoch, timedOut ? 'The present call timed out.' : 'Nobody replied with a usable block.');
  }

  /** Send the ask to one agent and read its transcript past the size it had before, until a usable block, an unusable one, or the timeout. */
  private async ask(item: Item, epoch: number, agent: Agent): Promise<Asked> {
    const { row } = item;
    const who = `${agent.name} ${shortID(agent)}`;
    let offset: number;
    try {
      offset = await this.deps.transcriptSize(agent);
      await this.deps.sendInbox(agent, lightningPresentAsk(row));
    } catch (err) {
      if (this.stale(item, epoch)) return 'stale';
      this.note(`${who} did not take the ask: ${errText(err)}`);
      this.changed();
      return 'failed';
    }
    if (this.stale(item, epoch)) return 'stale';
    const deadline = this.deps.clock() + this.presentTimeoutMs;
    let wrote = false;
    let readFailed = false;
    while (this.deps.clock() < deadline) {
      if (!(await this.nap(Math.min(this.pollMs, deadline - this.deps.clock())))) return 'stale';
      if (this.stale(item, epoch)) return 'stale';
      let read: { texts: string[]; endOffset: number };
      try {
        read = await this.deps.readSince(agent, offset);
      } catch (err) {
        if (!readFailed) {
          readFailed = true;
          this.note(`${who} transcript could not be read: ${errText(err)}`);
          this.changed();
        }
        continue;
      }
      if (this.stale(item, epoch)) return 'stale';
      offset = read.endOffset;
      const replies = read.texts.map((t) => ({ text: t, reply: classify(t, row.id) }));
      const usable = replies.find((r) => r.reply.kind === 'usable')?.reply;
      if (usable?.kind === 'usable') return usable.parsed;
      if (replies.some((r) => r.reply.kind === 'unusable')) {
        this.note(`${who} replied without a usable block.`);
        this.changed();
        return 'unusable';
      }
      if (replies.some((r) => r.reply.kind === 'chatty' && r.text.trim() !== '')) wrote = true;
    }
    this.note(wrote ? `${who} replied without a usable block.` : `${who} did not reply within ${Math.round(this.presentTimeoutMs / 1000)}s.`);
    this.changed();
    return 'timeout';
  }

  /** Ground the winning block's cites against the presenter's checkout, then put the card up. */
  private async show(item: Item, epoch: number, agent: Agent, raw: RawPresentation): Promise<void> {
    const evidence: PresentedEvidence[] = [];
    for (const [i, line] of raw.evidence.entries()) {
      const cite = parseCite(line);
      const grounding: Grounding = cite ? await groundCite(this.deps.run, agent.cwd, cite) : { status: 'ungrounded', reason: 'not a citation' };
      evidence.push({ n: i + 1, raw: line, cite, grounding });
      if (this.stale(item, epoch)) return;
    }
    const options: PresentedOption[] = raw.options.map((o) => ({ ...o, grounding: o.cites.some((n) => evidence.find((e) => e.n === n)?.grounding.status === 'grounded') ? 'grounded' : 'ungrounded' }));
    item.presentation = { source: 'agent', presentedBy: agent.name, needs: raw.needs, nature: raw.nature, checkable: raw.checkable, title: raw.title, claim: raw.claim, assessment: raw.assessment, evidence, options };
    item.presenter = agent;
    item.phase = 'presented';
    this.changed();
  }

  /** Show the ledger row; `reason` null shows it without a log line. A task that outlived its moment changes nothing. */
  private fallback(item: Item, epoch: number, reason: string | null): void {
    if (this.stale(item, epoch)) return;
    item.presentation = ledgerPresentation(item.row);
    item.presenter = null;
    item.phase = 'fallback';
    if (reason !== null) this.note(`No presentation for ${item.row.key}: ${reason} Showing the ledger row.`);
    this.changed();
  }

  // ---- deciding -----------------------------------------------------------------------------------------------------

  /**
   * Approve option `letter`. no_change records the decision and sends nothing; the other verbs relay it to the presenting agent
   * (for a ledger card, the first messageable agent of the row's repo) and record it only once it was taken.
   * A second approve of a decided item sends nothing, and approves racing each other send once.
   */
  async approve(key: string, letter: Letter): Promise<ApproveResult> {
    const item = this.item(key);
    const presentation = item.presentation;
    const option = presentation?.options.find((o) => o.letter === letter);
    if (presentation && !option) throw new Error(`Option ${letter} is not offered for ${key}.`);
    if (item.phase === 'decided') return { delivered: false, decided: true };
    if (!presentation || !option || !isOpenPhase(item.phase)) return { delivered: false, decided: false };
    if (item.approving) {
      const first = await item.approving;
      return { delivered: false, decided: first.decided };
    }
    const attempt = this.relay(item, presentation, option);
    item.approving = attempt;
    try {
      return await attempt;
    } finally {
      item.approving = null;
    }
  }

  private async relay(item: Item, presentation: Presentation, option: PresentedOption): Promise<ApproveResult> {
    const { row } = item;
    if (option.verb === 'no_change') {
      this.settleItem(item, option, false);
      return { delivered: false, decided: true };
    }
    const to = this.recipient(item, presentation);
    if (!to) {
      this.note(`Nobody in ${row.repo} can be messaged: copy the decision by hand.`);
      this.changed();
      return { delivered: false, decided: false };
    }
    try {
      await this.deps.sendInbox(to, lightningDecision(row, { letter: option.letter, verb: option.verb, title: option.title, why: option.why }, presentation));
    } catch (err) {
      this.note(`${to.name} did not take the decision: ${errText(err)}`);
      this.changed();
      return { delivered: false, decided: false };
    }
    this.settleItem(item, option, true);
    return { delivered: true, decided: true };
  }

  /** Who takes the decision: the presenting agent (its current roster entry, if it has one), or for a ledger card the first messageable agent of the row's repo. */
  private recipient(item: Item, presentation: Presentation): Agent | null {
    const roster = this.deps.messageable();
    const { presenter } = item;
    if (presentation.source === 'agent') return presenter && (roster.find((a) => a.sessionID === presenter.sessionID) ?? presenter);
    return roster.find((a) => this.deps.repoOf(a) === item.row.repoPath) ?? null;
  }

  /** Record the decision for a week, mark the item decided and move on. */
  private settleItem(item: Item, option: PresentedOption, delivered: boolean): void {
    const now = this.deps.clock();
    item.phase = 'decided';
    item.epoch++;
    item.decision = { option: option.letter, verb: option.verb, at: now, delivered };
    this.remember(item, { state: 'decided', option: option.letter, verb: option.verb }, now + DECISION_TTL_MS);
    this.advanceFrom(item);
  }

  /** The store can fail (a full disk); the round goes on and says so. */
  private remember(item: Item, rec: { state: 'decided' | 'deferred'; option?: Letter; verb?: Verb }, until: number): void {
    try {
      this.deps.decisions.record(item.row.key, rec, until);
    } catch (err) {
      this.note(`Could not save the ${rec.state === 'deferred' ? 'deferral' : 'decision'} for ${item.row.key}: ${errText(err)}`);
    }
  }

  /** None of these: drop the card, remember who presented it, and ask again later (the back of the queue) with someone else. Nothing is sent. */
  reject(key: string): void {
    const item = this.item(key);
    if (item.approving || !isOpenPhase(item.phase)) return;
    if (item.presentation?.source === 'agent' && item.presenter) item.rejectedBy.add(item.presenter.sessionID);
    item.epoch++;
    item.presentation = null;
    item.presenter = null;
    item.votes = { asked: false, entries: new Map() };
    item.phase = 'queued';
    // Pick the next card first: the scan wraps round the queue, so the rejected item itself comes last.
    if (this.currentKey === key) this.pickCurrent(this.items.indexOf(item) + 1);
    this.items.splice(this.items.indexOf(item), 1);
    this.items.push(item);
    this.fill();
    this.changed();
  }

  /** Hide the row until the next local midnight and move on. */
  defer(key: string): void {
    const item = this.item(key);
    if (item.approving || !isLive(item.phase)) return;
    item.epoch++;
    item.phase = 'deferred';
    this.remember(item, { state: 'deferred' }, nextLocalMidnight(this.deps.clock()));
    this.advanceFrom(item);
  }

  // ---- votes --------------------------------------------------------------------------------------------------------

  /**
   * Ask a panel of other agents to vote on the card: not the presenter, the row's repo first, then roster order, at most `panelSize`
   * in all. An agent already asked is not asked again. Resolves once the asks are sent; the votes are read in the background.
   */
  async askSkeptics(key: string): Promise<void> {
    const item = this.item(key);
    const presentation = item.presentation;
    if (!presentation || !isOpenPhase(item.phase)) return;
    const { row } = item;
    const epoch = item.epoch;
    item.votes.asked = true;
    const others = this.deps.messageable().filter((a) => a.sessionID !== item.presenter?.sessionID && !item.votes.entries.has(a.sessionID));
    const sameRepo = (a: Agent): boolean => this.deps.repoOf(a) === row.repoPath;
    const panel = [...others.filter(sameRepo), ...others.filter((a) => !sameRepo(a))].slice(0, Math.max(0, this.panelSize - item.votes.entries.size));
    if (panel.length === 0 && item.votes.entries.size === 0) this.note(`No other agent can be messaged to vote on ${key}.`);
    for (const a of panel) item.votes.entries.set(a.sessionID, { sessionID: a.sessionID, name: a.name, vote: null, prefers: null, reason: '' });
    this.changed();
    const sent: Array<{ agent: Agent; offset: number }> = [];
    await Promise.all(
      panel.map(async (agent) => {
        try {
          const offset = await this.deps.transcriptSize(agent);
          await this.deps.sendInbox(agent, lightningVoteAsk(row, presentation));
          sent.push({ agent, offset });
        } catch (err) {
          this.note(`${agent.name} ${shortID(agent)} did not take the vote ask: ${errText(err)}`);
        }
      })
    );
    if (this.stale(item, epoch)) return;
    this.changed();
    if (sent.length) this.spawn(this.watchVotes(item, epoch, sent), (err) => this.noteAndChange(`Reading the votes for ${key} failed: ${errText(err)}`));
  }

  private noteAndChange(line: string): void {
    this.note(line);
    this.changed();
  }

  /** Read the asked agents' transcripts until all have voted, the card closes, the round is aborted, or the late window ends. */
  private async watchVotes(item: Item, epoch: number, asked: Array<{ agent: Agent; offset: number }>): Promise<void> {
    const { row } = item;
    const windowEnd = this.deps.clock() + this.voteTimeoutMs;
    const deadline = windowEnd + LATE_VOTE_MS;
    const waiting = new Map(asked.map((a) => [a.agent.sessionID, a]));
    const open = (): boolean => !this.stale(item, epoch) && isOpenPhase(item.phase);
    let warned = false;
    while (waiting.size > 0 && this.deps.clock() < deadline) {
      if (!(await this.nap(Math.min(this.pollMs, deadline - this.deps.clock())))) return;
      if (!open()) return;
      await Promise.all(
        [...waiting.values()].map(async (w) => {
          let read: { texts: string[]; endOffset: number };
          try {
            read = await this.deps.readSince(w.agent, w.offset);
          } catch {
            return; // tried again at the next poll
          }
          w.offset = read.endOffset;
          const votes = read.texts.map((t) => parseVote(t, row.id)).filter((v): v is RawVote => v !== null);
          const vote = votes[votes.length - 1];
          const entry = item.votes.entries.get(w.agent.sessionID);
          if (!vote || !entry) return;
          Object.assign(entry, { vote: vote.vote, prefers: vote.prefers, reason: vote.reason });
          waiting.delete(w.agent.sessionID);
        })
      );
      if (!open()) return;
      if (!warned && waiting.size > 0 && this.deps.clock() >= windowEnd) {
        warned = true;
        this.note(`${waiting.size} of ${asked.length} did not vote on ${row.key} within ${Math.round(this.voteTimeoutMs / 1000)}s. A late vote still counts.`);
      }
      this.changed();
    }
  }

  /** Stop every poller and the round. Decisions already recorded stay; a card that was still being presented goes back to the queue. */
  abort(): void {
    if (this.ctrl.signal.aborted) return;
    this.ctrl.abort();
    for (const item of this.items) if (item.phase === 'presenting') item.phase = 'queued';
    this.changed();
  }
}
