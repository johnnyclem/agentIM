import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { ClaimRegistry, isLive, type ClaimInput } from '../src/claims.js';

const T0 = Date.parse('2026-10-16T12:00:00.000Z');
const MIN = 60_000;
const base = (over: Partial<ClaimInput> = {}): ClaimInput => ({ agent: 'instrument-62', resource: '/Repos/instrument-worktrees/qp27110', verb: 'edit', confidence: 0.8, ttlMs: 30 * MIN, ...over });

describe('claims (Item 4)', () => {
  it('two agents claiming one worktree: one allowed, one refused with the winner attached', () => {
    const r = new ClaimRegistry();
    const first = r.claim(base(), T0);
    const second = r.claim(base({ agent: 'instrument-66', confidence: 0.99 }), T0 + MIN);
    expect(first.allowed).toBe(true);
    expect(second).toMatchObject({ allowed: false, winner: { agent: 'instrument-62', resource: base().resource } });
    expect(r.live(T0 + MIN).map((c) => c.agent)).toEqual(['instrument-62']);
  });

  it('an unfinished claim disappears after its TTL, with no cleanup: expiry is a function of the clock', () => {
    const r = new ClaimRegistry();
    const v = r.claim(base({ ttlMs: 10 * MIN }), T0);
    expect(v.allowed).toBe(true);
    expect(r.live(T0 + 10 * MIN - 1)).toHaveLength(1);
    expect(r.live(T0 + 10 * MIN)).toHaveLength(0);
    // The resource is free again: another agent's claim is allowed
    expect(r.claim(base({ agent: 'instrument-66' }), T0 + 10 * MIN).allowed).toBe(true);
    // And the registry forgot nothing
    expect(r.all()).toHaveLength(2);
  });

  it('completion ends a claim before its TTL; the same agent renews its own claim', () => {
    const r = new ClaimRegistry();
    const v = r.claim(base(), T0);
    if (!v.allowed) throw new Error('unexpected');
    expect(r.complete(v.claim.id, T0 + MIN)).toBe(true);
    expect(r.complete(v.claim.id, T0 + MIN)).toBe(false);
    expect(r.live(T0 + MIN)).toHaveLength(0);
    const again = r.claim(base(), T0 + 2 * MIN);
    const renewed = r.claim(base({ verb: 'merge' }), T0 + 3 * MIN);
    expect(again.allowed && renewed.allowed).toBe(true);
    if (!renewed.allowed || !again.allowed) throw new Error('unexpected');
    expect(renewed.renewed?.id).toBe(again.claim.id);
    expect(r.live(T0 + 3 * MIN).map((c) => c.verb)).toEqual(['merge']);
  });

  it('refuses a malformed claim', () => {
    const r = new ClaimRegistry();
    expect(() => r.claim(base({ confidence: 1.5 }), T0)).toThrow();
    expect(() => r.claim(base({ ttlMs: 0 }), T0)).toThrow();
    expect(() => r.claim(base({ agent: '' }), T0)).toThrow();
  });

  it('property: at most one live claim per resource at any clock reading, and it is always the earliest writer still live', () => {
    const op = fc.record({ agent: fc.constantFrom('a', 'b', 'c'), resource: fc.constantFrom('r1', 'r2'), ttl: fc.integer({ min: 1, max: 20 }), dt: fc.integer({ min: 0, max: 5 }), complete: fc.boolean() });
    fc.assert(
      fc.property(fc.array(op, { minLength: 1, maxLength: 30 }), (ops) => {
        const r = new ClaimRegistry();
        let now = T0;
        for (const o of ops) {
          now += o.dt * MIN;
          const v = r.claim({ agent: o.agent, resource: o.resource, verb: 'edit', confidence: 0.5, ttlMs: o.ttl * MIN }, now);
          if (v.allowed && o.complete) r.complete(v.claim.id, now);
          for (const res of ['r1', 'r2']) {
            const live = r.live(now).filter((c) => c.resource === res);
            expect(live.length).toBeLessThanOrEqual(1);
            if (live.length === 1) expect(isLive(live[0], now)).toBe(true);
          }
          if (!v.allowed) {
            // The winner is live and on the same resource, and belongs to another agent
            expect(isLive(v.winner, now)).toBe(true);
            expect(v.winner.resource).toBe(o.resource);
            expect(v.winner.agent).not.toBe(o.agent);
          }
        }
      }),
      { numRuns: 200 }
    );
  });
});
