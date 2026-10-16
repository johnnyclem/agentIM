/**
 * The archive (spec §4.5): "Done" records a session here so it stops
 * appearing even while its process winds down. Capped at 100, newest first.
 */

import { type Agent, projectName } from './agent.js';
import { KEYS, type KV } from './store.js';
import type { Clock } from './clock.js';

export const ARCHIVE_CAP = 100;

export interface ArchivedSession {
  sessionID: string;
  name: string;
  projectName: string;
  archivedAt: number;
}

export class Archive {
  entries: ArchivedSession[] = [];

  constructor(
    private readonly kv: KV,
    private readonly clock: Clock
  ) {
    this.entries = kv.get<ArchivedSession[]>(KEYS.archived) ?? [];
  }

  has(sessionID: string): boolean {
    return this.entries.some((e) => e.sessionID === sessionID);
  }

  visible(agents: Agent[]): Agent[] {
    return agents.filter((a) => !this.has(a.sessionID));
  }

  archive(agent: Agent): void {
    if (this.has(agent.sessionID)) return;
    this.entries = [{ sessionID: agent.sessionID, name: agent.name, projectName: projectName(agent), archivedAt: this.clock() }, ...this.entries].slice(0, ARCHIVE_CAP);
    this.kv.set(KEYS.archived, this.entries);
  }

  /** The session reappears on the next poll if still running; otherwise it is simply gone. */
  restore(sessionID: string): void {
    this.entries = this.entries.filter((e) => e.sessionID !== sessionID);
    this.kv.set(KEYS.archived, this.entries);
  }
}
