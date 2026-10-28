import { describe, it, expect, afterEach } from 'vitest';
import { DecisionStore, LightningRound, type LightningDeps, type LightningView } from '../src/lightning.js';
import { MemoryKV, KEYS } from '../src/store.js';
import { parseLedger, type LedgerRow, type RepoRef, type RowKind } from '../src/tbuv-ledger.js';
import { lightningDecision, lightningPresentAsk, lightningVoteAsk } from '../src/prompts.js';
import { isMessageable, type Agent } from '../src/agent.js';
import type { RunResult, Runner } from '../src/runner.js';

const T0 = Date.parse('2026-10-27T09:00:00.000Z');
const DAY = 86_400_000;
const REPO: RepoRef = { name: 'shop-app', path: '/work/shop-app' };
const BILLING: RepoRef = { name: 'billing', path: '/work/billing' };
const HEAD = '75c7b13' + 'e'.repeat(33);
const WEEK = 7 * DAY;

const ticks = async (n = 5) => {
  for (let i = 0; i < n; i++) await new Promise<void>((r) => setImmediate(r));
};

// ---- fixtures -------------------------------------------------------------------------------------------------------

/** A ledger row through the real parser. */
function rowOf(id: string, over: Record<string, unknown> = {}, repo: RepoRef = REPO, kind: RowKind = 'unverified'): LedgerRow {
  const rows = parseLedger(JSON.stringify({ id, date: '2026-10-12', claim: `the claim of ${id}`, ...over }), kind, repo);
  if (rows.length !== 1) throw new Error(`test setup: ${id} should parse`);
  return rows[0];
}

/** `A` becomes session `A0000000-5e55-4a1b`: the first 8 characters are what the log prints. */
const agent = (id: string, over: Partial<Agent> = {}): Agent => ({
  sessionID: `${id.padEnd(8, '0')}-5e55-4a1b`,
  pid: 100,
  name: `agent-${id}`,
  cwd: '/work/shop-app',
  kind: 'interactive',
  status: 'idle',
  startedAt: T0,
  inboxSocketPath: `/tmp/${id}.sock`,
  ...over,
});

const repoOf = (a: Agent): string | null => (a.cwd.startsWith('/work/shop-app') ? '/work/shop-app' : a.cwd.startsWith('/work/billing') ? '/work/billing' : null);

const SESSION_TS =
  [
    'export function mintSession(online: boolean): string {', // 1
    '  if (!online) return queuedId();', // 2
    '  return crypto.randomUUID();', // 3
    '}', // 4
    '// offline uploads reuse the session id minted online', // 5
    'export function reuse(id: string) {', // 6
    '  return id;', // 7
    '}', // 8
  ].join('\n') + '\n';

/** A tiny repo behind a fake Runner: one commit (HEAD), the files in it. Records every call. */
function fakeGit(files: Record<string, string> = { 'src/session.ts': SESSION_TS }) {
  const calls: Array<{ cmd: string; args: string[] }> = [];
  const ok = (stdout: string): RunResult => ({ code: 0, stdout, stderr: '' });
  const fail = (): RunResult => ({ code: 128, stdout: '', stderr: 'fatal: not found' });
  const run: Runner = async (cmd, args) => {
    calls.push({ cmd, args });
    const [dashC, , sub, ...rest] = args;
    if (cmd !== 'git' || dashC !== '-C') throw new Error(`unexpected invocation: ${cmd} ${args.join(' ')}`);
    if (sub === 'rev-parse') {
      const name = rest[2].slice(0, -'^{commit}'.length);
      return name === 'HEAD' || HEAD.startsWith(name) ? ok(`${HEAD}\n`) : fail();
    }
    const isCat = sub === 'cat-file';
    const object = isCat ? rest[1] : rest[0];
    const content = object.startsWith(`${HEAD}:`) ? files[object.slice(HEAD.length + 1)] : undefined;
    if (content === undefined) return fail();
    if (!isCat) return ok(content);
    return ok(rest[0] === '-t' ? 'blob\n' : `${Buffer.byteLength(content)}\n`);
  };
  return { run, calls };
}

interface BlockOpts {
  title?: string;
  claim?: string;
  assessment?: string;
  evidence?: string[];
  options?: string[];
}
/** A cim-lightning reply: line 1 of the file is grounded, the journal note is not, and the options cite them as in the photo. */
const block = (id: string, o: BlockOpts = {}): string =>
  [
    '```cim-lightning',
    `id: ${id}`,
    'needs: human',
    'nature: decision',
    'checkable: now',
    `title: ${o.title ?? 'Session id reuse'}`,
    `claim: ${o.claim ?? 'offline uploads reuse the session id minted online'}`,
    `assessment: ${o.assessment ?? 'The upload queue stores the id it minted online and replays it.'}`,
    'evidence:',
    ...(o.evidence ?? ['src/session.ts:5@75c7b13 "reuse the session id"', 'journal/2026-10-14.md:17']).map((e) => `- ${e}`),
    'options:',
    ...(o.options ?? ['A | challenge | Qualify the claim | 1,2 | Holds only while the queue keeps the id.', 'B | deny | Deny the claim | 2 | The journal note is not code.', 'C | no_change | Leave the row alone | | Nothing new to add.']).map((e) => `- ${e}`),
    '```',
  ].join('\n');

/** A fence that names the right row but is not usable (one option). */
const unusable = (id: string): string => ['```cim-lightning', `id: ${id}`, 'claim: half a thought', 'options:', '- A | confirm | the only one | | why', '```'].join('\n');

const vote = (id: string, v: string, prefers = 'A'): string => ['```cim-vote', `id: ${id}`, `vote: ${v}`, `prefers: ${prefers}`, 'reason: matches the code', '```'].join('\n');

const idIn = (text: string): string => /(?:UV|TB)-\d{4}/.exec(text)?.[0] ?? '?';
const kindOfSent = (text: string): string => (text.startsWith('[cIM Lightning Round]') ? 'decision' : text.includes('Lightning Round: a human') ? 'ask' : text.includes('independent vote') ? 'vote' : 'other');

// ---- harness: a fake clock whose sleep advances time and yields, transcripts, an inbox --------------------------------

function harness(over: Partial<LightningDeps> = {}, kv: MemoryKV = new MemoryKV()) {
  let now = T0;
  let sleeps = 0;
  let reads = 0;
  let hold: Promise<void> | null = null;
  const hooks = new Map<number, () => void>();
  const files = new Map<string, string[]>();
  const roster: Agent[] = [];
  const sent: Array<{ to: string; text: string }> = [];
  const failSend = new Map<string, string>();
  const onAsk = new Map<string, (text: string) => string | undefined>();
  const git = fakeGit();
  const clock = () => now;
  const decisions = new DecisionStore(kv, clock);
  const reply = (sid: string, text: string) => files.set(sid, [...(files.get(sid) ?? []), text]);
  const deps: LightningDeps = {
    clock,
    sleep: (ms) => {
      sleeps++;
      hooks.get(sleeps)?.();
      return new Promise<void>((r) => {
        now += ms;
        setImmediate(r);
      });
    },
    run: git.run,
    messageable: () => roster.filter(isMessageable),
    repoOf,
    sendInbox: async (a, text) => {
      sent.push({ to: a.sessionID, text });
      if (hold) await hold;
      const refusal = failSend.get(a.sessionID);
      if (refusal) throw new Error(refusal);
      const answer = onAsk.get(a.sessionID)?.(text);
      if (answer !== undefined && kindOfSent(text) === 'ask') reply(a.sessionID, answer);
    },
    transcriptSize: async (a) => files.get(a.sessionID)?.length ?? 0,
    readSince: async (a, offset) => {
      reads++;
      const texts = files.get(a.sessionID) ?? [];
      return { texts: texts.slice(offset), endOffset: texts.length };
    },
    decisions,
    pollMs: 2_000,
    ...over,
  };
  return {
    deps,
    kv,
    decisions,
    git,
    roster,
    sent,
    failSend,
    onAsk,
    reply,
    now: () => now,
    set: (ms: number) => void (now = ms),
    sleeps: () => sleeps,
    reads: () => reads,
    /** Run `fn` as the n-th sleep (counting from 1, over every poller) begins. */
    at: (n: number, fn: () => void) => void hooks.set(n, fn),
    /** Make every inbox send wait until the returned function is called. */
    hold: () => {
      let release!: () => void;
      hold = new Promise<void>((r) => (release = r));
      return () => {
        hold = null;
        release();
      };
    },
    /** Every agent answers every ask with a presentation of the row it was asked about. */
    answerAll: (...agents: Agent[]) => {
      for (const a of agents) onAsk.set(a.sessionID, (text) => block(idIn(text), { title: `${a.name} on ${idIn(text)}` }));
    },
    sentLabels: () => sent.map((s) => `${s.to.slice(0, 1)} ${kindOfSent(s.text)} ${idIn(s.text)}`),
  };
}
type Harness = ReturnType<typeof harness>;

const rounds: LightningRound[] = [];
/** A round that is aborted when the test ends, so nothing keeps polling. */
function round(rows: LedgerRow[], h: Harness, opts?: { panelSize?: number; prefetch?: number }): LightningRound {
  const r = new LightningRound(rows, h.deps, opts);
  rounds.push(r);
  return r;
}
afterEach(async () => {
  for (const r of rounds.splice(0)) {
    r.abort();
    await r.settle();
  }
});

const item = (v: LightningView, key: string) => {
  const found = v.items.find((i) => i.key === key);
  if (!found) throw new Error(`test setup: no item ${key}`);
  return found;
};
const phases = (v: LightningView) => v.items.map((i) => `${i.id}:${i.phase}`);

// ---- DecisionStore --------------------------------------------------------------------------------------------------

describe('the decision store', () => {
  it('hides a key until its `until`, strictly', () => {
    const kv = new MemoryKV();
    let now = T0;
    const store = new DecisionStore(kv, () => now);
    expect(store.hidden('uv:shop-app:UV-0036')).toBe(false);
    store.record('uv:shop-app:UV-0036', { state: 'decided', option: 'B', verb: 'deny' }, T0 + WEEK);
    now = T0 + WEEK - 1;
    expect(store.hidden('uv:shop-app:UV-0036')).toBe(true);
    now = T0 + WEEK;
    expect(store.hidden('uv:shop-app:UV-0036')).toBe(false);
    expect(store.hidden('uv:shop-app:UV-0099')).toBe(false);
  });

  it('writes { state, option, verb, at, until } under the lightning key, and a deferral carries no option or verb', () => {
    const kv = new MemoryKV();
    let now = T0;
    const store = new DecisionStore(kv, () => now);
    store.record('uv:shop-app:UV-0001', { state: 'decided', option: 'A', verb: 'challenge' }, T0 + WEEK);
    now = T0 + 1000;
    store.record('uv:shop-app:UV-0002', { state: 'deferred' }, T0 + DAY);
    expect(KEYS.lightning).toBe('cimLightningDecisions');
    expect(kv.get(KEYS.lightning)).toStrictEqual({
      'uv:shop-app:UV-0001': { state: 'decided', option: 'A', verb: 'challenge', at: T0, until: T0 + WEEK },
      'uv:shop-app:UV-0002': { state: 'deferred', at: T0 + 1000, until: T0 + DAY },
    });
  });

  it('drops entries more than 30 days past their `until` when it writes, and keeps the ones at the edge', () => {
    const kv = new MemoryKV();
    const store = new DecisionStore(kv, () => T0);
    const rec = (until: number) => ({ state: 'decided', option: 'C', verb: 'no_change', at: T0 - 40 * DAY, until });
    kv.set(KEYS.lightning, { old: rec(T0 - 30 * DAY - 1), edge: rec(T0 - 30 * DAY), recent: rec(T0 - DAY), future: rec(T0 + DAY) });
    store.record('fresh', { state: 'deferred' }, T0 + DAY);
    expect(Object.keys(kv.get<Record<string, unknown>>(KEYS.lightning) ?? {}).sort()).toStrictEqual(['edge', 'fresh', 'future', 'recent']);
  });

  it('treats a corrupt value as empty and overwrites it with a clean map', () => {
    const live = { state: 'decided', at: 1, until: T0 + DAY };
    for (const bad of ['garbage', 42, true, [1, 2, 3], [live], { k: 'str' }, { k: { ...live, until: 'soon' } }, { k: { ...live, state: 'maybe' } }, { k: null }]) {
      const kv = new MemoryKV();
      kv.set(KEYS.lightning, bad);
      const store = new DecisionStore(kv, () => T0);
      expect(store.hidden('k')).toBe(false);
      expect(store.hidden('0')).toBe(false); // an array is not a map keyed by its indexes
      store.record('uv:shop-app:UV-0001', { state: 'deferred' }, T0 + DAY);
      expect(kv.get(KEYS.lightning)).toStrictEqual({ 'uv:shop-app:UV-0001': { state: 'deferred', at: T0, until: T0 + DAY } });
    }
  });

  it('is shared through the kv: another instance sees what one recorded', () => {
    const kv = new MemoryKV();
    new DecisionStore(kv, () => T0).record('k', { state: 'deferred' }, T0 + 5);
    expect(new DecisionStore(kv, () => T0).hidden('k')).toBe(true);
  });
});

// ---- the view -------------------------------------------------------------------------------------------------------

describe('the view', () => {
  it('lists the rows queued before start, without raw, with the title and summary the card shows', () => {
    const h = harness();
    const a = rowOf('UV-0036', { claim: 'offline uploads reuse the session id minted online', doubt: 'never checked against a cold start', extra: 'kept in raw only' });
    const b = rowOf('UV-0037', { claim: undefined, doubt: undefined });
    const r = round([a, b], h, { panelSize: 2 });
    const v = r.view();
    expect(v).toMatchObject({ active: false, current: null, panelSize: 2, counts: { total: 2, remaining: 2, decided: 0, deferred: 0 }, log: [] });
    expect(v.items[0]).toStrictEqual({
      key: 'uv:shop-app:UV-0036',
      id: 'UV-0036',
      kind: 'unverified',
      repo: 'shop-app',
      title: 'UV-0036 offline uploads reuse the session id minted online',
      summary: 'shop-app. Doubt: never checked against a cold start',
      row: { key: 'uv:shop-app:UV-0036', id: 'UV-0036', kind: 'unverified', repo: 'shop-app', repoPath: '/work/shop-app', date: '2026-10-12', claim: 'offline uploads reuse the session id minted online', doubt: 'never checked against a cold start', status: 'open', open: true },
      phase: 'queued',
      presentation: null,
      votes: { asked: false, tally: { concur: 0, concern: 0, refuted: 0, silent: 0, asked: 0 }, entries: [] },
      decision: null,
    });
    expect('raw' in v.items[0].row).toBe(false);
    expect(v.items[1]).toMatchObject({ title: 'UV-0037', summary: 'shop-app.' });
    expect(new LightningRound([], h.deps).view().panelSize).toBe(4);
  });

  it('the title falls back to the presentation title when the row has no claim', async () => {
    const h = harness();
    const a = agent('A');
    h.roster.push(a);
    h.answerAll(a);
    const row = rowOf('UV-0050', { claim: undefined });
    const r = round([row], h);
    r.start();
    await r.settle();
    expect(r.view().items[0].title).toBe('UV-0050 agent-A on UV-0050');
  });

  it('counts remaining as everything not decided or deferred', async () => {
    const h = harness();
    const rows = [rowOf('UV-0001'), rowOf('UV-0002'), rowOf('UV-0003')];
    const r = round(rows, h);
    r.start();
    await r.settle();
    expect(r.view().counts).toStrictEqual({ total: 3, remaining: 3, decided: 0, deferred: 0 });
    r.defer(rows[0].key);
    await r.approve(rows[1].key, 'C');
    expect(r.view().counts).toStrictEqual({ total: 3, remaining: 1, decided: 1, deferred: 1 });
  });

  it('keeps the last 20 log lines, oldest first', async () => {
    const h = harness(); // nobody to ask: every row ends in a ledger card with one log line
    const rows = Array.from({ length: 25 }, (_, i) => rowOf(`UV-${String(i + 1).padStart(4, '0')}`));
    const r = round(rows, h);
    r.start();
    for (const row of rows.slice(0, 23)) r.defer(row.key);
    const log = r.view().log;
    expect(log).toHaveLength(20);
    expect(log[0]).toBe('No presentation for uv:shop-app:UV-0006: No agent in shop-app can be messaged. Showing the ledger row.');
    expect(log[19]).toBe('No presentation for uv:shop-app:UV-0025: No agent in shop-app can be messaged. Showing the ledger row.');
  });
});

// ---- presenting -----------------------------------------------------------------------------------------------------

describe('presenting: the winning block', () => {
  it('asks the agent, reads its reply, grounds the cites against its checkout and shows the card', async () => {
    const h = harness();
    const a = agent('A', { cwd: '/work/shop-app-wt' }); // a worktree of the repo: the cites are checked where the agent looked
    h.roster.push(a);
    h.onAsk.set(a.sessionID, () => block('UV-0036'));
    const row = rowOf('UV-0036', { claim: 'offline uploads reuse the session id minted online' });
    const r = round([row], h);
    r.start();
    expect(r.view().items[0].phase).toBe('presenting');
    await r.settle();
    const v = r.view();
    expect(v.current).toBe('uv:shop-app:UV-0036');
    expect(v.items[0].phase).toBe('presented');
    expect(h.sent).toStrictEqual([{ to: a.sessionID, text: lightningPresentAsk(row) }]);
    expect(v.items[0].presentation).toStrictEqual({
      source: 'agent',
      presentedBy: 'agent-A',
      needs: 'human',
      nature: 'decision',
      checkable: 'now',
      title: 'Session id reuse',
      claim: 'offline uploads reuse the session id minted online',
      assessment: 'The upload queue stores the id it minted online and replays it.',
      evidence: [
        {
          n: 1,
          raw: 'src/session.ts:5@75c7b13 "reuse the session id"',
          cite: { raw: 'src/session.ts:5@75c7b13 "reuse the session id"', path: 'src/session.ts', startLine: 5, endLine: 5, sha: '75c7b13', quote: 'reuse the session id' },
          grounding: { status: 'grounded', sha: '75c7b13' },
        },
        {
          n: 2,
          raw: 'journal/2026-10-14.md:17',
          cite: { raw: 'journal/2026-10-14.md:17', path: 'journal/2026-10-14.md', startLine: 17, endLine: 17 },
          grounding: { status: 'ungrounded', reason: 'journal/2026-10-14.md is not in 75c7b13' },
        },
      ],
      options: [
        { letter: 'A', verb: 'challenge', title: 'Qualify the claim', cites: [1, 2], why: 'Holds only while the queue keeps the id.', grounding: 'grounded' },
        { letter: 'B', verb: 'deny', title: 'Deny the claim', cites: [2], why: 'The journal note is not code.', grounding: 'ungrounded' },
        { letter: 'C', verb: 'no_change', title: 'Leave the row alone', cites: [], why: 'Nothing new to add.', grounding: 'ungrounded' },
      ],
    });
    expect(v.log).toStrictEqual([]);
    expect(h.git.calls.length).toBeGreaterThan(0);
    expect(h.git.calls.every((c) => c.args[1] === '/work/shop-app-wt')).toBe(true);
  });

  it('an option is grounded when it cites at least one grounded evidence line; numbers out of range are ignored', async () => {
    const h = harness();
    const a = agent('A');
    h.roster.push(a);
    h.onAsk.set(a.sessionID, () =>
      block('UV-0036', {
        options: ['A | confirm | cites a good one and a missing one | 1,7 | x', 'B | deny | cites only missing ones | 7,9 | x', 'C | challenge | cites the ungrounded one | 2 | x', 'D | no_change | cites nothing | | x'],
      })
    );
    const r = round([rowOf('UV-0036')], h);
    r.start();
    await r.settle();
    expect(r.view().items[0].presentation?.options.map((o) => `${o.letter}:${o.grounding}`)).toStrictEqual(['A:grounded', 'B:ungrounded', 'C:ungrounded', 'D:ungrounded']);
  });

  it('a line that is not a citation is an ungrounded evidence entry with no cite, and hostile cites never reach git', async () => {
    const h = harness();
    const a = agent('A');
    h.roster.push(a);
    const hostile = ['-x/y:1', '../../etc/passwd:1', '--output=/tmp/pwn:1@abc1234', 'it just works, trust me', 'src/session.ts:99'];
    h.onAsk.set(a.sessionID, () => block('UV-0036', { evidence: hostile }));
    const r = round([rowOf('UV-0036')], h);
    r.start();
    await r.settle();
    const evidence = r.view().items[0].presentation?.evidence ?? [];
    expect(evidence.map((e) => e.n)).toStrictEqual([1, 2, 3, 4, 5]);
    for (const i of [0, 1, 2, 3]) expect(evidence[i]).toStrictEqual({ n: i + 1, raw: hostile[i], cite: null, grounding: { status: 'ungrounded', reason: 'not a citation' } });
    expect(evidence[4].cite).toMatchObject({ path: 'src/session.ts', startLine: 99 });
    expect(evidence[4].grounding).toStrictEqual({ status: 'ungrounded', reason: 'lines 99-99 are beyond the end of the file (8 lines)' });
    const argv = h.git.calls.flatMap((c) => c.args).join('\n');
    for (const bad of ['passwd', '-x/y', '--output', 'trust me']) expect(argv).not.toContain(bad);
    expect(h.git.calls.length).toBe(4); // only the one parseable cite was checked
  });

  it('a runner that throws makes the cite ungrounded with the error, and the card still shows', async () => {
    const h = harness({
      run: async () => {
        throw new Error('git timed out after 20000ms');
      },
    });
    const a = agent('A');
    h.roster.push(a);
    h.answerAll(a);
    const r = round([rowOf('UV-0036')], h);
    r.start();
    await r.settle();
    const p = r.view().items[0].presentation;
    expect(r.view().items[0].phase).toBe('presented');
    expect(p?.evidence.map((e) => e.grounding)).toStrictEqual([
      { status: 'ungrounded', reason: 'git timed out after 20000ms' },
      { status: 'ungrounded', reason: 'git timed out after 20000ms' },
    ]);
    expect(p?.options.every((o) => o.grounding === 'ungrounded')).toBe(true);
  });
});

describe('presenting: who is asked, and the ladder when they fail', () => {
  it('asks the idle agents of the row’s repo first, then busy ones, in roster order, at most maxPresenters, skipping other repos and the unreachable', async () => {
    const roster = [agent('B1', { status: 'busy' }), agent('I1'), agent('X', { cwd: '/work/billing' }), agent('N', { cwd: '/elsewhere' }), agent('D', { inboxSocketPath: undefined }), agent('I2')];
    const askedBy = async (maxPresenters?: number): Promise<string[]> => {
      const h = harness({ presentTimeoutMs: 10_000, maxPresenters });
      h.roster.push(...roster);
      const r = round([rowOf('UV-0036')], h);
      r.start();
      await r.settle();
      return h.sent.map((s) => s.to);
    };
    const [b1, i1, i2] = [roster[0].sessionID, roster[1].sessionID, roster[5].sessionID];
    expect(await askedBy()).toStrictEqual([i1, i2]); // the default is two; the busy agent comes after both idle ones
    expect(await askedBy(3)).toStrictEqual([i1, i2, b1]);
    expect(await askedBy(1)).toStrictEqual([i1]);
  });

  it('an unusable cim-lightning block moves on to the next candidate at once, without waiting out the timeout', async () => {
    const h = harness();
    const [a, b] = [agent('A'), agent('B')];
    h.roster.push(a, b);
    h.onAsk.set(a.sessionID, () => unusable('UV-0036'));
    h.onAsk.set(b.sessionID, () => block('UV-0036', { title: 'from B' }));
    const r = round([rowOf('UV-0036')], h);
    r.start();
    await r.settle();
    const v = r.view();
    expect(v.log).toStrictEqual(['agent-A A0000000 replied without a usable block.']);
    expect(v.items[0].phase).toBe('presented');
    expect(v.items[0].presentation).toMatchObject({ source: 'agent', presentedBy: 'agent-B', title: 'from B' });
    expect(h.sent.map((s) => s.to)).toStrictEqual([a.sessionID, b.sessionID]);
    expect(h.now() - T0).toBe(4_000); // A failed at the first poll, B won at the second: nobody waited 90 s
  });

  it('plain chatty text with no fence is ignored and the wait goes on until the block arrives', async () => {
    const h = harness();
    const a = agent('A');
    h.roster.push(a);
    h.onAsk.set(a.sessionID, () => 'On it, reading the upload queue now.');
    h.at(3, () => h.reply(a.sessionID, block('UV-0036')));
    const r = round([rowOf('UV-0036')], h);
    r.start();
    await r.settle();
    expect(r.view().items[0].phase).toBe('presented');
    expect(r.view().log).toStrictEqual([]);
    expect(h.sent).toHaveLength(1);
    expect(h.now() - T0).toBe(6_000);
  });

  it('a usable block beats an unusable one read in the same poll', async () => {
    const h = harness();
    const a = agent('A');
    h.roster.push(a);
    h.onAsk.set(a.sessionID, () => unusable('UV-0036'));
    h.at(1, () => h.reply(a.sessionID, block('UV-0036')));
    const r = round([rowOf('UV-0036')], h);
    r.start();
    await r.settle();
    expect(r.view().items[0].phase).toBe('presented');
    expect(r.view().log).toStrictEqual([]);
  });

  it('silence for 90 s (the default) logs "did not reply within 90s." for each candidate, then falls back with the timeout reason', async () => {
    const h = harness();
    h.roster.push(agent('A'), agent('B'));
    const r = round([rowOf('UV-0036')], h);
    r.start();
    await r.settle();
    const v = r.view();
    expect(v.log).toStrictEqual([
      'agent-A A0000000 did not reply within 90s.',
      'agent-B B0000000 did not reply within 90s.',
      'No presentation for uv:shop-app:UV-0036: The present call timed out. Showing the ledger row.',
    ]);
    expect(v.items[0].phase).toBe('fallback');
    expect(h.now() - T0).toBe(180_000);
  });

  it('nonsense timing options fall back to the defaults, and the poll interval is never zero', async () => {
    const h = harness({ pollMs: Number.NaN, presentTimeoutMs: Number.NaN });
    h.roster.push(agent('A'));
    const r = round([rowOf('UV-0036')], h);
    r.start();
    await r.settle();
    expect(r.view().log[0]).toBe('agent-A A0000000 did not reply within 90s.');
    expect(h.now() - T0).toBe(90_000);
    const h2 = harness({ pollMs: 0, presentTimeoutMs: 20 });
    h2.roster.push(agent('A'));
    const r2 = round([rowOf('UV-0036')], h2);
    r2.start();
    await r2.settle();
    expect(h2.sleeps()).toBe(20); // one millisecond at a time, not a spin
    expect(h2.now() - T0).toBe(20);
  });

  it('chatty text without a block at the timeout reads "replied without a usable block." and still counts as a timeout (the photo)', async () => {
    const h = harness({ presentTimeoutMs: 20_000 });
    const [a, b] = [agent('A'), agent('B')];
    h.roster.push(a, b);
    h.onAsk.set(a.sessionID, () => 'Looking into it.');
    h.onAsk.set(b.sessionID, () => 'Give me a minute.');
    const r = round([rowOf('UV-0021', { claim: 'x' }, { name: 'shop-app', path: '/work/shop-app' })], h);
    r.start();
    await r.settle();
    expect(r.view().log).toStrictEqual([
      'agent-A A0000000 replied without a usable block.',
      'agent-B B0000000 replied without a usable block.',
      'No presentation for uv:shop-app:UV-0021: The present call timed out. Showing the ledger row.',
    ]);
  });

  it('a candidate that timed out and one that replied badly: the reason is still the timeout, in either order', async () => {
    for (const badFirst of [true, false]) {
      const h = harness({ presentTimeoutMs: 10_000 });
      const [a, b] = [agent('A'), agent('B')];
      h.roster.push(a, b);
      h.onAsk.set((badFirst ? a : b).sessionID, () => unusable('UV-0036'));
      const r = round([rowOf('UV-0036')], h);
      r.start();
      await r.settle();
      expect(r.view().log.at(-1)).toBe('No presentation for uv:shop-app:UV-0036: The present call timed out. Showing the ledger row.');
      expect(r.view().log).toHaveLength(3);
    }
  });

  it('everyone replying with an unusable block is "Nobody replied with a usable block."', async () => {
    const h = harness();
    const [a, b] = [agent('A'), agent('B')];
    h.roster.push(a, b);
    h.onAsk.set(a.sessionID, () => unusable('UV-0036'));
    h.onAsk.set(b.sessionID, () => unusable('UV-0036'));
    const r = round([rowOf('UV-0036')], h);
    r.start();
    await r.settle();
    expect(r.view().log).toStrictEqual([
      'agent-A A0000000 replied without a usable block.',
      'agent-B B0000000 replied without a usable block.',
      'No presentation for uv:shop-app:UV-0036: Nobody replied with a usable block. Showing the ledger row.',
    ]);
    expect(h.now() - T0).toBe(4_000);
  });

  it('no candidate is an immediate fallback: "No agent in <repo> can be messaged.", nothing sent, nothing slept', () => {
    const cases: Agent[][] = [[], [agent('X', { cwd: '/work/billing' })], [agent('N', { cwd: '/elsewhere' })], [agent('D', { inboxSocketPath: undefined })]];
    for (const roster of cases) {
      const h = harness();
      h.roster.push(...roster);
      const r = round([rowOf('UV-0036')], h);
      r.start();
      const v = r.view(); // synchronously, with no awaiting
      expect(v.items[0].phase).toBe('fallback');
      expect(v.log).toStrictEqual(['No presentation for uv:shop-app:UV-0036: No agent in shop-app can be messaged. Showing the ledger row.']);
      expect(h.sent).toStrictEqual([]);
      expect(h.sleeps()).toBe(0);
    }
  });

  it('an agent that will not take the ask is logged and the next candidate is tried; so is one whose transcript size cannot be read', async () => {
    const h = harness({ maxPresenters: 3 });
    const [a, b, c] = [agent('A'), agent('B'), agent('C')];
    h.roster.push(a, b, c);
    h.failSend.set(a.sessionID, 'inbox closed');
    const size = h.deps.transcriptSize;
    h.deps.transcriptSize = async (x) => {
      if (x.sessionID === b.sessionID) throw new Error('ENOENT: no transcript');
      return size(x);
    };
    h.answerAll(c);
    const r = round([rowOf('UV-0036')], h);
    r.start();
    await r.settle();
    const v = r.view();
    expect(v.log).toStrictEqual(['agent-A A0000000 did not take the ask: inbox closed', 'agent-B B0000000 did not take the ask: ENOENT: no transcript']);
    expect(v.items[0].presentation).toMatchObject({ source: 'agent', presentedBy: 'agent-C' });
    expect(h.sent.map((s) => s.to)).toStrictEqual([a.sessionID, c.sessionID]);
  });

  it('when the only candidate will not take the ask the row falls back, and that is not a timeout', async () => {
    const h = harness();
    const a = agent('A');
    h.roster.push(a);
    h.failSend.set(a.sessionID, 'inbox closed');
    const r = round([rowOf('UV-0036')], h);
    r.start();
    await r.settle();
    expect(r.view().log).toStrictEqual(['agent-A A0000000 did not take the ask: inbox closed', 'No presentation for uv:shop-app:UV-0036: Nobody replied with a usable block. Showing the ledger row.']);
  });

  it('a transcript that cannot be read is reported once and the wait goes on to the timeout', async () => {
    const h = harness({
      presentTimeoutMs: 10_000,
      readSince: async () => {
        throw new Error('EIO');
      },
    });
    h.roster.push(agent('A'));
    const r = round([rowOf('UV-0036')], h);
    r.start();
    await r.settle();
    expect(r.view().log).toStrictEqual([
      'agent-A A0000000 transcript could not be read: EIO',
      'agent-A A0000000 did not reply within 10s.',
      'No presentation for uv:shop-app:UV-0036: The present call timed out. Showing the ledger row.',
    ]);
    expect(h.sleeps()).toBe(5);
  });

  it('only replies written after the ask count: a block already in the transcript is not an answer', async () => {
    const h = harness({ presentTimeoutMs: 10_000 });
    const a = agent('A');
    h.roster.push(a);
    h.reply(a.sessionID, block('UV-0036', { title: 'from an earlier round' }));
    h.reply(a.sessionID, unusable('UV-0036'));
    const r = round([rowOf('UV-0036')], h);
    r.start();
    await r.settle();
    expect(r.view().items[0].phase).toBe('fallback');
    expect(r.view().log).toStrictEqual(['agent-A A0000000 did not reply within 10s.', 'No presentation for uv:shop-app:UV-0036: The present call timed out. Showing the ledger row.']);
  });

  it('a reply that arrives after the fallback is ignored: nothing is polling any more', async () => {
    const h = harness({ presentTimeoutMs: 10_000 });
    const a = agent('A');
    h.roster.push(a);
    const r = round([rowOf('UV-0036')], h);
    r.start();
    await r.settle();
    const before = { sleeps: h.sleeps(), reads: h.reads(), sent: h.sent.length, view: r.view() };
    expect(before.view.items[0].phase).toBe('fallback');
    h.reply(a.sessionID, block('UV-0036', { title: 'too late' }));
    await ticks(20);
    await r.settle();
    expect({ sleeps: h.sleeps(), reads: h.reads(), sent: h.sent.length }).toStrictEqual({ sleeps: before.sleeps, reads: before.reads, sent: before.sent });
    expect(r.view()).toStrictEqual(before.view);
    expect(r.view().items[0].presentation?.source).toBe('ledger');
  });
});

describe('presenting: the ledger card', () => {
  it('is built from the row: Confirm, Deny and No change, all ungrounded, no tags, no evidence', () => {
    const h = harness();
    const row = rowOf('UV-0036', { claim: 'offline uploads reuse the session id minted online', doubt: 'never checked against a cold start', settles_it: 'replay the upload with the network off', raised_by: 'ana' });
    const r = round([row], h);
    r.start();
    expect(r.view().items[0].presentation).toStrictEqual({
      source: 'ledger',
      presentedBy: 'ana',
      needs: null,
      nature: null,
      checkable: null,
      title: 'offline uploads reuse the session id minted online',
      claim: 'offline uploads reuse the session id minted online',
      assessment: 'Doubt: never checked against a cold start\nTo settle it: replay the upload with the network off',
      evidence: [],
      options: [
        { letter: 'A', verb: 'confirm', title: 'The claim holds', cites: [], why: '“offline uploads reuse the session id minted online” holds.', grounding: 'ungrounded' },
        { letter: 'B', verb: 'deny', title: 'The claim is wrong', cites: [], why: '“offline uploads reuse the session id minted online” is wrong.', grounding: 'ungrounded' },
        { letter: 'C', verb: 'no_change', title: 'Leave the row as it is', cites: [], why: 'UV-0036 stays open for now.', grounding: 'ungrounded' },
      ],
    });
  });

  it('a tombstone with nothing but an id: no presenter name, plain wording', () => {
    const h = harness();
    const r = round([rowOf('TB-0004', { claim: undefined }, REPO, 'tombstone')], h);
    r.start();
    expect(r.view().items[0].presentation).toStrictEqual({
      source: 'ledger',
      presentedBy: '',
      needs: null,
      nature: null,
      checkable: null,
      title: 'TB-0004',
      claim: '',
      assessment: '',
      evidence: [],
      options: [
        { letter: 'A', verb: 'confirm', title: 'The tombstone stands', cites: [], why: 'TB-0004 stands.', grounding: 'ungrounded' },
        { letter: 'B', verb: 'deny', title: 'The tombstone is wrong', cites: [], why: 'TB-0004 is wrong.', grounding: 'ungrounded' },
        { letter: 'C', verb: 'no_change', title: 'Leave the row as it is', cites: [], why: 'TB-0004 stays open for now.', grounding: 'ungrounded' },
      ],
    });
  });
});

describe('presenting: several asks at once', () => {
  it('two asks to one agent for different rows are told apart by id, even when the replies are in the wrong order', async () => {
    const h = harness({ maxPresenters: 1 });
    const a = agent('A');
    h.roster.push(a);
    h.at(1, () => {
      h.reply(a.sessionID, block('UV-0002', { title: 'the second row' }));
      h.reply(a.sessionID, block('UV-0001', { title: 'the first row' }));
    });
    const r = round([rowOf('UV-0001'), rowOf('UV-0002')], h);
    r.start();
    await r.settle();
    const v = r.view();
    expect(v.items.map((i) => i.presentation?.title)).toStrictEqual(['the first row', 'the second row']);
    expect(v.log).toStrictEqual([]);
    expect(h.sentLabels()).toStrictEqual(['A ask UV-0001', 'A ask UV-0002']);
  });

  it('another row’s unusable block is not this row’s failure', async () => {
    const h = harness({ maxPresenters: 1 });
    const a = agent('A');
    h.roster.push(a);
    h.at(1, () => {
      h.reply(a.sessionID, unusable('UV-0002'));
      h.reply(a.sessionID, block('UV-0001', { title: 'the first row' }));
    });
    const r = round([rowOf('UV-0001'), rowOf('UV-0002')], h);
    r.start();
    await r.settle();
    const v = r.view();
    expect(phases(v)).toStrictEqual(['UV-0001:presented', 'UV-0002:fallback']);
    expect(v.log).toStrictEqual(['agent-A A0000000 replied without a usable block.', 'No presentation for uv:shop-app:UV-0002: Nobody replied with a usable block. Showing the ledger row.']);
  });

  it('a block for another row alone is not this ask’s reply: the wait goes on to the timeout, and it does not count as having written', async () => {
    const h = harness({ presentTimeoutMs: 10_000 });
    const a = agent('A');
    h.roster.push(a);
    h.onAsk.set(a.sessionID, () => block('UV-9999'));
    const r = round([rowOf('UV-0036')], h);
    r.start();
    await r.settle();
    expect(r.view().log).toStrictEqual(['agent-A A0000000 did not reply within 10s.', 'No presentation for uv:shop-app:UV-0036: The present call timed out. Showing the ledger row.']);
  });

  it('prefetch decides how many further rows are asked at once, and the window moves as rows are settled', async () => {
    for (const [prefetch, expected] of [
      [0, ['UV-0001']],
      [1, ['UV-0001', 'UV-0002']],
      [2, ['UV-0001', 'UV-0002', 'UV-0003']],
    ] as const) {
      const h = harness();
      h.roster.push(agent('A'));
      const r = round([1, 2, 3, 4].map((n) => rowOf(`UV-000${n}`)), h, { prefetch });
      r.start();
      await ticks(3);
      expect(h.sent.map((s) => idIn(s.text))).toStrictEqual(expected);
    }
    const h = harness({ maxPresenters: 1 });
    const a = agent('A');
    h.roster.push(a);
    h.answerAll(a);
    const rows = [1, 2, 3, 4].map((n) => rowOf(`UV-000${n}`));
    const r = round(rows, h); // prefetch 1 by default
    r.start();
    await r.settle();
    expect(h.sentLabels()).toStrictEqual(['A ask UV-0001', 'A ask UV-0002']);
    await r.approve(rows[0].key, 'C');
    await r.settle();
    expect(h.sentLabels()).toStrictEqual(['A ask UV-0001', 'A ask UV-0002', 'A ask UV-0003']);
    await r.approve(rows[1].key, 'C');
    await r.settle();
    expect(h.sentLabels().slice(3)).toStrictEqual(['A ask UV-0004']);
    expect(r.view().current).toBe(rows[2].key);
  });
});

// ---- start and select -----------------------------------------------------------------------------------------------

describe('start and select', () => {
  it('start makes the first row current and is not repeated; an unknown key throws', async () => {
    const h = harness();
    h.roster.push(agent('A'));
    const r = round([rowOf('UV-0001'), rowOf('UV-0002')], h);
    expect(() => r.select('nope')).toThrow(new Error('No lightning item nope.'));
    expect(() => r.reject('nope')).toThrow(new Error('No lightning item nope.'));
    expect(() => r.defer('nope')).toThrow(new Error('No lightning item nope.'));
    await expect(r.approve('nope', 'A')).rejects.toThrow(new Error('No lightning item nope.'));
    await expect(r.askSkeptics('nope')).rejects.toThrow(new Error('No lightning item nope.'));
    r.start();
    r.start();
    await ticks(3);
    expect(r.view()).toMatchObject({ active: true, current: 'uv:shop-app:UV-0001' });
    expect(h.sent).toHaveLength(2); // one ask per row, not four
  });

  it('select makes any card current, presents it if it was queued, and can show a settled card', async () => {
    const h = harness({ maxPresenters: 1 });
    const a = agent('A');
    h.roster.push(a);
    h.answerAll(a);
    const rows = [1, 2, 3, 4].map((n) => rowOf(`UV-000${n}`));
    const r = round(rows, h);
    r.start();
    await r.settle();
    expect(phases(r.view())).toStrictEqual(['UV-0001:presented', 'UV-0002:presented', 'UV-0003:queued', 'UV-0004:queued']);
    r.select(rows[3].key);
    expect(r.view().current).toBe(rows[3].key);
    await r.settle();
    expect(phases(r.view())).toStrictEqual(['UV-0001:presented', 'UV-0002:presented', 'UV-0003:queued', 'UV-0004:presented']);
    await r.approve(rows[0].key, 'C');
    r.select(rows[0].key); // the card of a settled row: its history
    await r.settle();
    const v = r.view();
    expect(v.current).toBe(rows[0].key);
    expect(item(v, rows[0].key)).toMatchObject({ phase: 'decided', decision: { option: 'C', verb: 'no_change', delivered: false } });
    expect(h.sentLabels().filter((l) => l.endsWith('UV-0001'))).toStrictEqual(['A ask UV-0001']); // never asked again
  });

  it('skips the rows the decision store hides at start, but a constructor lists the rows as given', async () => {
    const h = harness();
    h.roster.push(agent('A'));
    const rows = [rowOf('UV-0001'), rowOf('UV-0002'), rowOf('UV-0003')];
    h.decisions.record(rows[1].key, { state: 'decided', option: 'C', verb: 'no_change' }, T0 + WEEK);
    h.decisions.record(rows[2].key, { state: 'deferred' }, T0 + DAY);
    const r = round(rows, h, { prefetch: 2 });
    expect(r.view().items).toHaveLength(3);
    r.start();
    await ticks(3);
    const v = r.view();
    expect(v.items.map((i) => i.key)).toStrictEqual([rows[0].key]);
    expect(v.counts).toStrictEqual({ total: 1, remaining: 1, decided: 0, deferred: 0 });
    expect(h.sent.map((s) => idIn(s.text))).toStrictEqual(['UV-0001']);
    // a week on the decided row is back, a day on the deferred one
    h.set(T0 + WEEK + 1);
    const later = round(rows, h);
    later.start();
    expect(later.view().items).toHaveLength(3);
  });
});

// ---- approve --------------------------------------------------------------------------------------------------------

/** Rows presented by agent A (and B on the roster), settled. */
async function presented(rows: LedgerRow[], h: Harness, opts?: { prefetch?: number }) {
  const [a, b] = [agent('A'), agent('B')];
  h.roster.push(a, b);
  h.answerAll(a, b);
  const r = round(rows, h, opts);
  r.start();
  await r.settle();
  return { r, a, b };
}

describe('approve', () => {
  it('relays the option to the presenting agent, records the decision for a week and moves on to the next card', async () => {
    const h = harness();
    const rows = [rowOf('UV-0001'), rowOf('UV-0002')];
    const { r, a } = await presented(rows, h);
    const card = r.view().items[0].presentation;
    expect(card?.presentedBy).toBe('agent-A');
    const at = h.now();
    expect(await r.approve(rows[0].key, 'A')).toStrictEqual({ delivered: true, decided: true });
    expect(h.sent.at(-1)).toStrictEqual({ to: a.sessionID, text: lightningDecision(rows[0], { letter: 'A', verb: 'challenge', title: 'Qualify the claim', why: 'Holds only while the queue keeps the id.' }, card!) });
    const v = r.view();
    expect(item(v, rows[0].key)).toMatchObject({ phase: 'decided', decision: { option: 'A', verb: 'challenge', at, delivered: true } });
    expect(v.current).toBe(rows[1].key);
    expect(v.counts).toStrictEqual({ total: 2, remaining: 1, decided: 1, deferred: 0 });
    expect(h.kv.get(KEYS.lightning)).toStrictEqual({ [rows[0].key]: { state: 'decided', option: 'A', verb: 'challenge', at, until: at + WEEK } });
    expect(h.decisions.hidden(rows[0].key)).toBe(true);
  });

  it('each verb sends its own instruction', async () => {
    const h = harness();
    const [a] = [agent('A')];
    h.roster.push(a);
    const options = ['A | confirm | Holds | 1 | Line 5 says so.', 'B | deny | Wrong | 2 | The note is not code.', 'C | challenge | Only offline | 1 | Qualify it.'];
    h.onAsk.set(a.sessionID, (text) => block(idIn(text), { options }));
    const rows = [rowOf('UV-0001'), rowOf('TB-0004', {}, REPO, 'tombstone')];
    const r = round(rows, h);
    r.start();
    await r.settle();
    for (const [row, letter, verb, title, why] of [
      [rows[0], 'A', 'confirm', 'Holds', 'Line 5 says so.'],
      [rows[1], 'B', 'deny', 'Wrong', 'The note is not code.'],
    ] as const) {
      const card = item(r.view(), row.key).presentation!;
      await r.approve(row.key, letter);
      expect(h.sent.at(-1)?.text).toBe(lightningDecision(row, { letter, verb, title, why }, card));
    }
    expect(h.sent.filter((s) => kindOfSent(s.text) === 'decision')).toHaveLength(2);
  });

  it('checks the key, then the letter, then the phase', async () => {
    const h = harness();
    const a = agent('A');
    h.roster.push(a); // silent: the row stays "presenting"
    const rows = [rowOf('UV-0036')];
    const r = round(rows, h);
    r.start();
    await ticks(3);
    expect(r.view().items[0].phase).toBe('presenting');
    expect(await r.approve(rows[0].key, 'A')).toStrictEqual({ delivered: false, decided: false }); // nothing to approve yet
    expect(h.sent.map((s) => kindOfSent(s.text))).toStrictEqual(['ask']);

    const h2 = harness();
    const { r: r2 } = await presented([rowOf('UV-0036')], h2);
    const sentBefore = h2.sent.length;
    await expect(r2.approve('uv:shop-app:UV-0036', 'D')).rejects.toThrow(new Error('Option D is not offered for uv:shop-app:UV-0036.'));
    await expect(r2.approve('uv:shop-app:UV-0036', 'z' as 'A')).rejects.toThrow(new Error('Option z is not offered for uv:shop-app:UV-0036.'));
    expect(h2.sent).toHaveLength(sentBefore);
    expect(r2.view().items[0].phase).toBe('presented');
  });

  it('no_change records the decision and sends nothing: decided, though not delivered', async () => {
    const h = harness();
    const rows = [rowOf('UV-0001'), rowOf('UV-0002')];
    const { r } = await presented(rows, h);
    const sentBefore = h.sent.length;
    const at = h.now();
    expect(await r.approve(rows[0].key, 'C')).toStrictEqual({ delivered: false, decided: true });
    expect(h.sent).toHaveLength(sentBefore);
    expect(item(r.view(), rows[0].key)).toMatchObject({ phase: 'decided', decision: { option: 'C', verb: 'no_change', at, delivered: false } });
    expect(h.kv.get(KEYS.lightning)).toStrictEqual({ [rows[0].key]: { state: 'decided', option: 'C', verb: 'no_change', at, until: at + WEEK } });
  });

  it('a second approve of a decided item sends nothing and says it is decided, whichever valid letter it names', async () => {
    const h = harness();
    const rows = [rowOf('UV-0001'), rowOf('UV-0002')];
    const { r } = await presented(rows, h);
    expect(await r.approve(rows[0].key, 'A')).toStrictEqual({ delivered: true, decided: true });
    const sentBefore = h.sent.length;
    const stored = h.kv.get(KEYS.lightning);
    expect(await r.approve(rows[0].key, 'A')).toStrictEqual({ delivered: false, decided: true });
    expect(await r.approve(rows[0].key, 'B')).toStrictEqual({ delivered: false, decided: true });
    expect(h.sent).toHaveLength(sentBefore);
    expect(h.kv.get(KEYS.lightning)).toStrictEqual(stored);
    expect(item(r.view(), rows[0].key).decision?.option).toBe('A');
  });

  it('approves racing each other send once, and reject and defer do nothing while the relay is in flight', async () => {
    const h = harness();
    const rows = [rowOf('UV-0001'), rowOf('UV-0002')];
    const { r } = await presented(rows, h);
    const release = h.hold();
    const results = [r.approve(rows[0].key, 'A'), r.approve(rows[0].key, 'A'), r.approve(rows[0].key, 'B')];
    await ticks(3);
    expect(h.sent.filter((s) => kindOfSent(s.text) === 'decision')).toHaveLength(1);
    r.reject(rows[0].key);
    r.defer(rows[0].key);
    expect(item(r.view(), rows[0].key).phase).toBe('presented');
    expect(h.decisions.hidden(rows[0].key)).toBe(false);
    release();
    expect(await Promise.all(results)).toStrictEqual([
      { delivered: true, decided: true },
      { delivered: false, decided: true },
      { delivered: false, decided: true },
    ]);
    expect(h.sent.filter((s) => kindOfSent(s.text) === 'decision')).toHaveLength(1);
    expect(item(r.view(), rows[0].key)).toMatchObject({ phase: 'decided', decision: { option: 'A' } });
  });

  it('racing approves against a refusing agent try once and all report not decided', async () => {
    const h = harness();
    const rows = [rowOf('UV-0001'), rowOf('UV-0002')];
    const { r, a } = await presented(rows, h);
    h.failSend.set(a.sessionID, 'socket closed');
    const release = h.hold();
    const results = [r.approve(rows[0].key, 'A'), r.approve(rows[0].key, 'A')];
    await ticks(3);
    release();
    expect(await Promise.all(results)).toStrictEqual([
      { delivered: false, decided: false },
      { delivered: false, decided: false },
    ]);
    expect(h.sent.filter((s) => kindOfSent(s.text) === 'decision')).toHaveLength(1);
    expect(r.view().log).toStrictEqual(['agent-A did not take the decision: socket closed']);
  });

  it('an agent that will not take the decision leaves the row open and unrecorded; a retry can succeed', async () => {
    const h = harness();
    const rows = [rowOf('UV-0001'), rowOf('UV-0002')];
    const { r, a } = await presented(rows, h);
    h.failSend.set(a.sessionID, 'socket closed');
    expect(await r.approve(rows[0].key, 'B')).toStrictEqual({ delivered: false, decided: false });
    expect(r.view().log).toStrictEqual(['agent-A did not take the decision: socket closed']);
    expect(item(r.view(), rows[0].key)).toMatchObject({ phase: 'presented', decision: null });
    expect(r.view().current).toBe(rows[0].key);
    expect(h.kv.get(KEYS.lightning)).toBeUndefined();
    expect(h.decisions.hidden(rows[0].key)).toBe(false);
    h.failSend.delete(a.sessionID);
    expect(await r.approve(rows[0].key, 'B')).toStrictEqual({ delivered: true, decided: true });
    expect(h.decisions.hidden(rows[0].key)).toBe(true);
  });

  it('sends to the live roster entry of the presenter, so a restarted agent’s new inbox is used', async () => {
    const h = harness();
    const { r, a } = await presented([rowOf('UV-0001'), rowOf('UV-0002')], h);
    h.roster[0] = { ...a, inboxSocketPath: '/tmp/A-new.sock', pid: 200 };
    const seen: Agent[] = [];
    const send = h.deps.sendInbox;
    h.deps.sendInbox = async (x, text) => {
      seen.push(x);
      return send(x, text);
    };
    await r.approve('uv:shop-app:UV-0001', 'A');
    expect(seen.map((x) => x.inboxSocketPath)).toStrictEqual(['/tmp/A-new.sock']);
  });

  describe('a ledger card (nobody presented it)', () => {
    async function fallbackRound(h: Harness) {
      const [x, p1, p2] = [agent('X', { cwd: '/work/billing' }), agent('P1'), agent('P2')];
      h.roster.push(x, p1, p2);
      h.onAsk.set(p1.sessionID, () => unusable('UV-0036'));
      h.onAsk.set(p2.sessionID, () => unusable('UV-0036'));
      const row = rowOf('UV-0036', { claim: 'offline uploads reuse the session id minted online' });
      const r = round([row], h);
      r.start();
      await r.settle();
      expect(r.view().items[0].phase).toBe('fallback');
      return { r, row, x, p1, p2 };
    }

    it('goes to the first messageable agent of the row’s repo, in roster order, never another repo’s', async () => {
      const h = harness();
      const { r, row, p1 } = await fallbackRound(h);
      const card = r.view().items[0].presentation!;
      expect(await r.approve(row.key, 'A')).toStrictEqual({ delivered: true, decided: true });
      expect(h.sent.at(-1)).toStrictEqual({ to: p1.sessionID, text: lightningDecision(row, { letter: 'A', verb: 'confirm', title: 'The claim holds', why: card.options[0].why }, card) });
    });

    it('uses the next agent when the first has gone', async () => {
      const h = harness();
      const { r, row, p2 } = await fallbackRound(h);
      h.roster.splice(1, 1); // P1 leaves
      expect(await r.approve(row.key, 'B')).toStrictEqual({ delivered: true, decided: true });
      expect(h.sent.at(-1)?.to).toBe(p2.sessionID);
    });

    it('with nobody to tell it says so, records nothing and leaves the row in the queue; no_change needs nobody', async () => {
      const h = harness();
      const { r, row } = await fallbackRound(h);
      const sentBefore = h.sent.length;
      h.roster.splice(1); // everyone in shop-app leaves, only X (billing) is left
      expect(await r.approve(row.key, 'A')).toStrictEqual({ delivered: false, decided: false });
      expect(r.view().log.at(-1)).toBe('Nobody in shop-app can be messaged: copy the decision by hand.');
      expect(h.sent).toHaveLength(sentBefore);
      expect(item(r.view(), row.key)).toMatchObject({ phase: 'fallback', decision: null });
      expect(h.kv.get(KEYS.lightning)).toBeUndefined();
      expect(h.decisions.hidden(row.key)).toBe(false);
      expect(await r.approve(row.key, 'C')).toStrictEqual({ delivered: false, decided: true });
      expect(h.decisions.hidden(row.key)).toBe(true);
    });
  });

  it('keeps going when the store cannot save, and says so', async () => {
    class FailingKV extends MemoryKV {
      set(): void {
        throw new Error('disk full');
      }
    }
    const h = harness({}, new FailingKV());
    const rows = [rowOf('UV-0001'), rowOf('UV-0002'), rowOf('UV-0003')];
    const { r } = await presented(rows, h);
    expect(await r.approve(rows[0].key, 'A')).toStrictEqual({ delivered: true, decided: true });
    r.defer(rows[1].key);
    expect(r.view().log).toStrictEqual(['Could not save the decision for uv:shop-app:UV-0001: disk full', 'Could not save the deferral for uv:shop-app:UV-0002: disk full']);
    expect(phases(r.view()).slice(0, 2)).toStrictEqual(['UV-0001:decided', 'UV-0002:deferred']);
  });
});

// ---- reject ---------------------------------------------------------------------------------------------------------

describe('reject', () => {
  it('drops the card, sends nothing, and asks again later with a different presenter; when everyone has rejected it, it shows the ledger row quietly', async () => {
    const h = harness({ maxPresenters: 1 });
    const rows = [rowOf('UV-0001'), rowOf('UV-0002')];
    const [a, b] = [agent('A'), agent('B')];
    h.roster.push(a, b);
    h.answerAll(a, b);
    const r = round(rows, h, { prefetch: 0 });
    r.start();
    await r.settle();
    expect(item(r.view(), rows[0].key).presentation?.presentedBy).toBe('agent-A');

    r.reject(rows[0].key);
    let v = r.view();
    expect(v.items.map((i) => i.id)).toStrictEqual(['UV-0002', 'UV-0001']); // to the back of the queue
    expect(item(v, rows[0].key)).toMatchObject({ phase: 'queued', presentation: null, decision: null, votes: { asked: false } });
    expect(v.current).toBe(rows[1].key);
    await r.settle();
    expect(phases(r.view())).toStrictEqual(['UV-0002:presented', 'UV-0001:queued']);
    expect(h.sentLabels()).toStrictEqual(['A ask UV-0001', 'A ask UV-0002']); // nothing was relayed to anybody
    expect(h.kv.get(KEYS.lightning)).toBeUndefined();

    await r.approve(rows[1].key, 'C'); // R1 is next: A rejected it, so B is asked
    await r.settle();
    expect(item(r.view(), rows[0].key).presentation?.presentedBy).toBe('agent-B');
    expect(h.sentLabels().slice(2)).toStrictEqual(['B ask UV-0001']);

    r.reject(rows[0].key); // B rejects it too: nobody is left to ask
    v = r.view();
    expect(item(v, rows[0].key)).toMatchObject({ phase: 'fallback', presentation: { source: 'ledger' } });
    expect(v.log).toStrictEqual([]); // no noise
    expect(v.current).toBe(rows[0].key);
    expect(h.sentLabels()).toHaveLength(3);
    await r.settle();
  });

  it('each reject moves the card to the back and the next undecided one becomes current', () => {
    const h = harness();
    const rows = [1, 2, 3].map((n) => rowOf(`UV-000${n}`));
    const r = round(rows, h);
    r.start(); // nobody to ask: every card is a ledger card at once
    r.reject(rows[0].key);
    expect(r.view().items.map((i) => i.id)).toStrictEqual(['UV-0002', 'UV-0003', 'UV-0001']);
    expect(r.view().current).toBe(rows[1].key);
    r.reject(rows[1].key);
    expect(r.view().items.map((i) => i.id)).toStrictEqual(['UV-0003', 'UV-0001', 'UV-0002']);
    expect(r.view().current).toBe(rows[2].key);
  });

  it('rejecting the only card brings it straight back', () => {
    const h = harness();
    const row = rowOf('UV-0001');
    const r = round([row], h);
    r.start();
    r.reject(row.key);
    expect(r.view()).toMatchObject({ current: row.key, items: [{ phase: 'fallback' }] });
  });

  it('does nothing to a card that is not up: queued, presenting or settled', async () => {
    const h = harness();
    h.roster.push(agent('A')); // silent
    const rows = [rowOf('UV-0001'), rowOf('UV-0002'), rowOf('UV-0003')];
    const r = round(rows, h);
    const queued = r.view();
    r.reject(rows[0].key);
    expect(r.view()).toStrictEqual(queued);
    r.start();
    await ticks(3);
    const presenting = r.view();
    expect(phases(presenting)).toStrictEqual(['UV-0001:presenting', 'UV-0002:presenting', 'UV-0003:queued']);
    r.reject(rows[0].key);
    expect(r.view()).toStrictEqual(presenting);
    await r.approve(rows[0].key, 'C').catch(() => undefined);
    r.defer(rows[2].key);
    const settled = r.view();
    r.reject(rows[2].key);
    expect(r.view()).toStrictEqual(settled);
  });
});

// ---- defer ----------------------------------------------------------------------------------------------------------

describe('defer', () => {
  const realTZ = process.env.TZ;
  afterEach(() => {
    if (realTZ === undefined) delete process.env.TZ;
    else process.env.TZ = realTZ;
  });

  // zone, now, the next local midnight, the zone's UTC offset in minutes at `now` (west positive)
  const midnights: Array<[string, string, string, number]> = [
    ['America/New_York', '2026-01-15T23:59:00-05:00', '2026-01-16T00:00:00-05:00', 300],
    ['America/New_York', '2026-01-16T00:00:00-05:00', '2026-01-17T00:00:00-05:00', 300],
    ['America/New_York', '2026-03-08T00:00:00-05:00', '2026-03-09T00:00:00-04:00', 300], // the 23-hour day
    ['America/New_York', '2026-11-01T00:00:00-04:00', '2026-11-02T00:00:00-05:00', 240], // the 25-hour day
    ['Pacific/Auckland', '2026-01-15T23:59:00+13:00', '2026-01-16T00:00:00+13:00', -780],
    ['Pacific/Auckland', '2026-01-16T00:00:00+13:00', '2026-01-17T00:00:00+13:00', -780],
  ];
  it.each(midnights)('%s at %s: hidden until the next local midnight, %s', (tz, nowIso, untilIso, offset) => {
    process.env.TZ = tz;
    const now = Date.parse(nowIso);
    expect(new Date(now).getTimezoneOffset()).toBe(offset); // the zone really took effect
    const h = harness();
    h.set(now);
    const row = rowOf('UV-0001');
    const r = round([row], h);
    r.start();
    r.defer(row.key);
    const until = Date.parse(untilIso);
    expect(h.kv.get(KEYS.lightning)).toStrictEqual({ [row.key]: { state: 'deferred', at: now, until } });
    h.set(until - 1);
    expect(h.decisions.hidden(row.key)).toBe(true);
    h.set(until);
    expect(h.decisions.hidden(row.key)).toBe(false);
  });

  it('advances past decided and deferred cards, and current is null when none remain', async () => {
    const h = harness();
    const rows = [1, 2, 3, 4].map((n) => rowOf(`UV-000${n}`));
    const { r } = await presented(rows, h);
    await r.approve(rows[0].key, 'C');
    expect(r.view().current).toBe(rows[1].key);
    r.defer(rows[2].key); // not the current one: current stays
    expect(r.view().current).toBe(rows[1].key);
    r.defer(rows[1].key); // the current one: skips the deferred third, lands on the fourth
    expect(r.view().current).toBe(rows[3].key);
    r.defer(rows[3].key);
    const v = r.view();
    expect(v.current).toBeNull();
    expect(v.counts).toStrictEqual({ total: 4, remaining: 0, decided: 1, deferred: 3 });
    expect(phases(v)).toStrictEqual(['UV-0001:decided', 'UV-0002:deferred', 'UV-0003:deferred', 'UV-0004:deferred']);
  });

  it('does nothing to a card already decided or deferred, so the first record stands', async () => {
    const h = harness();
    const rows = [rowOf('UV-0001'), rowOf('UV-0002')];
    const { r } = await presented(rows, h);
    await r.approve(rows[0].key, 'C');
    r.defer(rows[1].key);
    const stored = h.kv.get(KEYS.lightning);
    h.set(h.now() + 1000);
    r.defer(rows[0].key);
    r.defer(rows[1].key);
    expect(h.kv.get(KEYS.lightning)).toStrictEqual(stored);
    expect(item(r.view(), rows[0].key).phase).toBe('decided');
  });

  it('a card still being presented can be deferred, and its late reply is ignored', async () => {
    const h = harness();
    const a = agent('A');
    h.roster.push(a);
    const rows = [rowOf('UV-0001')];
    const r = round(rows, h);
    r.start();
    await ticks(3);
    expect(r.view().items[0].phase).toBe('presenting');
    r.defer(rows[0].key);
    h.reply(a.sessionID, block('UV-0001'));
    await r.settle();
    expect(r.view().items[0]).toMatchObject({ phase: 'deferred', presentation: null });
    expect(r.view().log).toStrictEqual([]);
  });
});

// ---- skeptics -------------------------------------------------------------------------------------------------------

describe('asking skeptics', () => {
  const rosterOf = (...ids: string[]): Agent[] => ids.map((id) => agent(id, { cwd: id.startsWith('X') ? '/work/billing' : '/work/shop-app' }));

  /** The presenter P and the rest, with row UV-0036 presented by P. */
  async function withPanel(h: Harness, ids: string[], opts?: { panelSize?: number }) {
    const roster = rosterOf(...ids);
    h.roster.push(...roster);
    const row = rowOf('UV-0036');
    h.onAsk.set(roster[0].sessionID, () => block('UV-0036'));
    const r = round([row], h, opts);
    r.start();
    await r.settle();
    expect(r.view().items[0].presentation?.presentedBy).toBe('agent-P');
    return { r, row, key: row.key, roster, byName: (n: string) => roster.find((a) => a.name === `agent-${n}`)! };
  }
  const votesSent = (h: Harness) => h.sent.filter((s) => kindOfSent(s.text) === 'vote').map((s) => s.to.slice(0, 2));

  it('asks the presenter’s repo first, then the roster, at most panelSize, never the presenter; votes.asked is false until called', async () => {
    const h = harness({ voteTimeoutMs: 10_000 });
    const { r, row, key } = await withPanel(h, ['P', 'X1', 'S2', 'S3', 'X4', 'X5']);
    expect(item(r.view(), key).votes).toStrictEqual({ asked: false, tally: { concur: 0, concern: 0, refuted: 0, silent: 0, asked: 0 }, entries: [] });
    await r.askSkeptics(key);
    expect(votesSent(h)).toStrictEqual(['S2', 'S3', 'X1', 'X4']);
    const card = item(r.view(), key).presentation!;
    expect(h.sent.filter((s) => kindOfSent(s.text) === 'vote').every((s) => s.text === lightningVoteAsk(row, card))).toBe(true);
    const votes = item(r.view(), key).votes;
    expect(votes.asked).toBe(true);
    expect(votes.entries).toStrictEqual(['S2', 'S3', 'X1', 'X4'].map((n) => ({ sessionID: `${n.padEnd(8, '0')}-5e55-4a1b`, name: `agent-${n}`, vote: null, prefers: null, reason: '' })));
    expect(votes.tally).toStrictEqual({ concur: 0, concern: 0, refuted: 0, silent: 4, asked: 4 });
  });

  it('reads votes by row id, only past the ask, and a late vote still counts', async () => {
    const h = harness({ voteTimeoutMs: 10_000 });
    const { r, key, byName } = await withPanel(h, ['P', 'X1', 'S2', 'S3', 'X4']);
    h.reply(byName('X4').sessionID, vote('UV-0036', 'concur')); // written before the ask: not a reply to it
    const sleepsBefore = h.sleeps();
    const askedAt = h.now();
    await r.askSkeptics(key);
    h.reply(byName('S2').sessionID, 'Sure, looking.\n' + vote('UV-0036', 'concur', 'A'));
    h.reply(byName('S3').sessionID, vote('UV-0036', 'refuted', 'B'));
    h.reply(byName('X1').sessionID, vote('UV-9999', 'concur')); // a vote on another row
    h.at(sleepsBefore + 9, () => h.reply(byName('X1').sessionID, vote('UV-0036', 'concern', 'none'))); // well after the 10 s window
    await r.settle();
    const votes = item(r.view(), key).votes;
    expect(votes.entries.map((e) => [e.name, e.vote, e.prefers])).toStrictEqual([
      ['agent-S2', 'concur', 'A'],
      ['agent-S3', 'refuted', 'B'],
      ['agent-X1', 'concern', null],
      ['agent-X4', null, null],
    ]);
    expect(votes.entries[0].reason).toBe('matches the code');
    expect(votes.tally).toStrictEqual({ concur: 1, concern: 1, refuted: 1, silent: 1, asked: 4 });
    expect(r.view().log).toStrictEqual(['2 of 4 did not vote on uv:shop-app:UV-0036 within 10s. A late vote still counts.']);
    // the silent one is waited for through the late window, and no longer
    expect(h.now() - askedAt).toBe(10_000 + 15 * 60_000);
  });

  it('asking twice does not ask an agent again; a newcomer is asked while the panel has room', async () => {
    const h = harness({ voteTimeoutMs: 10_000 });
    const { r, key, roster } = await withPanel(h, ['P', 'S1', 'S2'], { panelSize: 3 });
    await r.askSkeptics(key);
    expect(votesSent(h)).toStrictEqual(['S1', 'S2']);
    await r.askSkeptics(key);
    expect(votesSent(h)).toStrictEqual(['S1', 'S2']);
    const s3 = agent('S3');
    const s4 = agent('S4');
    h.roster.push(s3, s4);
    await r.askSkeptics(key);
    expect(votesSent(h)).toStrictEqual(['S1', 'S2', 'S3']); // one place was left
    await r.askSkeptics(key);
    expect(votesSent(h)).toHaveLength(3);
    expect(item(r.view(), key).votes.entries.map((e) => e.name)).toStrictEqual(['agent-S1', 'agent-S2', 'agent-S3']);
    expect(roster).toHaveLength(3);
  });

  it('a send failure leaves that agent a silent entry and the others carry on', async () => {
    const h = harness({ voteTimeoutMs: 10_000 });
    const { r, key, byName } = await withPanel(h, ['P', 'X1', 'S2']);
    h.failSend.set(byName('S2').sessionID, 'refused');
    await r.askSkeptics(key);
    h.reply(byName('X1').sessionID, vote('UV-0036', 'concur'));
    await r.settle(); // only X1 is being waited for, and it answered
    const votes = item(r.view(), key).votes;
    expect(votes.entries.map((e) => [e.name, e.vote])).toStrictEqual([
      ['agent-S2', null],
      ['agent-X1', 'concur'],
    ]);
    expect(votes.tally).toStrictEqual({ concur: 1, concern: 0, refuted: 0, silent: 1, asked: 2 });
    expect(r.view().log).toStrictEqual(['agent-S2 S2000000 did not take the vote ask: refused']);
  });

  it('with nobody else to ask it is asked, empty, and says why', async () => {
    const h = harness();
    const { r, key } = await withPanel(h, ['P']);
    await r.askSkeptics(key);
    expect(item(r.view(), key).votes).toStrictEqual({ asked: true, tally: { concur: 0, concern: 0, refuted: 0, silent: 0, asked: 0 }, entries: [] });
    expect(r.view().log).toStrictEqual(['No other agent can be messaged to vote on uv:shop-app:UV-0036.']);
    expect(votesSent(h)).toStrictEqual([]);
  });

  it('works on a ledger card too, where nobody is excluded as the presenter; not on a card that is not up', async () => {
    const h = harness({ presentTimeoutMs: 10_000 });
    const [a, b] = [agent('A'), agent('B')];
    h.roster.push(a, b);
    h.onAsk.set(a.sessionID, () => unusable('UV-0036'));
    h.onAsk.set(b.sessionID, () => unusable('UV-0036'));
    const rows = [rowOf('UV-0036'), rowOf('UV-0037')];
    const r = round(rows, h, { prefetch: 0 });
    await r.askSkeptics(rows[1].key); // queued: nothing happens
    expect(item(r.view(), rows[1].key).votes.asked).toBe(false);
    r.start();
    await r.settle();
    expect(r.view().items[0].phase).toBe('fallback');
    await r.askSkeptics(rows[0].key);
    expect(votesSent(h)).toStrictEqual(['A0', 'B0']);
    expect(item(r.view(), rows[0].key).votes.asked).toBe(true);
    expect(item(r.view(), rows[1].key).votes.asked).toBe(false);
    r.abort();
  });

  it('stops reading once the card is settled: the silent stay silent, and nobody waits out the late window', async () => {
    const h = harness({ voteTimeoutMs: 10_000 });
    const { r, key, byName } = await withPanel(h, ['P', 'S1', 'S2']);
    const askedAt = h.now();
    await r.askSkeptics(key);
    await ticks(3);
    await r.approve(key, 'C');
    await r.settle();
    expect(h.now() - askedAt).toBeLessThan(10_000);
    h.reply(byName('S1').sessionID, vote('UV-0036', 'concur')); // too late for this card
    await ticks(10);
    expect(item(r.view(), key).votes.tally).toStrictEqual({ concur: 0, concern: 0, refuted: 0, silent: 2, asked: 2 });
  });

  it('a rejection clears the votes with the card, and the old poller adds nothing to the next one', async () => {
    const h = harness({ voteTimeoutMs: 10_000 });
    const { r, key, byName } = await withPanel(h, ['P', 'S1', 'S2']);
    await r.askSkeptics(key);
    await ticks(3);
    r.reject(key);
    const cleared = { asked: false, tally: { concur: 0, concern: 0, refuted: 0, silent: 0, asked: 0 }, entries: [] };
    expect(item(r.view(), key).votes).toStrictEqual(cleared);
    h.reply(byName('S1').sessionID, vote('UV-0036', 'concur'));
    h.reply(byName('S2').sessionID, vote('UV-0036', 'refuted'));
    await r.settle(); // the row is presented again, by the agents that did not reject it
    expect(item(r.view(), key).votes).toStrictEqual(cleared);
  });
});

// ---- abort ----------------------------------------------------------------------------------------------------------

describe('abort', () => {
  it('cancels every poller: after abort and settle nothing sleeps, reads or sends again, and the cards go back to the queue', async () => {
    const h = harness();
    h.roster.push(agent('A'), agent('B')); // silent, so each ask would be polled for 90 s
    const rows = [1, 2, 3].map((n) => rowOf(`UV-000${n}`));
    const r = round(rows, h, { prefetch: 2 });
    r.start();
    await ticks(4);
    expect(h.sleeps()).toBeGreaterThan(2);
    expect(r.view().active).toBe(true);
    r.abort();
    await r.settle();
    const after = { sleeps: h.sleeps(), reads: h.reads(), sent: h.sent.length, now: h.now() };
    await ticks(30);
    expect({ sleeps: h.sleeps(), reads: h.reads(), sent: h.sent.length, now: h.now() }).toStrictEqual(after);
    const v = r.view();
    expect(v.active).toBe(false);
    expect(phases(v)).toStrictEqual(['UV-0001:queued', 'UV-0002:queued', 'UV-0003:queued']);
    expect(v.log).toStrictEqual([]); // an abort is not a failure
    // the round stays stopped
    r.select(rows[1].key);
    r.start();
    r.abort();
    await r.settle();
    expect(h.sent).toHaveLength(after.sent);
    expect(h.sleeps()).toBe(after.sleeps);
  });

  it('a poller parked in a sleep that never wakes is released by abort, and a sleep that wakes afterwards starts nothing new', async () => {
    const parked: Array<() => void> = [];
    let sleeps = 0;
    const h = harness({
      sleep: () => {
        sleeps++;
        return new Promise<void>((res) => parked.push(res));
      },
    });
    h.roster.push(agent('A'));
    const r = round([rowOf('UV-0001'), rowOf('UV-0002')], h);
    r.start();
    await ticks(3);
    expect(sleeps).toBe(2);
    r.abort();
    await r.settle(); // would hang if a poller were waiting on its sleep
    for (const wake of parked.splice(0)) wake();
    await ticks(10);
    expect(sleeps).toBe(2);
    expect(h.sent).toHaveLength(2);
    expect(h.reads()).toBe(0);
  });

  it('an abort while the cites are being grounded leaves the card in the queue when the git calls return', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const git = fakeGit();
    const h = harness({
      run: async (cmd, args, opts) => {
        await gate;
        return git.run(cmd, args, opts);
      },
    });
    const a = agent('A');
    h.roster.push(a);
    h.answerAll(a);
    const r = round([rowOf('UV-0001')], h);
    r.start();
    await ticks(5);
    expect(git.calls).toHaveLength(0); // the reply was read; the first git call is waiting on the gate
    r.abort();
    release();
    await r.settle();
    expect(r.view().items[0]).toMatchObject({ phase: 'queued', presentation: null });
    expect(git.calls).toHaveLength(4); // the first cite, already in flight, ran to its end; the second was never started
  });

  it('cancels the vote pollers too', async () => {
    const h = harness({ voteTimeoutMs: 10_000 });
    const [p, s] = [agent('P'), agent('S1')];
    h.roster.push(p, s);
    h.onAsk.set(p.sessionID, () => block('UV-0036'));
    const row = rowOf('UV-0036');
    const r = round([row], h);
    r.start();
    await r.settle();
    await r.askSkeptics(row.key);
    await ticks(4);
    r.abort();
    await r.settle();
    const after = { sleeps: h.sleeps(), reads: h.reads() };
    h.reply(s.sessionID, vote('UV-0036', 'concur'));
    await ticks(30);
    expect({ sleeps: h.sleeps(), reads: h.reads() }).toStrictEqual(after);
    expect(item(r.view(), row.key).votes.tally.silent).toBe(1);
  });

  it('leaves the decisions already recorded', async () => {
    const h = harness();
    const rows = [rowOf('UV-0001'), rowOf('UV-0002')];
    const { r } = await presented(rows, h);
    await r.approve(rows[0].key, 'A');
    r.abort();
    expect(h.decisions.hidden(rows[0].key)).toBe(true);
    expect(item(r.view(), rows[0].key).phase).toBe('decided');
    expect(r.view().active).toBe(false);
  });

  it('is harmless before start, and a round that was never started is not active', async () => {
    const h = harness();
    h.roster.push(agent('A'));
    const r = round([rowOf('UV-0001')], h);
    expect(r.view().active).toBe(false);
    r.abort();
    r.start();
    await r.settle();
    expect(h.sent).toStrictEqual([]);
    expect(r.view().active).toBe(false);
  });
});

// ---- change notifications -------------------------------------------------------------------------------------------

describe('onChange', () => {
  it('fires after state changes with the round, so a listener sees each phase', async () => {
    const seen: LightningView[] = [];
    const rounds2: LightningRound[] = [];
    const h = harness({
      onChange: (x) => {
        rounds2.push(x);
        seen.push(x.view());
      },
    });
    const rows = [rowOf('UV-0001'), rowOf('UV-0002')];
    const a = agent('A');
    h.roster.push(a);
    h.answerAll(a);
    const r = round(rows, h);
    r.start();
    expect(seen.some((v) => v.items[0].phase === 'presenting')).toBe(true);
    await r.settle();
    expect(seen.at(-1)?.items.map((i) => i.phase)).toStrictEqual(['presented', 'presented']);
    await r.approve(rows[0].key, 'C');
    expect(seen.at(-1)?.items[0].phase).toBe('decided');
    expect(seen.at(-1)?.current).toBe(rows[1].key);
    r.reject(rows[1].key);
    expect(seen.at(-1)?.items.at(-1)?.phase).not.toBe('presented');
    r.abort();
    expect(seen.at(-1)?.active).toBe(false);
    expect(rounds2.every((x) => x === r)).toBe(true);
  });

  it('a listener that throws never breaks the engine', async () => {
    const h = harness({
      onChange: () => {
        throw new Error('listener bug');
      },
    });
    const rows = [rowOf('UV-0001'), rowOf('UV-0002'), rowOf('UV-0003')];
    const { r } = await presented(rows, h);
    expect(await r.approve(rows[0].key, 'A')).toStrictEqual({ delivered: true, decided: true });
    await r.askSkeptics(rows[1].key);
    r.reject(rows[1].key);
    r.defer(rows[2].key);
    await r.settle();
    expect(phases(r.view())).toStrictEqual(['UV-0001:decided', 'UV-0003:deferred', 'UV-0002:presented']);
    expect(item(r.view(), rows[1].key).presentation?.presentedBy).toBe('agent-B'); // A rejected it, so B presented it
  });
});

// ---- a whole run ----------------------------------------------------------------------------------------------------

describe('a whole round', () => {
  it('runs through approve, reject, defer and no_change deterministically and ends with the counts, the store and the messages in order', async () => {
    const h = harness({ maxPresenters: 1 });
    const [a, b] = [agent('A'), agent('B')];
    h.roster.push(a, b);
    h.onAsk.set(a.sessionID, (text) => (idIn(text) === 'UV-0003' ? unusable('UV-0003') : block(idIn(text), { title: `A on ${idIn(text)}` })));
    h.onAsk.set(b.sessionID, (text) => block(idIn(text), { title: `B on ${idIn(text)}` }));
    const rows = [rowOf('UV-0001'), rowOf('UV-0002'), rowOf('UV-0003'), rowOf('TB-0004', {}, REPO, 'tombstone'), rowOf('UV-0005', {}, BILLING)];
    const [k1, k2, k3, k4, k5] = rows.map((x) => x.key);
    const r = round(rows, h);
    const cards = () => r.view().items.map((i) => `${i.id}:${i.phase}${i.presentation ? `:${i.presentation.source === 'agent' ? i.presentation.presentedBy : 'ledger'}` : ''}`);

    r.start();
    await r.settle();
    expect(cards()).toStrictEqual(['UV-0001:presented:agent-A', 'UV-0002:presented:agent-A', 'UV-0003:queued', 'TB-0004:queued', 'UV-0005:queued']);
    expect(r.view().current).toBe(k1);

    const t1 = h.now();
    expect(await r.approve(k1, 'A')).toStrictEqual({ delivered: true, decided: true });
    await r.settle();
    expect(cards()).toStrictEqual(['UV-0001:decided:agent-A', 'UV-0002:presented:agent-A', 'UV-0003:fallback:ledger', 'TB-0004:queued', 'UV-0005:queued']);
    expect(r.view().current).toBe(k2);

    r.reject(k2);
    await r.settle();
    expect(cards()).toStrictEqual(['UV-0001:decided:agent-A', 'UV-0003:fallback:ledger', 'TB-0004:presented:agent-A', 'UV-0005:queued', 'UV-0002:queued']);
    expect(r.view().current).toBe(k3);

    const t3 = h.now();
    expect(await r.approve(k3, 'C')).toStrictEqual({ delivered: false, decided: true });
    await r.settle();
    expect(cards()).toStrictEqual(['UV-0001:decided:agent-A', 'UV-0003:decided:ledger', 'TB-0004:presented:agent-A', 'UV-0005:fallback:ledger', 'UV-0002:queued']);
    expect(r.view().current).toBe(k4);

    const t4 = h.now();
    expect(await r.approve(k4, 'B')).toStrictEqual({ delivered: true, decided: true });
    await r.settle();
    expect(cards()).toStrictEqual(['UV-0001:decided:agent-A', 'UV-0003:decided:ledger', 'TB-0004:decided:agent-A', 'UV-0005:fallback:ledger', 'UV-0002:presented:agent-B']);
    expect(r.view().current).toBe(k5);

    const t5 = h.now();
    r.defer(k5);
    expect(r.view().current).toBe(k2);

    const t7 = h.now();
    expect(await r.approve(k2, 'A')).toStrictEqual({ delivered: true, decided: true });
    await r.settle();

    const v = r.view();
    expect(v.current).toBeNull();
    expect(v.counts).toStrictEqual({ total: 5, remaining: 0, decided: 4, deferred: 1 });
    expect(cards()).toStrictEqual(['UV-0001:decided:agent-A', 'UV-0003:decided:ledger', 'TB-0004:decided:agent-A', 'UV-0005:deferred:ledger', 'UV-0002:decided:agent-B']);
    expect(h.sentLabels()).toStrictEqual(['A ask UV-0001', 'A ask UV-0002', 'A decision UV-0001', 'A ask UV-0003', 'A ask TB-0004', 'A decision TB-0004', 'B ask UV-0002', 'B decision UV-0002']);
    expect(v.log).toStrictEqual([
      'agent-A A0000000 replied without a usable block.',
      'No presentation for uv:shop-app:UV-0003: Nobody replied with a usable block. Showing the ledger row.',
      'No presentation for uv:billing:UV-0005: No agent in billing can be messaged. Showing the ledger row.',
    ]);
    expect(h.kv.get(KEYS.lightning)).toStrictEqual({
      [k1]: { state: 'decided', option: 'A', verb: 'challenge', at: t1, until: t1 + WEEK },
      [k3]: { state: 'decided', option: 'C', verb: 'no_change', at: t3, until: t3 + WEEK },
      [k4]: { state: 'decided', option: 'B', verb: 'deny', at: t4, until: t4 + WEEK },
      [k5]: { state: 'deferred', at: t5, until: new Date(new Date(t5).getFullYear(), new Date(t5).getMonth(), new Date(t5).getDate() + 1).getTime() },
      [k2]: { state: 'decided', option: 'A', verb: 'challenge', at: t7, until: t7 + WEEK },
    });

    // the next round over the same rows has nothing left to settle, until the records run out
    const again = round(rows, h);
    again.start();
    expect(again.view()).toMatchObject({ active: true, current: null, counts: { total: 0, remaining: 0, decided: 0, deferred: 0 } });
    h.set(t7 + 8 * DAY);
    const later = round(rows, h);
    later.start();
    expect(later.view().items).toHaveLength(5);
    expect(rows.map((x) => h.decisions.hidden(x.key))).toStrictEqual([false, false, false, false, false]);
  });
});
