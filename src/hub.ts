/**
 * The hub — everything the panel does, with no HTTP in it.
 *
 * It owns the coordination core (claims, volunteer rounds, the canary gate),
 * reads the roster off disk, speaks the peer channel through a `PeerInbox`,
 * and starts agents through an injected runner. Every method takes or
 * records the clock reading it acted at, so a test drives it with a fake
 * clock, fake sockets and a fake runner, and the HTTP layer in `daemon.ts`
 * is a thin translation.
 */

import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { ClaimRegistry, type Claim, type ClaimInput, type Verdict } from './claims.js';
import { VolunteerRound, VOLUNTEER_WINDOW_MS, type Resolution, type VolunteerReply, type VolunteerRequest } from './volunteer.js';
import { CanaryGate, ACK_TOOL, canaryPromptLine, type Canary, type GateVerdict } from './canary.js';
import { buildStatusReport, type StatusReport, type WorktreeFact } from './status.js';
import { roster, readTranscript, CLAUDE_DIR, IDLE_AFTER_MS, type Agent, type Roster, type TranscriptSummary } from './discovery.js';
import { PeerInbox, sendFrame, messageFrame, wrapFromUser, parseVolunteerReply, type Frame, type CapturedFrame } from './transport.js';
import { runCommand, spawnBackground, spawnInteractive, openInTerminal, listWorktrees, type Runner } from './spawn.js';
import type { Clock } from './clock.js';

export interface HubOptions {
  /** Where Claude Code keeps its state; `~/.claude` by default. */
  claudeDir?: string;
  /** Where the peer sockets live; `/tmp/cc-socks` by default. */
  socketDir?: string;
  /** The peer name this daemon registers under: what agents address their replies to. */
  name?: string;
  cwd?: string;
  pid?: number;
  clock?: Clock;
  alive?: (pid: number) => boolean;
  run?: Runner;
  /** Where background agents get their worktrees. */
  worktreesDir?: string;
  /** Repositories whose worktrees the status report inspects, with their base branch. */
  repos?: Array<{ path: string; baseBranch?: string }>;
  idleAfterMs?: number;
  /** Every frame received is appended here as JSON, one per line. */
  captureLog?: string;
  /** Overrides on the message frame once a capture pins the real shape. */
  frameExtra?: Record<string, unknown>;
  sendTimeoutMs?: number;
}

export type DeliveryStatus = 'delivered' | 'answered' | 'unreachable';

export interface Delivery {
  id: string;
  agent: string;
  text: string;
  sentAt: number;
  status: DeliveryStatus;
  error?: string;
  answeredAt?: number;
  reply?: string;
  /** The delivery replies on this volunteer round, when it is one. */
  round?: string;
}

export interface VolunteerView {
  request: VolunteerRequest;
  resolution: Resolution;
  replies: VolunteerReply[];
  briefed: boolean;
  spawned: { mode: 'interactive' | 'background'; agent: string; where: string } | null;
}

export type HubEvent =
  | { type: 'frame'; at: number; captured: CapturedFrame }
  | { type: 'delivery'; at: number; delivery: Delivery }
  | { type: 'volunteer'; at: number; view: VolunteerView }
  | { type: 'claim'; at: number; verdict: Verdict }
  | { type: 'canary'; at: number; sessionId: string; verdict: GateVerdict | 'issued' | 'cleared' }
  | { type: 'spawn'; at: number; mode: 'interactive' | 'background'; agent: string; where: string };

export const DEFAULT_SOCKET_DIR = '/tmp/cc-socks';
export const DEFAULT_PEER_NAME = 'agentim';

/** The text of an inbound frame, whatever field the sender used; null when there is none. */
export function frameText(frame: Frame): string | null {
  for (const key of ['text', 'content', 'message', 'body', 'summary']) {
    const v = frame[key];
    if (typeof v === 'string' && v.trim()) return v;
    if (v && typeof v === 'object' && typeof (v as { text?: unknown }).text === 'string') return (v as { text: string }).text;
  }
  return null;
}

export function volunteerAsk(request: VolunteerRequest, replyTo: string): string {
  return [
    `[agentIM volunteer request ${request.id}] New task: "${request.title}".`,
    `If you already have context on this, volunteer; otherwise keep doing what you were doing. Nobody sees the description until picked.`,
    `Reply to ${replyTo} within ${Math.round(request.windowMs / 1000)} seconds, even to decline, with these lines:`,
    `request: ${request.id}`,
    `volunteer: yes | no`,
    `context: <one line on why>`,
    `confidence: <0.0-1.0, volunteers only>`,
  ].join('\n');
}

export function briefingText(request: VolunteerRequest): string {
  return `[agentIM volunteer request ${request.id}] You were picked for "${request.title}". The briefing follows.\n\n${request.description}`;
}

export function releaseText(request: VolunteerRequest, winner: string): string {
  return `[agentIM volunteer request ${request.id}] "${request.title}" is taken by ${winner}. Nothing to do; carry on.`;
}

/** A tool call as a Claude Code hook reports it, mapped onto the gate's view: `agentim ack <id>` from Bash, or an MCP tool named cim_ack, is the acknowledgment. */
export function toolCallOf(input: { tool_name?: string; tool_input?: Record<string, unknown> }): { tool: string; args?: Record<string, unknown> } {
  const tool = input.tool_name ?? '';
  const args = input.tool_input ?? {};
  if (tool === 'Bash' && typeof args.command === 'string') {
    const m = /^\s*(?:npx\s+)?agentim\s+ack\s+(\S+)\s*$/.exec(args.command);
    if (m) return { tool: ACK_TOOL, args: { canary: m[1] } };
  }
  if (tool === ACK_TOOL || tool.endsWith(`__${ACK_TOOL}`)) return { tool: ACK_TOOL, args };
  return { tool, args };
}

export class Hub {
  readonly claims = new ClaimRegistry();
  readonly canaries = new CanaryGate();
  readonly inbox: PeerInbox;
  private rounds = new Map<string, { round: VolunteerRound; spawned: VolunteerView['spawned'] }>();
  private deliveries = new Map<string, Delivery>();
  private listeners = new Set<(e: HubEvent) => void>();
  readonly clock: Clock;
  readonly claudeDir: string;
  readonly name: string;
  private readonly run: Runner;

  constructor(readonly opts: HubOptions = {}) {
    this.clock = opts.clock ?? Date.now;
    this.claudeDir = opts.claudeDir ?? CLAUDE_DIR;
    this.name = opts.name ?? DEFAULT_PEER_NAME;
    this.run = opts.run ?? runCommand;
    this.inbox = new PeerInbox({
      claudeDir: this.claudeDir,
      socketDir: opts.socketDir ?? DEFAULT_SOCKET_DIR,
      name: this.name,
      cwd: opts.cwd ?? process.cwd(),
      pid: opts.pid,
      captureLog: opts.captureLog,
      onFrame: (frame, captured) => this.onFrame(frame, captured),
    });
  }

  async start(): Promise<void> {
    await this.inbox.start(this.clock());
  }

  async stop(): Promise<void> {
    await this.inbox.stop();
  }

  subscribe(fn: (e: HubEvent) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(e: HubEvent): void {
    for (const fn of this.listeners) fn(e);
  }

  // ---- roster ------------------------------------------------------------

  agents(): Roster {
    return roster(this.clock(), { claudeDir: this.claudeDir, alive: this.opts.alive, idleAfterMs: this.opts.idleAfterMs ?? IDLE_AFTER_MS, selfPid: this.opts.pid ?? process.pid });
  }

  /** An agent by peer name or session id. */
  agent(id: string): Agent | null {
    return this.agents().agents.find((a) => a.name === id || a.sessionId === id) ?? null;
  }

  transcript(id: string, tail = 50): TranscriptSummary | null {
    const a = this.agent(id);
    return a?.transcriptPath ? readTranscript(a.transcriptPath, { tail }) : null;
  }

  // ---- messages ----------------------------------------------------------

  /**
   * Deliver a human's message to an agent over the peer channel, under the
   * user heading. `Delivered — waiting for <agent>…` lasts until the agent
   * replies to this daemon or writes its next assistant turn.
   */
  async send(agentId: string, text: string, opts: { fromUser?: boolean; round?: string } = {}): Promise<Delivery> {
    const now = this.clock();
    const target = this.agent(agentId);
    if (!target) throw new Error(`no agent named ${agentId}`);
    const body = opts.fromUser === false ? text : wrapFromUser(text);
    const delivery: Delivery = { id: randomUUID(), agent: target.name, text, sentAt: now, status: 'delivered', ...(opts.round ? { round: opts.round } : {}) };
    if (!target.socket || !existsSync(target.socket) || target.state === 'stopped') {
      delivery.status = 'unreachable';
      delivery.error = target.state === 'stopped' ? 'the agent has stopped' : 'the agent has no peer socket';
    } else {
      try {
        await sendFrame(target.socket, messageFrame({ from: this.name, to: target.name, text: body }, this.opts.frameExtra), { timeoutMs: this.opts.sendTimeoutMs });
      } catch (err) {
        delivery.status = 'unreachable';
        delivery.error = err instanceof Error ? err.message : String(err);
      }
    }
    this.deliveries.set(delivery.id, delivery);
    this.emit({ type: 'delivery', at: now, delivery });
    return delivery;
  }

  delivery(id: string): Delivery | null {
    return this.deliveries.get(id) ?? null;
  }

  /** Every delivery, newest first, after checking the transcripts for answers. */
  deliveriesList(): Delivery[] {
    this.refreshDeliveries();
    return [...this.deliveries.values()].sort((a, b) => b.sentAt - a.sentAt);
  }

  /** A delivery is answered when its agent's transcript gained an assistant text turn after it was sent. */
  refreshDeliveries(): void {
    const now = this.clock();
    const pending = [...this.deliveries.values()].filter((d) => d.status === 'delivered');
    if (pending.length === 0) return;
    const agents = this.agents().agents;
    for (const d of pending) {
      const a = agents.find((x) => x.name === d.agent);
      if (!a?.transcriptPath) continue;
      const t = readTranscript(a.transcriptPath, { tail: 20 });
      const answer = t?.turns.filter((turn) => turn.role === 'assistant' && !turn.toolUse && turn.text && Date.parse(turn.timestamp) > d.sentAt).pop();
      if (answer) this.answered(d, answer.text, Math.max(now, Date.parse(answer.timestamp)));
    }
  }

  private answered(d: Delivery, reply: string, at: number): void {
    d.status = 'answered';
    d.answeredAt = at;
    d.reply = reply;
    this.emit({ type: 'delivery', at, delivery: d });
  }

  // ---- the peer channel, inbound ----------------------------------------

  private onFrame(frame: Frame, captured: CapturedFrame): unknown {
    const now = this.clock();
    this.emit({ type: 'frame', at: now, captured });
    const from = typeof frame.from === 'string' ? frame.from : null;
    const text = frameText(frame);
    if (!from || !text) return { ok: true };
    const parsed = parseVolunteerReply(text);
    if (parsed) {
      const round = this.roundFor(text, from);
      if (round) {
        try {
          round.reply({ agent: from, ...parsed }, now);
          this.emit({ type: 'volunteer', at: now, view: this.view(round.request.id)! });
          return { ok: true, request: round.request.id };
        } catch (err) {
          return { ok: false, error: err instanceof Error ? err.message : String(err) };
        }
      }
    }
    const waiting = [...this.deliveries.values()].filter((d) => d.agent === from && d.status === 'delivered').sort((a, b) => a.sentAt - b.sentAt)[0];
    if (waiting) this.answered(waiting, text, now);
    return { ok: true };
  }

  /** The round a reply belongs to: the one it names, else the newest open round that asked this agent and has no reply from it. */
  private roundFor(text: string, from: string): VolunteerRound | null {
    const named = /(?:^|\n)\s*request\s*:\s*(\S+)/i.exec(text)?.[1] ?? /\[agentIM volunteer request (\S+)\]/.exec(text)?.[1];
    if (named && this.rounds.has(named)) return this.rounds.get(named)!.round;
    const now = this.clock();
    const open = [...this.rounds.values()]
      .map((r) => r.round)
      .filter((r) => r.request.roster.includes(from) && !r.tally().some((t) => t.agent === from) && r.resolve(now).status === 'open')
      .sort((a, b) => b.request.createdAt - a.request.createdAt);
    return open[0] ?? null;
  }

  // ---- volunteer rounds --------------------------------------------------

  /**
   * Open a volunteer round: every live agent (or the roster given) gets the
   * title and the instruction; the description is withheld. Returns the view
   * with the delivery outcome per agent.
   */
  async volunteer(input: { title: string; description: string; roster?: string[]; windowMs?: number }): Promise<VolunteerView & { deliveries: Delivery[] }> {
    const now = this.clock();
    const live = this.agents().agents.filter((a) => a.state !== 'stopped').map((a) => a.name);
    const names = input.roster ?? live;
    if (names.length === 0) throw new Error('no live agents to ask');
    const request: VolunteerRequest = { id: `vr-${randomUUID().slice(0, 8)}`, title: input.title, description: input.description, roster: names, createdAt: now, windowMs: input.windowMs ?? VOLUNTEER_WINDOW_MS };
    const round = new VolunteerRound(request);
    this.rounds.set(request.id, { round, spawned: null });
    const deliveries: Delivery[] = [];
    for (const name of names) deliveries.push(await this.send(name, volunteerAsk(request, this.name), { fromUser: false, round: request.id }));
    const view = this.view(request.id)!;
    this.emit({ type: 'volunteer', at: now, view });
    return { ...view, deliveries };
  }

  view(id: string): VolunteerView | null {
    const entry = this.rounds.get(id);
    if (!entry) return null;
    const { round } = entry;
    return { request: round.request, resolution: round.resolve(this.clock()), replies: round.tally(), briefed: round.released(), spawned: entry.spawned };
  }

  volunteers(): VolunteerView[] {
    return [...this.rounds.keys()].map((id) => this.view(id)!).sort((a, b) => b.request.createdAt - a.request.createdAt);
  }

  /** A reply typed in by hand or relayed by another route, in the two-line format. */
  volunteerReply(id: string, agent: string, text: string): VolunteerView {
    const entry = this.rounds.get(id);
    if (!entry) throw new Error(`no volunteer request ${id}`);
    const parsed = parseVolunteerReply(text);
    if (!parsed) throw new Error('a reply has a `volunteer: yes | no` line');
    entry.round.reply({ agent, ...parsed }, this.clock());
    const view = this.view(id)!;
    this.emit({ type: 'volunteer', at: this.clock(), view });
    return view;
  }

  volunteerPick(id: string, agent: string): VolunteerView {
    const entry = this.rounds.get(id);
    if (!entry) throw new Error(`no volunteer request ${id}`);
    entry.round.pickBy({ agent }, this.clock());
    const view = this.view(id)!;
    this.emit({ type: 'volunteer', at: this.clock(), view });
    return view;
  }

  /**
   * Settle a round whose resolution is `picked` and not yet briefed: the
   * briefing goes to the winner first; only after it lands are the others
   * released. Returns the view; a no-op while the round is open or already
   * briefed.
   */
  async settle(id: string): Promise<VolunteerView> {
    const entry = this.rounds.get(id);
    if (!entry) throw new Error(`no volunteer request ${id}`);
    const { round } = entry;
    const res = round.resolve(this.clock());
    if (res.status !== 'picked' || round.released()) return this.view(id)!;
    const briefing = await this.send(res.winner, briefingText(round.request), { round: id });
    if (briefing.status === 'unreachable') throw new Error(`the briefing did not reach ${res.winner}: ${briefing.error}`);
    round.briefed(this.clock());
    for (const other of round.request.roster) if (other !== res.winner) await this.send(other, releaseText(round.request, res.winner), { fromUser: false, round: id });
    const view = this.view(id)!;
    this.emit({ type: 'volunteer', at: this.clock(), view });
    return view;
  }

  /** Every round that resolved to a pick and is not yet briefed, settled: the caller runs this on a timer. */
  async settleAll(): Promise<VolunteerView[]> {
    const out: VolunteerView[] = [];
    for (const [id, entry] of this.rounds) {
      if (entry.round.released() || entry.spawned) continue;
      if (entry.round.resolve(this.clock()).status === 'picked') out.push(await this.settle(id));
    }
    return out;
  }

  /** "Nobody volunteered": start a fresh agent with the briefing as its first prompt. */
  async volunteerSpawn(id: string, input: { mode: 'interactive' | 'background'; repo: string; agent?: string }): Promise<VolunteerView> {
    const entry = this.rounds.get(id);
    if (!entry) throw new Error(`no volunteer request ${id}`);
    if (entry.spawned) throw new Error(`already started ${entry.spawned.agent}`);
    const agent = input.agent ?? `vol-${id.replace(/^vr-/, '')}`;
    const briefing = `${entry.round.request.title}\n\n${entry.round.request.description}`;
    const where = await this.spawn({ mode: input.mode, agent, repo: input.repo, prompt: briefing });
    entry.spawned = { mode: input.mode, agent, where };
    const view = this.view(id)!;
    this.emit({ type: 'volunteer', at: this.clock(), view });
    return view;
  }

  // ---- starting agents ---------------------------------------------------

  /** Start an agent; returns where it runs (the tmux session or the worktree). */
  async spawn(input: { mode: 'interactive' | 'background'; agent: string; repo: string; prompt?: string; claudeBin?: string }): Promise<string> {
    let where: string;
    if (input.mode === 'interactive') where = (await spawnInteractive({ agent: input.agent, cwd: input.repo, prompt: input.prompt, claudeBin: input.claudeBin }, this.run)).tmuxSession;
    else {
      if (!input.prompt) throw new Error('a background agent needs a briefing');
      where = (await spawnBackground({ agent: input.agent, repo: input.repo, briefing: input.prompt, worktreesDir: this.opts.worktreesDir ?? `${input.repo}/.agentim-worktrees`, claudeBin: input.claudeBin }, this.run)).worktree;
    }
    this.emit({ type: 'spawn', at: this.clock(), mode: input.mode, agent: input.agent, where });
    return where;
  }

  openInTerminal(agent: string): Promise<void> {
    return openInTerminal(agent, this.run);
  }

  // ---- claims ------------------------------------------------------------

  claim(input: ClaimInput): Verdict {
    const verdict = this.claims.claim(input, this.clock());
    this.emit({ type: 'claim', at: this.clock(), verdict });
    return verdict;
  }

  complete(claimId: string): boolean {
    return this.claims.complete(claimId, this.clock());
  }

  liveClaims(): Claim[] {
    return this.claims.live(this.clock());
  }

  // ---- canary ------------------------------------------------------------

  canaryIssue(sessionId: string): { canary: Canary; promptLine: string } {
    const canary = this.canaries.issue(sessionId, this.clock());
    this.emit({ type: 'canary', at: this.clock(), sessionId, verdict: 'issued' });
    return { canary, promptLine: canaryPromptLine(canary) };
  }

  canaryGate(sessionId: string, call: { tool_name?: string; tool_input?: Record<string, unknown> }): GateVerdict {
    const verdict = this.canaries.gate(sessionId, toolCallOf(call), this.clock());
    this.emit({ type: 'canary', at: this.clock(), sessionId, verdict });
    return verdict;
  }

  canaryClear(sessionId: string): void {
    this.canaries.clear(sessionId);
    this.emit({ type: 'canary', at: this.clock(), sessionId, verdict: 'cleared' });
  }

  // ---- the status report -------------------------------------------------

  async status(): Promise<StatusReport> {
    const now = this.clock();
    const { agents } = this.agents();
    const nameOf = new Map(agents.map((a) => [a.sessionId, a.name]));
    const worktrees: WorktreeFact[] = [];
    for (const repo of this.opts.repos ?? []) {
      for (const w of await listWorktrees(repo.path, repo.baseBranch ?? 'main', this.run)) {
        const agent = agents.find((a) => a.cwd === w.path)?.name;
        worktrees.push({ ...w, ...(agent ? { agent } : {}) });
      }
    }
    const canaries = this.canaries.all().map((c) => ({ ...c, sessionId: nameOf.get(c.sessionId) ?? c.sessionId }));
    return buildStatusReport(
      {
        agents: agents.map((a) => ({ name: a.name, mode: a.mode, cwd: a.cwd, lastActivityAt: a.lastActivityAt, stopped: a.state === 'stopped' })),
        worktrees,
        claims: this.liveClaims(),
        canaries,
        idleAfterMs: this.opts.idleAfterMs,
      },
      now
    );
  }
}
