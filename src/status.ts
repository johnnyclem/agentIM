/**
 * The status report: what every agent is doing, what it holds, and what is
 * left behind. Pure: facts in, a report out, every age stated against the
 * clock reading it was measured at.
 */

import type { Claim } from './claims.js';
import type { Canary } from './canary.js';

export type AgentMode = 'interactive' | 'background';
export type AgentState = 'busy' | 'idle' | 'stopped';

export interface AgentFact {
  name: string;
  mode: AgentMode;
  /** The repository or worktree the agent works in. */
  cwd: string;
  /** The clock reading of its last activity, or null for one that ended. */
  lastActivityAt: number | null;
  stopped?: boolean;
}

export interface WorktreeFact {
  path: string;
  branch: string;
  /** The branch is merged into its base. */
  merged: boolean;
  /** Uncommitted changes remain. */
  dirty: boolean;
  /** The agent working in it, when one is. */
  agent?: string;
}

export interface StatusReportInput {
  agents: AgentFact[];
  worktrees: WorktreeFact[];
  claims: Claim[];
  canaries: Canary[];
  /** Activity older than this reads as idle. */
  idleAfterMs?: number;
}

export interface AgentStatus {
  name: string;
  mode: AgentMode;
  state: AgentState;
  cwd: string;
  /** Elapsed since last activity, in ms, measured at `asOf`; null for a stopped agent. */
  sinceActivityMs: number | null;
  claims: Claim[];
  canary: 'acknowledged' | 'pending' | 'needs-review' | 'none';
}

export interface StatusReport {
  /** The clock reading every age here was measured against. */
  asOf: number;
  agents: AgentStatus[];
  /** Worktrees that are unmerged or uncleaned: the closest thing to a resource registry before claims. */
  leftBehind: WorktreeFact[];
  needsReview: Array<{ sessionId: string; tool: string; at: number }>;
}

export const DEFAULT_IDLE_AFTER_MS = 5 * 60 * 1000;

export function buildStatusReport(input: StatusReportInput, now: number): StatusReport {
  const idleAfter = input.idleAfterMs ?? DEFAULT_IDLE_AFTER_MS;
  const claimsByAgent = new Map<string, Claim[]>();
  for (const c of input.claims) claimsByAgent.set(c.agent, [...(claimsByAgent.get(c.agent) ?? []), c]);
  const canaryByAgent = new Map(input.canaries.map((c) => [c.sessionId, c]));
  const agents = input.agents.map((a): AgentStatus => {
    const since = a.lastActivityAt === null ? null : Math.max(0, now - a.lastActivityAt);
    const state: AgentState = a.stopped || since === null ? 'stopped' : since >= idleAfter ? 'idle' : 'busy';
    const canary = canaryByAgent.get(a.name);
    return {
      name: a.name,
      mode: a.mode,
      state,
      cwd: a.cwd,
      sinceActivityMs: since,
      claims: claimsByAgent.get(a.name) ?? [],
      canary: !canary ? 'none' : canary.violation ? 'needs-review' : canary.acknowledgedAt !== undefined ? 'acknowledged' : 'pending',
    };
  });
  return {
    asOf: now,
    agents,
    leftBehind: input.worktrees.filter((w) => !w.merged || w.dirty),
    needsReview: input.canaries.filter((c) => c.violation).map((c) => ({ sessionId: c.sessionId, tool: c.violation!.tool, at: c.violation!.at })),
  };
}
