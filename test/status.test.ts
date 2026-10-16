import { describe, it, expect } from 'vitest';
import { buildStatusReport } from '../src/status.js';
import { ClaimRegistry } from '../src/claims.js';

const T0 = Date.parse('2026-10-16T12:00:00.000Z');
const MIN = 60_000;

describe('the status report', () => {
  it('lists live claims per agent, busy/idle/stopped against the clock it states, and the worktrees left behind', () => {
    const claims = new ClaimRegistry();
    claims.claim({ agent: 'instrument-62', resource: '/wt/qp27110', verb: 'edit', confidence: 0.8, ttlMs: 30 * MIN }, T0);
    claims.claim({ agent: 'instrument-66', resource: 'QP-26185', verb: 'review', confidence: 0.5, ttlMs: 5 * MIN }, T0);
    const now = T0 + 10 * MIN;
    const report = buildStatusReport(
      {
        agents: [
          { name: 'instrument-62', mode: 'interactive', cwd: '/Repos/instrument', lastActivityAt: now - 42_000 },
          { name: 'instrument-66', mode: 'interactive', cwd: '/Repos/instrument', lastActivityAt: now - 60 * MIN },
          { name: 'MR !1267 merge conflicts', mode: 'background', cwd: '/Repos/instrument', lastActivityAt: null, stopped: true },
        ],
        worktrees: [
          { path: '/wt/qp27110', branch: 'qp27110-swift-split', merged: false, dirty: true, agent: 'instrument-62' },
          { path: '/wt/old', branch: 'done', merged: true, dirty: false },
          { path: '/wt/leftover', branch: 'fix-ci', merged: true, dirty: true },
        ],
        claims: claims.live(now),
        canaries: [],
      },
      now
    );
    expect(report.asOf).toBe(now);
    expect(report.agents.map((a) => [a.name, a.state, a.claims.length, a.canary])).toEqual([
      ['instrument-62', 'busy', 1, 'none'],
      ['instrument-66', 'idle', 0, 'none'],
      ['MR !1267 merge conflicts', 'stopped', 0, 'none'],
    ]);
    expect(report.agents[0].sinceActivityMs).toBe(42_000);
    // The 5-minute claim expired before the report was built
    expect(report.leftBehind.map((w) => w.path)).toEqual(['/wt/qp27110', '/wt/leftover']);
  });
});
