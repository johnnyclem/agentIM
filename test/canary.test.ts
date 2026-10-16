import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { ACK_TOOL, CanaryGate, canaryPromptLine } from '../src/canary.js';
import { buildStatusReport } from '../src/status.js';

const T0 = Date.parse('2026-10-16T12:00:00.000Z');

describe('the canary (Item 5)', () => {
  it('an agent that acknowledges proceeds normally', () => {
    const gate = new CanaryGate(() => 'c-123');
    const canary = gate.issue('instrument-62', T0);
    expect(canaryPromptLine(canary)).toContain('c-123');
    expect(gate.gate('instrument-62', { tool: ACK_TOOL, args: { canary: 'c-123' } }, T0 + 1)).toEqual({ allow: true, acknowledged: true });
    expect(gate.gate('instrument-62', { tool: 'Bash', args: { command: 'ls' } }, T0 + 2)).toEqual({ allow: true, acknowledged: true });
    expect(gate.needingReview()).toEqual([]);
  });

  it('an agent that skips the acknowledgment gets zero tool calls and appears in the status report as needing review', () => {
    const gate = new CanaryGate(() => 'c-123');
    gate.issue('instrument-66', T0);
    expect(gate.gate('instrument-66', { tool: 'Bash', args: { command: 'rm -rf /' } }, T0 + 1)).toMatchObject({ allow: false, reason: 'unacknowledged', needsReview: true });
    // Stopped: a late acknowledgment does not reopen it
    expect(gate.gate('instrument-66', { tool: ACK_TOOL, args: { canary: 'c-123' } }, T0 + 2)).toMatchObject({ allow: false, reason: 'stopped' });
    const report = buildStatusReport({ agents: [{ name: 'instrument-66', mode: 'interactive', cwd: '/Repos/instrument', lastActivityAt: T0 + 1 }], worktrees: [], claims: [], canaries: gate.needingReview() }, T0 + 3);
    expect(report.needsReview).toEqual([{ sessionId: 'instrument-66', tool: 'Bash', at: T0 + 1 }]);
    expect(report.agents[0].canary).toBe('needs-review');
    // A person clears it; the session still has to acknowledge before it acts
    gate.clear('instrument-66');
    expect(gate.gate('instrument-66', { tool: 'Read' }, T0 + 4)).toMatchObject({ allow: false, reason: 'unacknowledged' });
  });

  it('a wrong or missing canary id is a violation, and a session with no canary gets nothing', () => {
    const gate = new CanaryGate(() => 'c-123');
    gate.issue('s', T0);
    expect(gate.gate('s', { tool: ACK_TOOL, args: { canary: 'c-999' } }, T0 + 1)).toMatchObject({ allow: false, reason: 'wrong-canary', needsReview: true });
    expect(gate.gate('unknown', { tool: ACK_TOOL, args: { canary: 'c-123' } }, T0 + 1)).toMatchObject({ allow: false, reason: 'no-canary' });
  });

  it('property: no sequence of calls gets a tool through before the acknowledgment, and each session gets a fresh id', () => {
    const call = fc.record({ tool: fc.constantFrom('Bash', 'Read', 'Edit', ACK_TOOL), guess: fc.constantFrom('right', 'wrong') });
    fc.assert(
      fc.property(fc.array(call, { minLength: 1, maxLength: 12 }), (calls) => {
        let n = 0;
        const gate = new CanaryGate(() => `id-${++n}`);
        const a = gate.issue('s1', T0);
        const b = gate.issue('s2', T0);
        expect(a.id).not.toBe(b.id);
        let acknowledged = false;
        calls.forEach((c, i) => {
          const v = gate.gate('s1', { tool: c.tool, args: { canary: c.guess === 'right' ? a.id : 'nope' } }, T0 + i);
          if (!acknowledged) {
            if (c.tool === ACK_TOOL && c.guess === 'right' && gate.needingReview().length === 0) acknowledged = v.allow;
            else expect(v.allow).toBe(false);
          } else expect(v.allow).toBe(true);
        });
      }),
      { numRuns: 200 }
    );
  });
});
