/**
 * The session ledger (spec §4.4): cIM names, the resume set ("Resume
 * Agents" after a pause, a reboot or a crash), the last-running list that
 * seeds it, and the in-flight list of sessions resumed but not yet listed.
 */

import { type Agent, isStopped } from './agent.js';
import { KEYS, type KV } from './store.js';
import type { Clock } from './clock.js';

/** Enough to build a stopped stand-in when the CLI no longer lists the session. */
export interface LedgerEntry {
  sessionID: string;
  name: string;
  cwd: string;
  isInteractive: boolean;
  startedAt: number;
}

export interface ResumeSet {
  entries: LedgerEntry[];
  /** True for a set recorded by Pause Agents; false for one inferred from the last-running list. */
  paused: boolean;
  recordedAt: number;
}

const entryOf = (a: Agent): LedgerEntry => ({ sessionID: a.sessionID, name: a.name, cwd: a.cwd, isInteractive: a.kind === 'interactive', startedAt: a.startedAt });

export class SessionLedger {
  names = new Map<string, string>();
  resumeSet: ResumeSet | null = null;
  inFlight: LedgerEntry[] = [];
  private lastRunning: LedgerEntry[] = [];

  constructor(
    private readonly kv: KV,
    private readonly clock: Clock
  ) {
    this.names = new Map(Object.entries(kv.get<Record<string, string>>(KEYS.names) ?? {}));
    this.resumeSet = kv.get<ResumeSet>(KEYS.resumeSet) ?? null;
    this.lastRunning = kv.get<LedgerEntry[]>(KEYS.lastRunning) ?? [];
    // No resume set but sessions were running when cIM last looked: infer what a reboot or crash took down.
    if (!this.resumeSet && this.lastRunning.length) {
      this.resumeSet = { entries: [...this.lastRunning], paused: false, recordedAt: clock() };
      kv.set(KEYS.resumeSet, this.resumeSet);
    }
  }

  displayName(agent: Agent): string {
    return this.names.get(agent.sessionID) ?? agent.name;
  }

  /** Empty clears the override, falling back to the CLI name. */
  rename(sessionID: string, name: string): void {
    const trimmed = name.trim();
    if (trimmed) this.names.set(sessionID, trimmed);
    else this.names.delete(sessionID);
    this.kv.set(KEYS.names, Object.fromEntries(this.names));
  }

  private standIn(e: LedgerEntry): Agent {
    return { sessionID: e.sessionID, name: this.names.get(e.sessionID) ?? e.name, cwd: e.cwd, kind: e.isInteractive ? 'interactive' : 'background', startedAt: e.startedAt };
  }

  /** The roster with cIM names applied, plus a stopped stand-in for every resume-set or in-flight entry the CLI no longer lists. */
  decorate(roster: Agent[]): Agent[] {
    const out = roster.map((a) => (this.names.has(a.sessionID) ? { ...a, name: this.names.get(a.sessionID)! } : a));
    const listed = new Set(roster.map((a) => a.sessionID));
    for (const e of [...(this.resumeSet?.entries ?? []), ...this.inFlight]) {
      if (listed.has(e.sessionID)) continue;
      listed.add(e.sessionID);
      out.push(this.standIn(e));
    }
    return out;
  }

  /** Called on every clean roster read with the visible agents. */
  observe(visible: Agent[]): void {
    const running = visible.filter((a) => !isStopped(a));
    const runningIDs = new Set(running.map((a) => a.sessionID));
    this.inFlight = this.inFlight.filter((e) => !runningIDs.has(e.sessionID));
    const before = this.lastRunning.map((e) => e.sessionID).sort().join('\n');
    const after = [...runningIDs].sort().join('\n');
    if (before !== after) {
      this.lastRunning = running.map(entryOf);
      this.kv.set(KEYS.lastRunning, this.lastRunning);
    }
    // An inferred set lists only what died; a paused set keeps live sessions because they still need the resume message.
    if (this.resumeSet && !this.resumeSet.paused) {
      const entries = this.resumeSet.entries.filter((e) => !runningIDs.has(e.sessionID));
      if (entries.length !== this.resumeSet.entries.length) {
        this.resumeSet = entries.length ? { ...this.resumeSet, entries } : null;
        this.kv.set(KEYS.resumeSet, this.resumeSet);
      }
    }
  }

  recordPause(agents: Agent[]): void {
    const running = agents.filter((a) => !isStopped(a));
    this.resumeSet = running.length ? { entries: running.map(entryOf), paused: true, recordedAt: this.clock() } : null;
    this.kv.set(KEYS.resumeSet, this.resumeSet);
  }

  /** Move entries from the resume set to in-flight: still shown as stopped until the roster lists them. */
  markResumed(sessionIDs: Iterable<string>): void {
    const ids = new Set(sessionIDs);
    if (!this.resumeSet) return;
    const moved = this.resumeSet.entries.filter((e) => ids.has(e.sessionID));
    const kept = this.resumeSet.entries.filter((e) => !ids.has(e.sessionID));
    this.inFlight = [...this.inFlight.filter((e) => !ids.has(e.sessionID)), ...moved];
    this.resumeSet = kept.length ? { ...this.resumeSet, entries: kept } : null;
    this.kv.set(KEYS.resumeSet, this.resumeSet);
  }

  /** Drop from both lists (archived or dismissed). */
  forget(sessionIDs: Iterable<string>): void {
    const ids = new Set(sessionIDs);
    this.inFlight = this.inFlight.filter((e) => !ids.has(e.sessionID));
    if (this.resumeSet) {
      const kept = this.resumeSet.entries.filter((e) => !ids.has(e.sessionID));
      this.resumeSet = kept.length ? { ...this.resumeSet, entries: kept } : null;
      this.kv.set(KEYS.resumeSet, this.resumeSet);
    }
  }

  dismissResumeSet(): void {
    this.resumeSet = null;
    this.kv.set(KEYS.resumeSet, null);
  }
}
