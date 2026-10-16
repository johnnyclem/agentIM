import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type Server } from 'node:net';
import { createHash } from 'node:crypto';
import { peerKeyPath, inboxFrames, sendInboxMessage, InboxError } from '../src/inbox.js';

let dir: string | null = null;
let server: Server | null = null;
afterEach(async () => {
  if (server) await new Promise<void>((r) => server!.close(() => r()));
  server = null;
  if (dir) rmSync(dir, { recursive: true, force: true });
});

describe('the inbox socket', () => {
  it('derives the key file name from the pid and the sha256 of the socket path', () => {
    const digest = createHash('sha256').update('/tmp/cc-socks/42.sock').digest('hex');
    expect(peerKeyPath('/s', 42, '/tmp/cc-socks/42.sock')).toBe(`/s/42.${digest}.key`);
  });
  it('writes an auth line and a user-message line', () => {
    const frames = inboxFrames('tok', 'hello', 'id-1');
    const [a, m, rest] = frames.split('\n');
    expect(JSON.parse(a)).toEqual({ type: 'auth', token: 'tok' });
    expect(JSON.parse(m)).toEqual({ msgV: 1, msg_id: 'id-1', type: 'user', message: { role: 'user', content: 'hello' }, priority: 'next' });
    expect(rest).toBe('');
  });
  it('delivers to a listening socket, half-closing after the two lines', async () => {
    dir = mkdtempSync(join(tmpdir(), 'ib-'));
    const sock = join(dir, '7.sock');
    writeFileSync(peerKeyPath(dir, 7, sock), JSON.stringify({ peerToken: 'secret' }));
    const received: string[] = [];
    server = createServer((c) => {
      let buf = '';
      c.on('data', (d) => (buf += d.toString()));
      c.on('end', () => {
        received.push(buf);
        c.end();
      });
    });
    await new Promise<void>((r) => server!.listen(sock, r));
    await sendInboxMessage({ socketPath: sock, pid: 7 }, 'ping', { sessionsDir: dir });
    await new Promise((r) => setTimeout(r, 30));
    expect(received).toHaveLength(1);
    const [auth, msg] = received[0].trim().split('\n').map((l) => JSON.parse(l));
    expect(auth).toEqual({ type: 'auth', token: 'secret' });
    expect(msg.message).toEqual({ role: 'user', content: 'ping' });
  });
  it('names each failure: no inbox, unreadable key, connection refused', async () => {
    dir = mkdtempSync(join(tmpdir(), 'ib-'));
    await expect(sendInboxMessage({}, 'x', { sessionsDir: dir })).rejects.toMatchObject({ kind: 'no-inbox' });
    const sock = join(dir, '9.sock');
    await expect(sendInboxMessage({ socketPath: sock, pid: 9 }, 'x', { sessionsDir: dir })).rejects.toMatchObject({ kind: 'key-unreadable' });
    writeFileSync(peerKeyPath(dir, 9, sock), JSON.stringify({ peerToken: 't' }));
    const err = await sendInboxMessage({ socketPath: sock, pid: 9 }, 'x', { sessionsDir: dir }).catch((e) => e);
    expect(err).toBeInstanceOf(InboxError);
    expect(err.kind).toBe('connect-failed');
    expect(err.message).toMatch(/Refresh the agent list/);
  });
  it('rejects a socket path that does not fit sun_path', async () => {
    await expect(sendInboxMessage({ socketPath: '/' + 'p'.repeat(120), pid: 1 }, 'x', { sessionsDir: '/s', token: 't' })).rejects.toMatchObject({ kind: 'bad-socket-path' });
  });
  it('a peer that closes without reading does not crash the process', async () => {
    dir = mkdtempSync(join(tmpdir(), 'ib-'));
    const sock = join(dir, '8.sock');
    server = createServer((c) => c.destroy());
    await new Promise<void>((r) => server!.listen(sock, r));
    const result = await sendInboxMessage({ socketPath: sock, pid: 8 }, 'x'.repeat(200_000), { sessionsDir: dir, token: 't', timeoutMs: 1000 }).then(() => 'ok', (e) => e.kind);
    expect(['ok', 'write-failed']).toContain(result);
  });
});
