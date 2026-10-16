/**
 * The roster: `claude agents --json --all` joined with the per-process
 * descriptors `~/.claude/sessions/<pid>.json` (spec §2.1, §2.2, §4.1).
 *
 * A failure is an error, never an empty list: an empty roster prunes every
 * open thread, so a transient failure must not look like "no agents".
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Agent, AgentKind, AgentStatus } from './agent.js';
import { CLAUDE_DIR } from './transcript.js';
import { failureText, type Runner } from './runner.js';
import type { Clock } from './clock.js';

export interface RosterRow {
  sessionId: string;
  cwd: string;
  pid?: number;
  kind?: string;
  name?: string;
  status?: string;
  startedAt?: number;
  id?: string;
}

/** Only the socket path is taken from a descriptor; everything else comes from the roster (the two disagree during startup). */
export async function readSocketPath(sessionsDir: string, pid: number): Promise<string | undefined> {
  try {
    const o = JSON.parse(await readFile(join(sessionsDir, `${pid}.json`), 'utf8')) as { messagingSocketPath?: unknown };
    return typeof o.messagingSocketPath === 'string' && o.messagingSocketPath ? o.messagingSocketPath : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Parse the CLI's JSON into agents: dedupe by session id (the live row wins
 * over a stopped one), sort newest first, name falls back to the short id.
 * `socketOf` supplies the descriptor join.
 */
export function parseRoster(json: string, socketOf: (pid: number) => string | undefined, now: number): Agent[] {
  let rows: unknown;
  try {
    rows = JSON.parse(json);
  } catch (err) {
    throw new Error(`claude agents printed something that is not JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!Array.isArray(rows)) throw new Error('claude agents did not print a JSON array');
  const byId = new Map<string, Agent>();
  for (const raw of rows as RosterRow[]) {
    if (!raw || typeof raw.sessionId !== 'string' || typeof raw.cwd !== 'string') continue;
    const pid = typeof raw.pid === 'number' ? raw.pid : undefined;
    const kind: AgentKind = raw.kind === 'background' ? 'background' : 'interactive';
    const status: AgentStatus | undefined = raw.status === 'idle' || raw.status === 'busy' ? raw.status : undefined;
    const agent: Agent = {
      sessionID: raw.sessionId,
      ...(pid !== undefined ? { pid } : {}),
      ...(typeof raw.id === 'string' && raw.id ? { jobID: raw.id } : {}),
      name: typeof raw.name === 'string' && raw.name.trim() ? raw.name : raw.sessionId.slice(0, 8),
      cwd: raw.cwd,
      kind,
      ...(status ? { status } : {}),
      startedAt: typeof raw.startedAt === 'number' ? raw.startedAt : now,
    };
    if (pid !== undefined) {
      const sock = socketOf(pid);
      if (sock) agent.inboxSocketPath = sock;
    }
    const existing = byId.get(agent.sessionID);
    if (!existing || (existing.pid === undefined && pid !== undefined)) byId.set(agent.sessionID, agent);
  }
  return [...byId.values()].sort((a, b) => b.startedAt - a.startedAt);
}

export interface ListAgentsOptions {
  run: Runner;
  claudeBin: string;
  sessionsDir?: string;
  clock?: Clock;
}

/** `claude agents --json --all`, joined with the descriptors. Throws on a non-zero exit. */
export async function listAgents(opts: ListAgentsOptions): Promise<Agent[]> {
  const r = await opts.run(opts.claudeBin, ['agents', '--json', '--all'], { timeoutMs: 20_000 });
  if (r.code !== 0) throw new Error(`claude agents failed: ${failureText(r)}`);
  const sessionsDir = opts.sessionsDir ?? join(CLAUDE_DIR, 'sessions');
  const now = (opts.clock ?? Date.now)();
  // Read descriptors for every pid first so the parse itself stays synchronous.
  const pids = new Set<number>();
  try {
    for (const row of JSON.parse(r.stdout) as RosterRow[]) if (row && typeof row.pid === 'number') pids.add(row.pid);
  } catch {
    // parseRoster reports the JSON error with context
  }
  const sockets = new Map<number, string | undefined>();
  await Promise.all([...pids].map(async (pid) => sockets.set(pid, await readSocketPath(sessionsDir, pid))));
  return parseRoster(r.stdout, (pid) => sockets.get(pid), now);
}

export const ROSTER_INTERVAL_MS = 5_000;

/**
 * The poller (spec §4.1): `refresh` keeps the previous agents on failure and
 * only sets the error; an unresolvable CLI path clears them. `hasLoaded`
 * tells "still loading" from "nothing running".
 */
export class RosterPoller {
  agents: Agent[] = [];
  isRefreshing = false;
  lastError: string | null = null;
  hasLoaded = false;
  private listeners = new Set<(agents: Agent[]) => void>();

  constructor(
    private readonly deps: {
      list: () => Promise<Agent[]>;
      /** Resolves the CLI path; null means not found. */
      resolveCli: () => string | null;
      sleep: (ms: number) => Promise<void>;
    }
  ) {}

  /** Called after every clean read with the fresh agents. */
  onClean(fn: (agents: Agent[]) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  async refresh(): Promise<void> {
    if (this.isRefreshing) return;
    this.isRefreshing = true;
    try {
      if (!this.deps.resolveCli()) {
        this.lastError = 'Couldn’t find the `claude` CLI. Set its path in Settings.';
        this.agents = [];
        return;
      }
      try {
        const agents = await this.deps.list();
        this.agents = agents;
        this.lastError = null;
        this.hasLoaded = true;
        for (const fn of this.listeners) fn(agents);
      } catch (err) {
        this.lastError = err instanceof Error ? err.message : String(err);
      }
    } finally {
      this.isRefreshing = false;
    }
  }

  /** Refresh, sleep, repeat until the signal aborts. Drive it from the pane's lifecycle. */
  async poll(signal: AbortSignal, intervalMs: number = ROSTER_INTERVAL_MS): Promise<void> {
    while (!signal.aborted) {
      await this.refresh();
      await this.deps.sleep(intervalMs);
    }
  }
}
