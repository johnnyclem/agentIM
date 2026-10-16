import { describe, it, expect, afterEach } from 'vitest';
import { Hub } from '../src/hub.js';
import { serve, type Daemon } from '../src/daemon.js';
import { world, type World } from './fixture.js';

let w: World;
let d: Daemon | null = null;
afterEach(async () => {
  if (d) await d.close();
  d = null;
  if (w) await w.dispose();
});

async function call(method: string, path: string, body?: unknown): Promise<{ status: number; json: any }> {
  const res = await fetch(d!.url + path, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, json: await res.json() };
}

describe('the daemon', () => {
  it('serves the panel’s actions over loopback and streams events', async () => {
    w = await world();
    const a = await w.agent('instrument-62');
    const hub = new Hub({ claudeDir: w.claudeDir, socketDir: w.socketDir, cwd: w.root, pid: 90_001, clock: w.clock, alive: () => true, run: async () => ({ code: 0, stdout: '', stderr: '' }) });
    d = await serve(hub, { port: 0, tickMs: 0 });
    expect(d.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);

    const events: string[] = [];
    const ctrl = new AbortController();
    const stream = fetch(d.url + '/events', { signal: ctrl.signal }).then(async (res) => {
      const reader = res.body!.getReader();
      const dec = new TextDecoder();
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          events.push(dec.decode(value));
        }
      } catch {
        // aborted
      }
    });

    expect((await call('GET', '/health')).json).toMatchObject({ ok: true, name: 'agentim' });
    expect((await call('GET', '/agents')).json.agents.map((x: any) => x.name)).toEqual(['instrument-62']);
    expect((await call('GET', '/agents/instrument-62/transcript?tail=1')).json.turns).toHaveLength(1);
    expect((await call('GET', '/agents/nobody')).status).toBe(404);

    const sent = await call('POST', '/agents/instrument-62/message', { text: 'hi there' });
    expect(sent.json.status).toBe('delivered');
    expect(a.texts()[0]).toContain('hi there');
    expect((await call('GET', `/deliveries/${sent.json.id}`)).json.status).toBe('delivered');
    expect((await call('POST', '/agents/instrument-62/message', { text: '' })).status).toBe(400);
    expect((await call('POST', '/agents/instrument-62/message', 'not json' as any)).status).toBe(400);

    const c1 = await call('POST', '/claims', { agent: 'instrument-62', resource: '/wt/x', verb: 'edit' });
    expect(c1.json.allowed).toBe(true);
    const c2 = await call('POST', '/claims', { agent: 'other', resource: '/wt/x', verb: 'edit', confidence: 0.3 });
    expect(c2.json).toMatchObject({ allowed: false, winner: { id: c1.json.claim.id } });
    expect((await call('GET', '/claims')).json).toHaveLength(1);
    expect((await call('POST', `/claims/${c1.json.claim.id}/complete`)).json).toEqual({ completed: true });

    const issued = await call('POST', '/canary/issue', { sessionId: 's1' });
    const gate = await call('POST', '/canary/gate', { sessionId: 's1', tool_name: 'Bash', tool_input: { command: `agentim ack ${issued.json.canary.id}` } });
    expect(gate.json).toEqual({ allow: true, acknowledged: true });

    const vr = await call('POST', '/volunteer', { title: 'docs', description: 'write them' });
    expect(vr.json.resolution.status).toBe('open');
    expect((await call('POST', `/volunteer/${vr.json.request.id}/reply`, { agent: 'instrument-62', text: 'volunteer: yes\ncontext: ok\nconfidence: 1' })).json.replies).toHaveLength(1);
    w.now += 31_000;
    const settled = await call('POST', `/volunteer/${vr.json.request.id}/settle`);
    expect(settled.json).toMatchObject({ briefed: true, resolution: { winner: 'instrument-62' } });
    expect((await call('GET', '/volunteer')).json).toHaveLength(1);
    expect((await call('GET', '/status')).json.agents[0].name).toBe('instrument-62');
    expect((await call('GET', '/nope')).status).toBe(404);

    await new Promise((r) => setTimeout(r, 50));
    ctrl.abort();
    await stream;
    const text = events.join('');
    expect(text).toContain('event: delivery');
    expect(text).toContain('event: claim');
    expect(text).toContain('event: volunteer');
    expect(text).toContain('event: canary');
  });
});
