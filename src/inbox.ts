/**
 * The inbox socket (spec §2.3, verified against CLI 2.1.267): connect to the
 * session's `messagingSocketPath`, write an auth line and a user-message
 * line, half-close. The peer token comes from
 * `~/.claude/sessions/<pid>.<sha256-hex of the socket path>.key`, derived,
 * never globbed (a stale key from a dead process with a reused pid would
 * match). The inbox acknowledges nothing: success means the write completed.
 */

import { connect } from 'node:net';
import { readFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';

export type InboxErrorKind = 'no-inbox' | 'bad-socket-path' | 'key-unreadable' | 'connect-failed' | 'write-failed';

export class InboxError extends Error {
  constructor(
    readonly kind: InboxErrorKind,
    message: string
  ) {
    super(message);
  }
}

export const INBOX_TIMEOUT_MS = 5_000;
/** sun_path: 104 bytes on macOS, 108 on Linux, NUL included. */
export const SUN_PATH_MAX = process.platform === 'darwin' ? 104 : 108;

export const NO_INBOX_MESSAGE = 'That session has no live inbox, it may have exited. Refresh the agent list.';

export function peerKeyPath(sessionsDir: string, pid: number, socketPath: string): string {
  const digest = createHash('sha256').update(socketPath, 'utf8').digest('hex');
  return join(sessionsDir, `${pid}.${digest}.key`);
}

export async function readPeerToken(sessionsDir: string, pid: number, socketPath: string): Promise<string> {
  const path = peerKeyPath(sessionsDir, pid, socketPath);
  try {
    const o = JSON.parse(await readFile(path, 'utf8')) as { peerToken?: unknown };
    if (typeof o.peerToken !== 'string' || !o.peerToken) throw new Error('no peerToken field');
    return o.peerToken;
  } catch (err) {
    throw new InboxError('key-unreadable', `Couldn’t read the session’s inbox key (${err instanceof Error ? err.message : String(err)}). Refresh the agent list.`);
  }
}

/** The two newline-terminated JSON lines a send writes. */
export function inboxFrames(token: string, text: string, msgId: string = randomUUID()): string {
  const auth = JSON.stringify({ type: 'auth', token });
  const message = JSON.stringify({ msgV: 1, msg_id: msgId, type: 'user', message: { role: 'user', content: text }, priority: 'next' });
  return `${auth}\n${message}\n`;
}

export interface InboxTarget {
  socketPath?: string;
  pid?: number;
}

/**
 * Deliver one message. Rejects with an `InboxError` whose kind is one of the
 * four vocabulary entries. The timeout covers connect as well as the write,
 * since this runs on the event loop and nothing here blocks.
 */
export async function sendInboxMessage(target: InboxTarget, text: string, opts: { sessionsDir: string; timeoutMs?: number; token?: string }): Promise<void> {
  const socketPath = target.socketPath;
  if (!socketPath || target.pid === undefined) throw new InboxError('no-inbox', NO_INBOX_MESSAGE);
  if (Buffer.byteLength(socketPath, 'utf8') >= SUN_PATH_MAX) throw new InboxError('bad-socket-path', `The inbox socket path is too long for this platform (${SUN_PATH_MAX - 1} bytes).`);
  const token = opts.token ?? (await readPeerToken(opts.sessionsDir, target.pid, socketPath));
  const frames = inboxFrames(token, text);
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    let connected = false;
    const done = (err?: InboxError) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err) reject(err);
      else resolve();
    };
    const timer = setTimeout(() => {
      sock.destroy();
      done(new InboxError(connected ? 'write-failed' : 'connect-failed', `The session’s inbox did not ${connected ? 'take the message' : 'answer'} within ${opts.timeoutMs ?? INBOX_TIMEOUT_MS} ms.`));
    }, opts.timeoutMs ?? INBOX_TIMEOUT_MS);
    const sock = connect(socketPath);
    sock.on('connect', () => {
      connected = true;
      // end() writes then half-closes the write side; 'finish' fires once the bytes are flushed.
      sock.end(frames);
    });
    sock.on('finish', () => done());
    sock.on('error', (err: NodeJS.ErrnoException) => {
      // EPIPE here is the peer that just exited; Node raises it as an event, never as a SIGPIPE.
      if (!connected) done(new InboxError('connect-failed', `Couldn’t connect to the session’s inbox (${err.code ?? err.message}). ${NO_INBOX_MESSAGE}`));
      else done(new InboxError('write-failed', `The message could not be written to the session’s inbox (${err.code ?? err.message}).`));
    });
  });
}
