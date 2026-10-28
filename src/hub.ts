/**
 * The hub: everything the cIM pane does, with no UI in it (spec §4, §5.8,
 * §7.4, §9). It owns one instance each of the roster poller, the
 * conversation store, the group store, the volunteer requests, the archive
 * and the ledger, plus the harness extras from the markspace review
 * (claims, the canary gate), and the Morning Standup and the Lightning
 * Round (standup spec §6.4). The HTTP layer in daemon.ts is a thin
 * translation; every collaborator is injectable so tests drive the hub
 * with a fake clock and no sockets.
 */

import { randomUUID } from 'node:crypto';
import { userInfo } from 'node:os';
import { basename, join } from 'node:path';
import { type Agent, isMessageable, isStopped, shortID, projectName } from './agent.js';
import { CLAUDE_DIR, readTail, readSince, transcriptPath, type TranscriptRead } from './transcript.js';
import { runCommand, failureText, type Runner } from './runner.js';
import { limitRunner } from './limit.js';
import { listAgents, RosterPoller } from './roster.js';
import { sendInboxMessage, NO_INBOX_MESSAGE } from './inbox.js';
import { Conversation, ConversationStore } from './conversation.js';
import { GroupConversation, GroupStore, groupKey } from './group.js';
import { computeReviewEntries, nextUnreviewed, repairSelection, reviewHeader, type ReviewEntry } from './review.js';
import { VolunteerRequest } from './volunteer.js';
import { SessionLedger } from './ledger.js';
import { Archive } from './archive.js';
import { buildStandup as buildBoard, orderLightningRows, type SessionActivity, type Standup } from './standup.js';
import { DecisionStore, LightningRound, type ApproveResult, type LightningView } from './lightning.js';
import { DEFAULT_LEDGER_REF, discoverRepos, readLedger, uniqueRepoNames, type LedgerRead, type LedgerRow, type RepoRef } from './tbuv-ledger.js';
import type { Letter } from './lightning-format.js';
import { JsonFileKV, KEYS, type KV } from './store.js';
import { Spawner, resolveClaude, processAlive, gitWorktreeChecks, terminalTooltip, type PermissionMode } from './spawner.js';
import { WRAP_UP, pauseMessage, resumeMessage, renameNotice, JOURNAL_NOW, JOURNAL_INCOMPLETE, CLEANUP_SAFE, CLEANUP_ANYWAY, tbuvReviewed } from './prompts.js';
import { parseStatusReport, choreStates, rollup, worktreeDecision, type StatusReport, type WorktreeFinding, type ChoreState } from './status-report.js';
import { ClaimRegistry, type ClaimInput, type Verdict } from './claims.js';
import { CanaryGate, ACK_TOOL, canaryPromptLine, type GateVerdict } from './canary.js';
import { buildFleetReport, type FleetReport } from './fleet.js';
import type { Clock } from './clock.js';

export interface ModelPreset {
  id: string;
  label: string;
}

/** The Settings the panel reads (§9). */
export interface Settings {
  claudePath: string | null;
  repoPath: string | null;
  permissionMode: PermissionMode;
  planningModel: string;
  modelPresets: ModelPreset[];
  claudeDir: string;
  statePath: string;
  /** The branch the TB/UV ledger files live on. */
  ledgerRef: string;
  /** Prefixes whose unhyphenated form in a branch or session name (`qp27153`) is a ticket key (QP-27153). */
  ticketPrefixes: string[];
}

export const DEFAULT_SETTINGS: Settings = {
  claudePath: null,
  repoPath: null,
  permissionMode: 'acceptEdits',
  planningModel: 'claude-opus-5-5',
  modelPresets: [
    { id: 'claude-fable-5-1', label: 'Fable 5.1 (smartest)' },
    { id: 'claude-opus-5-5', label: 'Opus 5.5 (workhorse)' },
    { id: 'claude-haiku-5-5', label: 'Haiku 5.5 (fastest)' },
  ],
  claudeDir: CLAUDE_DIR,
  statePath: join(CLAUDE_DIR, 'agentim', 'state.json'),
  ledgerRef: DEFAULT_LEDGER_REF,
  ticketPrefixes: [],
};

/** Timing knobs of the Lightning Round; the engine's own defaults apply to what is left out (the demo shortens them). */
export interface LightningTiming {
  presentTimeoutMs?: number;
  voteTimeoutMs?: number;
  pollMs?: number;
  maxPresenters?: number;
}

export interface HubDeps {
  settings?: Partial<Settings>;
  kv?: KV;
  clock?: Clock;
  sleep?: (ms: number) => Promise<void>;
  run?: Runner;
  alive?: (pid: number) => boolean;
  listAgents?: () => Promise<Agent[]>;
  sendInbox?: (agent: Agent, text: string) => Promise<void>;
  readTail?: (path: string) => Promise<TranscriptRead>;
  readSince?: (path: string, offset: number) => Promise<TranscriptRead>;
  gitChecks?: (cwd: string) => Promise<WorktreeFinding>;
  writeScript?: (content: string) => Promise<string>;
  openFile?: (path: string) => Promise<void>;
  osUserName?: string;
  lightningTiming?: LightningTiming;
}

export type Selection = { kind: 'agent'; sessionID: string } | { kind: 'group'; key: string } | { kind: 'volunteer'; id: string } | { kind: 'standup' } | null;

export interface Toast {
  id: string;
  at: number;
  text: string;
  /** Text the UI should put on the clipboard (the rename flow). */
  clipboard?: string;
}

export type HubEvent =
  | { type: 'roster' }
  | { type: 'conversation'; sessionID: string }
  | { type: 'group'; key: string }
  | { type: 'volunteer'; id: string }
  | { type: 'standup' }
  | { type: 'lightning' }
  | { type: 'selection'; selection: Selection }
  | { type: 'toast'; toast: Toast }
  | { type: 'claim'; verdict: Verdict }
  | { type: 'canary'; sessionID: string; verdict: GateVerdict | 'issued' | 'cleared' };

export interface ChoreOutcome {
  action: 'sent' | 'open-wiki-entry' | 'needs-confirmation' | 'sign-off' | 'nothing';
  text?: string;
  /** open-wiki-entry: the path and the directories to search, the reporting agent's cwd first. */
  path?: string;
  searchDirs?: string[];
  /** needs-confirmation: the alert's reasons. */
  reasons?: string[];
  /** sign-off: the de-duplicated TB/UV ids with their ledger records. */
  records?: TbUvRecord[];
}

export interface TbUvRecord {
  id: string;
  kind: 'tombstone' | 'unverified' | 'not-found';
  date?: string;
  claim?: string;
  supersededBy?: string;
  doubt?: string;
}

const sleepReal = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** At most this many distinct directories are asked which repo they belong to. */
const MAX_REPO_DIRS = 200;

/** The standup, the queue and the round's grounding share this many git processes at a time; the rest wait. */
const MAX_GIT_PROCESSES = 8;

/** What GET /lightning says before any round was started. */
const emptyLightning = (): LightningView => ({ active: false, current: null, panelSize: 4, items: [], counts: { total: 0, remaining: 0, decided: 0, deferred: 0 }, log: [] });

export class Hub {
  readonly settings: Settings;
  readonly kv: KV;
  readonly clock: Clock;
  readonly roster: RosterPoller;
  readonly conversations: ConversationStore;
  readonly groups: GroupStore;
  readonly ledger: SessionLedger;
  readonly archive: Archive;
  readonly spawner: Spawner;
  readonly volunteers = new Map<string, VolunteerRequest>();
  readonly claims = new ClaimRegistry();
  readonly canaries = new CanaryGate();
  readonly decisions: DecisionStore;
  /** The last standup built; null until the first. */
  standup: Standup | null = null;
  /** The current (or last) Lightning Round; kept after an abort so its log stays readable until the next start. */
  lightning: LightningRound | null = null;
  selection: Selection = null;
  isPausing = false;
  isResuming = false;
  donePending = new Set<string>();
  toasts: Toast[] = [];
  private listeners = new Set<(e: HubEvent) => void>();
  private pollCtrl: AbortController | null = null;
  private readonly run: Runner;
  /** `run` for everything the standup, the queue and the round ask git; the roster and the spawner keep the plain one. */
  private readonly gitRun: Runner;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly sendInboxFn: (agent: Agent, text: string) => Promise<void>;
  private readonly gitChecks: (cwd: string) => Promise<WorktreeFinding>;
  private readonly osUserName: string;
  private readonly readTailFn: (path: string) => Promise<TranscriptRead>;
  private readonly readSinceFn: (path: string, offset: number) => Promise<TranscriptRead>;
  private readonly lightningTiming: LightningTiming;
  /** Working directory to the repo it belongs to, as the last `refreshRepos` found it. */
  private repoByCwd = new Map<string, RepoRef>();
  /** The roster read in flight (or the last one), never rejecting: `RosterPoller.refresh` returns at once when a read is running, so this is what a caller waits on. */
  private rosterRead: Promise<unknown> = Promise.resolve();
  /** Counts the starts and aborts of the Lightning Round; a start that finds it changed while it was reading has been overtaken. */
  private lightningGen = 0;

  constructor(deps: HubDeps = {}) {
    this.settings = { ...DEFAULT_SETTINGS, ...deps.settings };
    this.kv = deps.kv ?? new JsonFileKV(this.settings.statePath);
    this.clock = deps.clock ?? Date.now;
    this.sleep = deps.sleep ?? sleepReal;
    this.run = deps.run ?? runCommand;
    this.gitRun = limitRunner(this.run, MAX_GIT_PROCESSES);
    this.osUserName = deps.osUserName ?? safeUserName();
    this.lightningTiming = deps.lightningTiming ?? {};
    const sessionsDir = join(this.settings.claudeDir, 'sessions');
    const claudeBin = () => resolveClaude(this.settings.claudePath);
    const list = deps.listAgents ?? (() => listAgents({ run: this.run, claudeBin: claudeBin() ?? 'claude', sessionsDir, clock: this.clock }));
    this.sendInboxFn = deps.sendInbox ?? ((agent, text) => sendInboxMessage({ socketPath: agent.inboxSocketPath, pid: agent.pid }, text, { sessionsDir }));
    this.gitChecks = deps.gitChecks ?? ((cwd) => gitWorktreeChecks(cwd, this.run));
    const tail = deps.readTail ?? ((p: string) => readTail(p));
    const since = deps.readSince ?? ((p: string, o: number) => readSince(p, o));
    this.readTailFn = tail;
    this.readSinceFn = since;
    const path = (a: Agent) => transcriptPath(a.cwd, a.sessionID, this.settings.claudeDir);

    this.roster = new RosterPoller({
      list: () => {
        const read = list();
        this.rosterRead = read.catch(() => undefined);
        return read;
      },
      resolveCli: claudeBin,
      sleep: this.sleep,
    });
    this.ledger = new SessionLedger(this.kv, this.clock);
    this.decisions = new DecisionStore(this.kv, this.clock);
    this.archive = new Archive(this.kv, this.clock);
    this.spawner = new Spawner({ run: this.run, claudeBin, clock: this.clock, sleep: this.sleep, alive: deps.alive ?? processAlive, listAgents: list, writeScript: deps.writeScript, openFile: deps.openFile });
    this.conversations = new ConversationStore({ clock: this.clock, sleep: this.sleep, readTail: tail, readSince: since, sendInbox: this.sendInboxFn, transcriptPath: path, onChange: (c) => this.emit({ type: 'conversation', sessionID: c.sessionID }) });
    this.conversations.resumer = (agent, prompt) => this.spawner.resume(agent, prompt);
    this.conversations.userTurnSender = (agent, prompt) => this.spawner.sendAsUserTurn(agent, prompt);
    this.groups = new GroupStore({ clock: this.clock, sleep: this.sleep, readTail: tail, readSince: since, sendInbox: this.sendInboxFn, transcriptPath: path, onChange: (g) => this.emit({ type: 'group', key: g.key }) });
    this.roster.onClean((agents) => this.onCleanRoster(agents));
  }

  // ---- lifecycle and events -------------------------------------------------

  subscribe(fn: (e: HubEvent) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(e: HubEvent): void {
    for (const fn of this.listeners) fn(e);
  }

  toast(text: string, clipboard?: string): Toast {
    const toast: Toast = { id: randomUUID(), at: this.clock(), text, ...(clipboard ? { clipboard } : {}) };
    this.toasts = [...this.toasts.slice(-49), toast];
    this.emit({ type: 'toast', toast });
    return toast;
  }

  /** Start polling the roster every 5 seconds until `stop`. */
  start(intervalMs?: number): void {
    if (this.pollCtrl) return;
    this.pollCtrl = new AbortController();
    void this.roster.poll(this.pollCtrl.signal, intervalMs);
  }

  /** Leaving the pane: stop polling and unload every idle thread. */
  stop(): void {
    this.pollCtrl?.abort();
    this.pollCtrl = null;
    this.conversations.unloadAllIdle();
    this.groups.unloadAllIdle();
    for (const v of this.volunteers.values()) v.close();
    this.lightningAbort();
  }

  refresh(): Promise<void> {
    return this.roster.refresh();
  }

  // ---- the roster as the pane sees it ---------------------------------------

  /** Archive-filtered, ledger-decorated. */
  get visibleAgents(): Agent[] {
    return this.archive.visible(this.ledger.decorate(this.roster.agents));
  }
  get liveCount(): number {
    return this.visibleAgents.filter((a) => !isStopped(a)).length;
  }
  get messageableAgents(): Agent[] {
    return this.visibleAgents.filter(isMessageable);
  }

  agent(sessionID: string): Agent | null {
    return this.visibleAgents.find((a) => a.sessionID === sessionID) ?? null;
  }

  private requireAgent(sessionID: string): Agent {
    const a = this.agent(sessionID);
    if (!a) throw new Error(`No agent with session ${sessionID} is listed.`);
    return a;
  }

  /** After each clean roster read: observe, prune, refresh memberships, repair the selection. */
  private onCleanRoster(_agents: Agent[]): void {
    const visible = this.visibleAgents;
    this.ledger.observe(visible);
    const decorated = this.visibleAgents; // stand-ins may have changed after observe
    this.conversations.prune(decorated);
    this.groups.refreshMembership(decorated);
    for (const v of this.volunteers.values()) v.refreshRecipients(decorated);
    if (this.selection?.kind === 'agent' && !decorated.some((a) => a.sessionID === (this.selection as { sessionID: string }).sessionID)) this.setSelection(null);
    this.emit({ type: 'roster' });
  }

  // ---- selection ------------------------------------------------------------

  setSelection(selection: Selection): void {
    this.selection = selection;
    this.emit({ type: 'selection', selection });
  }

  /** Select a card: create the thread if new, load its tail, unload stale ones. */
  async selectAgent(sessionID: string): Promise<Conversation> {
    const agent = this.requireAgent(sessionID);
    const c = this.conversations.select(agent);
    this.setSelection({ kind: 'agent', sessionID });
    await c.loadIfNeeded();
    return c;
  }

  async selectGroup(key: string): Promise<GroupConversation> {
    const g = this.groups.existing(key);
    if (!g) throw new Error(`No group ${key}.`);
    this.setSelection({ kind: 'group', key });
    await g.loadIfNeeded();
    return g;
  }

  selectVolunteer(id: string): VolunteerRequest {
    const v = this.volunteers.get(id);
    if (!v) throw new Error(`No volunteer request ${id}.`);
    this.setSelection({ kind: 'volunteer', id });
    return v;
  }

  // ---- 1:1 ----------------------------------------------------------------------

  conversation(sessionID: string): Conversation {
    return this.conversations.conversation(this.requireAgent(sessionID));
  }

  /** Type into the composer and send. */
  async send(sessionID: string, text: string): Promise<boolean> {
    const c = this.conversation(sessionID);
    c.draft = text;
    return c.send();
  }

  async sendAsUser(sessionID: string, text: string): Promise<boolean> {
    const c = this.conversation(sessionID);
    c.draft = text;
    return c.sendAsUser();
  }

  async changeModel(sessionID: string, modelId: string): Promise<boolean> {
    const c = this.conversation(sessionID);
    const ok = await c.changeModel(modelId);
    if (ok) this.toast(`Asked ${c.agent.name} to switch to ${this.settings.modelPresets.find((m) => m.id === modelId)?.label ?? modelId}`);
    return ok;
  }

  async openInTerminal(sessionID: string): Promise<{ opened: boolean; tooltip: string }> {
    const agent = this.requireAgent(sessionID);
    return { opened: await this.spawner.openInTerminal(agent), tooltip: terminalTooltip(agent) };
  }

  // ---- groups -------------------------------------------------------------------

  /** Message All: a group of every messageable agent, a live snapshot. */
  async messageAll(): Promise<GroupConversation> {
    const agents = this.messageableAgents;
    if (agents.length < 2) throw new Error('Message All needs at least two messageable agents; message the one directly.');
    const g = this.groups.group(agents);
    await this.selectGroup(g.key);
    return g;
  }

  async newGroup(sessionIDs: string[]): Promise<GroupConversation> {
    const agents = sessionIDs.map((id) => this.requireAgent(id)).filter(isMessageable);
    if (agents.length < 2) throw new Error('A group needs at least two messageable agents.');
    const g = this.groups.group(agents);
    await this.selectGroup(g.key);
    return g;
  }

  /** Status Check: open (or reuse) the group, send the ask, open it in review mode. */
  async statusCheck(sessionIDs?: string[]): Promise<GroupConversation> {
    const agents = (sessionIDs ? sessionIDs.map((id) => this.requireAgent(id)) : this.messageableAgents).filter(isMessageable);
    if (agents.length === 0) throw new Error('Nobody to check: no agent has a live inbox.');
    let g: GroupConversation;
    if (agents.length === 1) {
      // One recipient: a solo check still goes through a group so review mode and the rollup apply.
      const partner = this.messageableAgents.find((a) => a.sessionID !== agents[0].sessionID);
      if (!partner) {
        const c = this.conversation(agents[0].sessionID);
        await c.sendInstruction((await import('./prompts.js')).STATUS_CHECK);
        throw new Error('Only one agent is messageable; the status ask went to its 1:1 thread.');
      }
      g = this.groups.group([agents[0], partner]);
      await g.sendInstruction((await import('./prompts.js')).STATUS_CHECK, agents[0]);
    } else {
      g = this.groups.group(agents);
      await g.sendStatusCheck();
    }
    g.isReviewing = true;
    g.reviewSelectionManual = false; // a new round: follow the ranking again
    await this.selectGroup(g.key);
    this.emit({ type: 'group', key: g.key });
    return g;
  }

  group(key: string): GroupConversation {
    const g = this.groups.existing(key);
    if (!g) throw new Error(`No group ${key}.`);
    return g;
  }

  /** The review entries, sorted, with the header and the repaired selection. */
  review(key: string): { entries: ReviewEntry[]; header: ReturnType<typeof reviewHeader>; selection: string | null; rollup: ReturnType<typeof rollup> } {
    const g = this.group(key);
    const entries = computeReviewEntries(g.participants, g.turns, g.awaitingSessionIDs, g.reviewedReplyIDs);
    // Until a person picks a row, the default is the first unreviewed entry in the current ranking, so a late needs-human reply surfaces on its own.
    g.reviewSelection = repairSelection(entries, g.reviewSelectionManual ? g.reviewSelection : null);
    return { entries, header: reviewHeader(entries), selection: g.reviewSelection, rollup: rollup([...g.latestReports().values()]) };
  }

  /** Mark the selected entry reviewed and jump to the next unreviewed one. */
  markReviewed(key: string, sessionID: string): string | null {
    const g = this.group(key);
    const { entries } = this.review(key);
    const e = entries.find((x) => x.sessionID === sessionID);
    if (!e || !e.latestReplyID) return g.reviewSelection;
    g.reviewedReplyIDs.set(sessionID, e.latestReplyID);
    const after = computeReviewEntries(g.participants, g.turns, g.awaitingSessionIDs, g.reviewedReplyIDs);
    g.reviewSelection = nextUnreviewed(after, sessionID) ?? sessionID;
    g.reviewSelectionManual = true;
    this.emit({ type: 'group', key });
    return g.reviewSelection;
  }

  closeGroup(key: string): void {
    this.groups.drop(key);
    if (this.selection?.kind === 'group' && this.selection.key === key) this.setSelection(null);
    this.emit({ type: 'roster' });
  }

  // ---- volunteers ------------------------------------------------------------------

  get volunteerRequesterName(): string {
    return this.kv.get<string>(KEYS.volunteerRequester) ?? this.osUserName;
  }
  set volunteerRequesterName(name: string) {
    this.kv.set(KEYS.volunteerRequester, name.trim() || null);
  }

  /** Find a volunteer: ask everyone messageable (or the given ids), then select the request. */
  async findVolunteer(input: { requester?: string; title: string; description: string; sessionIDs?: string[] }): Promise<VolunteerRequest> {
    const requester = (input.requester ?? this.volunteerRequesterName).trim();
    const title = input.title.trim();
    const description = input.description.trim();
    if (!requester || !title || !description) throw new Error('A volunteer request needs your name, a task and a description.');
    if (input.requester) this.volunteerRequesterName = requester;
    const recipients = input.sessionIDs ? input.sessionIDs.map((id) => this.requireAgent(id)) : this.messageableAgents;
    const request = new VolunteerRequest(requester, title, description, recipients, {
      clock: this.clock,
      sleep: this.sleep,
      sendInbox: this.sendInboxFn,
      transcriptSize: (a) => this.transcriptSize(a),
      readSince: (a, offset) => this.assistantSince(a, offset),
      spawn: async (s) => {
        const { jobID } = await this.spawner.spawnBackground({ name: s.name, cwd: s.cwd, model: s.model, permissionMode: this.settings.permissionMode, prompt: s.prompt });
        void this.refresh();
        return { jobID };
      },
      onChange: (r) => this.emit({ type: 'volunteer', id: r.id }),
    });
    this.volunteers.set(request.id, request);
    this.setSelection({ kind: 'volunteer', id: request.id });
    await request.start();
    return request;
  }

  private transcriptFor(a: Agent): string {
    return transcriptPath(a.cwd, a.sessionID, this.settings.claudeDir);
  }

  /** Where an agent's transcript is now: replies to an ask are read from here on. */
  private async transcriptSize(a: Agent): Promise<number> {
    return (await this.readTailFn(this.transcriptFor(a))).endOffset;
  }

  /** The assistant texts appended after `offset`, for the features that wait for a reply block (volunteers, the Lightning Round). */
  private async assistantSince(a: Agent, offset: number): Promise<{ texts: string[]; endOffset: number }> {
    const r = await this.readSinceFn(this.transcriptFor(a), offset);
    return { texts: r.turns.filter((t) => t.role === 'assistant').map((t) => t.text), endOffset: r.endOffset };
  }

  volunteer(id: string): VolunteerRequest {
    const v = this.volunteers.get(id);
    if (!v) throw new Error(`No volunteer request ${id}.`);
    return v;
  }

  /** The agent the roster lists for a request's assignee, once it shows up. */
  assigneeAgent(id: string): Agent | null {
    const v = this.volunteer(id);
    return this.visibleAgents.find((a) => v.matchesAssignee(a)) ?? null;
  }

  closeVolunteer(id: string): void {
    this.volunteer(id).close();
    this.volunteers.delete(id);
    if (this.selection?.kind === 'volunteer' && this.selection.id === id) this.setSelection(null);
    this.emit({ type: 'roster' });
  }

  /** The spawn sheet's defaults and directory choices. */
  spawnDefaults(title: string): { name: string; model: string; directories: string[] } {
    const dirs: string[] = [];
    for (const d of [this.settings.repoPath, ...this.visibleAgents.map((a) => a.cwd)]) if (d && !dirs.includes(d)) dirs.push(d);
    return { name: title.trim().slice(0, 60), model: this.settings.planningModel, directories: dirs };
  }

  async spawnAgent(input: { name: string; model?: string; cwd: string; prompt: string }): Promise<string> {
    const { jobID } = await this.spawner.spawnBackground({ ...input, permissionMode: this.settings.permissionMode });
    this.toast(`Started ${input.name}. It shows up in the list in a few seconds.`);
    void this.refresh();
    return jobID;
  }

  // ---- pause, resume, done, rename (§5.8) --------------------------------------------

  async pauseAgents(): Promise<void> {
    if (this.isPausing) return;
    const running = this.visibleAgents.filter((a) => !isStopped(a));
    if (running.length === 0) return;
    this.ledger.recordPause(running);
    this.isPausing = true;
    this.emit({ type: 'roster' });
    const failed: string[] = [];
    try {
      for (const a of running) {
        const ok = isMessageable(a) ? await this.conversations.conversation(a).sendInstruction(pauseMessage(this.ledger.displayName(a))) : false;
        if (!ok) failed.push(this.ledger.displayName(a));
      }
    } finally {
      this.isPausing = false;
    }
    const kept = this.ledger.resumeSet?.entries.length ?? 0;
    this.toast(`Asked ${running.length} agent(s) to pause. Resume Agents brings back these ${kept}, even after a reboot.${failed.length ? ` Couldn’t reach: ${failed.join(', ')}.` : ''}`);
    this.emit({ type: 'roster' });
  }

  async resumeAgents(): Promise<void> {
    if (this.isResuming) return;
    const set = this.ledger.resumeSet;
    if (!set) return;
    const visible = this.visibleAgents;
    const present = set.entries.map((e) => visible.find((a) => a.sessionID === e.sessionID)).filter((a): a is Agent => !!a);
    if (present.length === 0) {
      this.ledger.dismissResumeSet();
      this.emit({ type: 'roster' });
      return;
    }
    const targets = present.filter((a) => !this.conversations.existing(a.sessionID)?.isResuming);
    this.isResuming = true;
    this.emit({ type: 'roster' });
    const successes: string[] = [];
    const failures: string[] = [];
    try {
      for (const a of targets) {
        const prompt = resumeMessage(this.ledger.displayName(a), set.paused);
        try {
          if (isMessageable(a)) await this.sendInboxFn(a, prompt);
          else if (isStopped(a)) await this.spawner.resume(a, prompt);
          else throw new Error(NO_INBOX_MESSAGE);
          successes.push(a.sessionID);
        } catch (err) {
          failures.push(`${this.ledger.displayName(a)} (${err instanceof Error ? err.message : String(err)})`);
        }
      }
    } finally {
      this.isResuming = false;
    }
    this.ledger.markResumed(successes);
    void this.refresh();
    this.toast(`Resumed ${successes.length} agent(s).${failures.length ? ` Still waiting: ${failures.join('; ')}` : ''}`);
    this.emit({ type: 'roster' });
  }

  dismissResumeSet(): void {
    this.ledger.dismissResumeSet();
    this.emit({ type: 'roster' });
  }

  /** Done: ask the session to clean up and journal, then archive it; only after the send succeeds. */
  async done(sessionID: string): Promise<void> {
    if (this.donePending.has(sessionID)) return;
    const agent = this.requireAgent(sessionID);
    const name = this.ledger.displayName(agent);
    if (!isMessageable(agent)) {
      this.archiveAgent(agent);
      this.toast(`${name} has no live inbox, so nothing was sent. Archived it.`);
      return;
    }
    this.donePending.add(sessionID);
    this.emit({ type: 'roster' });
    try {
      const ok = await this.conversations.conversation(agent).sendInstruction(WRAP_UP);
      if (!ok) {
        this.toast(`Couldn’t reach ${name}: ${this.conversations.existing(sessionID)?.errorMessage ?? 'the send failed'}. It stays in the list.`);
        return;
      }
      this.archiveAgent(agent);
      this.toast(`Asked ${name} to clean up worktrees and journal, then archived it.`);
    } finally {
      this.donePending.delete(sessionID);
      this.emit({ type: 'roster' });
    }
  }

  private archiveAgent(agent: Agent): void {
    if (this.selection?.kind === 'agent' && this.selection.sessionID === agent.sessionID) this.setSelection(null);
    this.ledger.forget([agent.sessionID]);
    this.conversations.drop(agent.sessionID);
    this.archive.archive({ ...agent, name: this.ledger.displayName(agent) });
    this.emit({ type: 'roster' });
  }

  restoreArchived(sessionID: string): void {
    this.archive.restore(sessionID);
    this.emit({ type: 'roster' });
  }

  /** Rename in cIM, then tell the user what else is needed; the CLI's own name cannot be changed from outside a running session. */
  async rename(sessionID: string, name: string): Promise<Toast> {
    const agent = this.requireAgent(sessionID);
    this.ledger.rename(sessionID, name);
    const shown = this.ledger.displayName(agent);
    this.emit({ type: 'roster' });
    if (isStopped(agent)) {
      return agent.kind === 'interactive'
        ? this.toast(`Renamed to ${shown}. Claude Code takes the name too when cIM resumes it.`)
        : this.toast(`Renamed to ${shown} in cIM. A background job keeps its launch name in /resume; cIM tells it the new one when it resumes.`);
    }
    if (isMessageable(agent)) await this.sendInboxFn(agent, renameNotice(shown)).catch(() => undefined);
    const where = agent.kind === 'interactive' ? 'in its terminal' : `after \`claude attach ${shortID(agent)}\``;
    return this.toast(`Renamed to ${shown} in cIM. Copied \`/rename ${shown}\` to the clipboard; run it ${where} to rename the session itself.`, `/rename ${shown}`);
  }

  // ---- the Morning Standup and the Lightning Round (standup spec §6.4) ----------------------

  /**
   * The sessions come from the roster, so a standup or a queue built before its first read would show an empty morning. Wait for that read:
   * start one, or, when the poller's own is running (`refresh` returns at once then), wait for it. A read that failed leaves `lastError` for the caller to report.
   */
  private async rosterLoaded(): Promise<void> {
    if (this.roster.hasLoaded) return;
    await this.roster.refresh();
    await this.rosterRead;
  }

  /**
   * Which repo each working directory belongs to, for the standup, the queue and the round. The round's `repoOf` is synchronous, so it reads
   * `repoByCwd`; this fills it, one question per distinct directory so a linked worktree that lives outside the repo folder maps to its repo too.
   * A session that appears mid-round is recognised at the next refresh (the next standup, queue read or round start), not before.
   * Two repos with one folder name are told apart here, where all of them are known: `discoverRepos` only ever sees one directory at a time.
   */
  private async refreshRepos(): Promise<RepoRef[]> {
    await this.rosterLoaded();
    const dirs = [...new Set([this.settings.repoPath, ...this.visibleAgents.map((a) => a.cwd)].filter((d): d is string => !!d))].slice(0, MAX_REPO_DIRS);
    const found = await Promise.all(dirs.map(async (dir) => ({ dir, repo: (await discoverRepos(this.gitRun, [dir]))[0] })));
    const distinct = new Map<string, RepoRef>();
    for (const { repo } of found) if (repo && !distinct.has(repo.path)) distinct.set(repo.path, repo);
    const named = new Map(uniqueRepoNames([...distinct.values()]).map((repo) => [repo.path, repo]));
    const byCwd = new Map<string, RepoRef>();
    for (const { dir, repo } of found) if (repo) byCwd.set(dir, named.get(repo.path) as RepoRef);
    this.repoByCwd = byCwd;
    return [...named.values()];
  }

  /** What a session last did, from the tail of its transcript. A read error rejects: the standup counts that as no activity. */
  private async activity(agent: Agent): Promise<SessionActivity> {
    const { turns } = await this.readTailFn(this.transcriptFor(agent));
    let report: StatusReport | null = null;
    for (let i = turns.length - 1; i >= 0 && !report; i--) if (turns[i].role === 'assistant') report = parseStatusReport(turns[i].text);
    return { lastAt: turns.at(-1)?.timestamp ?? null, lastStatus: report?.status ?? null, lastScope: report?.scope ?? null };
  }

  /** Build the standup from local git, the ledgers and the sessions, keep it, and select it. Throws the engine's "covering must be ..." for a bad date. */
  async buildStandup(covering?: string): Promise<Standup> {
    const repos = await this.refreshRepos();
    const standup = await buildBoard(
      { clock: this.clock, run: this.gitRun, repos, agents: this.visibleAgents, activity: (a) => this.activity(a) },
      { covering, ticketPrefixes: this.settings.ticketPrefixes, ledgerRef: this.settings.ledgerRef, hidden: (key) => this.decisions.hidden(key) }
    );
    // A roster that could not be read leaves no sessions, or only the ones the last good read listed: say so on the chip rather than show a plain count.
    const failed = this.roster.lastError;
    if (failed !== null) {
      const sessions = standup.sources.find((c) => c.id === 'sessions');
      if (sessions) sessions.note = [`roster unavailable: ${failed.replace(/\s+/g, ' ').trim().slice(0, 200)}`, sessions.note].filter(Boolean).join('; ');
    }
    this.standup = standup;
    this.setSelection({ kind: 'standup' });
    this.emit({ type: 'standup' });
    return standup;
  }

  /** The open rows, and what the read could not give: `repos` are the ones found, `reads[i]` is the ledger of `repos[i]`. */
  private async readQueue(window?: { start: number; end: number }): Promise<{ rows: LedgerRow[]; repos: RepoRef[]; reads: LedgerRead[] }> {
    const repos = await this.refreshRepos();
    const reads = await Promise.all(repos.map((repo) => readLedger(this.gitRun, repo, this.settings.ledgerRef)));
    const rows = reads.flatMap((r) => r.rows).filter((row) => row.open && !this.decisions.hidden(row.key));
    return { rows: orderLightningRows(rows, window ?? (this.standup ? { start: this.standup.windowStart, end: this.standup.windowEnd } : undefined)), repos, reads };
  }

  /** The open ledger rows nobody has settled or put off, in queue order: the ones opened inside `window` (default: the last standup's) first. */
  async openRows(window?: { start: number; end: number }): Promise<LedgerRow[]> {
    return (await this.readQueue(window)).rows;
  }

  /**
   * Start a round over the open rows, narrowed to `keys` and/or the repo named `repo`. An empty queue is a round with nothing in it, not an error;
   * when it is empty (or short) because a repository or a ledger could not be found or read, the round's log says so.
   * A start that was overtaken while it read (a newer start, or an abort) installs nothing and starts nothing: it returns the view as it stands.
   */
  async lightningStart(input: { keys?: string[]; repo?: string; panelSize?: number } = {}): Promise<LightningView> {
    const gen = ++this.lightningGen;
    const { keys, repo } = input;
    const queue = await this.readQueue();
    if (gen !== this.lightningGen) return this.lightningView();
    let rows = queue.rows;
    if (keys) {
      const want = new Set(keys);
      rows = rows.filter((row) => want.has(row.key));
    }
    if (repo) rows = rows.filter((row) => row.repo === repo);
    // The old round is stopped only now, in the same step that replaces it: two starts racing each other cannot leave a round running that nothing points at.
    this.lightning?.abort();
    const round = new LightningRound(
      rows,
      {
        clock: this.clock,
        sleep: this.sleep,
        run: this.gitRun,
        messageable: () => this.messageableAgents,
        repoOf: (agent) => this.repoByCwd.get(agent.cwd)?.path ?? null,
        sendInbox: this.sendInboxFn,
        transcriptSize: (a) => this.transcriptSize(a),
        readSince: (a, offset) => this.assistantSince(a, offset),
        decisions: this.decisions,
        onChange: () => this.emit({ type: 'lightning' }),
        ...this.lightningTiming,
      },
      { panelSize: input.panelSize }
    );
    this.lightning = round;
    for (const line of queueProblems(queue.repos, queue.reads, repo)) round.note(line);
    round.start(); // reports the change to the listeners itself
    return round.view();
  }

  lightningView(): LightningView {
    return this.lightning?.view() ?? emptyLightning();
  }

  private round(): LightningRound {
    if (!this.lightning) throw new Error('No lightning round yet; POST /lightning/start first.');
    return this.lightning;
  }

  lightningSelect(key: string): LightningView {
    const round = this.round();
    round.select(key);
    return round.view();
  }

  /** `rev` is the card's `rev` the caller saw: a card that has changed since throws the engine's StaleCardError and sends nothing. */
  async lightningApprove(key: string, letter: Letter, rev?: number): Promise<ApproveResult & { view: LightningView }> {
    const round = this.round();
    const result = await round.approve(key, letter, rev);
    return { ...result, view: round.view() };
  }

  lightningReject(key: string): LightningView {
    const round = this.round();
    round.reject(key);
    return round.view();
  }

  lightningDefer(key: string): LightningView {
    const round = this.round();
    round.defer(key);
    return round.view();
  }

  /** Ask a panel of other agents to vote on the card; resolves once the asks are sent. */
  async lightningSkeptics(key: string): Promise<LightningView> {
    const round = this.round();
    await round.askSkeptics(key);
    return round.view();
  }

  /** Stop the round's pollers, and any start that is still reading. The round object stays, so its log and cards remain readable until the next start. */
  lightningAbort(): void {
    this.lightningGen++;
    this.lightning?.abort();
  }

  // ---- the status chip's chores (§7.4) ---------------------------------------------------

  private async sendChore(target: { sessionID?: string; groupKey?: string }, agent: Agent, text: string): Promise<boolean> {
    if (target.groupKey) return this.group(target.groupKey).sendInstruction(text, agent);
    return this.conversations.conversation(agent).sendInstruction(text);
  }

  /** The wiki chore button. `confirmed` is the alert's answer for the needs-attention case. */
  async wikiChore(target: { sessionID?: string; groupKey?: string }, agentID: string, report: StatusReport, confirmed = false): Promise<ChoreOutcome> {
    const agent = this.requireAgent(agentID);
    const state = choreStates(report).wiki;
    if (state === 'done') {
      if (!report.wikiEntry) {
        this.toast(`${agent.name} marked the session journaled but gave no entry path.`);
        return { action: 'nothing' };
      }
      return { action: 'open-wiki-entry', path: report.wikiEntry, searchDirs: [agent.cwd, ...(this.settings.repoPath ? [this.settings.repoPath] : [])] };
    }
    if (state === 'needs-attention' && !confirmed) return { action: 'needs-confirmation', reasons: ['the session has not completed its assigned tasks'], text: 'Write incomplete session to wiki?' };
    const text = state === 'needs-attention' ? JOURNAL_INCOMPLETE : JOURNAL_NOW;
    await this.sendChore(target, agent, text);
    return { action: 'sent', text };
  }

  /** The worktrees chore button: git checks first; confirmation when the session is not complete, the finding is concerning, or a check could not run. */
  async worktreeChore(target: { sessionID?: string; groupKey?: string }, agentID: string, report: StatusReport, confirmed = false): Promise<ChoreOutcome> {
    const agent = this.requireAgent(agentID);
    if (choreStates(report).worktrees === 'done') return { action: 'nothing' };
    const finding = await this.gitChecks(agent.cwd);
    const decision = worktreeDecision(report, finding);
    if (decision.reasons.length && !confirmed) return { action: 'needs-confirmation', reasons: decision.reasons, text: 'Clean Up Anyway' };
    const text = decision.reasons.length ? CLEANUP_ANYWAY : CLEANUP_SAFE;
    await this.sendChore(target, agent, text);
    return { action: 'sent', text };
  }

  /** The TB/UV chore button: a sign-off sheet when done or pending; a resolution ask when it needs attention. */
  async tbuvChore(target: { sessionID?: string; groupKey?: string }, agentID: string, report: StatusReport): Promise<ChoreOutcome> {
    const agent = this.requireAgent(agentID);
    const state = choreStates(report).tbUv;
    if (state !== 'needs-attention') return { action: 'sign-off', records: await this.tbuvLookup(report.tbUvRefs, agent.cwd) };
    if (!target.groupKey) {
      await this.conversations.conversation(agent).sendTBUVSolo();
      this.toast('Sent TB/UV resolution ask');
      return { action: 'sent' };
    }
    const g = this.group(target.groupKey);
    const latest = g.latestReports();
    // Every participant whose current latest status also needs attention, plus the clicking agent even if its own state has since resolved.
    const targets = g.participants.filter((p) => {
      if (p.sessionID === agent.sessionID) return true;
      const r = latest.get(p.sessionID);
      return !!r && choreStates(r).tbUv === 'needs-attention';
    });
    const ok = await g.sendTBUVResolution(targets);
    this.toast(ok ? 'Sent TB/UV resolution ask' : 'Nobody left to reach for TB/UV resolution');
    return { action: ok ? 'sent' : 'nothing' };
  }

  /** "Looks right" / "Needs follow-up" on a sign-off row relays a message to the agent; the GUI never writes the ledger files. */
  async tbuvReview(target: { sessionID?: string; groupKey?: string }, agentID: string, id: string, looksRight: boolean): Promise<boolean> {
    return this.sendChore(target, this.requireAgent(agentID), tbuvReviewed(id, looksRight));
  }

  /** The TB/UV records for a list of ids from the ledger ref of the repo `cwd` is in; open or closed rows alike; duplicates keep the first; failures read as not found. */
  async tbuvLookup(ids: string[], cwd: string): Promise<TbUvRecord[]> {
    const unique: string[] = [];
    for (const raw of ids) {
      const id = raw.trim();
      if (id && !unique.some((u) => u.toUpperCase() === id.toUpperCase())) unique.push(id);
    }
    // git finds the repo from `cwd`, so the name given here only decorates the row keys, which a lookup does not use.
    const { rows } = await readLedger(this.gitRun, { name: basename(cwd), path: cwd }, this.settings.ledgerRef);
    return unique.map((id): TbUvRecord => {
      const key = id.toUpperCase();
      const tb = rows.find((r) => r.kind === 'tombstone' && r.id === key);
      if (tb) return { id, kind: 'tombstone', date: tb.date, claim: tb.claim, supersededBy: tb.supersededBy };
      const uv = rows.find((r) => r.kind === 'unverified' && r.id === key);
      if (uv) return { id, kind: 'unverified', date: uv.date, claim: uv.claim, doubt: uv.doubt };
      return { id, kind: 'not-found' };
    });
  }

  /** Parse a turn as a status report and derive what the chip shows. */
  chip(text: string): { report: StatusReport; chores: ReturnType<typeof choreStates> } | null {
    const report = parseStatusReport(text);
    return report ? { report, chores: choreStates(report) } : null;
  }

  // ---- harness extras: claims and the canary (markspace review, Items 4 and 5) -------------

  claim(input: ClaimInput): Verdict {
    const verdict = this.claims.claim(input, this.clock());
    this.emit({ type: 'claim', verdict });
    return verdict;
  }

  canaryIssue(sessionID: string): { promptLine: string } {
    const canary = this.canaries.issue(sessionID, this.clock());
    this.emit({ type: 'canary', sessionID, verdict: 'issued' });
    return { promptLine: canaryPromptLine(canary) };
  }

  canaryGate(sessionID: string, call: { tool_name?: string; tool_input?: Record<string, unknown> }): GateVerdict {
    const tool = call.tool_name ?? '';
    const args = call.tool_input ?? {};
    let mapped: { tool: string; args?: Record<string, unknown> } = { tool, args };
    if (tool === 'Bash' && typeof args.command === 'string') {
      const m = /^\s*(?:npx\s+)?agentim\s+ack\s+(\S+)\s*$/.exec(args.command);
      if (m) mapped = { tool: ACK_TOOL, args: { canary: m[1] } };
    } else if (tool === ACK_TOOL || tool.endsWith(`__${ACK_TOOL}`)) mapped = { tool: ACK_TOOL, args };
    const verdict = this.canaries.gate(sessionID, mapped, this.clock());
    this.emit({ type: 'canary', sessionID, verdict });
    return verdict;
  }

  canaryClear(sessionID: string): void {
    this.canaries.clear(sessionID);
    this.emit({ type: 'canary', sessionID, verdict: 'cleared' });
  }

  fleet(): FleetReport {
    const now = this.clock();
    const agents = this.visibleAgents;
    const nameOf = new Map(agents.map((a) => [a.sessionID, a.name]));
    return buildFleetReport(
      {
        agents: agents.map((a) => ({ name: a.name, mode: a.kind, cwd: a.cwd, lastActivityAt: isStopped(a) ? null : a.startedAt, stopped: isStopped(a) })),
        worktrees: [],
        claims: this.claims.live(now),
        canaries: this.canaries.all().map((c) => ({ ...c, sessionId: nameOf.get(c.sessionId) ?? c.sessionId })),
      },
      now
    );
  }

  // ---- a snapshot for the panel ------------------------------------------------------

  snapshot(): HubSnapshot {
    const visible = this.visibleAgents;
    const round = this.lightning?.view();
    return {
      at: this.clock(),
      roster: { agents: visible, hasLoaded: this.roster.hasLoaded, isRefreshing: this.roster.isRefreshing, lastError: this.roster.lastError, liveCount: this.liveCount },
      selection: this.selection,
      resumeSet: this.ledger.resumeSet,
      inFlight: this.ledger.inFlight,
      archived: this.archive.entries,
      groups: this.groups.all().map((g) => ({ key: g.key, participants: g.participants.map((p) => ({ sessionID: p.sessionID, name: p.name })), isAwaitingReply: g.isAwaitingReply, isReviewing: g.isReviewing })),
      volunteers: [...this.volunteers.values()].map((v) => ({ id: v.id, title: v.title, phase: v.phase, volunteers: v.volunteers.length, assignee: v.assignee?.name ?? null })),
      flags: { isPausing: this.isPausing, isResuming: this.isResuming, donePending: [...this.donePending] },
      toasts: this.toasts.slice(-10),
      settings: { ...this.settings, statePath: undefined },
      volunteerRequesterName: this.volunteerRequesterName,
      projectNames: Object.fromEntries(visible.map((a) => [a.sessionID, projectName(a)])),
      standup: this.standup && { at: this.standup.at, covering: this.standup.covering, through: this.standup.through, run: this.standup.run, lanes: this.standup.lanes },
      lightning: round ? { active: round.active, remaining: round.counts.remaining, current: round.current } : null,
    };
  }
}

export interface HubSnapshot {
  at: number;
  roster: { agents: Agent[]; hasLoaded: boolean; isRefreshing: boolean; lastError: string | null; liveCount: number };
  selection: Selection;
  resumeSet: SessionLedger['resumeSet'];
  inFlight: SessionLedger['inFlight'];
  archived: Archive['entries'];
  groups: Array<{ key: string; participants: Array<{ sessionID: string; name: string }>; isAwaitingReply: boolean; isReviewing: boolean }>;
  volunteers: Array<{ id: string; title: string; phase: string; volunteers: number; assignee: string | null }>;
  flags: { isPausing: boolean; isResuming: boolean; donePending: string[] };
  toasts: Toast[];
  settings: Omit<Settings, 'statePath'> & { statePath?: undefined };
  volunteerRequesterName: string;
  projectNames: Record<string, string>;
  standup: { at: number; covering: string; through: string; run: string; lanes: Standup['lanes'] } | null;
  lightning: { active: boolean; remaining: number; current: string | null } | null;
}

/** The lines for the round's log when the queue could not be read in full: no repository, a `repo` that names none, ledgers that could not be read or only in part. */
function queueProblems(repos: RepoRef[], reads: LedgerRead[], repo?: string): string[] {
  if (repos.length === 0) return ['No repository found: pass --repo or start an agent inside one.'];
  const lines: string[] = [];
  if (repo && !repos.some((r) => r.name === repo)) lines.push(`No repository named ${repo}; the repositories are ${repos.map((r) => r.name).join(', ')}.`);
  const list = (bad: Array<{ name: string; why: string }>): string => (bad.length === 1 && repos.length === 1 ? bad[0].why : bad.map((b) => `${b.name}: ${b.why}`).join('; '));
  const gone = repos.flatMap((r, i) => (reads[i].unavailable ? [{ name: r.name, why: reads[i].note ?? 'no ledger branch' }] : []));
  if (gone.length) lines.push(`No ledger could be read in ${gone.length} repo(s): ${list(gone)}.`);
  const partial = repos.flatMap((r, i) => (!reads[i].unavailable && reads[i].note !== undefined ? [{ name: r.name, why: reads[i].note as string }] : []));
  if (partial.length) lines.push(`Part of the ledger could not be read in ${partial.length} repo(s): ${list(partial)}.`);
  return lines;
}

function safeUserName(): string {
  try {
    return userInfo().username;
  } catch {
    return 'me';
  }
}

export { groupKey, failureText, type ChoreState };
