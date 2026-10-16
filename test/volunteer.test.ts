import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { VolunteerRound, VOLUNTEER_WINDOW_MS, type VolunteerRequest } from '../src/volunteer.js';

const T0 = Date.parse('2026-10-16T12:00:00.000Z');
const request = (over: Partial<VolunteerRequest> = {}): VolunteerRequest => ({
  id: 'req-1',
  title: 'Fix the flaky upload retry test',
  description: 'The long context, withheld until someone is picked.',
  roster: ['agent-1', 'agent-2', 'agent-3', 'agent-4'],
  createdAt: T0,
  windowMs: VOLUNTEER_WINDOW_MS,
  ...over,
});

describe('volunteer requests with deferred resolution (Item 4, D9)', () => {
  it('the window is a fixed 30 seconds', () => {
    expect(VOLUNTEER_WINDOW_MS).toBe(30_000);
  });

  it('two volunteers resolve deterministically: highest confidence wins, ties to the earliest', () => {
    const round = new VolunteerRound(request());
    round.reply({ agent: 'agent-1', volunteer: true, confidence: 0.6, context: 'wrote the retry helper this session' }, T0 + 2_000);
    round.reply({ agent: 'agent-2', volunteer: false, context: 'in the billing module, no overlap' }, T0 + 3_000);
    round.reply({ agent: 'agent-3', volunteer: true, confidence: 0.9, context: 'debugged this test earlier today' }, T0 + 4_000);
    expect(round.resolve(T0 + 10_000)).toMatchObject({ status: 'open', closesAt: T0 + 30_000, at: T0 + 10_000 });
    expect(round.resolve(T0 + 30_000)).toMatchObject({ status: 'picked', winner: 'agent-3', by: 'confidence' });
    // A tie goes to the earliest reply
    const tie = new VolunteerRound(request());
    tie.reply({ agent: 'agent-2', volunteer: true, confidence: 0.7 }, T0 + 5_000);
    tie.reply({ agent: 'agent-1', volunteer: true, confidence: 0.7 }, T0 + 6_000);
    expect(tie.resolve(T0 + 30_000)).toMatchObject({ status: 'picked', winner: 'agent-2' });
  });

  it('nobody volunteered is an answer: the silent are busy, the declined are named, and the request stays for the new-agent button', () => {
    const round = new VolunteerRound(request());
    round.reply({ agent: 'agent-2', volunteer: false, context: 'no overlap' }, T0 + 3_000);
    const r = round.resolve(T0 + 31_000);
    expect(r).toMatchObject({ status: 'nobody', declined: ['agent-2'], silent: ['agent-1', 'agent-3', 'agent-4'] });
    // A late yes lands but does not decide
    const late = round.reply({ agent: 'agent-4', volunteer: true, confidence: 1 }, T0 + 40_000);
    expect(late.late).toBe(true);
    expect(round.resolve(T0 + 41_000).status).toBe('nobody');
    expect(round.tally().map((x) => x.agent)).toEqual(['agent-2', 'agent-4']);
  });

  it('the person may pick anyone, any time, and the pick is final; the others are released only after the briefing lands', () => {
    const round = new VolunteerRound(request());
    round.reply({ agent: 'agent-3', volunteer: true, confidence: 0.9 }, T0 + 1_000);
    round.pickBy({ agent: 'agent-2' }, T0 + 5_000);
    expect(round.resolve(T0 + 5_000)).toMatchObject({ status: 'picked', winner: 'agent-2', by: 'person' });
    expect(() => round.pickBy({ agent: 'agent-3' }, T0 + 6_000)).toThrow(/already picked/);
    expect(round.released()).toBe(false);
    round.briefed(T0 + 7_000);
    expect(round.released()).toBe(true);
    expect(() => new VolunteerRound(request()).briefed(T0)).toThrow(/nobody is picked/);
    expect(() => round.reply({ agent: 'stranger', volunteer: true }, T0)).toThrow(/was not asked/);
  });

  it('property: resolution is deterministic in the replies, never changes once the window closed, and the winner is a volunteer who replied in time', () => {
    const reply = fc.record({ agent: fc.constantFrom('agent-1', 'agent-2', 'agent-3', 'agent-4'), volunteer: fc.boolean(), confidence: fc.double({ min: 0, max: 1, noNaN: true }), at: fc.integer({ min: 0, max: 60_000 }) });
    fc.assert(
      fc.property(fc.array(reply, { maxLength: 10 }), fc.integer({ min: 30_000, max: 120_000 }), (replies, later) => {
        const build = () => {
          const round = new VolunteerRound(request());
          for (const r of [...replies].sort((a, b) => a.at - b.at)) round.reply({ agent: r.agent, volunteer: r.volunteer, confidence: r.confidence }, T0 + r.at);
          return round;
        };
        const a = build().resolve(T0 + 30_000);
        const b = build().resolve(T0 + later);
        expect({ ...a, at: 0 }).toEqual({ ...b, at: 0 });
        if (a.status === 'picked') {
          const winner = a.candidates.find((c) => c.agent === a.winner)!;
          expect(winner.volunteer && !winner.late).toBe(true);
          for (const c of a.candidates.filter((c) => c.volunteer && !c.late)) expect(c.confidence).toBeLessThanOrEqual(winner.confidence);
        }
      }),
      { numRuns: 200 }
    );
  });
});
