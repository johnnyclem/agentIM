/**
 * The volunteer flow (spec §5.7): every agent gets the title and is asked
 * to volunteer if it has context; only the picked one gets the
 * description; everyone else asked is released. Replies are read from each
 * recipient's transcript past the byte size it had when the ask went out,
 * so only answers written after the ask count. Timing, sends, reads and
 * spawning are injected.
 */

import { randomUUID } from 'node:crypto';
import { type Agent, isMessageable } from './agent.js';
import { fencedBlock } from './status-report.js';
import { VOLUNTEER_FENCE, volunteerAsk, volunteerBriefing, volunteerRelease } from './prompts.js';
import type { Clock } from './clock.js';

export const ANSWER_WINDOW_MS = 30_000;
export const LISTEN_MS = 15 * 60_000;
export const LISTEN_POLL_MS = 2_000;

export type VolunteerPhase = 'asking' | 'collecting' | 'assigned' | 'failed';
export type SilentReason = 'busy' | 'offline';

export interface VolunteerAnswer {
  volunteer: boolean;
  context: string;
  at: number;
  /** Arrived after the answer window closed. Counts all the same. */
  late: boolean;
}

export interface Assignee {
  sessionID?: string;
  jobID?: string;
  name: string;
  model?: string;
  /** True when a new agent was started for it. */
  spawned: boolean;
}

/** `volunteer: yes | no` and `context:` from the fenced block; null when there is no recognizable answer. */
export function parseVolunteerReply(text: string): { volunteer: boolean; context: string } | null {
  const body = fencedBlock(text, VOLUNTEER_FENCE);
  if (body === null) return null;
  let answer: boolean | null = null;
  let context = '';
  for (const raw of body.split(/\r?\n/)) {
    const colon = raw.indexOf(':');
    if (colon < 0) continue;
    const key = raw.slice(0, colon).trim().toLowerCase();
    const value = raw.slice(colon + 1).trim();
    if (value.includes('|')) continue; // the template echoed back
    if (key === 'volunteer') {
      const word = /[A-Za-z]+/.exec(value)?.[0]?.toLowerCase();
      if (word === 'yes' || word === 'true' || word === 'y') answer = true;
      else if (word === 'no' || word === 'false' || word === 'n') answer = false;
    } else if (key === 'context') context = value;
  }
  return answer === null ? null : { volunteer: answer, context };
}

export interface VolunteerDeps {
  clock: Clock;
  sleep: (ms: number) => Promise<void>;
  sendInbox: (agent: Agent, text: string) => Promise<void>;
  /** The transcript's current byte size: replies are read from here on. */
  transcriptSize: (agent: Agent) => Promise<number>;
  /** New assistant texts past the offset, with the new offset. */
  readSince: (agent: Agent, offset: number) => Promise<{ texts: string[]; endOffset: number }>;
  spawn: (input: { name: string; model?: string; cwd: string; prompt: string }) => Promise<{ jobID: string }>;
  onChange?: (r: VolunteerRequest) => void;
  windowMs?: number;
  listenMs?: number;
  pollMs?: number;
}

export class VolunteerRequest {
  readonly id = randomUUID();
  phase: VolunteerPhase = 'asking';
  recipients: Agent[];
  /** Recipients the ask was delivered to. */
  reached = new Set<string>();
  answers = new Map<string, VolunteerAnswer>();
  silent = new Map<string, SilentReason>();
  assignee: Assignee | null = null;
  isListening = false;
  isAssigning = false;
  errorMessage: string | null = null;
  readonly createdAt: number;
  private offsets = new Map<string, number>();
  private listener: AbortController | null = null;
  private windowClosed = false;
  private tasks = new Set<Promise<void>>();

  constructor(
    readonly requester: string,
    readonly title: string,
    readonly description: string,
    recipients: Agent[],
    private readonly deps: VolunteerDeps
  ) {
    this.recipients = [...recipients];
    this.createdAt = deps.clock();
  }

  private changed(): void {
    this.deps.onChange?.(this);
  }

  async settle(): Promise<void> {
    while (this.tasks.size) await Promise.all([...this.tasks]);
  }

  private track(p: Promise<void>): Promise<void> {
    const wrapped = p.finally(() => this.tasks.delete(wrapped));
    this.tasks.add(wrapped);
    return wrapped;
  }

  get windowMs(): number {
    return this.deps.windowMs ?? ANSWER_WINDOW_MS;
  }
  get volunteers(): Agent[] {
    return this.recipients.filter((a) => this.answers.get(a.sessionID)?.volunteer === true);
  }
  get declined(): Agent[] {
    return this.recipients.filter((a) => this.answers.get(a.sessionID)?.volunteer === false);
  }
  get unanswered(): Agent[] {
    return this.recipients.filter((a) => this.reached.has(a.sessionID) && !this.answers.has(a.sessionID));
  }
  get everyoneAnswered(): boolean {
    return this.reached.size > 0 && [...this.reached].every((id) => this.answers.has(id));
  }

  /** Fan the ask out; remember each transcript's size first so only later replies count. */
  async start(): Promise<void> {
    const targets = this.recipients.filter(isMessageable);
    const errors: string[] = [];
    await Promise.all(
      targets.map(async (a) => {
        try {
          this.offsets.set(a.sessionID, await this.deps.transcriptSize(a));
          await this.deps.sendInbox(a, volunteerAsk(this.requester, this.title));
          this.reached.add(a.sessionID);
        } catch (err) {
          errors.push(`${a.name}: ${err instanceof Error ? err.message : String(err)}`);
        }
      })
    );
    if (errors.length) this.errorMessage = errors.join('; ');
    if (this.reached.size === 0) {
      this.phase = 'failed';
      this.changed();
      return;
    }
    this.phase = 'collecting';
    this.changed();
    void this.track(
      (async () => {
        await this.deps.sleep(this.windowMs);
        this.closeAnswerWindow();
      })()
    );
    this.listen();
  }

  /** Every reached agent with no reply yet is marked silent: busy if its roster status is busy, else offline. */
  closeAnswerWindow(): void {
    if (this.phase !== 'collecting' || this.windowClosed) return;
    this.windowClosed = true;
    for (const a of this.unanswered) this.silent.set(a.sessionID, a.status === 'busy' ? 'busy' : 'offline');
    this.changed();
  }

  /** Poll the reached transcripts until everyone answered, the phase changes, or the deadline. */
  listen(): void {
    if (this.listener) return;
    const ctrl = new AbortController();
    this.listener = ctrl;
    this.isListening = true;
    const deadline = this.deps.clock() + (this.deps.listenMs ?? LISTEN_MS);
    void this.track(
      (async () => {
        try {
          while (!ctrl.signal.aborted && this.phase === 'collecting' && !this.everyoneAnswered && this.deps.clock() < deadline) {
            await this.deps.sleep(this.deps.pollMs ?? LISTEN_POLL_MS);
            if (ctrl.signal.aborted) return;
            await this.pollOnce();
          }
        } finally {
          if (this.listener === ctrl) {
            this.listener = null;
            this.isListening = false;
            this.changed();
          }
        }
      })()
    );
  }

  listenAgain(): void {
    if (this.phase === 'collecting') this.listen();
  }

  async pollOnce(): Promise<void> {
    const now = this.deps.clock();
    await Promise.all(
      this.recipients
        .filter((a) => this.reached.has(a.sessionID))
        .map(async (a) => {
          const { texts, endOffset } = await this.deps.readSince(a, this.offsets.get(a.sessionID) ?? 0);
          this.offsets.set(a.sessionID, endOffset);
          for (const text of texts) {
            const parsed = parseVolunteerReply(text);
            if (!parsed) continue;
            // The latest answer wins: an agent may change its mind. A late reply still counts and clears the silent mark.
            this.answers.set(a.sessionID, { ...parsed, at: now, late: this.windowClosed });
            this.silent.delete(a.sessionID);
          }
        })
    );
    this.changed();
  }

  /** Replace recipients with their roster values; a missing one keeps its last value. */
  refreshRecipients(roster: Agent[]): void {
    const byId = new Map(roster.map((a) => [a.sessionID, a]));
    this.recipients = this.recipients.map((r) => byId.get(r.sessionID) ?? r);
  }

  private stopListening(): void {
    this.listener?.abort();
    this.listener = null;
    this.isListening = false;
  }

  private async releaseOthers(except: string | null): Promise<void> {
    const assignee = this.assignee?.name ?? 'another agent';
    await Promise.all(
      this.recipients
        .filter((a) => this.reached.has(a.sessionID) && a.sessionID !== except)
        .map((a) => this.deps.sendInbox(a, volunteerRelease(this.title, assignee)).catch(() => undefined))
    );
  }

  /** Brief one agent. If the briefing fails, release nobody and leave the request open. */
  async assign(agent: Agent): Promise<boolean> {
    if ((this.phase !== 'collecting' && this.phase !== 'failed') || this.isAssigning) return false;
    this.isAssigning = true;
    this.changed();
    try {
      await this.deps.sendInbox(agent, volunteerBriefing(this.requester, this.title, this.description));
    } catch (err) {
      this.errorMessage = `The briefing didn’t reach ${agent.name}: ${err instanceof Error ? err.message : String(err)}`;
      this.isAssigning = false;
      this.changed();
      return false;
    }
    this.assignee = { sessionID: agent.sessionID, jobID: agent.jobID, name: agent.name, spawned: false };
    this.phase = 'assigned';
    this.stopListening();
    this.changed();
    await this.releaseOthers(agent.sessionID);
    this.isAssigning = false;
    this.changed();
    return true;
  }

  /** Start a new background agent whose first prompt is the briefing, then assign it by job id. */
  async spawn(input: { name: string; model?: string; cwd: string }): Promise<boolean> {
    if ((this.phase !== 'collecting' && this.phase !== 'failed') || this.isAssigning) return false;
    this.isAssigning = true;
    this.changed();
    try {
      const { jobID } = await this.deps.spawn({ ...input, prompt: volunteerBriefing(this.requester, this.title, this.description) });
      this.assignee = { jobID, name: input.name, model: input.model, spawned: true };
    } catch (err) {
      this.errorMessage = err instanceof Error ? err.message : String(err);
      this.isAssigning = false;
      this.changed();
      return false;
    }
    this.phase = 'assigned';
    this.stopListening();
    this.changed();
    await this.releaseOthers(null);
    this.isAssigning = false;
    this.changed();
    return true;
  }

  /** A spawned agent has only a job id until the roster lists it. */
  matchesAssignee(agent: Agent): boolean {
    if (!this.assignee) return false;
    if (this.assignee.sessionID) return agent.sessionID === this.assignee.sessionID;
    if (!this.assignee.jobID) return false;
    return agent.jobID === this.assignee.jobID || agent.sessionID.startsWith(this.assignee.jobID);
  }

  /** Closing stops listening; agents already asked are not messaged again. */
  close(): void {
    this.stopListening();
  }

  /** The status line of the request detail view. */
  summary(): string {
    switch (this.phase) {
      case 'asking':
        return 'Sending the ask…';
      case 'failed':
        return 'The ask didn’t reach any agent. You can still assign it or start a new agent.';
      case 'assigned':
        return this.assignee?.spawned ? `Started ${this.assignee.name}${this.assignee.model ? ` on ${this.assignee.model}` : ''}.` : `Briefed ${this.assignee?.name}.`;
      default: {
        if (this.everyoneAnswered) return 'Everyone answered.';
        if (!this.windowClosed) return `Waiting on ${this.unanswered.length} of ${this.reached.size}, up to ${Math.round(this.windowMs / 1000)}s…`;
        return `${this.unanswered.length} didn’t answer within ${Math.round(this.windowMs / 1000)}s. A late answer still counts.`;
      }
    }
  }
}
