/**
 * Volunteer requests with deferred resolution (markspace review, Item 4;
 * decision D9).
 *
 * A new task shows up. Every agent sees the title and one instruction: if
 * you already have context, volunteer; keep doing what you were doing.
 * Nobody sees the description until picked. Replies are two lines:
 * `volunteer: yes | no` and one line of context. A 30-second window
 * collects them (D9, the value already in production use); an agent silent
 * past the window shows as busy, and a late reply still lands.
 *
 * Resolution is deferred to the window's close: the highest declared
 * confidence among the volunteers wins, ties to the earliest reply. A
 * person may pick any agent instead, volunteer or not. "Nobody volunteered"
 * is an answer too: the request stays open for the existing button that
 * starts a fresh agent with the briefing as its first prompt. The window
 * is fixed: about one agent in five volunteers today, which is right, and
 * nothing here tunes the window to raise it.
 */

export const VOLUNTEER_WINDOW_MS = 30_000;

export interface VolunteerReply {
  agent: string;
  volunteer: boolean;
  /** Declared confidence in [0, 1]; a `no` carries none. */
  confidence: number;
  /** One line on why. */
  context: string;
  /** The clock reading the reply landed at. */
  at: number;
  /** True when it landed after the window closed: recorded, never decisive. */
  late: boolean;
}

export interface VolunteerRequest {
  id: string;
  title: string;
  /** Withheld until someone is picked. */
  description: string;
  /** The agents asked, in roster order. */
  roster: string[];
  createdAt: number;
  windowMs: number;
}

export type Resolution =
  | { status: 'open'; closesAt: number; at: number }
  | { status: 'picked'; winner: string; by: 'confidence' | 'person'; candidates: VolunteerReply[]; at: number }
  | { status: 'nobody'; silent: string[]; declined: string[]; at: number };

export class VolunteerRound {
  private replies = new Map<string, VolunteerReply>();
  private pick: { agent: string; by: 'person'; at: number } | null = null;
  /** The briefing was delivered to the picked agent: only then are the others released. */
  private briefedAt: number | null = null;

  constructor(readonly request: VolunteerRequest) {
    if (!(request.windowMs > 0)) throw new Error('the window is a positive number of milliseconds');
    if (request.roster.length === 0) throw new Error('a request names at least one agent');
  }

  get closesAt(): number {
    return this.request.createdAt + this.request.windowMs;
  }

  /** A reply from an agent in the roster at `now`. A second reply from the same agent replaces the first. */
  reply(input: { agent: string; volunteer: boolean; confidence?: number; context?: string }, now: number): VolunteerReply {
    if (!this.request.roster.includes(input.agent)) throw new Error(`${input.agent} was not asked`);
    const confidence = input.volunteer ? (input.confidence ?? 0) : 0;
    if (!(confidence >= 0 && confidence <= 1)) throw new Error('confidence is in [0, 1]');
    const reply: VolunteerReply = { agent: input.agent, volunteer: input.volunteer, confidence, context: (input.context ?? '').trim(), at: now, late: now >= this.closesAt };
    this.replies.set(input.agent, reply);
    return reply;
  }

  /** The person picks: any agent in the roster, volunteer or not, at any time. Final. */
  pickBy(person: { agent: string }, now: number): void {
    if (!this.request.roster.includes(person.agent)) throw new Error(`${person.agent} was not asked`);
    if (this.pick) throw new Error(`already picked ${this.pick.agent}`);
    this.pick = { agent: person.agent, by: 'person', at: now };
  }

  /** The harness records that the briefing reached the picked agent. Only after this are the others released. */
  briefed(now: number): void {
    if (!this.pick && this.resolve(now).status !== 'picked') throw new Error('nobody is picked yet');
    this.briefedAt = now;
  }

  /** Whether the other agents may be told the job is taken: brief first, release second. */
  released(): boolean {
    return this.briefedAt !== null;
  }

  /** The replies so far, in roster order, with the silent agents left out. */
  tally(): VolunteerReply[] {
    return this.request.roster.map((a) => this.replies.get(a)).filter((r): r is VolunteerReply => r !== undefined);
  }

  /**
   * Resolve at `now`: open until the window closes (unless a person picked),
   * then the volunteers by confidence, ties to the earliest reply, else
   * nobody. Late replies are shown but never decide. Pure in the clock.
   */
  resolve(now: number): Resolution {
    if (this.pick) return { status: 'picked', winner: this.pick.agent, by: 'person', candidates: this.tally(), at: now };
    if (now < this.closesAt) return { status: 'open', closesAt: this.closesAt, at: now };
    const inTime = this.tally().filter((r) => !r.late);
    const volunteers = inTime.filter((r) => r.volunteer).sort((a, b) => b.confidence - a.confidence || a.at - b.at || a.agent.localeCompare(b.agent));
    if (volunteers.length > 0) return { status: 'picked', winner: volunteers[0].agent, by: 'confidence', candidates: this.tally(), at: now };
    const declined = inTime.filter((r) => !r.volunteer).map((r) => r.agent);
    const silent = this.request.roster.filter((a) => !inTime.some((r) => r.agent === a));
    return { status: 'nobody', silent, declined, at: now };
  }
}
