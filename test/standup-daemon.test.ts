import { describe, it, expect, afterEach } from 'vitest';
import { request } from 'node:http';
import { serve, type Daemon } from '../src/daemon.js';
import { demoHub } from '../src/demo.js';
import type { Hub } from '../src/hub.js';
import { SHOP, kindOf, shopApp, world } from './standup-world.js';

const UV_36 = 'uv:shop-app:UV-0036';
const UV_21 = 'uv:shop-app:UV-0021';

let d: Daemon | null = null;
afterEach(async () => {
  if (d) await d.close();
  d = null;
});

/** Serve a hub on a free loopback port; `call` speaks JSON like the CLI and the panel do. */
async function boot(hub: Hub) {
  d = await serve(hub, { port: 0, pollMs: 60_000 });
  const url = d.url;
  const port = Number(new URL(url).port);
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(url + path, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, json: (await res.json()) as any };
  };
  /** A raw request, so the Host, Origin and Content-Type headers can be set the way a browser page or a rebinding attacker would. */
  const raw = (method: string, path: string, headers: Record<string, string>, body?: string): Promise<{ status: number; body: string }> =>
    new Promise((resolve, reject) => {
      const req = request({ host: '127.0.0.1', port, method, path, headers: { host: `127.0.0.1:${port}`, ...headers } }, (res) => {
        let b = '';
        res.on('data', (c) => (b += c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: b }));
      });
      req.on('error', reject);
      if (body !== undefined) req.write(body);
      req.end();
    });
  return { url, port, call, raw };
}

/** A shop-app with one agent that answers every ask, and a daemon in front of it. */
async function shop() {
  const w = world({ settings: { repoPath: SHOP } });
  shopApp(w);
  const a = w.agent('A');
  w.answerAsks(a);
  await w.ready(a);
  return { w, a, ...(await boot(w.hub)) };
}

/** Poll until `read` returns something, for at most `ms` real milliseconds; the failure says what it last saw. */
async function until<T>(what: string, ms: number, read: () => Promise<T | undefined | false>): Promise<T> {
  const stop = Date.now() + ms;
  for (;;) {
    const got = await read();
    if (got) return got;
    if (Date.now() > stop) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

describe('GET and POST /standup', () => {
  it('is a 404 until the first POST; the POST builds, selects and returns it, and GET returns the same', async () => {
    const { w, call } = await shop();
    const none = await call('GET', '/standup');
    expect(none.status).toBe(404);
    expect(none.json).toEqual({ error: 'No standup yet; POST /standup first.' });

    const built = await call('POST', '/standup', {});
    expect(built.status).toBe(200);
    expect(Object.keys(built.json).sort()).toEqual(['at', 'board', 'covering', 'lanes', 'run', 'sources', 'through', 'windowEnd', 'windowStart']);
    expect(built.json).toMatchObject({ covering: '2026-10-26', through: '2026-10-26', run: '2026-10-27', lanes: { triage: 2, agents: 1, lightning: 2 } });
    expect(built.json.sources.map((s: { id: string; count: number }) => [s.id, s.count])).toEqual([['git', 3], ['ledger', 4], ['sessions', 1]]);
    expect(Object.keys(built.json.board[0]).sort()).toEqual(expect.arrayContaining(['id', 'lane', 'refs', 'sources', 'state', 'tint', 'title']));
    expect((await call('GET', '/standup')).json).toEqual(built.json);
    expect(w.hub.selection).toEqual({ kind: 'standup' });

    const state = (await call('GET', '/state')).json;
    expect(state.selection).toEqual({ kind: 'standup' });
    expect(state.standup).toEqual({ at: built.json.at, covering: '2026-10-26', through: '2026-10-26', run: '2026-10-27', lanes: built.json.lanes });
    expect(state.lightning).toBeNull();
    expect(state.settings).toMatchObject({ ledgerRef: 'wiki', ticketPrefixes: [] });
  });

  it('covers a day asked for, and a date that is not a real one is a 400 that changes nothing', async () => {
    const { call } = await shop();
    const day = await call('POST', '/standup', { covering: '2026-10-24' });
    expect(day.status).toBe(200);
    expect(day.json).toMatchObject({ covering: '2026-10-24', through: '2026-10-24' });
    for (const bad of ['2026-02-30', 'tomorrow', '26-10-26']) {
      const r = await call('POST', '/standup', { covering: bad });
      expect(r.status).toBe(400);
      expect(r.json.error).toMatch(/^covering must be/);
    }
    const wrongType = await call('POST', '/standup', { covering: 20261026 });
    expect(wrongType.status).toBe(400);
    expect(wrongType.json.error).toBe('covering is a string');
    expect((await call('GET', '/standup')).json.covering).toBe('2026-10-24'); // the standup is still the last good one
    expect((await call('POST', '/standup', { covering: '' })).json.covering).toBe('2026-10-26'); // blank is left out: the default day
  });
});

describe('the /lightning routes', () => {
  it('GET /lightning is an inactive empty view before a round; the actions say there is no round (404)', async () => {
    const { call } = await shop();
    const view = await call('GET', '/lightning');
    expect(view.status).toBe(200);
    expect(view.json).toEqual({ active: false, current: null, panelSize: 4, items: [], counts: { total: 0, remaining: 0, decided: 0, deferred: 0 }, log: [] });
    for (const route of ['select', 'reject', 'defer', 'skeptics']) {
      const r = await call('POST', `/lightning/${route}`, { key: UV_36 });
      expect(r.status).toBe(404);
      expect(r.json.error).toMatch(/^No lightning round/);
    }
    expect((await call('POST', '/lightning/approve', { key: UV_36, option: 'A' })).status).toBe(404);
    expect((await call('POST', '/lightning/abort')).json).toEqual({ ok: true });
  });

  it('POST /lightning/start checks its options: a wrong type or range is a 400 and starts nothing', async () => {
    const { call } = await shop();
    const bad: Array<[string, unknown]> = [
      ['panelSize', 13],
      ['panelSize', -1],
      ['panelSize', 2.5],
      ['panelSize', '4'],
      ['panelSize', null],
      ['keys', 'uv:shop-app:UV-0036'],
      ['keys', [1, 2]],
      ['keys', [UV_36, null]],
      ['keys', null],
      ['repo', 5],
    ];
    for (const [field, value] of bad) {
      const r = await call('POST', '/lightning/start', { [field]: value });
      expect(r.status, `${field}: ${JSON.stringify(value)}`).toBe(400);
      expect(r.json.error).toMatch(field === 'panelSize' ? /^panelSize is a whole number from 0 to 12/ : field === 'keys' ? /^keys is an array of strings/ : /^repo is a string/);
    }
    expect((await call('GET', '/lightning')).json.active).toBe(false);
    for (const size of [0, 12]) expect((await call('POST', '/lightning/start', { panelSize: size })).json.panelSize).toBe(size);
  });

  it('runs a round over HTTP: start, the presented card, select, approve (400 bad letter, 404 unknown key), reject, defer, skeptics, abort', async () => {
    const { w, call } = await shop();
    await call('POST', '/standup', {}); // the window puts the row opened on 2026-10-26 first
    const started = await call('POST', '/lightning/start', { keys: [UV_36, UV_21] });
    expect(started.status).toBe(200);
    expect(started.json).toMatchObject({ active: true, current: UV_36, panelSize: 4, counts: { total: 2, remaining: 2, decided: 0, deferred: 0 } });
    await w.settle();
    const view = (await call('GET', '/lightning')).json;
    expect(Object.keys(view).sort()).toEqual(['active', 'counts', 'current', 'items', 'log', 'panelSize']);
    const card = view.items[0];
    expect(Object.keys(card).sort()).toEqual(['decision', 'id', 'key', 'kind', 'phase', 'presentation', 'repo', 'rev', 'row', 'summary', 'title', 'votes']);
    expect(card).toMatchObject({ key: UV_36, kind: 'unverified', phase: 'presented', decision: null, votes: { asked: false, tally: { asked: 0, silent: 0 } } });
    expect(card.row).toMatchObject({ id: 'UV-0036', repo: 'shop-app', date: '2026-10-26', open: true });
    expect(card.row.raw).toBeUndefined();
    expect(Object.keys(card.presentation).sort()).toEqual(['assessment', 'checkable', 'claim', 'evidence', 'nature', 'needs', 'options', 'presentedBy', 'source', 'title']);
    expect(Object.keys(card.presentation.evidence[0]).sort()).toEqual(['cite', 'grounding', 'n', 'raw']);

    expect((await call('POST', '/lightning/select', { key: UV_21 })).json.current).toBe(UV_21);
    expect((await call('POST', '/lightning/select', {})).status).toBe(400);
    expect((await call('POST', '/lightning/select', { key: 'uv:shop-app:UV-9999' })).status).toBe(404);

    const sentBefore = w.sent.length;
    for (const option of ['E', 'a', 'AB', '', 7, undefined]) {
      const r = await call('POST', '/lightning/approve', { key: UV_36, option });
      expect(r.status, `option ${JSON.stringify(option)}`).toBe(400);
    }
    expect((await call('POST', '/lightning/approve', { option: 'A' })).status).toBe(400);
    expect((await call('POST', '/lightning/approve', { key: 'uv:shop-app:UV-9999', option: 'A' })).status).toBe(404);
    const notOffered = await call('POST', '/lightning/approve', { key: UV_36, option: 'D' });
    expect(notOffered.status).toBe(400);
    expect(notOffered.json.error).toBe('Option D is not offered for uv:shop-app:UV-0036.');
    expect(w.sent).toHaveLength(sentBefore); // none of the refused approvals reached an agent

    const rejected = await call('POST', '/lightning/reject', { key: UV_21 });
    expect(rejected.status).toBe(200);
    // the only agent in the repo presented it, so nobody is left to ask: the card is the ledger row, without a word in the log
    expect(rejected.json.items.find((i: { key: string }) => i.key === UV_21)).toMatchObject({ phase: 'fallback', presentation: { source: 'ledger' } });
    expect(w.sent).toHaveLength(sentBefore);
    expect((await call('POST', '/lightning/defer', { key: UV_21 })).json.counts).toMatchObject({ deferred: 1, remaining: 1 });

    const skeptics = await call('POST', '/lightning/skeptics', { key: UV_36 });
    expect(skeptics.status).toBe(200);
    expect(skeptics.json.items[0].votes.asked).toBe(false); // nobody else is messageable here: nobody was asked, so the card is not marked asked (a retry asks a newcomer), and the log says so
    expect(skeptics.json.items[0].votes.tally).toMatchObject({ asked: 0 });
    expect(skeptics.json.log.at(-1)).toBe(`No other agent can be messaged to vote on ${UV_36}.`);

    const approved = await call('POST', '/lightning/approve', { key: UV_36, option: 'A' });
    expect(approved.status).toBe(200);
    expect(Object.keys(approved.json).sort()).toEqual(['decided', 'delivered', 'view']);
    expect(approved.json).toMatchObject({ delivered: true, decided: true });
    expect(approved.json.view.items[0]).toMatchObject({ phase: 'decided', decision: { option: 'A', verb: 'challenge', delivered: true } });
    const relayed = w.sent.slice(sentBefore).filter((s) => kindOf(s.text) === 'decision');
    expect(relayed).toHaveLength(1);

    expect((await call('POST', '/lightning/abort')).json).toEqual({ ok: true });
    expect((await call('GET', '/lightning')).json).toMatchObject({ active: false, counts: { decided: 1, deferred: 1 } }); // the round stays readable
  });
});

describe('POST /lightning/approve names the card it approves', () => {
  it('every card carries its rev; an approve that names it applies to that card, and one without it works as before', async () => {
    const { w, call } = await shop();
    await call('POST', '/lightning/start', { keys: [UV_36, UV_21] });
    await w.settle();
    const items = (await call('GET', '/lightning')).json.items as Array<{ key: string; rev: number }>;
    expect(items.map((i) => typeof i.rev)).toEqual(['number', 'number']);
    expect(items.every((i) => Number.isInteger(i.rev) && i.rev >= 0)).toBe(true);
    expect(items[0].rev).toBeGreaterThan(0); // it was presented: the card changed from nothing to something

    const withRev = await call('POST', '/lightning/approve', { key: UV_36, option: 'C', rev: items[0].rev });
    expect(withRev.status).toBe(200);
    expect(withRev.json).toMatchObject({ delivered: false, decided: true }); // No change decides and sends nothing
    const without = await call('POST', '/lightning/approve', { key: UV_21, option: 'C' });
    expect(without.status).toBe(200);
    expect(without.json).toMatchObject({ decided: true });
  });

  it('a card that has changed since the caller saw it is a 409 with the engine’s message, and nothing is sent or decided', async () => {
    const { w, call } = await shop();
    await call('POST', '/lightning/start', { keys: [UV_36] });
    await w.settle();
    const seen = (await call('GET', '/lightning')).json.items[0].rev as number;

    await call('POST', '/lightning/reject', { key: UV_36 }); // another tab rejects it: the card is replaced
    await w.settle();
    const now = (await call('GET', '/lightning')).json.items[0].rev as number;
    expect(now).not.toBe(seen);

    const sentBefore = w.sent.length;
    const stale = await call('POST', '/lightning/approve', { key: UV_36, option: 'A', rev: seen });
    expect(stale.status).toBe(409);
    expect(stale.json).toEqual({ error: `The card for ${UV_36} changed; look again.` });
    expect(w.sent).toHaveLength(sentBefore);
    expect(w.hub.decisions.hidden(UV_36)).toBe(false);
    expect((await call('GET', '/lightning')).json.items[0]).toMatchObject({ phase: 'fallback', decision: null });

    // looking again gives the new rev, and that one goes through
    const fresh = await call('POST', '/lightning/approve', { key: UV_36, option: 'A', rev: now });
    expect(fresh.status).toBe(200);
    expect(fresh.json).toMatchObject({ delivered: true, decided: true });
    expect(w.sent.slice(sentBefore).map((s) => kindOf(s.text))).toEqual(['decision']);
  });

  it('a rev that is not a whole number from 0 up is a 400, before anything is looked at or sent', async () => {
    const { w, call } = await shop();
    await call('POST', '/lightning/start', { keys: [UV_36] });
    await w.settle();
    const sentBefore = w.sent.length;
    for (const rev of [-1, 1.5, '1', null, true, [], {}]) {
      const r = await call('POST', '/lightning/approve', { key: UV_36, option: 'A', rev });
      expect(r.status, JSON.stringify(rev)).toBe(400);
      expect(r.json).toEqual({ error: 'rev is a whole number from 0 up' });
    }
    expect(w.sent).toHaveLength(sentBefore);
    expect((await call('GET', '/lightning')).json.items[0].phase).toBe('presented');
    // a rev for a key that is not there is still the unknown key's 404, and a rev of 0 is a rev (a number): the card is on a later one, so it is stale
    expect((await call('POST', '/lightning/approve', { key: 'uv:shop-app:UV-9999', option: 'A', rev: 0 })).status).toBe(404);
    expect((await call('POST', '/lightning/approve', { key: UV_36, option: 'A', rev: 0 })).status).toBe(409);
  });
});

describe('the browser guard covers the Lightning Round', () => {
  it('a foreign Origin is a 403 and text/plain a 415 on /lightning/approve, and nothing reaches any agent', async () => {
    const { w, raw, port } = await shop();
    const hub = w.hub;
    await hub.lightningStart({ keys: [UV_36] });
    await w.settle();
    const sentBefore = w.sent.length;
    const body = JSON.stringify({ key: UV_36, option: 'A' });
    const json = { 'content-type': 'application/json' };

    expect((await raw('POST', '/lightning/approve', { origin: 'https://evil.example', ...json }, body)).status).toBe(403);
    expect((await raw('POST', '/lightning/approve', { origin: 'https://evil.example', 'content-type': 'text/plain' }, body)).status).toBe(403); // the origin is judged before the type
    expect((await raw('POST', '/lightning/approve', { origin: 'null', ...json }, body)).status).toBe(403);
    expect((await raw('POST', '/lightning/approve', { host: `attacker.example:${port}`, ...json }, body)).status).toBe(403);
    for (const type of ['text/plain', 'application/x-www-form-urlencoded', 'multipart/form-data; boundary=x']) expect((await raw('POST', '/lightning/approve', { 'content-type': type }, body)).status).toBe(415);
    expect((await raw('POST', '/lightning/approve', {}, body)).status).toBe(415);

    expect(w.sent).toHaveLength(sentBefore); // not one message to any agent
    expect(hub.lightningView().items[0]).toMatchObject({ phase: 'presented', decision: null });
    expect(hub.decisions.hidden(UV_36)).toBe(false);

    // the panel itself (same origin) still gets through
    const panel = await raw('POST', '/lightning/approve', { origin: `http://127.0.0.1:${port}`, ...json }, body);
    expect(panel.status).toBe(200);
    expect(JSON.parse(panel.body)).toMatchObject({ delivered: true, decided: true });
    expect(w.sent.slice(sentBefore).map((s) => kindOf(s.text))).toEqual(['decision']);
  });

  it('every state-changing standup and lightning route is refused the same way, and none of them acts', async () => {
    const { w, raw, port } = await shop();
    await w.hub.lightningStart({ keys: [UV_36] });
    await w.settle();
    const sentBefore = w.sent.length;
    const runsBefore = w.runs.length;
    const body = JSON.stringify({ key: UV_36, option: 'A' });
    for (const path of ['/standup', '/lightning/start', '/lightning/select', '/lightning/approve', '/lightning/reject', '/lightning/defer', '/lightning/skeptics', '/lightning/abort']) {
      expect((await raw('POST', path, { origin: 'https://evil.example', 'content-type': 'application/json' }, body)).status, path).toBe(403);
      expect((await raw('POST', path, { 'content-type': 'text/plain' }, body)).status, path).toBe(415);
    }
    expect(w.sent).toHaveLength(sentBefore);
    expect(w.runs).toHaveLength(runsBefore); // no standup was built, no round restarted
    expect(w.hub.standup).toBeNull();
    expect(w.hub.lightningView()).toMatchObject({ active: true, counts: { total: 1, remaining: 1 } });
    // reads are not refused for a missing JSON type, but a rebinding host still is
    expect((await raw('GET', '/lightning', {})).status).toBe(200);
    expect((await raw('GET', '/lightning', { host: `attacker.example:${port}` })).status).toBe(403);
    expect((await raw('GET', '/standup', { host: `attacker.example:${port}` })).status).toBe(403);
  });
});

describe('serve --demo', () => {
  it('builds a standup with three non-zero lanes, and the sign-off rows of the status check still work', async () => {
    const hub = demoHub();
    const { call } = await boot(hub);
    await hub.refresh();
    const standup = (await call('POST', '/standup', {})).json;
    expect(standup.lanes.triage).toBeGreaterThan(0);
    expect(standup.lanes.agents).toBeGreaterThan(0);
    expect(standup.lanes.lightning).toBeGreaterThan(0);
    expect(standup.sources.map((s: { id: string; count: number; note?: string }) => [s.id, s.count > 0, s.note])).toEqual([['git', true, undefined], ['ledger', true, undefined], ['sessions', true, undefined]]);
    const triage = standup.board.filter((i: { lane: string }) => i.lane === 'triage');
    expect(triage.length).toBe(standup.lanes.triage);
    expect(standup.sources[0].count).toBeGreaterThan(standup.lanes.triage); // two branches share SHOP-123: the lane joins them, the chip counts them
    expect(triage.some((i: { sessionIDs?: string[] }) => i.sessionIDs?.includes('a1b2c3d4-0001'))).toBe(true); // instrument-62 is on a branch of the board
    expect(standup.board.filter((i: { lane: string }) => i.lane === 'lightning')[0].rowKey).toBe('uv:instrument:UV-0036');

    // the docs sweep's TB/UV references still resolve to ledger rows, as before the ledger moved into the standup
    const report = '```cim-status\nscope: API reference rewrite\nstatus: done\nwiki_journaled: true\nworktrees_cleaned: true\ntb_uv_cleared: true\ntb_uv_refs:\n- TB-0042\n- UV-0007\n```';
    const signoff = await call('POST', '/agents/c3d4e5f6-0003/chore/tbuv', { turnText: report });
    expect(signoff.json.action).toBe('sign-off');
    expect(signoff.json.records).toEqual([
      { id: 'TB-0042', kind: 'tombstone', date: '2026-10-01', claim: 'the v1 export endpoint is removed', supersededBy: 'TB-0051' },
      { id: 'UV-0007', kind: 'unverified', date: '2026-10-12', claim: 'CI cache key includes the lockfile', doubt: 'never checked against a cold run' },
    ]);
  });

  it('a round started on it presents UV-0036 with grounded and ungrounded cites, then a skeptics panel votes and one seat stays silent', async () => {
    const hub = demoHub();
    const { call } = await boot(hub);
    await hub.refresh();
    const lanesBefore = (await call('POST', '/standup', {})).json.lanes;
    const started = (await call('POST', '/lightning/start', {})).json;
    expect(started.items[0].key).toBe('uv:instrument:UV-0036');
    expect(started.panelSize).toBe(4);

    // the demo's own short timings: the canned agent answers within ~1.3 s and the round polls every 300 ms
    const card = await until('UV-0036 to be presented', 7500, async () => {
      const item = (await call('GET', '/lightning')).json.items.find((i: { id: string }) => i.id === 'UV-0036');
      return item.phase === 'presented' && item;
    });
    expect(card.presentation).toMatchObject({ source: 'agent', presentedBy: 'MR !1267 merge conflicts', needs: 'human', nature: 'decision', checkable: 'now' });
    expect(card.presentation.evidence.map((e: { grounding: { status: string } }) => e.grounding.status)).toEqual(['grounded', 'grounded', 'ungrounded', 'grounded']);
    expect(card.presentation.evidence[2].grounding.reason).toBe('src/upload/retry.ts is not in 75c7b13');
    expect(card.presentation.evidence[0].grounding.sha).toBe('75c7b13');
    expect(card.presentation.options.map((o: { letter: string; verb: string; grounding: string }) => [o.letter, o.verb, o.grounding])).toEqual([['A', 'challenge', 'grounded'], ['B', 'deny', 'ungrounded'], ['C', 'no_change', 'ungrounded']]);

    await call('POST', '/lightning/skeptics', { key: card.key });
    const votes = await until('the panel to vote', 6000, async () => {
      const v = (await call('GET', '/lightning')).json.items[0].votes;
      return v.tally.concur + v.tally.concern + v.tally.refuted >= 3 && v;
    });
    expect(votes.tally).toEqual({ concur: 1, concern: 1, refuted: 1, silent: 1, asked: 4 });
    expect(votes.entries.map((e: { name: string; vote: string | null }) => [e.name, e.vote])).toEqual([
      ['instrument-62', 'concur'],
      ['docs sweep', null],
      ['gateway tracing', 'concern'],
      ['infra cleanup', 'refuted'],
    ]);

    const approved = (await call('POST', '/lightning/approve', { key: card.key, option: 'A' })).json;
    expect(approved).toMatchObject({ delivered: true, decided: true });
    const next = (await call('POST', '/standup', {})).json;
    expect(next.lanes.lightning).toBe(lanesBefore.lightning - 1); // the decided row is out of the next standup's lane
  }, 12_000);

  it('the second card falls back to the ledger row: the first presenter replies without a usable block and the second never answers', async () => {
    const hub = demoHub();
    const { call } = await boot(hub);
    await hub.refresh();
    await call('POST', '/lightning/start', { keys: ['uv:instrument:UV-0021'] });
    const card = await until('UV-0021 to fall back', 9500, async () => {
      const item = (await call('GET', '/lightning')).json.items[0];
      return item.phase === 'fallback' && item;
    });
    expect(card.presentation).toMatchObject({ source: 'ledger', presentedBy: 'nightly-audit' });
    const log = (await call('GET', '/lightning')).json.log as string[];
    expect(log).toEqual([
      'MR !1267 merge conflicts b2c3d4e5 replied without a usable block.',
      'instrument-62 a1b2c3d4 did not reply within 4s.',
      'No presentation for uv:instrument:UV-0021: The present call timed out. Showing the ledger row.',
    ]);
  }, 12_000);
});
