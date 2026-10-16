/**
 * One 1:1 thread with a session, and the store that keeps one per session
 * (spec §4.2). The chat history is the tail of the session's transcript;
 * a send is a write into its inbox; replies are found by polling the
 * transcript for a reply window after each send. Every timer and read is
 * injected, so tests drive the thread with a fake clock and no sockets.
 */

import { randomUUID } from 'node:crypto';
import { type Agent, type Turn, isMessageable, isStopped, canTakeUserTurn } from './agent.js';
import type { TranscriptRead } from './transcript.js';
import { compose, modelCommand, TBUV_RESOLUTION_SOLO } from './prompts.js';
import type { Clock } from './clock.js';

export const REPLY_WINDOW_MS = 180_000;
export const REPLY_POLL_MS = 2_000;
export const MAX_RETAINED_TURNS = 60;
export const RESUME_HOLD_MS = 90_000;
export const LOADED_THREADS_KEPT = 3;

export type Resumer = (agent: Agent, prompt: string) => Promise<void>;
export type UserTurnSender = (agent: Agent, prompt: string) => Promise<void>;

export interface ConversationDeps {
  clock: Clock;
  sleep: (ms: number) => Promise<void>;
  readTail: (path: string) => Promise<TranscriptRead>;
  readSince: (path: string, offset: number) => Promise<TranscriptRead>;
  sendInbox: (agent: Agent, text: string) => Promise<void>;
  transcriptPath: (agent: Agent) => string;
  /** Published whenever visible state changes. */
  onChange?: (c: Conversation) => void;
}

interface Pending {
  id: string;
  text: string;
}

export class Conversation {
  turns: Turn[] = [];
  draft = '';
  isLoading = false;
  isAwaitingReply = false;
  errorMessage: string | null = null;
  selectedModel: string | null = null;
  isResuming = false;
  agent: Agent;
  resumer: Resumer | null = null;
  userTurnSender: UserTurnSender | null = null;

  private preambleSent = false;
  private offset = 0;
  private known = new Set<string>();
  private pending: Pending[] = [];
  private replacedPid: number | undefined;
  private watcher: AbortController | null = null;
  private hold: AbortController | null = null;
  private tasks = new Set<Promise<void>>();

  constructor(
    agent: Agent,
    private readonly deps: ConversationDeps
  ) {
    this.agent = agent;
  }

  get sessionID(): string {
    return this.agent.sessionID;
  }
  get canResume(): boolean {
    return isStopped(this.agent) && this.resumer !== null;
  }
  get canSend(): boolean {
    return this.draft.trim().length > 0 && (isMessageable(this.agent) || (this.canResume && !this.isResuming));
  }
  get offersSendAsUser(): boolean {
    return canTakeUserTurn(this.agent) && this.userTurnSender !== null;
  }
  get canSendAsUser(): boolean {
    return this.offersSendAsUser && !this.isResuming && this.draft.trim().length > 0;
  }
  get hasPending(): boolean {
    return this.pending.length > 0;
  }

  private changed(): void {
    this.deps.onChange?.(this);
  }

  /** Awaits every in-flight watcher, hold or send. For tests and shutdown. */
  async settle(): Promise<void> {
    while (this.tasks.size) await Promise.all([...this.tasks]);
  }

  private track(p: Promise<void>): Promise<void> {
    const wrapped = p.finally(() => this.tasks.delete(wrapped));
    this.tasks.add(wrapped);
    return wrapped;
  }

  /**
   * Always refresh the agent from the roster, never snapshot it: a session
   * stopped and reattached keeps its id but gets a new pid and socket. A
   * messageable update ends the resuming hold, unless a send-as-me is in
   * flight and the pid is still the one being replaced.
   */
  refreshAgent(agent: Agent): void {
    if (agent.sessionID !== this.agent.sessionID) return;
    if (JSON.stringify(agent) === JSON.stringify(this.agent)) return;
    this.agent = agent;
    if (this.isResuming && isMessageable(agent) && (this.replacedPid === undefined || agent.pid !== this.replacedPid)) this.endResume();
    this.changed();
  }

  private endResume(): void {
    this.isResuming = false;
    this.replacedPid = undefined;
    this.hold?.abort();
    this.hold = null;
  }

  async loadIfNeeded(): Promise<void> {
    if (this.turns.length > 0 || this.isLoading) return;
    this.isLoading = true;
    this.changed();
    try {
      const read = await this.deps.readTail(this.deps.transcriptPath(this.agent));
      // An optimistic send may have been posted while the read was in flight: prepend, do not replace.
      const fresh = read.turns.filter((t) => !this.known.has(t.id));
      for (const t of fresh) this.known.add(t.id);
      this.turns = [...fresh, ...this.turns];
      this.offset = Math.max(this.offset, read.endOffset);
      if (!this.selectedModel && read.latestModel) this.selectedModel = read.latestModel;
      this.trim();
    } finally {
      this.isLoading = false;
      this.changed();
    }
  }

  /** The composer's send: human-typed, clears the draft at once. Resolves to whether the message was delivered. */
  send(): Promise<boolean> {
    const text = this.draft;
    if (!this.canSend) return Promise.resolve(false);
    this.draft = '';
    return this.deliver(text, { userGenerated: true, sendAsUser: false });
  }

  /** "Send as me": restarts the idle background job with the text as a real user turn. */
  sendAsUser(): Promise<boolean> {
    const text = this.draft;
    if (!this.canSendAsUser) return Promise.resolve(false);
    this.draft = '';
    return this.deliver(text, { userGenerated: true, sendAsUser: true });
  }

  /** An app-composed instruction (chip buttons, wrap-up, status ask): no human tag, the draft is untouched. */
  sendInstruction(text: string): Promise<boolean> {
    return this.deliver(text, { userGenerated: false, sendAsUser: false });
  }

  /** A 1:1 chip has no peer to reconcile with: the solo TB/UV wording. */
  sendTBUVSolo(): Promise<boolean> {
    return this.sendInstruction(TBUV_RESOLUTION_SOLO);
  }

  private async deliver(message: string, opts: { userGenerated: boolean; sendAsUser: boolean }): Promise<boolean> {
    const payload = compose(message, { includePreamble: !this.preambleSent, userGenerated: opts.userGenerated });
    type Route = { kind: 'user-turn'; fn: UserTurnSender } | { kind: 'inbox' } | { kind: 'resume'; fn: Resumer };
    let route: Route;
    if (opts.sendAsUser && this.userTurnSender) route = { kind: 'user-turn', fn: this.userTurnSender };
    else if (isMessageable(this.agent)) route = { kind: 'inbox' };
    else if (this.canResume) route = { kind: 'resume', fn: this.resumer! };
    else {
      this.errorMessage = 'That session has no live inbox, it may have exited. Refresh the agent list.';
      if (opts.userGenerated) this.restoreDraft(message);
      this.changed();
      return false;
    }
    const resumeType = route.kind !== 'inbox';
    if (resumeType) {
      if (this.isResuming) {
        if (opts.userGenerated) this.restoreDraft(message);
        this.changed();
        return false;
      }
      this.isResuming = true;
      this.replacedPid = route.kind === 'user-turn' ? this.agent.pid : undefined;
    }
    const placeholder: Turn = { id: `pending-${randomUUID()}`, role: 'user', text: message, timestamp: this.deps.clock() };
    this.turns.push(placeholder);
    this.known.add(placeholder.id);
    this.pending.push({ id: placeholder.id, text: message });
    this.errorMessage = null;
    this.changed();
    const agent = this.agent;
    let delivered = false;
    await this.track(
      (async () => {
        try {
          if (route.kind === 'inbox') await this.deps.sendInbox(agent, payload);
          else await route.fn(agent, payload);
          delivered = true;
          if (resumeType) this.startResumeHold();
          this.preambleSent = true;
          this.startWatch();
        } catch (err) {
          if (resumeType) this.endResume();
          this.errorMessage = err instanceof Error ? err.message : String(err);
          this.turns = this.turns.filter((t) => t.id !== placeholder.id);
          this.known.delete(placeholder.id);
          this.pending = this.pending.filter((p) => p.id !== placeholder.id);
          if (opts.userGenerated) this.restoreDraft(message);
        } finally {
          this.changed();
        }
      })()
    );
    return delivered;
  }

  /** Never lose typed text: put it back at the front of the draft. */
  private restoreDraft(text: string): void {
    this.draft = this.draft.trim() ? `${text}\n\n${this.draft}` : text;
  }

  private startResumeHold(): void {
    this.hold?.abort();
    const ctrl = new AbortController();
    this.hold = ctrl;
    void this.track(
      (async () => {
        await this.deps.sleep(RESUME_HOLD_MS);
        if (ctrl.signal.aborted) return;
        this.endResume();
        this.changed();
      })()
    );
  }

  /** Restarted on every send, never continuous: an unselected tab costs nothing. */
  private startWatch(): void {
    this.watcher?.abort();
    const ctrl = new AbortController();
    this.watcher = ctrl;
    this.isAwaitingReply = true;
    const start = this.deps.clock();
    void this.track(
      (async () => {
        while (!ctrl.signal.aborted && this.deps.clock() - start < REPLY_WINDOW_MS) {
          await this.deps.sleep(REPLY_POLL_MS);
          if (ctrl.signal.aborted) return;
          const read = await this.deps.readSince(this.deps.transcriptPath(this.agent), this.offset);
          this.offset = read.endOffset;
          const gotReply = this.merge(read.turns);
          this.changed();
          if (gotReply) break;
        }
        if (!ctrl.signal.aborted) this.finishWaiting();
      })()
    );
  }

  /** Clears the wait and the optimistic list, so an unrecorded send cannot later match an unrelated turn. */
  private finishWaiting(): void {
    this.isAwaitingReply = false;
    this.pending = [];
    this.watcher = null;
    this.changed();
  }

  /**
   * Merge transcript turns. A user turn containing a pending send's raw text
   * replaces that placeholder in place (typed text kept, transcript id and
   * timestamp adopted). Known ids are skipped. Returns whether an assistant
   * turn arrived.
   */
  private merge(incoming: Turn[]): boolean {
    let reply = false;
    for (const t of incoming) {
      if (this.known.has(t.id)) continue;
      if (t.role === 'user') {
        const i = this.pending.findIndex((p) => t.text.includes(p.text));
        if (i >= 0) {
          const p = this.pending[i];
          const idx = this.turns.findIndex((x) => x.id === p.id);
          if (idx >= 0) this.turns[idx] = { ...this.turns[idx], id: t.id, timestamp: t.timestamp };
          this.known.delete(p.id);
          this.known.add(t.id);
          this.pending.splice(i, 1);
          continue;
        }
      } else reply = true;
      this.known.add(t.id);
      this.turns.push(t);
    }
    this.trim();
    return reply;
  }

  private trim(): void {
    if (this.turns.length > MAX_RETAINED_TURNS) {
      const dropped = this.turns.slice(0, this.turns.length - MAX_RETAINED_TURNS);
      this.turns = this.turns.slice(-MAX_RETAINED_TURNS);
      for (const d of dropped) this.known.delete(d.id);
      const ids = new Set(this.turns.map((t) => t.id));
      this.pending = this.pending.filter((p) => ids.has(p.id));
    }
  }

  /** The inbox has no control action: `/model <id>` is sent as an ordinary message. Returns whether the switch happened. */
  async changeModel(modelId: string): Promise<boolean> {
    if (!isMessageable(this.agent)) return false;
    const previous = this.selectedModel;
    this.selectedModel = modelId;
    this.changed();
    try {
      await this.deps.sendInbox(this.agent, modelCommand(modelId));
      return true;
    } catch (err) {
      this.selectedModel = previous;
      this.errorMessage = err instanceof Error ? err.message : String(err);
      this.changed();
      return false;
    }
  }

  /** Drop the turns unless something is in flight. Keeps the draft, the model and the preamble flag. */
  unloadIfIdle(): void {
    if (this.isAwaitingReply || this.isLoading || this.pending.length) return;
    this.turns = [];
    this.known.clear();
    this.offset = 0;
    this.changed();
  }

  cancelWatch(): void {
    this.watcher?.abort();
    this.watcher = null;
    this.hold?.abort();
    this.hold = null;
  }
}

/** One thread per session id; tab switches neither re-read the transcript nor lose a draft. */
export class ConversationStore {
  private threads = new Map<string, Conversation>();
  private recent: string[] = [];
  private resumerValue: Resumer | null = null;
  private userTurnSenderValue: UserTurnSender | null = null;

  constructor(private readonly deps: ConversationDeps) {}

  set resumer(fn: Resumer | null) {
    this.resumerValue = fn;
    for (const c of this.threads.values()) c.resumer = fn;
  }
  get resumer(): Resumer | null {
    return this.resumerValue;
  }
  set userTurnSender(fn: UserTurnSender | null) {
    this.userTurnSenderValue = fn;
    for (const c of this.threads.values()) c.userTurnSender = fn;
  }
  get userTurnSender(): UserTurnSender | null {
    return this.userTurnSenderValue;
  }

  /** Read-only lookup, safe anywhere. */
  existing(sessionID: string): Conversation | null {
    return this.threads.get(sessionID) ?? null;
  }

  /** Creates on demand: call from event handlers only. */
  conversation(agent: Agent): Conversation {
    let c = this.threads.get(agent.sessionID);
    if (!c) {
      c = new Conversation(agent, this.deps);
      c.resumer = this.resumerValue;
      c.userTurnSender = this.userTurnSenderValue;
      this.threads.set(agent.sessionID, c);
    } else c.refreshAgent(agent);
    return c;
  }

  all(): Conversation[] {
    return [...this.threads.values()];
  }

  /** Record the selection and keep only the last few threads loaded. */
  select(agent: Agent): Conversation {
    const c = this.conversation(agent);
    this.recent = [agent.sessionID, ...this.recent.filter((id) => id !== agent.sessionID)];
    const keep = new Set(this.recent.slice(0, LOADED_THREADS_KEPT));
    for (const [id, t] of this.threads) if (!keep.has(id)) t.unloadIfIdle();
    return c;
  }

  unloadAllIdle(): void {
    for (const c of this.threads.values()) c.unloadIfIdle();
  }

  drop(sessionID: string): void {
    const c = this.threads.get(sessionID);
    if (!c) return;
    c.cancelWatch();
    this.threads.delete(sessionID);
    this.recent = this.recent.filter((id) => id !== sessionID);
  }

  /** Remove threads for sessions no longer listed, then hand survivors their fresh agent. Returns whether anything was removed. */
  prune(live: Agent[]): boolean {
    const byId = new Map(live.map((a) => [a.sessionID, a]));
    let removed = false;
    for (const [id, c] of [...this.threads]) {
      const fresh = byId.get(id);
      if (!fresh) {
        c.cancelWatch();
        this.threads.delete(id);
        removed = true;
      } else c.refreshAgent(fresh);
    }
    if (removed) this.recent = this.recent.filter((id) => byId.has(id));
    return removed;
  }
}
