import { describe, it, expect, afterEach } from 'vitest';
import { Hub, toolCallOf, volunteerAsk, type HubEvent } from '../src/hub.js';
import { USER_HEADING } from '../src/transport.js';
import { ACK_TOOL } from '../src/canary.js';
import type { Runner } from '../src/spawn.js';
import { world, type World, type FakeAgent } from './fixture.js';

let w: World;
let hub: Hub | null = null;
afterEach(async () => {
  if (hub) await hub.stop();
  hub = null;
  if (w) await w.dispose();
});

const calls: Array<{ cmd: string; args: string[] }> = [];
const fakeRun: Runner = async (cmd, args) => {
  calls.push({ cmd, args });
  return { code: 0, stdout: '', stderr: '', pid: 1 };
};

async function setup(): Promise<{ a: FakeAgent; b: FakeAgent; events: HubEvent[] }> {
  w = await world();
  const a = await w.agent('instrument-62');
  const b = await w.agent('instrument-66');
  hub = new Hub({ claudeDir: w.claudeDir, socketDir: w.socketDir, name: 'agentim', cwd: w.root, pid: 90_000, clock: w.clock, alive: () => true, run: fakeRun, idleAfterMs: 5 * 60_000, repos: [] });
  const events: HubEvent[] = [];
  hub.subscribe((e) => events.push(e));
  await hub.start();
  return { a, b, events };
}

/** An agent replies to the daemon over the peer channel, the way SendMessage would. */
async function peerReply(agent: FakeAgent, text: string) {
  const { sendFrame } = await import('../src/transport.js');
  return sendFrame(hub!.inbox.socketPath, { action: 'message', msg_id: 'm1', from: agent.name, from_mode: 'interactive', text });
}

describe('the hub', () => {
  it('lists the roster without itself and reads a transcript', async () => {
    const { a } = await setup();
    const names = hub!.agents().agents.map((x) => x.name);
    expect(names).toEqual(['instrument-62', 'instrument-66']);
    expect(hub!.agent(a.sessionId)?.name).toBe('instrument-62');
    expect(hub!.transcript('instrument-62')!.turns.map((t) => t.text)).toEqual(['hello', 'ready']);
  });

  it('delivers a user message under the heading and waits until the agent answers over the channel', async () => {
    const { a, events } = await setup();
    const d = await hub!.send('instrument-62', 'please rebase');
    expect(d.status).toBe('delivered');
    expect(a.texts()[0]).toBe(`${USER_HEADING}\n\nplease rebase`);
    expect(a.received[0]).toMatchObject({ action: 'message', from: 'agentim', to: 'instrument-62' });
    w.now += 4000;
    await peerReply(a, 'rebased, pushed');
    const after = hub!.delivery(d.id)!;
    expect(after).toMatchObject({ status: 'answered', reply: 'rebased, pushed', answeredAt: w.now });
    expect(events.filter((e) => e.type === 'delivery')).toHaveLength(2);
  });

  it('also treats the agent’s next assistant turn in its transcript as the answer', async () => {
    const { b } = await setup();
    w.now += 1000;
    const d = await hub!.send('instrument-66', 'status?');
    w.now += 7000;
    w.transcriptLine(b.cwd, b.sessionId, { type: 'assistant', sessionId: b.sessionId, cwd: b.cwd, timestamp: new Date(w.now).toISOString(), uuid: 'a9', message: { role: 'assistant', content: [{ type: 'text', text: 'all green' }] } });
    expect(hub!.deliveriesList()[0]).toMatchObject({ id: d.id, status: 'answered', reply: 'all green' });
  });

  it('marks a stopped or socket-less agent unreachable instead of hanging', async () => {
    await setup();
    const { writeRegistry } = await import('./fixture.js');
    writeRegistry(w.claudeDir, { pid: 5, sessionId: 'nosock', cwd: '/x', kind: 'interactive', name: 'mute' });
    const d = await hub!.send('mute', 'hello?');
    expect(d.status).toBe('unreachable');
    await expect(hub!.send('nobody', 'x')).rejects.toThrow(/no agent named nobody/);
  });

  it('runs a volunteer round: title only, replies over the channel, the briefing reaches the winner before the others are released', async () => {
    const { a, b } = await setup();
    const opened = await hub!.volunteer({ title: 'MR !1267 merge conflicts', description: 'SECRET: three files in Sources/Core' });
    expect(opened.request.roster).toEqual(['instrument-62', 'instrument-66']);
    expect(opened.resolution.status).toBe('open');
    expect(opened.deliveries.map((d) => d.status)).toEqual(['delivered', 'delivered']);
    for (const agent of [a, b]) {
      expect(agent.texts()[0]).toBe(volunteerAsk(opened.request, 'agentim'));
      expect(agent.texts()[0]).not.toContain('SECRET');
    }
    w.now += 5000;
    await peerReply(a, `request: ${opened.request.id}\nvolunteer: no\ncontext: mid-merge on qp27110`);
    w.now += 5000;
    await peerReply(b, 'volunteer: yes\ncontext: I touched Sources/Core yesterday\nconfidence: 0.7'); // no request line: routed to the open round
    let view = hub!.view(opened.request.id)!;
    expect(view.replies.map((r) => [r.agent, r.volunteer, r.confidence, r.late])).toEqual([
      ['instrument-62', false, 0, false],
      ['instrument-66', true, 0.7, false],
    ]);
    expect(view.resolution.status).toBe('open');
    expect((await hub!.settleAll()).length).toBe(0);

    w.now += 30_000;
    view = hub!.view(opened.request.id)!;
    expect(view.resolution).toMatchObject({ status: 'picked', winner: 'instrument-66', by: 'confidence' });
    expect(view.briefed).toBe(false);
    const settled = await hub!.settleAll();
    expect(settled).toHaveLength(1);
    expect(settled[0].briefed).toBe(true);
    expect(b.texts()[1]).toContain('SECRET: three files in Sources/Core');
    expect(a.texts()[1]).toMatch(/is taken by instrument-66/);
    expect(a.texts()).toHaveLength(2);
    // Settling again is a no-op; the briefing went out once
    await hub!.settle(opened.request.id);
    expect(b.texts()).toHaveLength(2);
  });

  it('lets a person pick anyone, and starts a fresh agent when nobody volunteered', async () => {
    const { a, b } = await setup();
    const r1 = await hub!.volunteer({ title: 'docs sweep', description: 'd1' });
    hub!.volunteerPick(r1.request.id, 'instrument-62');
    const v1 = await hub!.settle(r1.request.id);
    expect(v1.resolution).toMatchObject({ status: 'picked', winner: 'instrument-62', by: 'person' });
    expect(a.texts().at(-1)).toContain('d1');
    expect(b.texts().at(-1)).toMatch(/taken by instrument-62/);

    const r2 = await hub!.volunteer({ title: 'flaky test', description: 'd2' });
    hub!.volunteerReply(r2.request.id, 'instrument-62', 'volunteer: no\ncontext: busy');
    w.now += 31_000;
    const v2 = hub!.view(r2.request.id)!;
    expect(v2.resolution).toMatchObject({ status: 'nobody', declined: ['instrument-62'], silent: ['instrument-66'] });
    calls.length = 0;
    const spawned = await hub!.volunteerSpawn(r2.request.id, { mode: 'background', repo: '/Repos/instrument' });
    expect(spawned.spawned).toMatchObject({ mode: 'background', agent: `vol-${r2.request.id.slice(3)}` });
    expect(calls[0].args.slice(0, 4)).toEqual(['-C', '/Repos/instrument', 'worktree', 'add']);
    expect(calls[1]).toMatchObject({ cmd: 'claude' });
    expect(calls[1].args[1]).toBe('flaky test\n\nd2');
    await expect(hub!.volunteerSpawn(r2.request.id, { mode: 'background', repo: '/r' })).rejects.toThrow(/already started/);
  });

  it('maps hook tool calls onto the canary gate: `agentim ack <id>` from Bash is the acknowledgment', async () => {
    await setup();
    const { canary, promptLine } = hub!.canaryIssue('sess-1');
    expect(promptLine).toContain(canary.id);
    expect(toolCallOf({ tool_name: 'Bash', tool_input: { command: `agentim ack ${canary.id}` } })).toEqual({ tool: ACK_TOOL, args: { canary: canary.id } });
    expect(toolCallOf({ tool_name: 'mcp__agentim__cim_ack', tool_input: { canary: 'x' } })).toEqual({ tool: ACK_TOOL, args: { canary: 'x' } });
    expect(toolCallOf({ tool_name: 'Read', tool_input: { file_path: '/a' } })).toEqual({ tool: 'Read', args: { file_path: '/a' } });

    expect(hub!.canaryGate('sess-1', { tool_name: 'Bash', tool_input: { command: `agentim ack ${canary.id}` } })).toEqual({ allow: true, acknowledged: true });
    expect(hub!.canaryGate('sess-1', { tool_name: 'Read', tool_input: {} })).toEqual({ allow: true, acknowledged: true });

    hub!.canaryIssue('sess-2');
    expect(hub!.canaryGate('sess-2', { tool_name: 'Bash', tool_input: { command: 'rm -rf /' } })).toEqual({ allow: false, reason: 'unacknowledged', needsReview: true });
    expect(hub!.canaryGate('sess-2', { tool_name: 'Read', tool_input: {} })).toEqual({ allow: false, reason: 'stopped', needsReview: true });
    const report = await hub!.status();
    expect(report.needsReview).toEqual([{ sessionId: 'sess-2', tool: 'Bash', at: w.now }]);
    hub!.canaryClear('sess-2');
    expect((await hub!.status()).needsReview).toEqual([]);
  });

  it('writes claims on an agent’s behalf, first writer wins, and the status report shows them against the clock', async () => {
    const { a } = await setup();
    const v1 = hub!.claim({ agent: 'instrument-62', resource: 'QP-26185', verb: 'review', confidence: 0.9, ttlMs: 60_000 });
    const v2 = hub!.claim({ agent: 'instrument-66', resource: 'QP-26185', verb: 'edit', confidence: 0.5, ttlMs: 60_000 });
    expect(v1.allowed).toBe(true);
    expect(v2).toMatchObject({ allowed: false, winner: { agent: 'instrument-62' } });
    hub!.canaryIssue(a.sessionId);
    w.now += 30_000;
    const report = await hub!.status();
    expect(report.asOf).toBe(w.now);
    expect(report.agents.map((x) => [x.name, x.state, x.claims.length, x.canary])).toEqual([
      ['instrument-62', 'busy', 1, 'pending'],
      ['instrument-66', 'busy', 0, 'none'],
    ]);
    w.now += 31_000;
    expect(hub!.liveClaims()).toEqual([]);
  });
});
