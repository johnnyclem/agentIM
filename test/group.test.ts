import { describe, it, expect } from 'vitest';
import { GroupConversation, GroupStore, groupKey, GROUP_MAX_RETAINED_TURNS } from '../src/group.js';
import { computeReviewEntries, nextUnreviewed, repairSelection, reviewHeader, needsHuman } from '../src/review.js';
import { STATUS_CHECK, TBUV_RESOLUTION_GROUP, TBUV_RESOLUTION_SOLO, HUMAN_TAG, RELAY_PREAMBLE } from '../src/prompts.js';
import { rollup } from '../src/status-report.js';
import type { Agent, Turn } from '../src/agent.js';
import type { TranscriptRead } from '../src/transcript.js';

const T0 = Date.parse('2026-10-16T12:00:00.000Z');

function harness() {
  let now = T0;
  const files = new Map<string, Turn[]>();
  const sent: Array<{ to: string; text: string }> = [];
  const failing = new Set<string>();
  let stall: ((v: void) => void) | null = null;
  const deps = {
    clock: () => now,
    sleep: (ms: number) =>
      new Promise<void>((r) => {
        now += ms;
        setImmediate(r);
      }),
    transcriptPath: (a: Agent) => a.sessionID,
    readTail: async (path: string): Promise<TranscriptRead> => {
      const turns = files.get(path) ?? [];
      return { turns: turns.slice(-40), endOffset: turns.length, latestModel: null };
    },
    readSince: async (path: string, offset: number): Promise<TranscriptRead> => {
      const turns = files.get(path) ?? [];
      return { turns: turns.slice(offset), endOffset: turns.length, latestModel: null };
    },
    sendInbox: async (a: Agent, text: string) => {
      if (a.sessionID === 'STALL') await new Promise<void>((r) => (stall = r));
      if (failing.has(a.sessionID)) throw new Error(`refused by ${a.sessionID}`);
      sent.push({ to: a.sessionID, text });
    },
  };
  const append = (sid: string, role: 'user' | 'assistant', text: string) => {
    const list = files.get(sid) ?? [];
    list.push({ id: `${sid}-${list.length}`, role, text, timestamp: (now += 1) });
    files.set(sid, list);
  };
  const agent = (id: string, over: Partial<Agent> = {}): Agent => ({ sessionID: id, pid: 1, name: `agent-${id}`, cwd: `/r/${id}`, kind: 'interactive', status: 'idle', startedAt: T0, inboxSocketPath: `/tmp/${id}.sock`, ...over });
  return { deps, append, agent, sent, failing, release: () => stall?.(), now: () => now };
}

const framed = (text: string) => `Another Claude session sent a message... ${text}`;
const statusBlock = (status: string, extra = '') => `\`\`\`cim-status\nscope: MR 1\nstatus: ${status}\n${extra}\`\`\``;

describe('a group thread', () => {
  it('keys by sorted ids, fans out concurrently with a per-agent preamble, dedupes the human’s copies and waits on everyone', async () => {
    const h = harness();
    const [a, b] = [h.agent('A'), h.agent('B')];
    expect(groupKey(['B', 'A'])).toBe('A+B');
    const g = new GroupConversation([b, a], h.deps);
    expect(g.key).toBe('A+B');
    g.draft = 'hello all';
    const ok = await g.send();
    expect(ok).toBe(true);
    expect(g.draft).toBe('');
    expect(h.sent.map((s) => s.to).sort()).toEqual(['A', 'B']);
    expect(h.sent[0].text).toBe(`${RELAY_PREAMBLE}\n\n${HUMAN_TAG}\n\nhello all`);
    expect(g.awaitingSessionIDs).toEqual(new Set(['A', 'B']));
    expect(g.turns.map((t) => t.agentName)).toEqual(['You']);
    h.append('A', 'user', framed('hello all'));
    h.append('B', 'user', framed('hello all'));
    h.append('A', 'assistant', 'A here');
    await g.pollOnce();
    expect(g.awaitingSessionIDs).toEqual(new Set(['B']));
    expect(g.isAwaitingReply).toBe(true);
    h.append('B', 'assistant', 'B here');
    h.append('B', 'user', 'typed in B’s terminal');
    await g.settle();
    expect(g.isAwaitingReply).toBe(false);
    expect(g.turns.map((t) => [t.agentName, t.turn.text])).toEqual([
      ['You', 'hello all'],
      ['agent-A', 'A here'],
      ['agent-B', 'B here'],
      ['agent-B', 'typed in B’s terminal'],
    ]);
    // The second send carries no preamble for either
    g.draft = 'again';
    await g.send();
    expect(h.sent.slice(2).every((s) => s.text === `${HUMAN_TAG}\n\nagain`)).toBe(true);
    await g.settle();
  });

  it('a partial failure reports who was missed and waits only on the delivered; a total failure restores the draft', async () => {
    const h = harness();
    const [a, b] = [h.agent('A'), h.agent('B')];
    const g = new GroupConversation([a, b], h.deps);
    h.failing.add('B');
    g.draft = 'partial';
    expect(await g.send()).toBe(true);
    expect(g.errorMessage).toBe('Didn’t reach everyone. agent-B: refused by B');
    expect(g.awaitingSessionIDs).toEqual(new Set(['A']));
    h.failing.add('A');
    g.draft = 'total';
    expect(await g.send()).toBe(false);
    expect(g.draft).toBe('total');
    expect(g.turns.filter((t) => t.turn.text === 'total')).toEqual([]);
    expect(g.errorMessage).toMatch(/agent-A: refused by A; agent-B: refused by B/);
    g.cancelAll();
  });

  it('a draft with no messageable target survives, and a stuck peer does not delay the others', async () => {
    const h = harness();
    const dead = h.agent('D', { inboxSocketPath: undefined });
    const g = new GroupConversation([dead, h.agent('E', { inboxSocketPath: undefined })], h.deps);
    g.draft = 'anyone';
    expect(g.canSend).toBe(false);
    expect(await g.send()).toBe(false);
    expect(g.draft).toBe('anyone');
    const g2 = new GroupConversation([h.agent('STALL'), h.agent('F')], h.deps);
    g2.draft = 'go';
    const p = g2.send();
    await new Promise((r) => setImmediate(r));
    expect(h.sent.map((s) => s.to)).toEqual(['F']); // F delivered while STALL hangs
    h.release();
    expect(await p).toBe(true);
    g2.cancelAll();
  });

  it('a one-agent send mid-wait unions the waiting set, and subsets are recorded on the bubble', async () => {
    const h = harness();
    const [a, b] = [h.agent('A'), h.agent('B')];
    const g = new GroupConversation([a, b], h.deps);
    await g.sendStatusCheck();
    expect(h.sent.every((s) => s.text.endsWith(STATUS_CHECK))).toBe(true);
    expect(h.sent[0].text.includes(HUMAN_TAG)).toBe(false);
    h.append('A', 'assistant', statusBlock('working'));
    await g.pollOnce();
    expect(g.awaitingSessionIDs).toEqual(new Set(['B']));
    await g.sendInstruction('carry on', a);
    expect(g.awaitingSessionIDs).toEqual(new Set(['A', 'B']));
    expect(g.turns.at(-1)).toMatchObject({ agentName: 'You', recipients: ['A'] });
    await g.sendTBUVResolution([a]);
    expect(h.sent.at(-1)!.text).toContain(TBUV_RESOLUTION_SOLO);
    await g.sendTBUVResolution([a, b]);
    expect(h.sent.at(-1)!.text).toContain(TBUV_RESOLUTION_GROUP);
    g.reviewDrafts.set('B', 'just you');
    await g.sendReviewReply(b);
    expect(g.reviewDrafts.has('B')).toBe(false);
    expect(h.sent.at(-1)).toEqual({ to: 'B', text: `${HUMAN_TAG}\n\njust you` });
    g.cancelAll();
  });

  it('reports the latest status per participant and rolls it up, keeps 120 turns, and never drops a member who exited', async () => {
    const h = harness();
    const [a, b] = [h.agent('A'), h.agent('B')];
    for (let i = 0; i < 90; i++) h.append('A', 'assistant', `a${i}`);
    for (let i = 0; i < 90; i++) h.append('B', 'assistant', `b${i}`);
    h.append('A', 'assistant', statusBlock('blocked'));
    h.append('A', 'assistant', 'chatter after the report');
    h.append('B', 'assistant', statusBlock('done', 'wiki_journaled: true\n'));
    const g = new GroupConversation([a, b], h.deps);
    await g.loadIfNeeded();
    expect(g.turns.length).toBe(80); // 40 per tail
    const latest = g.latestReports();
    expect(latest.get('A')?.status).toBe('blocked');
    expect(latest.get('B')?.status).toBe('done');
    expect(rollup([...latest.values()])).toEqual([
      { status: 'blocked', count: 1 },
      { status: 'done', count: 1 },
    ]);
    g.draft = 'x';
    await g.send();
    for (let i = 0; i < 100; i++) h.append('A', 'assistant', `more ${i}`);
    await g.pollOnce();
    expect(g.turns.length).toBeLessThanOrEqual(GROUP_MAX_RETAINED_TURNS);
    g.refreshParticipants([{ ...a, status: 'busy' }]); // B missing from the roster
    expect(g.participants.map((p) => [p.sessionID, p.status])).toEqual([
      ['A', 'busy'],
      ['B', 'idle'],
    ]);
    g.cancelAll();
  });
});

describe('the group store', () => {
  it('returns one thread per set regardless of order, keeps creation order, and never drops a group on refresh', () => {
    const h = harness();
    const store = new GroupStore(h.deps);
    const [a, b, c] = [h.agent('A'), h.agent('B'), h.agent('C')];
    const g1 = store.group([a, b]);
    const g2 = store.group([b, c]);
    expect(store.group([b, a])).toBe(g1);
    expect(store.all().map((g) => g.key)).toEqual(['A+B', 'B+C']);
    store.refreshMembership([a]);
    expect(store.all()).toHaveLength(2);
    store.drop('A+B');
    expect(store.all()).toEqual([g2]);
    expect(store.existing('A+B')).toBeNull();
  });
});

describe('review mode', () => {
  const gt = (sessionID: string, role: 'user' | 'assistant', text: string, i: number, recipients?: string[]) => ({ sessionID, agentName: sessionID || 'You', turn: { id: `${sessionID}:${i}`, role, text, timestamp: T0 + i }, ...(recipients ? { recipients } : {}) });
  const p = (id: string): Agent => ({ sessionID: id, name: id, cwd: `/r/${id}`, kind: 'interactive', startedAt: T0 });

  it('finds the last ask per participant, classifies replied / awaiting / no reply, and ranks needs-human first', () => {
    const turns = [
      gt('A', 'assistant', 'old chatter', 0),
      gt('', 'user', STATUS_CHECK, 1),
      gt('A', 'assistant', statusBlock('waiting_for_human'), 2),
      gt('B', 'assistant', 'prose instead of a block', 3),
      gt('C', 'assistant', statusBlock('done'), 4),
      gt('', 'user', 'only for A', 5, ['A']),
      gt('A', 'assistant', 'ack', 6),
    ];
    const entries = computeReviewEntries([p('A'), p('B'), p('C'), p('D'), p('E')], turns, new Set(['D']), new Map([['C', 'C:4']]));
    expect(entries.map((e) => [e.sessionID, e.state, e.rank, e.isReviewed])).toEqual([
      ['A', 'replied', 0, false],
      ['B', 'replied', 3, false],
      ['C', 'replied', 7, true],
      ['D', 'awaiting', 90, false],
      ['E', 'noReply', 100, false],
    ]);
    expect(entries[0].report?.status).toBe('waiting_for_human');
    expect(entries[0].latestReplyID).toBe('A:6');
    expect(entries[0].since.map((t) => t.turn.id)).toEqual(['A:2', 'A:5'.replace('A:5', ':5'), 'A:6']);
    expect(needsHuman(entries[0])).toBe(true);
    expect(needsHuman(entries[1])).toBe(false);
    expect(reviewHeader(entries)).toEqual({ replied: 3, total: 5, reviewed: 1 });
    expect(nextUnreviewed(entries, 'A')).toBe('B');
    expect(nextUnreviewed(entries, 'B')).toBe('A'); // wraps once past C (reviewed), D, E
    expect(repairSelection(entries, 'Z')).toBe('A');
    expect(repairSelection(entries, 'C')).toBe('C');
    expect(nextUnreviewed([entries[2]], 'C')).toBeNull();
  });

  it('when the ask scrolled out, "since" starts at the newest status report; a newer reply un-reviews the entry', () => {
    const turns = [gt('A', 'assistant', statusBlock('working'), 0), gt('A', 'assistant', 'then this', 1)];
    const [e] = computeReviewEntries([p('A')], turns, new Set(), new Map([['A', 'A:0']]));
    expect(e.state).toBe('replied');
    expect(e.since.map((t) => t.turn.id)).toEqual(['A:0', 'A:1']);
    expect(e.report?.status).toBe('working');
    expect(e.latestReplyID).toBe('A:1');
    expect(e.isReviewed).toBe(false);
    const [none] = computeReviewEntries([p('A')], [gt('A', 'assistant', 'just prose', 0)], new Set(), new Map());
    expect(none.state).toBe('noReply');
    expect(none.since).toEqual([]);
  });
});
