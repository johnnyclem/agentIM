/**
 * One Claude Code session as cIM addresses it (spec §3.1), and one turn of
 * its transcript (§3.2). Immutable values; every derived fact is a function.
 */

import { basename } from 'node:path';

export type AgentKind = 'interactive' | 'background';
export type AgentStatus = 'idle' | 'busy';

export interface Agent {
  /** Primary key everywhere: names the transcript and survives stop/resume. */
  sessionID: string;
  /** Absent for a stopped session. */
  pid?: number;
  /** The short background job id; background only. */
  jobID?: string;
  name: string;
  cwd: string;
  kind: AgentKind;
  status?: AgentStatus;
  /** Epoch milliseconds. */
  startedAt: number;
  /** From the per-process descriptor; absent means not messageable. */
  inboxSocketPath?: string;
}

export const isMessageable = (a: Agent): boolean => typeof a.inboxSocketPath === 'string' && a.inboxSocketPath.length > 0;
/** A stopped background job, or a session cIM saw running before a reboot. */
export const isStopped = (a: Agent): boolean => a.pid === undefined;
/** Gates "Send as me": an idle, live background job with a job id. */
export const canTakeUserTurn = (a: Agent): boolean => a.kind === 'background' && !isStopped(a) && !!a.jobID && a.status === 'idle';
/** What /resume, `claude attach` and the job id share. */
export const shortID = (a: Agent): string => a.sessionID.slice(0, 8);
export const projectName = (a: Agent): string => basename(a.cwd) || a.cwd;
export const renamed = (a: Agent, name: string): Agent => ({ ...a, name });

export type Role = 'user' | 'assistant';

export interface Turn {
  id: string;
  role: Role;
  text: string;
  /** Epoch milliseconds. */
  timestamp: number;
  model?: string;
  /** The text was cut at MAX_TURN_CHARS and carries the marker. */
  clipped?: boolean;
}
