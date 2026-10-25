/**
 * A group thread (spec §4.3): two or more messageable agents, a shared
 * composer that does N independent 1:1 sends concurrently, and a merged
 * view of N transcripts. Agents never see each other's replies unless the
 * human relays them. A group never disappears because a member exited.
 */

import { randomUUID } from 'node:crypto';
import { type Agent, type Turn, isMessageable } from './agent.js';
import type { TranscriptRead } from './transcript.js';
import { compose, STATUS_CHECK, TBUV_RESOLUTION_GROUP, TBUV_RESOLUTION_SOLO } from './prompts.js';
import { parseStatusReport, type StatusReport } from './status-report.js';
import type { Clock } from './clock.js';

export const GROUP_REPLY_WINDOW_MS = 180_000;
export const GROUP_REPLY_POLL_MS = 2_000;
export const GROUP_MAX_RETAINED_TURNS = 120;

/** The same set of sessions always maps to one thread, whatever the selection order. */
export const groupKey = (sessionIDs: Iterable<string>): string => [...new Set(sessionIDs)].sort().join('+');

export interface GroupTurn {
  /** Empty for the human's own turn ("You"). */
  sessionID: string;
  agentName: string;
  turn: Turn;
  /** For the human's turn: the subset it went to; unset means everyone. */
  recipients?: string[];
}

export interface GroupDeps {
  clock: Clock;
  sleep: (ms: number) => Promise<void>;
  readTail: (path: string) => Promise<TranscriptRead>;
  readSince: (path: string, offset: number) => Promise<TranscriptRead>;
  sendInbox: (agent: Agent, text: string) => Promise<void>;
  transcriptPath: (agent: Agent) => string;
  onChange?: (g: GroupConversation) => void;
}

interface Pending {
  id: string;
  text: string;
  recipients?: string[];
}

export type DraftSource = { kind: 'composer' } | { kind: 'review'; sessionID: string } | null;

export class GroupConversation {
  participants: Agent[];
  turns: GroupTurn[] = [];
  draft = '';
  isLoading = false;
  isAwaitingReply = false;
  awaitingSessionIDs = new Set<string>();
  errorMessage: string | null = null;
  /** Review mode state (§5.6). */
  isReviewing = false;
  reviewSelection: string | null = null;
  /** True once a person picked a row (or marked one reviewed): until then the selection follows the ranking. */
  reviewSelectionManual = false;
  /** sessionID → the id of the latest assistant reply that was marked reviewed. */
  reviewedReplyIDs = new Map<string, string>();
  reviewDrafts = new Map<string, string>();

  private preambleSent = new Set<string>();
  private offsets = new Map<string, number>();
  private known = new Set<string>();
  private pending: Pending[] = [];
  /** Texts already matched to a send, so a later participant's copy is dropped. Bounded. */
  private claimed: string[] = [];
  private watcher: AbortController | null = null;
  private deadline = 0;
  private sends = new Map<string, Promise<unknown>>();
  private tasks = new Set<Promise<void>>();

  constructor(
    participants: Agent[],
    private readonly deps: GroupDeps
  ) {
    if (participants.length < 2) throw new Error('a group is two or more agents');
    this.participants = [...participants];
  }

  get key(): string {
    return groupKey(this.participants.map((p) => p.sessionID));
  }
  get canSend(): boolean {
    return this.draft.trim().length > 0 && this.participants.some(isMessageable);
  }
  get hasPending(): boolean {
    return this.pending.length > 0;
  }

  private changed(): void {
    this.deps.onChange?.(this);
  }

  async settle(): Promise<void> {
    while (this.tasks.size || this.sends.size) await Promise.all([...this.tasks, ...this.sends.values()]);
  }

  private track(p: Promise<void>): Promise<void> {
    const wrapped = p.finally(() => this.tasks.delete(wrapped));
    this.tasks.add(wrapped);
    return wrapped;
  }

  /** Each participant's tail, read in parallel, tagged and interleaved by timestamp. */
  async loadIfNeeded(): Promise<void> {
    if (this.turns.length > 0 || this.isLoading) return;
    this.isLoading = true;
    this.changed();
    try {
      const reads = await Promise.all(this.participants.map(async (p) => ({ p, read: await this.deps.readTail(this.deps.transcriptPath(p)) })));
      const fresh: GroupTurn[] = [];
      for (const { p, read } of reads) {
        this.offsets.set(p.sessionID, Math.max(this.offsets.get(p.sessionID) ?? 0, read.endOffset));
        for (const t of read.turns) {
          const id = `${p.sessionID}:${t.id}`;
          if (this.known.has(id)) continue;
          this.known.add(id);
          fresh.push({ sessionID: p.sessionID, agentName: p.name, turn: { ...t, id } });
        }
      }
      this.turns = [...fresh, ...this.turns].sort((a, b) => a.turn.timestamp - b.turn.timestamp);
      this.trim();
    } finally {
      this.isLoading = false;
      this.changed();
    }
  }

  /** Replace each participant with its roster value; one missing from the roster keeps its last known value. */
  refreshParticipants(roster: Agent[]): void {
    const byId = new Map(roster.map((a) => [a.sessionID, a]));
    let changed = false;
    this.participants = this.participants.map((p) => {
      const fresh = byId.get(p.sessionID);
      if (fresh && JSON.stringify(fresh) !== JSON.stringify(p)) {
        changed = true;
        return fresh;
      }
      return p;
    });
    if (changed) this.changed();
  }

  // ---- sends ---------------------------------------------------------------

  /** The composer's send to everyone. */
  send(): Promise<boolean> {
    return this.deliver(this.draft, { userGenerated: true, draftSource: { kind: 'composer' } });
  }
  sendStatusCheck(): Promise<boolean> {
    return this.deliver(STATUS_CHECK, { userGenerated: false, draftSource: null });
  }
  sendInstruction(text: string, to: Agent): Promise<boolean> {
    return this.deliver(text, { userGenerated: false, draftSource: null, subset: [to] });
  }
  /** The multi-agent wording when the subset has more than one agent, else the solo wording: the group wording would be a false claim alone. */
  sendTBUVResolution(to: Agent[]): Promise<boolean> {
    return this.deliver(to.length > 1 ? TBUV_RESOLUTION_GROUP : TBUV_RESOLUTION_SOLO, { userGenerated: false, draftSource: null, subset: to });
  }
  sendReviewReply(to: Agent): Promise<boolean> {
    return this.deliver(this.reviewDrafts.get(to.sessionID) ?? '', { userGenerated: true, draftSource: { kind: 'review', sessionID: to.sessionID }, subset: [to] });
  }

  private clearSource(source: DraftSource): void {
    if (!source) return;
    if (source.kind === 'composer') this.draft = '';
    else this.reviewDrafts.delete(source.sessionID);
  }

  private restoreSource(source: DraftSource, text: string): void {
    if (!source) return;
    if (source.kind === 'composer') this.draft = this.draft.trim() ? `${text}\n\n${this.draft}` : text;
    else {
      const cur = this.reviewDrafts.get(source.sessionID) ?? '';
      this.reviewDrafts.set(source.sessionID, cur.trim() ? `${text}\n\n${cur}` : text);
    }
  }

  /**
   * Fan out concurrently to every messageable target. Returns false when
   * nothing was sent, so the caller never reports "sent". One optimistic
   * bubble for the human; the reply watch waits only on delivered agents.
   */
  private async deliver(message: string, opts: { userGenerated: boolean; draftSource: DraftSource; subset?: Agent[] }): Promise<boolean> {
    if (!message.trim()) return false;
    const targets = (opts.subset ?? this.participants).filter(isMessageable);
    if (targets.length === 0) {
      this.errorMessage = 'Nobody in this thread has a live inbox. Refresh the agent list.';
      this.changed();
      return false;
    }
    // Cleared here, not in send(): a draft typed with no messageable target survives.
    this.clearSource(opts.draftSource);
    const recipients = opts.subset ? targets.map((t) => t.sessionID) : undefined;
    const placeholder: Pending = { id: `pending-${randomUUID()}`, text: message.trim(), recipients };
    this.pending.push(placeholder);
    this.turns.push({ sessionID: '', agentName: 'You', turn: { id: placeholder.id, role: 'user', text: message.trim(), timestamp: this.deps.clock() }, recipients });
    this.known.add(placeholder.id);
    this.errorMessage = null;
    this.changed();
    const id = randomUUID();
    const run = Promise.all(
      targets.map(async (agent) => {
        const payload = compose(message, { includePreamble: !this.preambleSent.has(agent.sessionID), userGenerated: opts.userGenerated });
        try {
          await this.deps.sendInbox(agent, payload);
          return { agent, ok: true as const };
        } catch (err) {
          return { agent, ok: false as const, error: err instanceof Error ? err.message : String(err) };
        }
      })
    ).finally(() => this.sends.delete(id));
    this.sends.set(id, run);
    const results = await run;
    const delivered = results.filter((r) => r.ok).map((r) => r.agent);
    const failed = results.filter((r): r is { agent: Agent; ok: false; error: string } => !r.ok);
    if (delivered.length === 0) {
      this.turns = this.turns.filter((t) => t.turn.id !== placeholder.id);
      this.known.delete(placeholder.id);
      this.pending = this.pending.filter((p) => p.id !== placeholder.id);
      this.errorMessage = failed.map((f) => `${f.agent.name}: ${f.error}`).join('; ');
      this.restoreSource(opts.draftSource, message.trim());
      this.changed();
      return false;
    }
    for (const a of delivered) this.preambleSent.add(a.sessionID);
    if (failed.length) this.errorMessage = `Didn’t reach everyone. ${failed.map((f) => `${f.agent.name}: ${f.error}`).join('; ')}`;
    this.startWatch(new Set(delivered.map((a) => a.sessionID)));
    this.changed();
    return true;
  }

  // ---- replies ---------------------------------------------------------------

  /** If a watch is running, union the waiting set into it; a one-agent send mid-wait must not drop others still owed a reply. */
  private startWatch(waiting: Set<string>): void {
    for (const id of waiting) this.awaitingSessionIDs.add(id);
    this.deadline = this.deps.clock() + GROUP_REPLY_WINDOW_MS;
    this.isAwaitingReply = true;
    if (this.watcher) return;
    const ctrl = new AbortController();
    this.watcher = ctrl;
    void this.track(
      (async () => {
        while (!ctrl.signal.aborted && this.awaitingSessionIDs.size && this.deps.clock() < this.deadline) {
          await this.deps.sleep(GROUP_REPLY_POLL_MS);
          if (ctrl.signal.aborted) return;
          await this.pollOnce();
        }
        if (ctrl.signal.aborted) return;
        this.isAwaitingReply = false;
        this.awaitingSessionIDs.clear();
        this.pending = [];
        this.watcher = null;
        this.changed();
      })()
    );
  }

  /** Read every participant's transcript past its offset and merge. */
  async pollOnce(): Promise<void> {
    const reads = await Promise.all(this.participants.map(async (p) => ({ p, read: await this.deps.readSince(this.deps.transcriptPath(p), this.offsets.get(p.sessionID) ?? 0) })));
    for (const { p, read } of reads) {
      this.offsets.set(p.sessionID, read.endOffset);
      if (this.merge(p, read.turns)) this.awaitingSessionIDs.delete(p.sessionID);
    }
    this.turns.sort((a, b) => a.turn.timestamp - b.turn.timestamp);
    this.trim();
    this.changed();
  }

  /**
   * Merge one participant's new turns. The human's one send lands once in
   * each recipient's transcript: a user turn containing a claimed text is a
   * later copy and is dropped; one containing a pending text replaces the
   * bubble and claims the text; anything else was typed into that agent's
   * terminal. Returns whether an assistant turn arrived.
   */
  private merge(p: Agent, incoming: Turn[]): boolean {
    let reply = false;
    for (const t of incoming) {
      const id = `${p.sessionID}:${t.id}`;
      if (this.known.has(id)) continue;
      if (t.role === 'user') {
        if (this.claimed.some((c) => t.text.includes(c))) {
          this.known.add(id);
          continue;
        }
        const i = this.pending.findIndex((pd) => t.text.includes(pd.text));
        if (i >= 0) {
          const pd = this.pending[i];
          const idx = this.turns.findIndex((x) => x.turn.id === pd.id);
          if (idx >= 0) this.turns[idx] = { ...this.turns[idx], turn: { ...this.turns[idx].turn, id, timestamp: t.timestamp } };
          this.known.delete(pd.id);
          this.known.add(id);
          this.pending.splice(i, 1);
          this.claimed.push(pd.text);
          if (this.claimed.length > GROUP_MAX_RETAINED_TURNS) this.claimed = this.claimed.slice(-GROUP_MAX_RETAINED_TURNS);
          continue;
        }
      } else reply = true;
      this.known.add(id);
      this.turns.push({ sessionID: p.sessionID, agentName: p.name, turn: { ...t, id } });
    }
    return reply;
  }

  private trim(): void {
    if (this.turns.length > GROUP_MAX_RETAINED_TURNS) {
      const dropped = this.turns.slice(0, this.turns.length - GROUP_MAX_RETAINED_TURNS);
      this.turns = this.turns.slice(-GROUP_MAX_RETAINED_TURNS);
      for (const d of dropped) this.known.delete(d.turn.id);
      const ids = new Set(this.turns.map((t) => t.turn.id));
      this.pending = this.pending.filter((p) => ids.has(p.id));
    }
  }

  /** Each participant's most recent parsed status reply, scanning newest first, so a chat turn after a status check does not erase it. */
  latestReports(): Map<string, StatusReport | null> {
    const out = new Map<string, StatusReport | null>();
    for (const p of this.participants) {
      let found: StatusReport | null = null;
      for (let i = this.turns.length - 1; i >= 0; i--) {
        const gt = this.turns[i];
        if (gt.sessionID !== p.sessionID || gt.turn.role !== 'assistant') continue;
        const r = parseStatusReport(gt.turn.text);
        if (r) {
          found = r;
          break;
        }
      }
      out.set(p.sessionID, found);
    }
    return out;
  }

  unloadIfIdle(): void {
    if (this.isAwaitingReply || this.isLoading || this.pending.length) return;
    this.turns = [];
    this.known.clear();
    this.offsets.clear();
    this.claimed = [];
    this.changed();
  }

  /** Closing the thread cancels in-flight fan-outs and the watch. */
  cancelAll(): void {
    this.watcher?.abort();
    this.watcher = null;
    this.sends.clear();
  }
}

/** Groups by key, in creation order so the list does not shuffle on refresh. */
export class GroupStore {
  private groups = new Map<string, GroupConversation>();
  private order: string[] = [];

  constructor(private readonly deps: GroupDeps) {}

  /** The existing thread for this set (membership refreshed), else a new one. */
  group(agents: Agent[]): GroupConversation {
    const key = groupKey(agents.map((a) => a.sessionID));
    let g = this.groups.get(key);
    if (g) {
      g.refreshParticipants(agents);
      return g;
    }
    g = new GroupConversation(agents, this.deps);
    this.groups.set(key, g);
    this.order.push(key);
    return g;
  }

  existing(key: string): GroupConversation | null {
    return this.groups.get(key) ?? null;
  }

  all(): GroupConversation[] {
    return this.order.map((k) => this.groups.get(k)!).filter(Boolean);
  }

  /** Never drops a group. */
  refreshMembership(live: Agent[]): void {
    for (const g of this.groups.values()) g.refreshParticipants(live);
  }

  unloadAllIdle(): void {
    for (const g of this.groups.values()) g.unloadIfIdle();
  }

  drop(key: string): void {
    const g = this.groups.get(key);
    if (!g) return;
    g.cancelAll();
    this.groups.delete(key);
    this.order = this.order.filter((k) => k !== key);
  }
}
