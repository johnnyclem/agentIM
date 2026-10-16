/**
 * The canary (markspace review, Item 5).
 *
 * The harness writes a fresh canary id into each agent's system prompt per
 * session. The agent's first tool call must acknowledge it; until then every
 * other tool call is refused. An agent that acts without acknowledging is
 * stopped and shows in the status report as needing review. The
 * acknowledgment is recorded by the harness, never by the agent, and the
 * canary never appears in any ledger line: this module has no ledger.
 *
 * It catches total takeover — an agent whose instructions were overridden by
 * injected content — and nothing subtler. The close-out rule checks behavior
 * at the end of a session; this checks it at the start, and it is cheap.
 */

import { randomBytes } from 'node:crypto';

export const ACK_TOOL = 'cim_ack';

export interface Canary {
  sessionId: string;
  id: string;
  issuedAt: number;
  acknowledgedAt?: number;
  /** The first unacknowledged call, when the agent acted before acknowledging. */
  violation?: { tool: string; at: number };
}

export type GateVerdict =
  | { allow: true; acknowledged: true }
  | { allow: false; reason: 'no-canary' | 'unacknowledged' | 'wrong-canary' | 'stopped'; needsReview: boolean };

/** The line the harness writes into the system prompt. The id is the only thing the agent has to echo. */
export function canaryPromptLine(canary: Canary): string {
  return `Session canary: ${canary.id}. Your first tool call in this session must be ${ACK_TOOL} with this exact id; every other tool call is refused until then.`;
}

export class CanaryGate {
  private canaries = new Map<string, Canary>();

  constructor(private readonly mint: () => string = () => randomBytes(12).toString('base64url')) {}

  /** Issue a fresh canary for a session at `now`. A second issue for the same session replaces the first (a new session, a new canary). */
  issue(sessionId: string, now: number): Canary {
    const canary: Canary = { sessionId, id: this.mint(), issuedAt: now };
    this.canaries.set(sessionId, canary);
    return canary;
  }

  get(sessionId: string): Canary | null {
    return this.canaries.get(sessionId) ?? null;
  }

  /**
   * Gate one tool call. The acknowledgment tool with the right id is the only
   * call allowed before acknowledgment; anything else records the violation
   * and stops the session: every later call is refused too, acknowledgment
   * included, until a person reviews it.
   */
  gate(sessionId: string, call: { tool: string; args?: Record<string, unknown> }, now: number): GateVerdict {
    const canary = this.canaries.get(sessionId);
    if (!canary) return { allow: false, reason: 'no-canary', needsReview: false };
    if (canary.violation) return { allow: false, reason: 'stopped', needsReview: true };
    if (canary.acknowledgedAt !== undefined) return { allow: true, acknowledged: true };
    if (call.tool === ACK_TOOL) {
      if (call.args?.canary === canary.id) {
        canary.acknowledgedAt = now;
        return { allow: true, acknowledged: true };
      }
      canary.violation = { tool: call.tool, at: now };
      return { allow: false, reason: 'wrong-canary', needsReview: true };
    }
    canary.violation = { tool: call.tool, at: now };
    return { allow: false, reason: 'unacknowledged', needsReview: true };
  }

  /** A person reviewed the session: clear the stop. The session still has to acknowledge before it acts. */
  clear(sessionId: string): void {
    const canary = this.canaries.get(sessionId);
    if (canary) delete canary.violation;
  }

  /** Sessions that acted without acknowledging, for the status report. */
  needingReview(): Canary[] {
    return [...this.canaries.values()].filter((c) => c.violation !== undefined);
  }
}
