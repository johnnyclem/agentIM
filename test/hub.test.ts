import { describe, it, expect, afterEach } from 'vitest';
import { Hub } from '../src/hub.js';
import { serve, type Daemon } from '../src/daemon.js';
import { MemoryKV } from '../src/store.js';
import { WRAP_UP, STATUS_CHECK, JOURNAL_NOW, CLEANUP_SAFE, CLEANUP_ANYWAY, TBUV_RESOLUTION_GROUP, TBUV_RESOLUTION_SOLO, HUMAN_TAG } from '../src/prompts.js';
import { parseStatusReport, type WorktreeFinding } from '../src/status-report.js';
import type { Agent, Turn } from '../src/agent.js';
import type { TranscriptRead } from '../src/transcript.js';
import type { Runner } from '../src/runner.js';

const T0 = Date.parse('2026-10-16T12:00:00.000Z');
const statusBlock = (status: string, extra = '') => `\`\`\`cim-status\nscope: MR 1\nstatus: ${status}\n${extra}\`\`\``;

function world() {
  let now = T0;
  let roster: Agent[] = [];
  const files = new Map<string, Turn[]>();
  const sent: Array<{ to: string; text: string }> = [];
  const runs: string[][] = [];
  const failing = new Set<string>();
  let finding: WorktreeFinding = { dirty: false, unpushed: 0 };
  const run: Runner = async (cmd, args) => {
    runs.push([cmd, ...args]);
    if (args[0] === '--bg' && !args.includes('--resume')) return { code: 0, stdout: 'backgrounded · beef01 · x', stderr: '' };
    if (cmd === 'git' && args[2] === 'show' && args[3] === 'wiki:tombstones.jsonl') return { code: 0, stdout: '{"id":"TB-0042","date":"2026-10-01","claim":"the old API is gone"}\n{"id":"TB-0042","claim":"dup"}\n', stderr: '' };
    if (cmd === 'git' && args[2] === 'show') return { code: 128, stdout: '', stderr: 'no such ref' };
    return { code: 0, stdout: '', stderr: '' };
  };
  const hub = new Hub({
    kv: new MemoryKV(),
    clock: () => now,
    sleep: (ms) =>
      new Promise<void>((r) => {
        now += ms;
        setImmediate(r);
      }),
    run,
    alive: () => false,
    listAgents: async () => roster,
    sendInbox: async (a, text) => {
      if (failing.has(a.sessionID)) throw new Error(`refused by ${a.name}`);
      sent.push({ to: a.sessionID, text });
    },
    readTail: async (p): Promise<TranscriptRead> => ({ turns: (files.get(p) ?? []).slice(-40), endOffset: (files.get(p) ?? []).length, latestModel: null }),
    readSince: async (p, o): Promise<TranscriptRead> => ({ turns: (files.get(p) ?? []).slice(o), endOffset: (files.get(p) ?? []).length, latestModel: null }),
    gitChecks: async () => finding,
    osUserName: 'johnny',
    settings: { repoPath: '/Repos/wiki', claudeDir: '/claude', claudePath: process.execPath },
  });
  const agent = (id: string, over: Partial<Agent> = {}): Agent => ({ sessionID: id, pid: 1, name: `agent-${id}`, cwd: `/r/${id}`, kind: 'interactive', status: 'idle', startedAt: T0, inboxSocketPath: `/tmp/${id}`, ...over });
  const transcript = (a: Agent) => `/claude/projects/-r-${a.sessionID}/${a.sessionID}.jsonl`;
  const append = (a: Agent, role: 'user' | 'assistant', text: string) => {
    const p = transcript(a);
    const list = files.get(p) ?? [];
    list.push({ id: `${a.sessionID}-${list.length}`, role, text, timestamp: (now += 1) });
    files.set(p, list);
  };
  return { hub, agent, append, sent, runs, failing, setRoster: (r: Agent[]) => (roster = r), setFinding: (f: WorktreeFinding) => (finding = f), now: () => now };
}

describe('the hub', () => {
  it('decorates the roster, pauses with the ledger first, resumes paused sessions by inbox or CLI, and marks them in flight', async () => {
    const w = world();
    const [a, b] = [w.agent('A'), w.agent('B', { kind: 'background', jobID: 'B' })];
    w.setRoster([a, b]);
    await w.hub.refresh();
    expect(w.hub.visibleAgents.map((x) => x.sessionID)).toEqual(['A', 'B']);
    expect(w.hub.liveCount).toBe(2);
    await w.hub.rename('A', 'Reviewer');
    expect(w.hub.toasts.at(-1)!.clipboard).toBe('/rename Reviewer');
    expect(w.sent.at(-1)!.text).toMatch(/now “Reviewer”/);
    w.failing.add('B');
    await w.hub.pauseAgents();
    expect(w.hub.ledger.resumeSet).toMatchObject({ paused: true });
    expect(w.hub.ledger.resumeSet!.entries.map((e) => e.name)).toEqual(['Reviewer', 'agent-B']); // the cIM name rides along
    expect(w.hub.toasts.at(-1)!.text).toBe('Asked 2 agent(s) to pause. Resume Agents brings back these 2, even after a reboot. Couldn’t reach: agent-B.');
    expect(w.sent.filter((s) => s.to === 'A').at(-1)!.text).toMatch(/pausing every running agent/);
    expect(w.sent.filter((s) => s.to === 'A').at(-1)!.text).not.toContain(HUMAN_TAG);
    // After a reboot: A is gone, B is listed stopped
    w.failing.clear();
    w.setRoster([{ ...b, pid: undefined, inboxSocketPath: undefined, status: undefined }]);
    await w.hub.refresh();
    const visible = w.hub.visibleAgents;
    expect(visible.map((x) => [x.sessionID, x.pid, x.name])).toEqual([
      ['B', undefined, 'agent-B'],
      ['A', undefined, 'Reviewer'],
    ]); // A is a stand-in from the paused set
    await w.hub.resumeAgents();
    const cli = w.runs.filter((r) => r[0] === process.execPath && r[1] === '--bg');
    expect(cli.map((r) => r[3])).toEqual(['A', 'B']); // both resumed through the CLI in resume-set order: neither has an inbox
    expect(cli.find((r) => r[3] === 'A')).toContain('--name'); // interactive keeps its name
    expect(cli.find((r) => r[3] === 'B')).not.toContain('--name'); // a flag would fork the background job
    expect(w.hub.ledger.resumeSet).toBeNull();
    expect(w.hub.ledger.inFlight.map((e) => e.sessionID).sort()).toEqual(['A', 'B']);
    expect(w.hub.toasts.at(-1)!.text).toBe('Resumed 2 agent(s).');
    for (const c of w.hub.conversations.all()) await c.settle();
  });

  it('Done asks for the wrap-up and archives only after the send succeeds; a dead session is archived at once', async () => {
    const w = world();
    const [a, b, c] = [w.agent('A'), w.agent('B'), w.agent('C', { pid: undefined, inboxSocketPath: undefined })];
    w.setRoster([a, b, c]);
    await w.hub.refresh();
    await w.hub.selectAgent('A');
    expect(w.hub.selection).toEqual({ kind: 'agent', sessionID: 'A' });
    await w.hub.done('A');
    expect(w.sent.at(-1)).toMatchObject({ to: 'A' });
    expect(w.sent.at(-1)!.text.endsWith(WRAP_UP)).toBe(true);
    expect(w.hub.archive.has('A')).toBe(true);
    expect(w.hub.selection).toBeNull();
    expect(w.hub.visibleAgents.map((x) => x.sessionID)).toEqual(['B', 'C']);
    w.failing.add('B');
    await w.hub.done('B');
    expect(w.hub.archive.has('B')).toBe(false);
    expect(w.hub.toasts.at(-1)!.text).toMatch(/Couldn.t reach agent-B/);
    await w.hub.done('C');
    expect(w.hub.archive.has('C')).toBe(true);
    expect(w.hub.toasts.at(-1)!.text).toBe('agent-C has no live inbox, so nothing was sent. Archived it.');
    w.hub.restoreArchived('A');
    expect(w.hub.visibleAgents.map((x) => x.sessionID)).toEqual(['A', 'B']);
    for (const t of w.hub.conversations.all()) await t.settle();
  });

  it('a status check opens the group in review mode; chores send the right instruction or ask for confirmation', async () => {
    const w = world();
    const [a, b] = [w.agent('A'), w.agent('B')];
    w.setRoster([a, b]);
    await w.hub.refresh();
    const g = await w.hub.statusCheck();
    expect(g.isReviewing).toBe(true);
    expect(w.hub.selection).toEqual({ kind: 'group', key: 'A+B' });
    expect(w.sent.filter((s) => s.text.endsWith(STATUS_CHECK)).map((s) => s.to).sort()).toEqual(['A', 'B']);
    w.append(a, 'assistant', statusBlock('done', 'worktrees_cleaned: false\ntb_uv_cleared: false\ntb_uv_refs:\n- TB-0042\n- UV-0007\n- tb-0042\n'));
    w.append(b, 'assistant', statusBlock('working', 'wiki_journaled: false\n'));
    await g.pollOnce();
    const review = w.hub.review('A+B');
    expect(review.entries.map((e) => [e.sessionID, e.state, e.report?.status])).toEqual([
      ['B', 'replied', 'working'],
      ['A', 'replied', 'done'],
    ]);
    expect(review.rollup).toEqual([
      { status: 'working', count: 1 },
      { status: 'done', count: 1 },
    ]);
    expect(review.selection).toBe('B');
    expect(w.hub.markReviewed('A+B', 'B')).toBe('A');
    expect(w.hub.review('A+B').header).toEqual({ replied: 2, total: 2, reviewed: 1 });
    const done = parseStatusReport(w.hub.group('A+B').turns.find((t) => t.sessionID === 'A' && t.turn.role === 'assistant')!.turn.text)!;
    const working = parseStatusReport(w.hub.group('A+B').turns.find((t) => t.sessionID === 'B' && t.turn.role === 'assistant')!.turn.text)!;
    // wiki: pending for the working agent sends "journal now"; needs-attention for the done agent asks first
    expect(await w.hub.wikiChore({ groupKey: 'A+B' }, 'B', working)).toMatchObject({ action: 'sent', text: JOURNAL_NOW });
    expect(w.sent.at(-1)).toMatchObject({ to: 'B' });
    expect(await w.hub.wikiChore({ groupKey: 'A+B' }, 'A', done)).toMatchObject({ action: 'needs-confirmation' });
    expect((await w.hub.wikiChore({ groupKey: 'A+B' }, 'A', done, true)).action).toBe('sent');
    // worktrees: clean and complete goes the safe path; unknown git state needs confirmation
    expect(await w.hub.worktreeChore({ groupKey: 'A+B' }, 'A', done)).toMatchObject({ action: 'sent', text: CLEANUP_SAFE });
    w.setFinding({ dirty: null, unpushed: null });
    const ask = await w.hub.worktreeChore({ groupKey: 'A+B' }, 'A', done);
    expect(ask.action).toBe('needs-confirmation');
    expect(ask.reasons).toHaveLength(2);
    expect(await w.hub.worktreeChore({ groupKey: 'A+B' }, 'A', done, true)).toMatchObject({ action: 'sent', text: CLEANUP_ANYWAY });
    w.setFinding({ dirty: false, unpushed: 0 });
    expect(await w.hub.worktreeChore({ groupKey: 'A+B' }, 'B', working)).toMatchObject({ action: 'needs-confirmation', reasons: ['the session hasn’t completed its assigned task(s)'] });
    // TB/UV: needs attention in a group fans the group wording to everyone who needs it, plus the clicker
    expect(await w.hub.tbuvChore({ groupKey: 'A+B' }, 'A', done)).toEqual({ action: 'sent' });
    expect(w.sent.at(-1)).toMatchObject({ to: 'A' });
    expect(w.sent.at(-1)!.text).toContain(TBUV_RESOLUTION_SOLO); // B's latest status does not need attention, so A alone gets the solo wording
    w.append(b, 'assistant', statusBlock('done', 'tb_uv_cleared: false\n'));
    await g.pollOnce();
    await w.hub.tbuvChore({ groupKey: 'A+B' }, 'A', done);
    expect(w.sent.slice(-2).map((s) => s.to).sort()).toEqual(['A', 'B']);
    expect(w.sent.at(-1)!.text).toContain(TBUV_RESOLUTION_GROUP);
    // pending or done: the sign-off sheet, de-duplicated, looked up in the wiki branch ledgers
    const signoff = await w.hub.tbuvChore({ groupKey: 'A+B' }, 'B', working);
    expect(signoff.action).toBe('sign-off');
    expect(signoff.records).toEqual([]);
    const records = await w.hub.tbuvLookup(done.tbUvRefs, '/r/A');
    expect(records).toEqual([
      { id: 'TB-0042', kind: 'tombstone', date: '2026-10-01', claim: 'the old API is gone', supersededBy: undefined },
      { id: 'UV-0007', kind: 'not-found' },
    ]);
    expect(await w.hub.tbuvReview({ groupKey: 'A+B' }, 'A', 'TB-0042', true)).toBe(true);
    expect(w.sent.at(-1)!.text).toContain('Reviewed TB-0042: confirmed, looks right.');
    g.cancelAll();
    await g.settle();
  });

  it('review selection follows the ranking until a person picks a row, and a new status check starts over', async () => {
    const w = world();
    const [a, b] = [w.agent('A'), w.agent('B')];
    w.setRoster([a, b]);
    await w.hub.refresh();
    const g = await w.hub.statusCheck();
    w.append(a, 'assistant', statusBlock('working'));
    await g.pollOnce();
    expect(w.hub.review('A+B').selection).toBe('A'); // the only reply so far
    w.append(b, 'assistant', statusBlock('blocked'));
    await g.pollOnce();
    expect(w.hub.review('A+B').entries.map((e) => e.sessionID)).toEqual(['B', 'A']);
    expect(w.hub.review('A+B').selection).toBe('B'); // the late needs-human reply surfaced on its own
    g.reviewSelection = 'A';
    g.reviewSelectionManual = true; // the person picked A
    expect(w.hub.review('A+B').selection).toBe('A');
    w.append(b, 'assistant', statusBlock('waiting_for_human'));
    await g.pollOnce();
    expect(w.hub.review('A+B').selection).toBe('A'); // a manual pick is not overridden
    await w.hub.statusCheck();
    expect(g.reviewSelectionManual).toBe(false);
    g.cancelAll();
    await g.settle();
  });

  it('finds a volunteer, hands the assigned agent’s live thread back, and spawns through the CLI with the settings’ permission mode', async () => {
    const w = world();
    const [a, b] = [w.agent('A'), w.agent('B')];
    w.setRoster([a, b]);
    await w.hub.refresh();
    const req = await w.hub.findVolunteer({ title: 'review MR !1364', description: 'three files' });
    expect(req.requester).toBe('johnny');
    expect(w.hub.selection).toEqual({ kind: 'volunteer', id: req.id });
    expect(w.sent).toHaveLength(2);
    w.append(a, 'assistant', '```cim-volunteer\nvolunteer: yes\ncontext: I touched it\n```');
    await req.pollOnce();
    expect(req.volunteers.map((v) => v.sessionID)).toEqual(['A']);
    expect(await req.assign(a)).toBe(true);
    expect(w.hub.assigneeAgent(req.id)?.sessionID).toBe('A');
    expect(w.hub.spawnDefaults('a very long task title that goes on and on and on and on past sixty characters')).toMatchObject({ model: 'claude-opus-5-5', directories: ['/Repos/wiki', '/r/A', '/r/B'] });
    expect(w.hub.spawnDefaults('x').name).toBe('x');
    const jobID = await w.hub.spawnAgent({ name: 'fixer', cwd: '/r/A', prompt: 'fix it' });
    expect(jobID).toBe('beef01');
    expect(w.runs.find((r) => r[1] === '--bg' && r[3] === 'fixer')).toEqual([process.execPath, '--bg', '--name', 'fixer', '--permission-mode', 'acceptEdits', 'fix it']);
    w.hub.closeVolunteer(req.id);
    expect(w.hub.selection).toBeNull();
    await req.settle();
  });

  it('the canary hooks and claims ride along', () => {
    const w = world();
    const { promptLine } = w.hub.canaryIssue('s1');
    const id = /canary: (\S+)\./.exec(promptLine)![1];
    expect(w.hub.canaryGate('s1', { tool_name: 'Bash', tool_input: { command: `agentim ack ${id}` } })).toEqual({ allow: true, acknowledged: true });
    expect(w.hub.canaryGate('s2', { tool_name: 'Read' })).toEqual({ allow: false, reason: 'no-canary', needsReview: false });
    expect(w.hub.claim({ agent: 'a', resource: '/wt/x', verb: 'edit', confidence: 1, ttlMs: 1000 }).allowed).toBe(true);
    expect(w.hub.claim({ agent: 'b', resource: '/wt/x', verb: 'edit', confidence: 1, ttlMs: 1000 }).allowed).toBe(false);
    expect(w.hub.fleet().agents).toEqual([]);
  });
});

describe('the daemon', () => {
  let d: Daemon | null = null;
  afterEach(async () => {
    if (d) await d.close();
    d = null;
  });
  it('serves the pane over loopback and streams events', async () => {
    const w = world();
    const [a, b] = [w.agent('A'), w.agent('B')];
    w.setRoster([a, b]);
    d = await serve(w.hub, { port: 0, pollMs: 60_000 });
    const call = async (method: string, path: string, body?: unknown) => {
      const res = await fetch(d!.url + path, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
      return { status: res.status, json: (await res.json()) as any };
    };
    const seen: string[] = [];
    const ctrl = new AbortController();
    const stream = fetch(d.url + '/events', { signal: ctrl.signal }).then(async (res) => {
      const reader = res.body!.getReader();
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          seen.push(new TextDecoder().decode(value));
        }
      } catch {
        // aborted
      }
    });
    await new Promise((r) => setTimeout(r, 20));
    expect((await call('GET', '/health')).json.ok).toBe(true);
    const state = (await call('GET', '/state')).json;
    expect(state.roster.agents.map((x: Agent) => x.sessionID)).toEqual(['A', 'B']);
    expect(state.volunteerRequesterName).toBe('johnny');
    const selected = await call('POST', '/agents/A/select');
    expect(selected.json.agent.sessionID).toBe('A');
    const sent = await call('POST', '/agents/A/message', { text: 'hi' });
    expect(sent.json.delivered).toBe(true);
    expect(sent.json.thread.turns.at(-1).text).toBe('hi');
    expect((await call('POST', '/agents/A/message', { text: '' })).status).toBe(400);
    expect((await call('GET', '/agents/nope')).status).toBe(404);
    const group = await call('POST', '/status-check', {});
    expect(group.json.key).toBe('A+B');
    expect(group.json.isReviewing).toBe(true);
    expect((await call('GET', '/groups/A+B')).json.entries).toHaveLength(2);
    const chip = await call('POST', '/chip', { turnText: statusBlock('done', 'wiki_journaled: true\n') });
    expect(chip.json.chores).toMatchObject({ wiki: 'done', worktrees: 'needs-attention' });
    expect((await call('POST', '/agents/A/chore/wiki', { turnText: 'prose' })).status).toBe(400);
    const vol = await call('POST', '/volunteer', { title: 'docs', description: 'write them' });
    expect(vol.json.phase).toBe('collecting');
    expect((await call('GET', '/volunteer')).json).toHaveLength(1);
    expect((await call('POST', '/pause')).json.resumeSet.paused).toBe(true);
    expect((await call('POST', '/agents/A/rename', { name: 'Lead' })).json.clipboard).toBe('/rename Lead');
    expect((await call('GET', '/agents/A')).json.name).toBe('Lead');
    expect((await call('DELETE', '/volunteer/' + vol.json.id)).json.ok).toBe(true);
    expect((await call('DELETE', '/groups/A+B')).json.ok).toBe(true);
    expect((await call('GET', '/nope')).status).toBe(404);
    await new Promise((r) => setTimeout(r, 30));
    ctrl.abort();
    await stream;
    const text = seen.join('');
    for (const ev of ['event: roster', 'event: selection', 'event: conversation', 'event: group', 'event: volunteer', 'event: toast']) expect(text).toContain(ev);
    for (const c of w.hub.conversations.all()) await c.settle();
  });
});
