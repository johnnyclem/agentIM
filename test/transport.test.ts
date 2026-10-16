import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { sendFrame, messageFrame, wrapFromUser, USER_HEADING, parseVolunteerReply, PeerInbox } from '../src/transport.js';
import { world, type World } from './fixture.js';

let w: World;
afterEach(async () => w && (await w.dispose()));

describe('the peer channel', () => {
  it('wraps a human message under the heading that says it may not be the user', () => {
    const t = wrapFromUser('  please rebase  ');
    expect(t.startsWith(USER_HEADING)).toBe(true);
    expect(t.endsWith('\n\nplease rebase')).toBe(true);
    expect(USER_HEADING).toMatch(/impersonating the user/);
  });

  it('parses the two-line volunteer reply, with an optional confidence', () => {
    expect(parseVolunteerReply('request: vr-1\nvolunteer: yes\ncontext: I wrote that module\nconfidence: 0.8')).toEqual({ volunteer: true, confidence: 0.8, context: 'I wrote that module' });
    expect(parseVolunteerReply('Volunteer: NO\ncontext: mid-merge')).toEqual({ volunteer: false, context: 'mid-merge' });
    expect(parseVolunteerReply('sure, I can take it')).toBeNull();
  });

  it('delivers one JSON frame per connection, gets the reply, and the inbox records itself as a peer and logs the capture', async () => {
    w = await world();
    const log = join(w.root, 'capture.jsonl');
    const a = await w.agent('echo', { reply: (f) => ({ ok: true, echoed: f.msg_id }) });
    const inbox = new PeerInbox({ claudeDir: w.claudeDir, socketDir: w.socketDir, name: 'probe', cwd: '/x', pid: 80_001, captureLog: log });
    await inbox.start(w.now);
    const rec = JSON.parse(readFileSync(inbox.registryPath, 'utf8'));
    expect(rec).toMatchObject({ pid: 80_001, kind: 'daemon', name: 'probe', messagingSocketPath: inbox.socketPath, peerProtocol: 1 });

    const frame = messageFrame({ from: 'probe', to: 'echo', text: 'hi' });
    expect(frame).toMatchObject({ action: 'message', from: 'probe', to: 'echo', text: 'hi' });
    const reply = await sendFrame(a.inbox.socketPath, frame);
    expect(reply).toEqual({ ok: true, echoed: frame.msg_id });
    expect(a.received).toEqual([frame]);

    await sendFrame(inbox.socketPath, { action: 'peer_idle_notice', from: 'echo' });
    const captured = readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(captured).toHaveLength(1);
    expect(captured[0].frame).toEqual({ action: 'peer_idle_notice', from: 'echo' });
    await inbox.stop();
    await expect(sendFrame(inbox.socketPath, { action: 'x' })).rejects.toThrow();
  });

  it('answers a non-JSON frame with an error instead of dropping the connection', async () => {
    w = await world();
    const a = await w.agent('strict');
    const reply = (await sendFrame(a.inbox.socketPath, { action: 'ok' })) as { ok: boolean };
    expect(reply.ok).toBe(true);
    const { connect } = await import('node:net');
    const raw = await new Promise<string>((resolve) => {
      const s = connect(a.inbox.socketPath, () => s.end('not json'));
      let buf = '';
      s.on('data', (d) => (buf += d.toString()));
      s.on('close', () => resolve(buf));
    });
    expect(JSON.parse(raw).ok).toBe(false);
  });
});
