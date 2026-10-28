import { describe, it, expect, afterEach } from 'vitest';
import { KEYS } from '../src/store.js';
import type { Runner } from '../src/runner.js';
import { BILLING, DAY, HOUR, MONDAY, NOW, SHOP, idIn, jsonl, kindOf, refLine, shopApp, voteBlock, world, type World } from './standup-world.js';

const UV_36 = 'uv:shop-app:UV-0036';
const UV_21 = 'uv:shop-app:UV-0021';

const worlds: World[] = [];
/** A world that is stopped when the test ends, so no poller outlives it. */
function make(opts: Parameters<typeof world>[0] = {}): World {
  const w = world(opts);
  worlds.push(w);
  return w;
}
afterEach(async () => {
  for (const w of worlds.splice(0)) {
    w.hub.stop();
    await w.settle();
  }
});

const ticks = async (n = 5) => {
  for (let i = 0; i < n; i++) await new Promise<void>((r) => setImmediate(r));
};

const emfile = () => Object.assign(new Error('spawn git EMFILE'), { code: 'EMFILE' });

const statusReport = (status: string, scope: string) => `\`\`\`cim-status\nscope: ${scope}\nstatus: ${status}\n\`\`\``;
const chip = (s: { sources: Array<{ id: string }> }, id: string) => s.sources.find((c) => c.id === id);

describe('the standup through the hub', () => {
  it('builds the window, the chips, the lanes and the join from the repos and sessions it finds', async () => {
    const w = make({ settings: { ticketPrefixes: ['QP'] } });
    shopApp(w);
    const a = w.agent('A', { name: 'shop-62' });
    const b = w.agent('B', { name: 'notes', cwd: '/work/notes', status: 'busy' });
    const c = w.stopped('C', { name: 'yesterday', cwd: '/work/notes' });
    const d = w.stopped('D', { name: 'last week', cwd: '/work/notes' });
    w.onBranch.set(SHOP, 'SHOP-123-queue');
    w.append(a, 'assistant', 'Working on it.', MONDAY + 9 * HOUR);
    w.append(a, 'assistant', statusReport('waiting_for_human', 'MR 1'), MONDAY + 17 * HOUR);
    w.append(c, 'assistant', 'Done for the day.', MONDAY + 11 * HOUR);
    w.append(d, 'assistant', 'Done for the week.', MONDAY - 3 * DAY);
    await w.ready(a, b, c, d);

    const standup = await w.hub.buildStandup();

    expect(standup).toMatchObject({ at: NOW, covering: '2026-10-26', through: '2026-10-26', run: '2026-10-27', windowStart: MONDAY, windowEnd: new Date(2026, 9, 27).getTime() });
    // chips are raw counts per source: 3 branches in the window (the remote copy and the local branch are one), 4 ledger rows read (2 of them closed), 3 sessions (the stopped one from last week is not one)
    expect(standup.sources.map((s) => [s.id, s.count, s.note])).toEqual([
      ['git', 3, undefined],
      ['ledger', 4, undefined],
      ['sessions', 3, undefined],
    ]);
    // lanes count the board after the join: the two SHOP-123 branches are one item
    expect(standup.lanes).toEqual({ triage: 2, agents: 3, lightning: 2 });
    const triage = standup.board.filter((i) => i.lane === 'triage');
    expect(triage.map((i) => [i.id, i.title, i.detail, i.refs, i.tint, i.sessionIDs])).toEqual([
      ['branch:shop-app:SHOP-123', 'SHOP-123-backoff', '+1 more', ['SHOP-123'], 'red', ['A']], // A is on SHOP-123-queue and says it waits for a human
      ['branch:shop-app:QP-27153', 'qp27153-export-fix', 'Fix the export', ['QP-27153'], 'blue', undefined], // the prefix from the settings makes qp27153 a key
    ]);
    const agents = standup.board.filter((i) => i.lane === 'agents');
    expect(agents.map((i) => [i.title, i.state, i.tint, i.repo])).toEqual([
      ['shop-62', 'waiting_for_human', 'red', 'shop-app'],
      ['notes', 'working', 'blue', 'notes'],
      ['yesterday', 'stopped', 'grey', 'notes'],
    ]);
    expect(agents[0]).toMatchObject({ detail: 'MR 1', at: MONDAY + 17 * HOUR });
    expect(standup.board.filter((i) => i.lane === 'lightning').map((i) => i.rowKey)).toEqual([UV_36, UV_21]); // opened inside the window first

    // the hub keeps it, selects it and tells the listeners
    expect(w.hub.standup).toBe(standup);
    expect(w.hub.selection).toEqual({ kind: 'standup' });
    expect(w.events).toContainEqual({ type: 'standup' });
    expect(w.events).toContainEqual({ type: 'selection', selection: { kind: 'standup' } });
    expect(w.hub.snapshot().standup).toEqual({ at: NOW, covering: '2026-10-26', through: '2026-10-26', run: '2026-10-27', lanes: { triage: 2, agents: 3, lightning: 2 } });
    expect(w.hub.snapshot().selection).toEqual({ kind: 'standup' });
    expect(JSON.stringify(w.hub.snapshot())).toContain('"ledgerRef":"wiki"');
  });

  it('covers an explicit day, and a bad date throws the engine’s message and changes nothing', async () => {
    const w = make();
    shopApp(w);
    await w.ready(w.agent('A'));
    const day = await w.hub.buildStandup('2026-10-24');
    expect(day).toMatchObject({ covering: '2026-10-24', through: '2026-10-24', run: '2026-10-27' });
    expect(day.lanes.triage).toBe(0); // no branch has a commit on that Saturday
    w.hub.setSelection(null);
    for (const bad of ['2026-02-30', 'yesterday', '']) await expect(w.hub.buildStandup(bad)).rejects.toThrow(/^covering must be/);
    expect(w.hub.standup).toBe(day);
    expect(w.hub.selection).toBeNull();
  });

  it('reads the ledger from the ref in the settings, and never counts that branch as work', async () => {
    const w = make({ settings: { ledgerRef: 'notes' } });
    w.repos.set(SHOP, {
      refs: [refLine('notes', MONDAY + 9 * HOUR, 'Journal'), refLine('SHOP-9-x', MONDAY + 10 * HOUR, 'Work')],
      ledger: { 'notes:unverified.jsonl': jsonl({ id: 'UV-0001', date: '2026-10-26', claim: 'a claim' }), 'wiki:unverified.jsonl': jsonl({ id: 'UV-0002', claim: 'on the wrong ref' }) },
    });
    await w.ready(w.agent('A'));
    const standup = await w.hub.buildStandup();
    expect(standup.board.filter((i) => i.lane === 'lightning').map((i) => i.rowKey)).toEqual(['uv:shop-app:UV-0001']);
    expect(standup.board.filter((i) => i.lane === 'triage').map((i) => i.title)).toEqual(['SHOP-9-x']);
    expect(w.runs).toContainEqual(['git', '-C', SHOP, 'show', 'notes:unverified.jsonl']);
    expect(w.runs.some((r) => r.includes('wiki:unverified.jsonl'))).toBe(false);
  });

  it('a repo with no ledger ref says so on the chip instead of showing a zero', async () => {
    const w = make();
    w.repos.set(SHOP, { refs: [refLine('SHOP-9-x', MONDAY + 10 * HOUR, 'Work')] }); // no wiki branch
    await w.ready(w.agent('A'));
    const standup = await w.hub.buildStandup();
    expect(chip(standup, 'ledger')).toEqual({ id: 'ledger', label: 'Ledger', count: 0, note: 'no ledger' });
    expect(chip(standup, 'git')).toMatchObject({ count: 1 }); // the other sources are untouched
    expect(standup.lanes.lightning).toBe(0);
  });

  it('without any repository the chips say no repository, and the standup is still built', async () => {
    const w = make();
    shopApp(w);
    await w.ready(w.agent('X', { cwd: '/elsewhere' })); // not a repo, and no repoPath in the settings
    const standup = await w.hub.buildStandup();
    expect(chip(standup, 'git')).toMatchObject({ count: 0, note: 'no repository' });
    expect(chip(standup, 'ledger')).toMatchObject({ count: 0, note: 'no repository' });
    expect(chip(standup, 'sessions')).toMatchObject({ count: 1 });
    expect(standup.lanes).toEqual({ triage: 0, agents: 1, lightning: 0 });
  });

  it('a session whose transcript cannot be read is a note on the chip, and the standup is still built', async () => {
    const w = make();
    shopApp(w);
    const [a, b] = [w.agent('A'), w.agent('B')];
    w.append(b, 'assistant', statusReport('working', 'MR 2'));
    w.breakTranscript(a);
    await w.ready(a, b);
    const standup = await w.hub.buildStandup();
    expect(chip(standup, 'sessions')).toEqual({ id: 'sessions', label: 'Sessions', count: 2, note: 'activity unavailable for 1 of 2 sessions' });
    expect(standup.board.filter((i) => i.lane === 'agents').map((i) => [i.title, i.state])).toEqual([
      ['agent-B', 'working'], // the newest activity first; A's unreadable transcript is no activity, so it falls back to its start time
      ['agent-A', 'idle'],
    ]);
  });

  it('asks which repo a directory is in once per distinct directory, with the repo path as a directory of its own', async () => {
    const w = make({ settings: { repoPath: SHOP } });
    shopApp(w);
    await w.ready(w.agent('A'), w.agent('B'), w.agent('C', { cwd: '/elsewhere' }));
    await w.hub.buildStandup();
    const asked = w.runs.filter((r) => r[3] === 'rev-parse' && r[4] === '--git-common-dir').map((r) => r[2]);
    // SHOP is the repo path and the cwd of two agents: one question. The standup's own per-session lookups only concern directories no repo holds.
    expect(asked.filter((d) => d === SHOP)).toEqual([SHOP]);
    expect(asked.filter((d) => d === '/elsewhere').length).toBeGreaterThanOrEqual(1);
  });
});

describe('the ledger queue', () => {
  it('lists the open rows nobody has settled, oldest first until a standup puts the window’s first', async () => {
    const w = make({ settings: { repoPath: SHOP } });
    shopApp(w);
    await w.ready();
    expect((await w.hub.openRows()).map((r) => r.id)).toEqual(['UV-0021', 'UV-0036']); // closed rows (a status, a superseder) are not in the queue; no standup yet: oldest first
    await w.hub.buildStandup();
    expect((await w.hub.openRows()).map((r) => r.id)).toEqual(['UV-0036', 'UV-0021']); // the standup's window, 2026-10-26
    expect((await w.hub.openRows({ start: new Date(2026, 9, 20).getTime(), end: new Date(2026, 9, 21).getTime() })).map((r) => r.id)).toEqual(['UV-0021', 'UV-0036']);
  });

  it('reads every repo’s ledger, the repos of the agents as well as the one in the settings', async () => {
    const w = make({ settings: { repoPath: SHOP } });
    shopApp(w);
    w.repos.set(BILLING, { ledger: { 'wiki:unverified.jsonl': jsonl({ id: 'UV-0100', date: '2026-10-25', claim: 'Invoices are idempotent' }) } });
    await w.ready(w.agent('B', { cwd: BILLING }));
    expect((await w.hub.openRows()).map((r) => r.key)).toEqual([UV_21, 'uv:billing:UV-0100', UV_36]);
  });
});

describe('the Lightning Round through the hub', () => {
  it('before any round the view is an inactive empty one, and every action says there is no round', async () => {
    const w = make();
    expect(w.hub.lightningView()).toEqual({ active: false, current: null, panelSize: 4, items: [], counts: { total: 0, remaining: 0, decided: 0, deferred: 0 }, log: [] });
    expect(w.hub.snapshot().lightning).toBeNull();
    expect(w.hub.snapshot().standup).toBeNull();
    expect(() => w.hub.lightningSelect(UV_36)).toThrow(/^No lightning round/);
    expect(() => w.hub.lightningReject(UV_36)).toThrow(/^No lightning round/);
    expect(() => w.hub.lightningDefer(UV_36)).toThrow(/^No lightning round/);
    await expect(w.hub.lightningApprove(UV_36, 'A')).rejects.toThrow(/^No lightning round/);
    await expect(w.hub.lightningSkeptics(UV_36)).rejects.toThrow(/^No lightning round/);
    w.hub.lightningAbort(); // nothing to abort is not an error
  });

  it('runs a whole round: ask, a presented card with a grounded and an ungrounded cite, one relayed decision, and the row stays out of the next queue and standup', async () => {
    const w = make();
    shopApp(w);
    const a = w.agent('A');
    w.answerAsks(a);
    await w.ready(a);
    await w.hub.buildStandup();

    const started = await w.hub.lightningStart();
    expect(started).toMatchObject({ active: true, current: UV_36, panelSize: 4 });
    expect(started.items.map((i) => i.id)).toEqual(['UV-0036', 'UV-0021']);
    await w.settle();
    expect(w.sent.map((s) => [s.to, kindOf(s.text), idIn(s.text)])).toEqual([
      ['A', 'ask', 'UV-0036'],
      ['A', 'ask', 'UV-0021'], // the next card is prepared while the first is read
    ]);

    const view = w.hub.lightningView();
    const card = view.items[0];
    expect(card).toMatchObject({ key: UV_36, title: 'UV-0036 Offline uploads reuse the session id minted online', summary: 'shop-app. Doubt: the retry path may mint a fresh id', phase: 'presented' });
    expect(card.presentation).toMatchObject({ source: 'agent', presentedBy: 'agent-A', needs: 'human', nature: 'decision', checkable: 'now', title: 'agent-A on UV-0036' });
    expect(card.presentation!.evidence.map((e) => [e.n, e.raw, e.grounding.status])).toEqual([
      [1, 'src/session.ts:5@75c7b13 "reuse the session id"', 'grounded'],
      [2, 'journal/2026-10-14.md:17', 'ungrounded'], // not in the code repo
    ]);
    expect(card.presentation!.evidence[0].grounding.sha).toBe('75c7b13');
    expect(card.presentation!.options.map((o) => [o.letter, o.verb, o.grounding])).toEqual([
      ['A', 'challenge', 'grounded'],
      ['B', 'deny', 'ungrounded'],
      ['C', 'no_change', 'ungrounded'],
    ]);
    expect(w.hub.snapshot().lightning).toEqual({ active: true, remaining: 2, current: UV_36 });
    expect(w.events).toContainEqual({ type: 'lightning' });

    const before = w.sent.length;
    const result = await w.hub.lightningApprove(UV_36, 'A');
    expect(result).toMatchObject({ delivered: true, decided: true });
    expect(result.view.items[0]).toMatchObject({ phase: 'decided', decision: { option: 'A', verb: 'challenge', delivered: true } });
    expect(result.view.current).toBe(UV_21);
    const relayed = w.sent.slice(before);
    expect(relayed).toHaveLength(1); // exactly one message, to the agent that presented it
    expect(relayed[0].to).toBe('A');
    expect(relayed[0].text).toContain('[cIM Lightning Round]');
    expect(relayed[0].text).toContain('UV-0036');
    expect(w.hub.snapshot().lightning).toEqual({ active: true, remaining: 1, current: UV_21 });

    // settled: the next queue and the next standup leave it out
    expect(w.hub.decisions.hidden(UV_36)).toBe(true);
    expect((await w.hub.openRows()).map((r) => r.id)).toEqual(['UV-0021']);
    const next = await w.hub.buildStandup();
    expect(next.lanes.lightning).toBe(1);
    expect(chip(next, 'ledger')).toMatchObject({ count: 4 }); // the chip counts every row read, decided or not; the lane is what is left to settle
    expect(next.board.filter((i) => i.lane === 'lightning').map((i) => i.rowKey)).toEqual([UV_21]);
  });

  it('narrows the round to the keys and the repo asked for, and a new start stops the old round', async () => {
    const w = make({ settings: { repoPath: SHOP } });
    shopApp(w);
    w.repos.set(BILLING, { ledger: { 'wiki:unverified.jsonl': jsonl({ id: 'UV-0100', date: '2026-10-25', claim: 'Invoices are idempotent' }) } });
    await w.ready(w.agent('A'), w.agent('B', { cwd: BILLING }));
    const first = await w.hub.lightningStart({ repo: 'billing' });
    expect(first.items.map((i) => i.key)).toEqual(['uv:billing:UV-0100']);
    const oldRound = w.hub.lightning!;
    const second = await w.hub.lightningStart({ keys: [UV_21, 'uv:billing:UV-0100', 'uv:nowhere:UV-1'], panelSize: 2 });
    expect(second.items.map((i) => i.key)).toEqual([UV_21, 'uv:billing:UV-0100']);
    expect(second.panelSize).toBe(2);
    expect(oldRound.view().active).toBe(false);
    expect(w.hub.lightning).not.toBe(oldRound);
    expect((await w.hub.lightningStart({ keys: [UV_36], repo: 'billing' })).items).toEqual([]); // the filters narrow together
  });

  it('an empty queue is a round with nothing in it, not an error', async () => {
    const w = make();
    await w.ready(w.agent('X', { cwd: '/elsewhere' }));
    const view = await w.hub.lightningStart();
    expect(view).toMatchObject({ active: true, current: null, items: [], counts: { total: 0, remaining: 0, decided: 0, deferred: 0 } });
    expect(w.hub.snapshot().lightning).toEqual({ active: true, remaining: 0, current: null });
  });

  it('knows an agent that works in a linked worktree outside the repo folder, and asks nobody who is in no repo', async () => {
    const w = make();
    shopApp(w);
    w.linked.set('/work/wt/shop-hotfix', SHOP);
    const [a, outsider] = [w.agent('A', { cwd: '/work/wt/shop-hotfix' }), w.agent('X', { cwd: '/elsewhere' })];
    w.answerAsks(a, outsider);
    await w.ready(a, outsider);
    await w.hub.lightningStart({ keys: [UV_36] });
    await w.settle();
    expect(w.sent.map((s) => [s.to, kindOf(s.text)])).toEqual([['A', 'ask']]);
    expect(w.hub.lightningView().items[0]).toMatchObject({ phase: 'presented' });
    // the cites are grounded in the checkout the agent works in
    expect(w.runs.some((r) => r[2] === '/work/wt/shop-hotfix' && r[3] === 'cat-file')).toBe(true);
  });

  it('with nobody to ask the card shows the ledger row and says why; approving it cannot be delivered and the row stays', async () => {
    const w = make({ settings: { repoPath: SHOP } });
    shopApp(w);
    await w.ready(); // no agents
    await w.hub.lightningStart({ keys: [UV_36] });
    await w.settle();
    const view = w.hub.lightningView();
    expect(view.items[0]).toMatchObject({ phase: 'fallback', presentation: { source: 'ledger' } });
    expect(view.log).toEqual([`No presentation for ${UV_36}: No agent in shop-app can be messaged. Showing the ledger row.`]);
    const result = await w.hub.lightningApprove(UV_36, 'A');
    expect(result).toMatchObject({ delivered: false, decided: false });
    expect(result.view.log.at(-1)).toBe('Nobody in shop-app can be messaged: copy the decision by hand.');
    expect(w.sent).toEqual([]);
    expect(w.hub.decisions.hidden(UV_36)).toBe(false);
    expect((await w.hub.openRows()).map((r) => r.id)).toContain('UV-0036');
  });

  it('a decision the agent’s inbox refuses is not recorded: the row stays, the log says who refused, and a retry goes through', async () => {
    const w = make();
    shopApp(w);
    const a = w.agent('A');
    w.answerAsks(a);
    await w.ready(a);
    await w.hub.lightningStart({ keys: [UV_36] });
    await w.settle();
    w.failing.add('A');
    const refused = await w.hub.lightningApprove(UV_36, 'A');
    expect(refused).toMatchObject({ delivered: false, decided: false });
    expect(refused.view.log.at(-1)).toBe('agent-A did not take the decision: refused by agent-A');
    expect(refused.view.items[0].phase).toBe('presented');
    expect(w.hub.decisions.hidden(UV_36)).toBe(false);
    w.failing.delete('A');
    await expect(w.hub.lightningApprove(UV_36, 'A')).resolves.toMatchObject({ delivered: true, decided: true });
    expect(w.hub.decisions.hidden(UV_36)).toBe(true);
  });

  it('No change is decided and sends nothing', async () => {
    const w = make();
    shopApp(w);
    const a = w.agent('A');
    w.answerAsks(a);
    await w.ready(a);
    await w.hub.lightningStart({ keys: [UV_36] });
    await w.settle();
    const before = w.sent.length;
    const result = await w.hub.lightningApprove(UV_36, 'C');
    expect(result).toMatchObject({ delivered: false, decided: true });
    expect(w.sent).toHaveLength(before);
    const stored = w.hub.kv.get<Record<string, { state: string; option: string; verb: string; at: number; until: number }>>(KEYS.lightning)![UV_36];
    expect(stored).toMatchObject({ state: 'decided', option: 'C', verb: 'no_change' });
    expect(stored.until - stored.at).toBe(7 * DAY);
    expect((await w.hub.openRows()).map((r) => r.id)).toEqual(['UV-0021']);
    await expect(w.hub.lightningApprove(UV_36, 'B')).resolves.toMatchObject({ delivered: false }); // a second approve of a decided card is a no-op
  });

  it('Reject sends nothing and the next presenter is asked; Defer hides the row until the next local midnight', async () => {
    const w = make();
    shopApp(w);
    const [a, b] = [w.agent('A'), w.agent('B')];
    w.answerAsks(a, b);
    await w.ready(a, b);
    await w.hub.lightningStart({ keys: [UV_36] });
    await w.settle();
    expect(w.hub.lightningView().items[0].presentation).toMatchObject({ presentedBy: 'agent-A' });
    const before = w.sent.length;

    const rejected = w.hub.lightningReject(UV_36);
    expect(rejected.items[0].phase).toBe('presenting'); // asked again, at once, of someone else
    await w.settle();
    expect(w.sent.slice(before).map((s) => [s.to, kindOf(s.text)])).toEqual([['B', 'ask']]); // nothing was sent to A, and B was asked, not told
    expect(w.hub.lightningView().items[0]).toMatchObject({ phase: 'presented', presentation: { presentedBy: 'agent-B' } });
    expect(w.hub.decisions.hidden(UV_36)).toBe(false);

    const deferred = w.hub.lightningDefer(UV_36);
    expect(deferred.items[0].phase).toBe('deferred');
    expect(deferred.counts).toMatchObject({ deferred: 1, remaining: 0 });
    const stored = w.hub.kv.get<Record<string, { state: string; until: number }>>(KEYS.lightning)![UV_36];
    expect(stored).toMatchObject({ state: 'deferred', until: new Date(2026, 9, 28).getTime() });
    expect((await w.hub.openRows()).map((r) => r.id)).toEqual(['UV-0021']);
    w.set(new Date(2026, 9, 28).getTime()); // midnight
    expect(w.hub.decisions.hidden(UV_36)).toBe(false);
    expect((await w.hub.openRows()).map((r) => r.id)).toContain('UV-0036');
  });

  it('Select moves the card; an unknown key is the engine’s "No lightning item"', async () => {
    const w = make();
    shopApp(w);
    const a = w.agent('A');
    w.answerAsks(a);
    await w.ready(a);
    await w.hub.lightningStart();
    await w.settle();
    expect(w.hub.lightningSelect(UV_21).current).toBe(UV_21);
    expect(() => w.hub.lightningSelect('uv:shop-app:UV-9999')).toThrow('No lightning item uv:shop-app:UV-9999.');
    expect(() => w.hub.lightningReject('uv:shop-app:UV-9999')).toThrow(/^No lightning item/);
    expect(() => w.hub.lightningDefer('uv:shop-app:UV-9999')).toThrow(/^No lightning item/);
    await expect(w.hub.lightningApprove('uv:shop-app:UV-9999', 'A')).rejects.toThrow(/^No lightning item/);
    await expect(w.hub.lightningSkeptics('uv:shop-app:UV-9999')).rejects.toThrow(/^No lightning item/);
    await expect(w.hub.lightningApprove(UV_36, 'D')).rejects.toThrow('Option D is not offered for uv:shop-app:UV-0036.');
  });

  it('Ask skeptics sends the vote ask to the other agents and returns the view with the panel seated', async () => {
    const w = make();
    shopApp(w);
    const [a, b, c] = [w.agent('A'), w.agent('B'), w.agent('C')];
    w.answerAsks(a);
    w.answers.set('B', (text) => (kindOf(text) === 'vote' ? voteBlock(idIn(text), 'concur') : undefined));
    await w.ready(a, b, c);
    await w.hub.lightningStart({ keys: [UV_36] });
    await w.settle();
    const view = await w.hub.lightningSkeptics(UV_36);
    expect(w.sent.filter((s) => kindOf(s.text) === 'vote').map((s) => s.to)).toEqual(['B', 'C']); // the presenter is not asked to vote on its own card
    expect(view.items[0].votes.asked).toBe(true);
    expect(view.items[0].votes.entries.map((e) => e.name)).toEqual(['agent-B', 'agent-C']);
    await w.settle();
    expect(w.hub.lightningView().items[0].votes.tally).toEqual({ concur: 1, concern: 0, refuted: 0, silent: 1, asked: 2 });
  });

  it('abort keeps the round readable, tells the listeners and stops the pollers', async () => {
    const w = make();
    shopApp(w);
    const a = w.agent('A');
    w.answerAsks(a);
    await w.ready(a);
    await w.hub.lightningStart({ keys: [UV_36] });
    await w.settle();
    const round = w.hub.lightning!;
    w.events.length = 0;
    w.hub.lightningAbort();
    expect(w.events).toContainEqual({ type: 'lightning' });
    expect(w.hub.lightning).toBe(round);
    expect(w.hub.lightningView()).toMatchObject({ active: false, items: [{ key: UV_36, phase: 'presented' }] });
    expect(w.hub.snapshot().lightning).toMatchObject({ active: false });
  });

  it('stop() ends the round and leaves no poller waiting on the clock', async () => {
    const w = make({ park: true, settings: { repoPath: SHOP } }); // every sleep parks for good: only an abort can release a poller
    shopApp(w);
    await w.ready(w.agent('A')); // silent: its ask would be polled for 90 s
    await w.hub.lightningStart();
    await ticks();
    expect(w.sleeps()).toBeGreaterThan(0);
    expect(w.hub.lightningView().active).toBe(true);
    w.hub.stop();
    await w.settle(); // would hang if a poller were still waiting for its sleep
    const after = { sleeps: w.sleeps(), sent: w.sent.length, now: w.now() };
    await ticks(30);
    expect({ sleeps: w.sleeps(), sent: w.sent.length, now: w.now() }).toEqual(after);
    expect(w.hub.lightningView().active).toBe(false);
  });
});

describe('the roster behind the standup', () => {
  it('a standup asked for before the roster was read waits for that read, instead of showing an empty morning', async () => {
    const w = make();
    shopApp(w);
    w.list(w.agent('A'), w.agent('B')); // listed, but the hub has not read the roster yet
    expect(w.hub.roster.hasLoaded).toBe(false);
    const standup = await w.hub.buildStandup();
    expect(w.hub.roster.hasLoaded).toBe(true);
    expect(standup.sources.map((s) => [s.id, s.count, s.note])).toEqual([
      ['git', 3, undefined], // the repo is found through the sessions' working directories
      ['ledger', 4, undefined],
      ['sessions', 2, undefined],
    ]);
  });

  it('and when the poller’s own first read is still running, it waits for that one', async () => {
    const w = make();
    shopApp(w);
    w.list(w.agent('A'));
    const release = w.holdRoster();
    w.hub.start(60_000);
    await ticks();
    expect(w.hub.roster).toMatchObject({ isRefreshing: true, hasLoaded: false });
    let built = false;
    const pending = w.hub.buildStandup().then((s) => ((built = true), s));
    await ticks(20);
    expect(built).toBe(false);
    release();
    const standup = await pending;
    expect(chip(standup, 'sessions')).toMatchObject({ count: 1 });
    expect(chip(standup, 'git')).toMatchObject({ count: 3 });
  });

  it('a roster that could not be read is a note on the Sessions chip, one line, ahead of the engine’s own note', async () => {
    const w = make();
    shopApp(w);
    w.failRoster('claude agents exited 1: boom\n    at somewhere\n' + 'x'.repeat(500));
    w.list(w.agent('A'));
    const none = await w.hub.buildStandup(); // never loaded, and the read fails
    expect(w.hub.roster).toMatchObject({ hasLoaded: false });
    const note = chip(none, 'sessions')!;
    expect(note).toMatchObject({ count: 0 });
    expect((note as { note: string }).note).toMatch(/^roster unavailable: claude agents exited 1: boom at somewhere xxx/);
    expect((note as { note: string }).note).not.toContain('\n');
    expect((note as { note: string }).note.length).toBeLessThanOrEqual('roster unavailable: '.length + 200);

    // a read that worked once and then fails keeps the sessions it knew; the chip says they may be out of date, and keeps what it already said
    w.failRoster(null);
    const [a, b] = [w.agent('A'), w.agent('B')];
    w.breakTranscript(a);
    await w.ready(a, b);
    expect(chip(await w.hub.buildStandup(), 'sessions')).toEqual({ id: 'sessions', label: 'Sessions', count: 2, note: 'activity unavailable for 1 of 2 sessions' });
    w.failRoster('gone');
    await w.hub.refresh();
    expect(w.hub.roster).toMatchObject({ hasLoaded: true, lastError: 'gone' });
    expect(chip(await w.hub.buildStandup(), 'sessions')).toEqual({ id: 'sessions', label: 'Sessions', count: 2, note: 'roster unavailable: gone; activity unavailable for 1 of 2 sessions' });
    w.failRoster(null);
    await w.hub.refresh();
    expect(chip(await w.hub.buildStandup(), 'sessions')).toMatchObject({ note: 'activity unavailable for 1 of 2 sessions' }); // a clean read clears it
  });
});

describe('git behind a limit', () => {
  it('never has more than eight git processes at once, so a machine with eight file descriptors to spare refuses none, in the standup or the round', async () => {
    let inflight = 0;
    let peak = 0;
    let refused = 0;
    const w = make({
      wrapRun: (inner) => async (cmd, args, opts) => {
        inflight++;
        peak = Math.max(peak, inflight);
        try {
          await new Promise<void>((r) => setImmediate(r)); // a process takes a moment to start
          if (inflight > 8) {
            refused++;
            throw emfile();
          }
          return await inner(cmd, args, opts);
        } finally {
          inflight--;
        }
      },
    });
    const agents = Array.from({ length: 30 }, (_, i) => {
      w.repos.set(`/work/r${i}`, {
        refs: [refLine(`R${i}-1-work`, MONDAY + 10 * HOUR, 'Work')],
        ledger: { 'wiki:unverified.jsonl': jsonl({ id: 'UV-0001', date: '2026-10-26', claim: `claim ${i}` }) },
        files: { 'src/session.ts': 'x\n' },
      });
      return w.agent(`S${i}`, { cwd: `/work/r${i}` });
    });
    w.answerAsks(...agents);
    await w.ready(...agents);

    const standup = await w.hub.buildStandup();
    expect(standup.sources.map((s) => [s.id, s.count, s.note])).toEqual([
      ['git', 30, undefined],
      ['ledger', 30, undefined],
      ['sessions', 30, undefined],
    ]);
    const round = await w.hub.lightningStart();
    expect(round.counts.total).toBe(30);
    await w.settle();
    expect(w.hub.lightningView().items.filter((i) => i.phase === 'presented').length).toBeGreaterThan(0); // the cites of the presented cards were grounded through the same limit
    expect(w.runs.some((r) => r[3] === 'cat-file')).toBe(true);
    expect(refused).toBe(0);
    expect(peak).toBeLessThanOrEqual(8);
    expect(peak).toBeGreaterThan(1); // the limit is a cap, not a queue of one
  });

  it('git failing on every call (no descriptors left, or no git) is notes in the standup and a line in the round’s log, with nothing thrown and nothing left unhandled', async () => {
    const stray: unknown[] = [];
    const onStray = (reason: unknown) => void stray.push(reason);
    process.on('unhandledRejection', onStray);
    try {
      const w = make({
        wrapRun: () => async () => {
          throw emfile();
        },
      });
      shopApp(w);
      const a = w.agent('A');
      await w.ready(a);
      const standup = await w.hub.buildStandup();
      expect(chip(standup, 'git')).toMatchObject({ count: 0, note: 'no repository' });
      expect(chip(standup, 'sessions')).toMatchObject({ count: 1 });
      const round = await w.hub.lightningStart();
      expect(round).toMatchObject({ active: true, items: [] });
      expect(round.log).toEqual(['No repository found: pass --repo or start an agent inside one.']);
      expect(await w.hub.tbuvLookup(['UV-0036'], SHOP)).toEqual([{ id: 'UV-0036', kind: 'not-found' }]);
      await ticks(20);
      expect(stray).toEqual([]);
    } finally {
      process.off('unhandledRejection', onStray);
    }
  });
});

describe('starting a round while another start or an abort happens', () => {
  /** A world whose git waits for `release()` while `held()` is true. */
  function slowGit() {
    let hold = false;
    let release = (): void => undefined;
    const gate = new Promise<void>((r) => (release = r));
    const w = make({
      settings: { repoPath: SHOP },
      wrapRun: (inner) => async (cmd, args, opts) => {
        if (hold) await gate;
        return inner(cmd, args, opts);
      },
    });
    shopApp(w);
    return { w, slow: (on: boolean) => void (hold = on), release: () => release() };
  }

  it('an abort while the start is still reading leaves no round, and asks nobody', async () => {
    const { w, slow, release } = slowGit();
    const a = w.agent('A');
    w.answerAsks(a);
    await w.ready(a);
    slow(true);
    const start = w.hub.lightningStart({ keys: [UV_36] });
    await ticks();
    w.hub.lightningAbort();
    slow(false);
    release();
    const view = await start;
    expect(view).toMatchObject({ active: false, items: [] });
    expect(w.hub.lightning).toBeNull();
    expect(w.hub.lightningView().active).toBe(false);
    await w.settle();
    expect(w.sent).toEqual([]);
    expect(w.hub.snapshot().lightning).toBeNull();
  });

  it('stopping the hub does the same: no round is started after shutdown', async () => {
    const { w, slow, release } = slowGit();
    const a = w.agent('A');
    w.answerAsks(a);
    await w.ready(a);
    slow(true);
    const start = w.hub.lightningStart({ keys: [UV_36] });
    await ticks();
    w.hub.stop();
    slow(false);
    release();
    await start;
    expect(w.hub.lightning).toBeNull();
    expect(w.sent).toEqual([]);
    await ticks(10);
    expect(w.sleeps()).toBe(0); // and no poller is running
  });

  it('a start that was asked for while an earlier one was still reading leaves the LATER one running, whichever finishes first', async () => {
    const { w, slow, release } = slowGit();
    const a = w.agent('A');
    w.answerAsks(a);
    await w.ready(a);
    slow(true);
    const first = w.hub.lightningStart({ keys: [UV_36] });
    await ticks();
    slow(false); // the second one reads quickly
    const second = await w.hub.lightningStart({ keys: [UV_21] });
    const later = w.hub.lightning!;
    expect(second.items.map((i) => i.key)).toEqual([UV_21]);
    release();
    const overtaken = await first;
    expect(w.hub.lightning).toBe(later);
    expect(later.view().active).toBe(true);
    expect(overtaken.items.map((i) => i.key)).toEqual([UV_21]); // an overtaken start answers with the round that is there
    await w.settle();
    expect(w.sent.map((s) => [kindOf(s.text), idIn(s.text)])).toEqual([['ask', 'UV-0021']]);
    expect(w.hub.lightningView()).toMatchObject({ active: true, current: UV_21 });
  });

  it('a start after an abort is a fresh start and works', async () => {
    const { w } = slowGit();
    const a = w.agent('A');
    w.answerAsks(a);
    await w.ready(a);
    w.hub.lightningAbort();
    expect(await w.hub.lightningStart({ keys: [UV_36] })).toMatchObject({ active: true, current: UV_36 });
  });
});

describe('why a round is empty', () => {
  /** The shop-app with an agent in it that answers, so the engine itself has nothing to log. */
  async function shop(opts: Parameters<typeof world>[0] = {}, ...more: Array<ReturnType<World['agent']>>): Promise<World> {
    const w = make({ settings: { repoPath: SHOP }, ...opts });
    shopApp(w);
    const a = w.agent('A');
    w.answerAsks(a);
    await w.ready(a, ...more);
    return w;
  }

  it('no repository at all: the log says to pass --repo or start an agent inside one', async () => {
    const w = make();
    await w.ready(w.agent('X', { cwd: '/elsewhere' }));
    const view = await w.hub.lightningStart();
    expect(view.log).toEqual(['No repository found: pass --repo or start an agent inside one.']);
    expect(w.events.filter((e) => e.type === 'lightning').length).toBeGreaterThan(0); // and the listeners were told
  });

  it('a repository whose ledger branch is not there: the log says so, and a healthy start says nothing', async () => {
    const w = make({ settings: { repoPath: SHOP } });
    w.repos.set(SHOP, { refs: [refLine('SHOP-9-x', MONDAY + 10 * HOUR, 'Work')] }); // no wiki branch
    await w.ready();
    expect((await w.hub.lightningStart()).log).toEqual(['No ledger could be read in 1 repo(s): no ledger branch.']);

    const healthy = await shop();
    const view = await healthy.hub.lightningStart();
    await healthy.settle();
    expect(view.items).toHaveLength(2);
    expect(healthy.hub.lightningView().log).toEqual([]);
  });

  it('a ledger file that was too large to read: the note names the file, whether the other file gave rows or not', async () => {
    const truncate = (when: (args: string[]) => boolean) => (inner: Runner): Runner => async (cmd, args, opts) => (when(args) ? { code: 1, stdout: '', stderr: '', truncated: true } : inner(cmd, args, opts));

    const one = await shop({ wrapRun: truncate((args) => args.includes('wiki:tombstones.jsonl')) });
    const partial = await one.hub.lightningStart();
    expect(partial.items.map((i) => i.id)).toEqual(['UV-0021', 'UV-0036']); // the unverified rows still make the round
    expect(partial.log).toEqual(['Part of the ledger could not be read in 1 repo(s): tombstones.jsonl is larger than 2 MiB.']);

    const all = await shop({ wrapRun: truncate((args) => args.includes('show')) });
    const none = await all.hub.lightningStart();
    expect(none.items).toEqual([]);
    expect(none.log).toEqual(['No ledger could be read in 1 repo(s): tombstones.jsonl is larger than 2 MiB; unverified.jsonl is larger than 2 MiB.']);
  });

  it('some repositories fail and others work: the failing ones are named and the working ones are in the round', async () => {
    const w = make({ settings: { repoPath: SHOP } });
    shopApp(w);
    w.repos.set(BILLING, { refs: [] }); // repos with no ledger branch
    w.repos.set('/work/notes', { refs: [] });
    const a = w.agent('A');
    w.answerAsks(a);
    await w.ready(a, w.agent('B', { cwd: BILLING }), w.agent('N', { cwd: '/work/notes' }));
    const view = await w.hub.lightningStart();
    expect(view.items.map((i) => i.key)).toEqual([UV_21, UV_36]);
    expect(view.log).toEqual(['No ledger could be read in 2 repo(s): billing: no ledger branch; notes: no ledger branch.']);
  });

  it('a repo name that matches no repository is said so, with the names that do', async () => {
    const w = await shop();
    const view = await w.hub.lightningStart({ repo: SHOP }); // a path, where the folder name is wanted
    expect(view).toMatchObject({ active: true, items: [] });
    expect(view.log).toEqual([`No repository named ${SHOP}; the repositories are shop-app.`]);
    const right = await w.hub.lightningStart({ repo: 'shop-app' });
    await w.settle();
    expect(right.items).toHaveLength(2);
    expect(w.hub.lightningView().log).toEqual([]);
  });

  it('the lines come first in the round’s log, ahead of the engine’s own', async () => {
    const w = make({ settings: { repoPath: SHOP }, wrapRun: (inner) => async (cmd, args, opts) => (args.includes('wiki:tombstones.jsonl') ? { code: 1, stdout: '', stderr: '', truncated: true } : inner(cmd, args, opts)) });
    shopApp(w);
    await w.ready(); // nobody to ask: the engine logs a line of its own per card
    await w.hub.lightningStart({ keys: [UV_36] });
    await w.settle();
    expect(w.hub.lightningView().log).toEqual([
      'Part of the ledger could not be read in 1 repo(s): tombstones.jsonl is larger than 2 MiB.',
      `No presentation for ${UV_36}: No agent in shop-app can be messaged. Showing the ledger row.`,
    ]);
  });
});

describe('keys and repository names in the queue', () => {
  it('the keys are looked up in a Set built once, not scanned for every row', async () => {
    const w = make({ settings: { repoPath: SHOP } });
    shopApp(w);
    await w.ready();
    let scans = 0;
    class Keys extends Array<string> {
      override includes(...args: Parameters<Array<string>['includes']>): boolean {
        scans++;
        return super.includes(...args);
      }
    }
    const view = await w.hub.lightningStart({ keys: Keys.from([UV_36, UV_21, 'uv:nowhere:UV-1']) });
    expect(view.items.map((i) => i.key)).toEqual([UV_21, UV_36]);
    expect(scans).toBe(0);
  });

  it('two repositories with one folder name get distinct row keys, and settling one leaves the other in the queue', async () => {
    const w = make();
    const ledger = (claim: string) => ({ 'wiki:unverified.jsonl': jsonl({ id: 'UV-0001', date: '2026-10-26', claim }) });
    w.repos.set('/a/app', { refs: [], ledger: ledger('the claim in a') });
    w.repos.set('/b/app', { refs: [], ledger: ledger('the claim in b') });
    const [a, b] = [w.agent('A', { cwd: '/a/app' }), w.agent('B', { cwd: '/b/app' })];
    w.answerAsks(a, b);
    await w.ready(a, b);

    expect((await w.hub.openRows()).map((r) => [r.key, r.repo, r.claim])).toEqual([
      ['uv:a~app:UV-0001', 'a~app', 'the claim in a'],
      ['uv:b~app:UV-0001', 'b~app', 'the claim in b'],
    ]);
    const standup = await w.hub.buildStandup();
    expect(standup.board.filter((i) => i.lane === 'lightning').map((i) => i.rowKey)).toEqual(['uv:a~app:UV-0001', 'uv:b~app:UV-0001']);
    expect(standup.lanes.lightning).toBe(2);
    expect(standup.board.filter((i) => i.lane === 'agents').map((i) => i.repo)).toEqual(['a~app', 'b~app']);

    const view = await w.hub.lightningStart();
    expect(view.counts.total).toBe(2);
    await w.settle();
    expect(w.sent.filter((s) => kindOf(s.text) === 'ask').map((s) => s.to)).toEqual(['A', 'B']); // each repo's row is asked of the agent in that repo
    w.hub.lightningDefer('uv:a~app:UV-0001');
    expect(w.hub.decisions.hidden('uv:a~app:UV-0001')).toBe(true);
    expect(w.hub.decisions.hidden('uv:b~app:UV-0001')).toBe(false);
    expect((await w.hub.openRows()).map((r) => r.key)).toEqual(['uv:b~app:UV-0001']);
    expect((await w.hub.lightningStart({ repo: 'b~app' })).items.map((i) => i.key)).toEqual(['uv:b~app:UV-0001']); // the filter takes the name the rows carry
  });
});

describe('the sign-off lookup on the shared ledger reader', () => {
  it('finds tombstones and unverified rows, open or closed, de-duplicated, with ISO timestamps cut to their date', async () => {
    const w = make();
    w.repos.set('/work/notes', {
      ledger: {
        'wiki:tombstones.jsonl': jsonl({ id: 'TB-0042', ts: '2026-10-01T10:00:00Z', claim: 'the old API is gone', superseded_by: 'TB-0051' }),
        'wiki:unverified.jsonl': jsonl({ id: 'UV-0007', date: '2026-10-12', claim: 'CI cache key includes the lockfile', doubt: 'never run cold', status: 'confirmed' }),
      },
    });
    expect(await w.hub.tbuvLookup(['tb-0042', 'UV-0007', 'UV-0099', 'TB-0042', ' '], '/work/notes')).toEqual([
      { id: 'tb-0042', kind: 'tombstone', date: '2026-10-01', claim: 'the old API is gone', supersededBy: 'TB-0051' },
      { id: 'UV-0007', kind: 'unverified', date: '2026-10-12', claim: 'CI cache key includes the lockfile', doubt: 'never run cold' },
      { id: 'UV-0099', kind: 'not-found' },
    ]);
  });

  it('reads the ref in the settings, and a repo without it reads as not found', async () => {
    const w = make({ settings: { ledgerRef: 'notes' } });
    w.repos.set('/work/notes', { ledger: { 'notes:unverified.jsonl': jsonl({ id: 'UV-0007', claim: 'on the notes branch' }), 'wiki:unverified.jsonl': jsonl({ id: 'UV-0008', claim: 'on wiki' }) } });
    expect(await w.hub.tbuvLookup(['UV-0007', 'UV-0008'], '/work/notes')).toEqual([
      { id: 'UV-0007', kind: 'unverified', claim: 'on the notes branch' },
      { id: 'UV-0008', kind: 'not-found' },
    ]);
    expect(await w.hub.tbuvLookup(['UV-0007'], '/work/not-a-repo')).toEqual([{ id: 'UV-0007', kind: 'not-found' }]);
  });
});
