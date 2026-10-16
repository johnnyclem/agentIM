import { describe, it, expect } from 'vitest';
import { VolunteerRequest, parseVolunteerReply, ANSWER_WINDOW_MS } from '../src/volunteer.js';
import { volunteerAsk, volunteerRelease } from '../src/prompts.js';
import type { Agent } from '../src/agent.js';

const T0 = Date.parse('2026-10-16T12:00:00.000Z');
const agent = (id: string, over: Partial<Agent> = {}): Agent => ({ sessionID: id, pid: 1, name: `agent-${id}`, cwd: `/r/${id}`, kind: 'interactive', status: 'idle', startedAt: T0, inboxSocketPath: `/tmp/${id}`, ...over });
const yes = (ctx: string) => `Sure.\n\`\`\`cim-volunteer\nvolunteer: yes\ncontext: ${ctx}\n\`\`\``;
const no = `\`\`\`cim-volunteer\nvolunteer: no\ncontext: mid-merge\n\`\`\``;

function harness() {
  let now = T0;
  const files = new Map<string, string[]>();
  const sent: Array<{ to: string; text: string }> = [];
  const failing = new Set<string>();
  const spawned: Array<{ name: string; cwd: string; prompt: string; model?: string }> = [];
  const deps = {
    clock: () => now,
    sleep: (ms: number) =>
      new Promise<void>((r) => {
        now += ms;
        setImmediate(r);
      }),
    sendInbox: async (a: Agent, text: string) => {
      if (failing.has(a.sessionID)) throw new Error(`refused by ${a.sessionID}`);
      sent.push({ to: a.sessionID, text });
    },
    transcriptSize: async (a: Agent) => (files.get(a.sessionID) ?? []).length,
    readSince: async (a: Agent, offset: number) => {
      const texts = files.get(a.sessionID) ?? [];
      return { texts: texts.slice(offset), endOffset: texts.length };
    },
    spawn: async (input: { name: string; model?: string; cwd: string; prompt: string }) => {
      spawned.push(input);
      return { jobID: 'f00d' };
    },
    pollMs: 2_000,
    listenMs: 60_000,
  };
  const reply = (sid: string, text: string) => files.set(sid, [...(files.get(sid) ?? []), text]);
  return { deps, reply, sent, failing, spawned, now: () => now };
}

describe('the volunteer reply parser', () => {
  it('reads yes/no in several spellings, ignores the echoed template, and rejects prose', () => {
    expect(parseVolunteerReply(yes('I wrote that module'))).toEqual({ volunteer: true, context: 'I wrote that module' });
    expect(parseVolunteerReply('```cim-volunteer\nVolunteer: Y\ncontext: x\n```')).toEqual({ volunteer: true, context: 'x' });
    expect(parseVolunteerReply('```cim-volunteer\nvolunteer: FALSE.\n```')).toEqual({ volunteer: false, context: '' });
    expect(parseVolunteerReply(volunteerAsk('Johnny', 'review MR !1364'))).toBeNull();
    expect(parseVolunteerReply('yes I can take it')).toBeNull();
    expect(parseVolunteerReply('```cim-volunteer\nvolunteer: maybe\n```')).toBeNull();
  });
});

describe('a volunteer request', () => {
  it('asks only the messageable, reads only replies written after the ask, marks silence busy or offline at 30 s, and lets a late answer land', async () => {
    const h = harness();
    const [a, b, c, d] = [agent('A'), agent('B', { status: 'busy' }), agent('C'), agent('D', { inboxSocketPath: undefined })];
    h.reply('A', yes('stale: before the ask'));
    const r = new VolunteerRequest('Johnny', 'review MR !1364', 'SECRET details', [a, b, c, d], h.deps);
    await r.start();
    expect(r.phase).toBe('collecting');
    expect([...r.reached].sort()).toEqual(['A', 'B', 'C']);
    expect(h.sent).toHaveLength(3);
    expect(h.sent.every((s) => s.text === volunteerAsk('Johnny', 'review MR !1364') && !s.text.includes('SECRET'))).toBe(true);
    expect(r.summary()).toBe('Waiting on 3 of 3, up to 30s…');
    await r.pollOnce();
    expect(r.answers.size).toBe(0); // the stale reply before the ask does not count
    h.reply('A', no);
    h.reply('A', yes('changed my mind')); // the latest wins
    h.reply('C', no);
    await r.pollOnce();
    expect(r.volunteers.map((v) => v.sessionID)).toEqual(['A']);
    expect(r.answers.get('A')).toMatchObject({ volunteer: true, context: 'changed my mind', late: false });
    expect(r.declined.map((v) => v.sessionID)).toEqual(['C']);
    // The window closes: B is silent and busy
    await new Promise((res) => setImmediate(res));
    r.closeAnswerWindow();
    expect(r.silent.get('B')).toBe('busy');
    expect(r.summary()).toBe('1 didn’t answer within 30s. A late answer still counts.');
    h.reply('B', yes('late but here'));
    await r.pollOnce();
    expect(r.silent.has('B')).toBe(false);
    expect(r.answers.get('B')?.late).toBe(true);
    expect(r.everyoneAnswered).toBe(true);
    expect(r.summary()).toBe('Everyone answered.');
    r.close();
    await r.settle();
    expect(h.now() - T0).toBeGreaterThanOrEqual(ANSWER_WINDOW_MS);
  });

  it('an offline silent agent, a briefing that fails releases nobody, a briefing that lands releases every other reached recipient', async () => {
    const h = harness();
    const [a, b] = [agent('A'), agent('B')];
    const r = new VolunteerRequest('Johnny', 'docs sweep', 'write them', [a, b], h.deps);
    await r.start();
    r.closeAnswerWindow();
    expect(r.silent.get('A')).toBe('offline');
    h.sent.length = 0;
    h.failing.add('A');
    expect(await r.assign(a)).toBe(false);
    expect(r.phase).toBe('collecting');
    expect(r.errorMessage).toMatch(/briefing didn.t reach agent-A/);
    expect(h.sent).toEqual([]);
    h.failing.delete('A');
    expect(await r.assign(a)).toBe(true);
    expect(r.phase).toBe('assigned');
    expect(r.assignee).toMatchObject({ sessionID: 'A', name: 'agent-A', spawned: false });
    expect(h.sent.map((s) => s.to)).toEqual(['A', 'B']);
    expect(h.sent[0].text).toContain('write them');
    expect(h.sent[1].text).toBe(volunteerRelease('docs sweep', 'agent-A'));
    expect(r.isListening).toBe(false);
    expect(await r.assign(b)).toBe(false); // already assigned
    expect(r.matchesAssignee(a)).toBe(true);
    expect(r.matchesAssignee(b)).toBe(false);
    r.close();
    await r.settle();
  });

  it('nobody reached: failed, still assignable; spawning starts a background agent with the briefing and matches it by job id', async () => {
    const h = harness();
    const dead = agent('Z', { inboxSocketPath: undefined });
    const r = new VolunteerRequest('Johnny', 'flaky test', 'fix it', [dead], h.deps);
    await r.start();
    expect(r.phase).toBe('failed');
    expect(r.summary()).toMatch(/didn.t reach any agent/);
    expect(await r.spawn({ name: 'flaky test fixer', cwd: '/Repos/x', model: 'claude-sonnet-5-5' })).toBe(true);
    expect(h.spawned[0]).toMatchObject({ name: 'flaky test fixer', cwd: '/Repos/x', model: 'claude-sonnet-5-5' });
    expect(h.spawned[0].prompt).toContain('fix it');
    expect(r.assignee).toMatchObject({ jobID: 'f00d', spawned: true });
    expect(r.summary()).toBe('Started flaky test fixer on claude-sonnet-5-5.');
    expect(r.matchesAssignee(agent('f00d1234-abcd'))).toBe(true);
    expect(r.matchesAssignee(agent('other', { jobID: 'f00d' }))).toBe(true);
    expect(r.matchesAssignee(agent('nope'))).toBe(false);
    await r.settle();
  });

  it('listening stops at the deadline and can be started again', async () => {
    const h = harness();
    const r = new VolunteerRequest('J', 't', 'd', [agent('A')], { ...h.deps, listenMs: 10_000 });
    await r.start();
    expect(r.isListening).toBe(true);
    await r.settle();
    expect(r.isListening).toBe(false);
    expect(r.phase).toBe('collecting');
    r.listenAgain();
    expect(r.isListening).toBe(true);
    r.close();
    await r.settle();
  });
});
