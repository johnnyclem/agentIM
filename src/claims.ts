/**
 * Claims — "I plan to do X to resource R" (markspace review, Item 4; decision D8).
 *
 * A claim is ephemeral and is not truth. It lives in the harness, never in
 * stenographer: a stale claim in a signed hash chain is noise with a
 * signature on it. The harness writes claims on an agent's behalf when it
 * starts work; the agent never writes one as free text, and the agent's
 * identity comes from the harness (Item 1 applied here).
 *
 * Rules:
 * - A claim is live from `createdAt` until `createdAt + ttlMs`, unless the
 *   harness records completion first. Expiry is a function of the clock:
 *   there is no cleanup logic and no timer.
 * - First writer wins. A second agent claiming a live resource is refused,
 *   and the verdict carries the winning claim so the agent can pick another
 *   resource.
 * - The same agent claiming its own live resource again renews it: the old
 *   claim is retired (`supersededBy`) and the new one is live from now.
 * - Resources are opaque strings. First cut: worktree paths and task ids
 *   (D8); module paths wait for a file-to-module mapping.
 */

export interface ClaimInput {
  /** The agent, as the harness knows it: never caller-supplied. */
  agent: string;
  /** An opaque resource key: a worktree path or a task id in the first cut. */
  resource: string;
  /** What the agent plans to do: `edit`, `review`, `merge`, … opaque to the registry. */
  verb: string;
  /** The agent's declared confidence in [0, 1]. */
  confidence: number;
  /** Time to live in milliseconds. */
  ttlMs: number;
}

export interface Claim extends ClaimInput {
  id: string;
  /** The clock reading the claim was written at. */
  createdAt: number;
  /** Set when the harness recorded completion. */
  completedAt?: number;
  /** Set when the same agent renewed the claim: the id of the claim that replaced it. */
  supersededBy?: string;
}

export type Verdict =
  | { allowed: true; claim: Claim; renewed?: Claim }
  | { allowed: false; refused: Claim; winner: Claim };

export const DEFAULT_CLAIM_TTL_MS = 30 * 60 * 1000;

/** Whether a claim is live at `now`: neither completed, nor renewed, nor past its TTL. */
export function isLive(claim: Claim, now: number): boolean {
  return claim.completedAt === undefined && claim.supersededBy === undefined && now < claim.createdAt + claim.ttlMs;
}

export class ClaimRegistry {
  private claims = new Map<string, Claim>();
  private seq = 0;

  constructor(private readonly ids: () => string = () => `claim-${++this.seq}`) {}

  /** The live claim on `resource` at `now`, if any. */
  holder(resource: string, now: number): Claim | null {
    for (const c of this.claims.values()) if (c.resource === resource && isLive(c, now)) return c;
    return null;
  }

  /**
   * Write a claim at `now`. First writer wins: a live claim by another agent
   * refuses this one and is attached as the winner. The same agent renews.
   */
  claim(input: ClaimInput, now: number): Verdict {
    if (!input.agent || !input.resource || !input.verb) throw new Error('a claim names an agent, a resource and a verb');
    if (!(input.confidence >= 0 && input.confidence <= 1)) throw new Error('confidence is in [0, 1]');
    if (!(Number.isFinite(input.ttlMs) && input.ttlMs > 0)) throw new Error('ttlMs is a positive number of milliseconds');
    const held = this.holder(input.resource, now);
    const claim: Claim = { ...input, id: this.ids(), createdAt: now };
    if (held && held.agent !== input.agent) return { allowed: false, refused: claim, winner: held };
    this.claims.set(claim.id, claim);
    if (held) {
      held.supersededBy = claim.id;
      return { allowed: true, claim, renewed: held };
    }
    return { allowed: true, claim };
  }

  /** The harness records completion: the claim ends now, whatever its TTL. False when the id is unknown or already ended. */
  complete(claimId: string, now: number): boolean {
    const c = this.claims.get(claimId);
    if (!c || !isLive(c, now)) return false;
    c.completedAt = now;
    return true;
  }

  /** Every claim live at `now`, oldest first. */
  live(now: number): Claim[] {
    return [...this.claims.values()].filter((c) => isLive(c, now)).sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
  }

  /** Live claims grouped by agent, for the status report. */
  byAgent(now: number): Map<string, Claim[]> {
    const out = new Map<string, Claim[]>();
    for (const c of this.live(now)) out.set(c.agent, [...(out.get(c.agent) ?? []), c]);
    return out;
  }

  /** Every claim ever written, for inspection; the registry itself forgets nothing. */
  all(): Claim[] {
    return [...this.claims.values()];
  }
}
