import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PeerInbox, type Frame, type CapturedFrame } from '../src/transport.js';
import { transcriptPath } from '../src/discovery.js';

export const T0 = Date.parse('2026-10-16T12:00:00.000Z');

export interface World {
  root: string;
  claudeDir: string;
  socketDir: string;
  now: number;
  clock: () => number;
  /** A fake agent: a peer socket plus a registry record, with every frame it received. */
  agent(name: string, opts?: { pid?: number; cwd?: string; kind?: string; reply?: (f: Frame) => unknown }): Promise<FakeAgent>;
  /** Append one transcript line for a session. */
  transcriptLine(cwd: string, sessionId: string, line: Record<string, unknown>): void;
  dispose(): Promise<void>;
}

export interface FakeAgent {
  name: string;
  pid: number;
  sessionId: string;
  cwd: string;
  inbox: PeerInbox;
  received: Frame[];
  texts(): string[];
}

let nextPid = 70_000;

export async function world(): Promise<World> {
  const root = mkdtempSync(join(tmpdir(), 'aim-'));
  const claudeDir = join(root, 'claude');
  const socketDir = join(root, 'socks');
  mkdirSync(join(claudeDir, 'sessions'), { recursive: true });
  const agents: FakeAgent[] = [];
  const w: World = {
    root,
    claudeDir,
    socketDir,
    now: T0,
    clock: () => w.now,
    async agent(name, opts = {}) {
      const pid = opts.pid ?? ++nextPid;
      const cwd = opts.cwd ?? join(root, 'repo');
      const received: Frame[] = [];
      const inbox = new PeerInbox({
        claudeDir,
        socketDir,
        name,
        cwd,
        pid,
        kind: opts.kind ?? 'interactive',
        onFrame: (frame: Frame, _c: CapturedFrame) => {
          received.push(frame);
          return opts.reply?.(frame) ?? { ok: true };
        },
      });
      await inbox.start(w.now);
      const sessionId = inbox.record(w.now).sessionId;
      const a: FakeAgent = { name, pid, sessionId, cwd, inbox, received, texts: () => received.map((f) => String(f.text ?? '')) };
      agents.push(a);
      // A first transcript line so the roster knows the cwd/branch and sees recent activity
      w.transcriptLine(cwd, sessionId, { type: 'user', sessionId, cwd, gitBranch: 'main', timestamp: new Date(w.now).toISOString(), uuid: 'u0', message: { role: 'user', content: 'hello' } });
      w.transcriptLine(cwd, sessionId, { type: 'assistant', sessionId, cwd, timestamp: new Date(w.now).toISOString(), uuid: 'a0', message: { role: 'assistant', content: [{ type: 'text', text: 'ready' }] } });
      return a;
    },
    transcriptLine(cwd, sessionId, line) {
      const p = transcriptPath(cwd, sessionId, claudeDir);
      mkdirSync(join(p, '..'), { recursive: true });
      appendFileSync(p, JSON.stringify(line) + '\n');
    },
    async dispose() {
      for (const a of agents) await a.inbox.stop();
      rmSync(root, { recursive: true, force: true });
    },
  };
  return w;
}

export function writeRegistry(claudeDir: string, rec: Record<string, unknown>): void {
  writeFileSync(join(claudeDir, 'sessions', `${rec.pid}.json`), JSON.stringify(rec));
}
